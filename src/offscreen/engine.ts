import { registerFont, scanFont, unregisterFont } from '../core/fonts/glyphScan';
import { base64ToBytes } from '../core/image/bits';
import { grayToMask, inkCount } from '../core/image/binarize';
import { close, estimateStrokeWidth } from '../core/image/morphology';
import { normalizeMask } from '../core/image/normalize';
import {
  buildResults,
  buildSketchFeatures,
  createGlyphEntry,
  searchGlyphs,
  type GlyphEntry,
} from '../core/matching/matcher';
import * as db from '../core/store/db';
import { GLYPH_INDEX_VERSION, ICON_MARGIN, ICON_SIZE, familyFor } from '../shared/constants';
import type { SearchResponse } from '../shared/messaging';
import { yieldToEventLoop } from '../shared/schedule';
import { getTransport } from '../shared/transport';
import type { FontMeta, GlyphRecord, StoredFont } from '../shared/types';

/** Держим разобранные глифы в памяти: индекс строится один раз на шрифт. */
const entriesByFont = new Map<string, GlyphEntry[]>();
const pendingLoad = new Map<string, Promise<void>>();

/** Карта «кодпоинт → имя класса» из активного .less. */
let iconNames: Map<number, string> | null = null;

async function iconNameMap(): Promise<Map<number, string>> {
  if (!iconNames) {
    const entries = await db.getIconMap();
    iconNames = new Map(entries.map((entry) => [entry.codePoint, entry.className]));
  }
  return iconNames;
}

/** Сбросить кеш после того, как popup заменил .less. */
export async function reloadIcons(): Promise<void> {
  iconNames = null;
  await iconNameMap();
}

function reportProgress(
  font: Pick<FontMeta, 'id' | 'name'>,
  phase: 'fetch' | 'scan' | 'index',
  done: number,
  total: number,
): void {
  getTransport().push({
    target: 'popup',
    type: 'progress',
    fontId: font.id,
    fontName: font.name,
    phase,
    done,
    total,
  });
}

function notifyFontsChanged(): void {
  getTransport().push({ target: 'popup', type: 'fonts-changed' });
}

export async function listFonts(): Promise<FontMeta[]> {
  return db.listFonts();
}

/**
 * Переиндексирует шрифты, разобранные более слабой версией сканера.
 * @returns сколько шрифтов пришлось пересобрать.
 */
export async function reindexOutdatedFonts(): Promise<number> {
  const fonts = await db.listFonts();
  let reindexed = 0;

  for (const font of fonts) {
    if (!font.indexed || font.indexVersion === GLYPH_INDEX_VERSION) continue;
    entriesByFont.delete(font.id);
    try {
      await indexFont(font.id);
      reindexed += 1;
    } catch {
      // Битый шрифт не должен ломать запуск: о нём сообщит поиск.
    }
  }

  return reindexed;
}

/** Через столько миллисекунд построения дескрипторов отдаём поток. */
const ENTRY_BUILD_YIELD_MS = 8;

/**
 * Строит дескрипторы глифов порциями. На шрифте в несколько тысяч глифов это
 * заметная синхронная пауза (у каждого глифа считаются карты расстояний и HOG),
 * поэтому отдаём поток: иначе первый поиск и список шрифтов ждут её целиком.
 */
async function buildEntries(records: GlyphRecord[]): Promise<GlyphEntry[]> {
  const entries: GlyphEntry[] = [];
  let lastYield = performance.now();

  for (const record of records) {
    entries.push(createGlyphEntry(record));
    if (performance.now() - lastYield >= ENTRY_BUILD_YIELD_MS) {
      await yieldToEventLoop();
      lastYield = performance.now();
    }
  }

  return entries;
}

export async function ensureFontLoaded(fontId: string): Promise<void> {
  if (entriesByFont.has(fontId)) return;

  const pending = pendingLoad.get(fontId);
  if (pending) return pending;

  const task = (async () => {
    const records = await db.getGlyphsByFont(fontId);
    entriesByFont.set(fontId, await buildEntries(records));
  })();

  pendingLoad.set(fontId, task);
  try {
    await task;
  } finally {
    pendingLoad.delete(fontId);
  }
}

async function indexFont(fontId: string): Promise<void> {
  const stored = await db.getStoredFont(fontId);
  if (!stored) throw new Error('Шрифт не найден в хранилище');

  await registerFont(stored.family, stored.bytes);
  reportProgress(stored, 'scan', 0, 1);

  const scanned = await scanFont(stored.family, {
    onProgress: (done, total) => reportProgress(stored, 'scan', done, total),
  });

  if (scanned.length === 0) {
    throw new Error('В шрифте не найдено ни одного глифа');
  }

  const records: GlyphRecord[] = scanned.map((glyph) => ({
    id: `${fontId}:${glyph.codePoint}`,
    fontId,
    fontName: stored.name,
    sourceKind: stored.sourceKind,
    sourceValue: stored.sourceValue,
    codePoint: glyph.codePoint,
    char: glyph.char,
    mask: glyph.mask,
    inkPixels: inkCount(glyph.mask),
    coverage: glyph.coverage,
    aspect: glyph.aspect,
  }));

  const batchSize = 250;

  // Перед пересборкой чистим старый индекс: иначе останутся кодпоинты,
  // которых новый сканер уже не находит, и они будут вечно висеть в поиске.
  await db.deleteGlyphsByFont(fontId);

  for (let i = 0; i < records.length; i += batchSize) {
    const batch = records.slice(i, i + batchSize);
    await db.putGlyphs(batch);
    reportProgress(stored, 'index', Math.min(i + batch.length, records.length), records.length);
  }

  await db.patchFont(fontId, {
    glyphCount: records.length,
    indexed: true,
    indexVersion: GLYPH_INDEX_VERSION,
  });
  // Дескрипторы строим сразу — первый поиск не должен платить за это отдельно.
  entriesByFont.set(fontId, await buildEntries(records));
  notifyFontsChanged();
}

export async function addFontFromUrl(name: string, url: string): Promise<FontMeta> {
  const id = crypto.randomUUID();
  const family = familyFor(id);

  reportProgress({ id, name }, 'fetch', 0, 1);

  const response = await fetch(url);
  if (!response.ok) throw new Error(`Не удалось скачать шрифт: HTTP ${response.status}`);

  const bytes = await response.arrayBuffer();
  const font: StoredFont = {
    id,
    name,
    family,
    sourceKind: 'url',
    sourceValue: url,
    glyphCount: 0,
    indexed: false,
    createdAt: Date.now(),
    bytes,
  };

  await db.putStoredFont(font);
  notifyFontsChanged();

  try {
    await indexFont(id);
  } catch (error) {
    await db.deleteFont(id);
    notifyFontsChanged();
    throw error;
  }

  const stored = await db.getStoredFont(id);
  return db.stripBytes(stored ?? font);
}

export async function indexLocalFont(fontId: string): Promise<void> {
  try {
    await indexFont(fontId);
  } catch (error) {
    await db.deleteFont(fontId);
    notifyFontsChanged();
    throw error;
  }
}

export async function removeFont(fontId: string): Promise<void> {
  const stored = await db.getStoredFont(fontId);
  if (stored) unregisterFont(stored.family);
  entriesByFont.delete(fontId);
  await db.deleteFont(fontId);
  notifyFontsChanged();
}

/**
 * Сколько уникальных кодпоинтов среди глифов. Один и тот же кодпоинт может быть
 * в нескольких шрифтах сразу: для счётчика иконок это всё равно одна иконка.
 */
function distinctCodePoints(entries: GlyphEntry[]): number {
  const seen = new Set<number>();
  for (const entry of entries) seen.add(entry.record.codePoint);
  return seen.size;
}

export interface IconCount {
  /** Сколько иконок реально участвует в поиске: кодпоинты из стилей, найденные в шрифтах. */
  total: number;
  /** Имена классов из стилей, для которых глифа нет ни в одном шрифте. */
  missing: string[];
}

/**
 * Сколько глифов реально участвует в поиске: объявленные в .less и найденные в шрифте.
 * Считается без наброска, поэтому попадает в футер сразу при открытии popup.
 */
export async function iconCount(): Promise<IconCount> {
  const fonts = await db.listFonts();
  for (const font of fonts) {
    if (font.indexed) await ensureFontLoaded(font.id);
  }

  const names = await iconNameMap();
  const searchable: GlyphEntry[] = [];
  const found = new Set<number>();
  for (const list of entriesByFont.values()) {
    for (const entry of list) {
      found.add(entry.record.codePoint);
      if (names.size === 0 || names.has(entry.record.codePoint)) searchable.push(entry);
    }
  }

  // Имя есть в стилях, а глифа в шрифте нет — такое имя не найдётся никогда.
  // Молча пропадать оно не должно: снаружи это выглядит как провал распознавания.
  const missing = [...names.entries()]
    .filter(([codePoint]) => !found.has(codePoint))
    .map(([, className]) => className)
    .sort();

  return { total: distinctCodePoints(searchable), missing };
}

export async function search(
  sketchBase64: string,
  width: number,
  height: number,
): Promise<SearchResponse> {
  const started = performance.now();
  const empty: SearchResponse = { results: [], considered: 0, tookMs: 0 };

  const bytes = base64ToBytes(sketchBase64);
  if (bytes.length !== width * height) throw new Error('Некорректный размер наброска');

  const mask = grayToMask(bytes);
  let ink = 0;
  for (let i = 0; i < mask.length; i += 1) ink += mask[i];
  if (ink < 12) return empty;

  // Автоматическая оценка толщины штриха: закрываем разрывы ровно настолько, насколько нужно.
  const strokeWidth = estimateStrokeWidth(mask, width, height);
  const radius = Math.max(1, Math.min(3, Math.round(strokeWidth / 2)));
  const solid = close(mask, width, height, radius);

  const normalized = normalizeMask(solid, width, height, ICON_SIZE, ICON_MARGIN);
  if (!normalized) return empty;

  const features = buildSketchFeatures(normalized.mask, normalized, strokeWidth);

  const fonts = await db.listFonts();
  for (const font of fonts) {
    if (font.indexed) await ensureFontLoaded(font.id);
  }

  const entries: GlyphEntry[] = [];
  for (const list of entriesByFont.values()) {
    for (const entry of list) entries.push(entry);
  }

  if (entries.length === 0) return empty;

  // Если подключён .less со стилями иконок — ищем только по объявленным в нём символам.
  // Это не только ускоряет поиск, но и убирает из выдачи весь мусор шрифта
  // (математические знаки, рамки), который иначе забивает топ.
  const names = await iconNameMap();
  const searchable =
    names.size > 0 ? entries.filter((entry) => names.has(entry.record.codePoint)) : entries;

  if (searchable.length === 0) return empty;

  const { scored } = searchGlyphs(features, searchable);
  return {
    results: buildResults(scored, names),
    considered: distinctCodePoints(searchable),
    tookMs: Math.round(performance.now() - started),
  };
}
