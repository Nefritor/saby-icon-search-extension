import { registerFont, scanFont, unregisterFont } from '../core/fonts/glyphScan';
import { inkCount } from '../core/image/binarize';
import * as db from '../core/store/db';
import { GLYPH_INDEX_VERSION, familyFor } from '../shared/constants';
import type { SearchResponse } from '../shared/messaging';
import { getTransport } from '../shared/transport';
import type { FontMeta, GlyphRecord, StoredFont } from '../shared/types';
import { iconCountInWorker, invalidateSearch, searchInWorker } from './searchClient';
import type { IconCount } from './searchProtocol';

/**
 * Движок: индексация шрифтов (растеризация глифов в IndexedDB) и вход для поиска.
 * Сам поиск и дескрипторы глифов считает воркер (см. searchWorker.ts): иначе тяжёлый
 * расчёт блокировал бы главный поток, общий с popup.
 */

export type { IconCount };

/** Сбросить кеш поиска после того, как popup заменил .less. */
export async function reloadIcons(): Promise<void> {
  await invalidateSearch();
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
    try {
      await indexFont(font.id);
      reindexed += 1;
    } catch {
      // Битый шрифт не должен ломать запуск: о нём сообщит поиск.
    }
  }

  return reindexed;
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
  // Воркер перестроит дескрипторы при ближайшем поиске.
  await invalidateSearch(fontId);
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
  await db.deleteFont(fontId);
  await invalidateSearch(fontId);
  notifyFontsChanged();
}

/**
 * Сколько глифов реально участвует в поиске: объявленные в .less и найденные в шрифте.
 * Считается без наброска, поэтому попадает в футер сразу при открытии popup.
 */
export function iconCount(): Promise<IconCount> {
  return iconCountInWorker();
}

export function search(
  sketchBase64: string,
  width: number,
  height: number,
): Promise<SearchResponse> {
  return searchInWorker(sketchBase64, width, height);
}
