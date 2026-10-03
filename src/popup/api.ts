import { parseLessIcons } from '../core/less/parseLess';
import { getIconMap, getStoredFont, putStoredFont, replaceIconMap } from '../core/store/db';
import { HOST_ORIGINS, familyFor } from '../shared/constants';
import type {
  ErrorResponse,
  FontListResponse,
  FontsChangedPush,
  OkResponse,
  ProgressPush,
  PushMessage,
  SearchResponse,
} from '../shared/messaging';
import { getLocal, removeLocal, setLocal } from '../shared/storage';
import { chromeTransport, getTransport, hasTransport, setTransport } from '../shared/transport';
import type {
  FontMeta,
  FontSourceKind,
  IconEntry,
  LessSourceMeta,
  StoredFont,
  StyleSourceMeta,
} from '../shared/types';
import type { SketchPayload } from './components/SketchCanvas';

// В расширении UI общается с движком через chrome.runtime.
// На отладочном стенде транспорт уже подменён на локальный — не перетираем его.
if (!hasTransport()) setTransport(chromeTransport);

const PENDING_URL_KEY = 'pending-url-request';
const LESS_SOURCE_KEY = 'less-source';
const STYLES_KEY = 'icon-styles';
const SHOW_DEBUG_KEY = 'show-debug-metrics';
const DEFAULTS_FLAG_KEY = 'bundled-defaults-installed';

/**
 * Вшитые в сборку шрифты: лежат в public/defaults и попадают в dist как есть.
 * Ставятся автоматически при первом запуске, чтобы расширение работало
 * сразу после установки. Их может быть несколько — наборы дополняют друг друга.
 */
const BUNDLED_FONTS = [{ url: 'defaults/cbuc-icons.woff2', name: 'cbuc-icons' }] as const;

/**
 * Вшитые файлы, которые больше не входят в поставку.
 *
 * Шрифт `cbuc-icons24.woff2` был в прежних версиях и оказался просто копией
 * `cbuc-icons.woff2` крупнее размером: тот же набор кодпоинтов, оттого в выдаче
 * каждая иконка дублировалась. У тех, кто ставил прежнюю версию, запись осталась
 * в хранилище, поэтому её надо снести — иначе дубли никуда не денутся.
 */
const RETIRED_FONTS = ['defaults/cbuc-icons24.woff2'];
const BUNDLED_GLYPHS_URL = 'defaults/_glyphs.less';
const BUNDLED_GLYPHS_NAME = '_glyphs';
/** Постоянный id вшитого источника стилей: к нему привязано обновление. */
const BUNDLED_STYLE_ID = 'bundled-styles';

/**
 * Вшитые шрифты и стили удалять нельзя: без них расширение остаётся без иконок,
 * а поставить их обратно можно только переустановкой. Панель настроек по этому
 * признаку прячет кнопку «убрать».
 */
export function isBundledSource(sourceValue: string): boolean {
  return (
    sourceValue === BUNDLED_GLYPHS_URL || BUNDLED_FONTS.some((font) => font.url === sourceValue)
  );
}

/** Незавершённое добавление по ссылке: диалог разрешения уводит фокус и закрывает popup. */
export interface PendingUrlRequest {
  kind: 'font' | 'less';
  name: string;
  url: string;
  requestedAt: number;
}

function unwrap<T>(response: T | ErrorResponse): T {
  if (response && typeof response === 'object' && 'error' in response) {
    throw new Error((response as ErrorResponse).error);
  }
  return response as T;
}

/* ------------------------------------------------------------------ */
/* Движок                                                              */
/* ------------------------------------------------------------------ */

export async function ensureEngine(): Promise<void> {
  await getTransport().ensureReady();
}

export function subscribeToEngine(listener: (message: PushMessage) => void): () => void {
  return getTransport().subscribe(listener);
}

export async function fetchFonts(): Promise<FontMeta[]> {
  await ensureEngine();
  const response = unwrap(
    await getTransport().send<FontListResponse | ErrorResponse>({
      target: 'offscreen',
      type: 'list-fonts',
    }),
  );
  return response.fonts;
}

export async function searchSketch(payload: SketchPayload): Promise<SearchResponse> {
  await ensureEngine();
  return unwrap(
    await getTransport().send<SearchResponse | ErrorResponse>({
      target: 'offscreen',
      type: 'search',
      sketch: payload.sketch,
      width: payload.width,
      height: payload.height,
    }),
  );
}

/**
 * Сколько глифов участвует в поиске и какие имена из стилей остались без глифа.
 * Нужно футеру (число видно всегда, а не только после первого наброска) и панели
 * настроек: список «без глифа» объясняет, почему часть иконок не находится.
 */
export async function fetchIconCount(): Promise<{ total: number; missing: string[] }> {
  await ensureEngine();
  return unwrap(
    await getTransport().send<{ total: number; missing: string[] } | ErrorResponse>({
      target: 'offscreen',
      type: 'icon-count',
    }),
  );
}

async function storeAndIndexFont(
  bytes: ArrayBuffer,
  name: string,
  sourceKind: FontSourceKind,
  sourceValue: string,
): Promise<FontMeta> {
  const id = crypto.randomUUID();

  const font: StoredFont = {
    id,
    name,
    family: familyFor(id),
    sourceKind,
    sourceValue,
    glyphCount: 0,
    indexed: false,
    createdAt: Date.now(),
    bytes,
  };

  // Байты кладём в общий IndexedDB сами: гонять их через сообщения незачем.
  await putStoredFont(font);
  await ensureEngine();
  unwrap(
    await getTransport().send<OkResponse | ErrorResponse>({
      target: 'offscreen',
      type: 'index-local-font',
      fontId: id,
    }),
  );

  const { bytes: _bytes, ...meta } = font;
  return meta;
}

export async function addFontFromFile(file: File, name: string): Promise<FontMeta> {
  return storeAndIndexFont(await file.arrayBuffer(), name, 'file', file.name);
}

export async function addFontByUrl(name: string, url: string): Promise<FontMeta> {
  const parsed = new URL(url);
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    throw new Error('Поддерживаются только ссылки http(s)');
  }
  if (canRequestPermissions() && !(await hasHostAccess())) {
    throw new Error('Нет доступа к сайтам — разрешение не выдано');
  }

  await ensureEngine();
  const response = unwrap(
    await getTransport().send<{ font: FontMeta } | ErrorResponse>({
      target: 'offscreen',
      type: 'add-font-url',
      name,
      url,
    }),
  );
  return response.font;
}

export async function removeFont(fontId: string): Promise<void> {
  // Вшитый шрифт — часть поставки: без него расширение останется без иконок,
  // а вернуть его можно только переустановкой. Проверка нужна и здесь, не только
  // в интерфейсе: кнопки для него нет, но вызов может прийти другим путём.
  const font = (await fetchFonts()).find((item) => item.id === fontId);
  if (font && isBundledSource(font.sourceValue)) {
    throw new Error('Встроенный шрифт удалить нельзя');
  }

  await dropFont(fontId);
}

/** Удаляет запись шрифта без проверки на вшитость: нужно обновлению вшитых файлов. */
async function dropFont(fontId: string): Promise<void> {
  await ensureEngine();
  unwrap(
    await getTransport().send<OkResponse | ErrorResponse>({
      target: 'offscreen',
      type: 'remove-font',
      fontId,
    }),
  );
}

/**
 * Заново ставит вшитый шрифт: сносит прежнюю запись и читает файл из поставки.
 *
 * Нужно, когда вшитый набор обновился вместе с расширением или когда индекс
 * в хранилище испортился. Если стили тоже вшитые, они перечитываются вместе
 * со шрифтом: это пара из одной поставки, и расходиться им незачем.
 */
export async function refreshBundledFonts(): Promise<void> {
  const bundled = (await fetchFonts()).filter((font) => isBundledSource(font.sourceValue));
  for (const font of bundled) await dropFont(font.id);

  for (const item of BUNDLED_FONTS) await installBundledFont(item.url, item.name);
}

/** Заново читает вшитые стили иконок. */
export async function refreshBundledGlyphs(): Promise<void> {
  await refreshBundledStyles();
}

/* ------------------------------------------------------------------ */
/* Разрешения на доступ к сайтам                                       */
/* ------------------------------------------------------------------ */

export function canRequestPermissions(): boolean {
  return typeof chrome !== 'undefined' && Boolean(chrome.permissions?.request);
}

/** Проверка «уже разрешено?» — вызывается сразу при открытии popup. */
export async function hasHostAccess(): Promise<boolean> {
  // На отладочном стенде chrome.permissions нет — считаем, что доступ есть.
  if (!canRequestPermissions()) return true;
  return chrome.permissions.contains({ origins: HOST_ORIGINS });
}

/** Запрашивает доступ. Диалог может закрыть popup — см. PendingUrlRequest. */
export async function requestHostAccess(): Promise<boolean> {
  if (!canRequestPermissions()) return true;
  return chrome.permissions.request({ origins: HOST_ORIGINS });
}

export async function setPendingUrl(request: PendingUrlRequest): Promise<void> {
  await setLocal(PENDING_URL_KEY, request);
}

export async function getPendingUrl(): Promise<PendingUrlRequest | undefined> {
  return getLocal<PendingUrlRequest>(PENDING_URL_KEY);
}

export async function clearPendingUrl(): Promise<void> {
  await removeLocal(PENDING_URL_KEY);
}

/* ------------------------------------------------------------------ */
/* Стили иконочного шрифта (.less)                                     */
/* ------------------------------------------------------------------ */

/**
 * Источник стилей: распарсенные правила держим рядом с описанием, чтобы можно было
 * пересобрать общую карту, когда источников станет больше или один из них уберут.
 */
export interface StyleSource extends LessSourceMeta {
  id: string;
  entries: { codePoint: number; className: string }[];
}

function parseStyleText(text: string): { codePoint: number; className: string }[] {
  const parsed = parseLessIcons(text);
  if (parsed.length === 0) {
    throw new Error(
      'Не нашёл ни одного правила вида .icon-Name::before { content: "\\eb7e" } — проверьте файл',
    );
  }
  return parsed.map((item) => ({ codePoint: item.codePoint, className: item.className }));
}

/**
 * Читает список источников стилей. Заодно переносит источник прежних версий, где он
 * был один: его текст не сохранялся, зато в хранилище есть готовая карта с именами.
 */
async function readStyleSources(): Promise<StyleSource[]> {
  const stored = await getLocal<StyleSource[]>(STYLES_KEY);
  if (stored && stored.length > 0) return stored;

  const legacy = await getLocal<LessSourceMeta>(LESS_SOURCE_KEY);
  const map = legacy ? await getIconMap() : [];
  if (!legacy || map.length === 0) return [];

  const source: StyleSource = {
    ...legacy,
    id: crypto.randomUUID(),
    entries: map.map((entry) => ({ codePoint: entry.codePoint, className: entry.className })),
  };
  await setLocal(STYLES_KEY, [source]);
  await removeLocal(LESS_SOURCE_KEY);
  return [source];
}

/**
 * Порядок применения: вшитые источники первыми, свои — после них. Значит, при
 * совпадении кодпоинта побеждает свой файл, а между своими — добавленный позже.
 */
function inApplyOrder(sources: StyleSource[]): StyleSource[] {
  const rank = (source: StyleSource) => (isBundledSource(source.sourceValue) ? 0 : 1);
  return [...sources].sort((a, b) => rank(a) - rank(b) || a.createdAt - b.createdAt);
}

/**
 * Пересобирает общую карту «кодпоинт → имя класса» из всех источников.
 * Пустой список источников карту не трогает: иначе поиск остался бы без имён.
 */
async function rebuildIconMap(): Promise<void> {
  const sources = inApplyOrder(await readStyleSources());
  if (sources.length === 0) return;

  const merged = new Map<number, IconEntry>();
  for (const source of sources) {
    for (const entry of source.entries) {
      merged.set(entry.codePoint, { ...entry, sourceName: source.name });
    }
  }

  await replaceIconMap(Array.from(merged.values()));

  await ensureEngine();
  unwrap(
    await getTransport().send<OkResponse | ErrorResponse>({
      target: 'offscreen',
      type: 'reload-icons',
    }),
  );
}

async function saveStyleSources(sources: StyleSource[]): Promise<void> {
  await setLocal(STYLES_KEY, sources);
  await rebuildIconMap();
}

export async function getStyleSources(): Promise<StyleSourceMeta[]> {
  return readStyleSources();
}

/** Добавляет источник стилей. Свои файлы дополняют вшитые, а не заменяют их. */
export async function addStyleSource(
  text: string,
  name: string,
  sourceKind: FontSourceKind,
  sourceValue: string,
): Promise<StyleSourceMeta> {
  const entries = parseStyleText(text);
  const sources = await readStyleSources();

  // Повторно добавленный тот же файл заменяет прежнюю версию, а не дублируется.
  const existing = sources.find((source) => source.sourceValue === sourceValue);
  const meta = { name, sourceKind, sourceValue, iconCount: entries.length, createdAt: Date.now() };
  const source: StyleSource = existing
    ? { ...existing, ...meta, entries }
    : { ...meta, id: crypto.randomUUID(), entries };

  await saveStyleSources(
    existing
      ? sources.map((item) => (item.id === existing.id ? source : item))
      : [...sources, source],
  );
  return { id: source.id, ...meta };
}

export async function addStyleFromFile(file: File, name: string): Promise<StyleSourceMeta> {
  return addStyleSource(await file.text(), name, 'file', file.name);
}

export async function addStyleByUrl(name: string, url: string): Promise<StyleSourceMeta> {
  const parsed = new URL(url);
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    throw new Error('Поддерживаются только ссылки http(s)');
  }
  if (canRequestPermissions() && !(await hasHostAccess())) {
    throw new Error('Нет доступа к сайтам — разрешение не выдано');
  }

  const response = await fetch(url);
  if (!response.ok) throw new Error(`Не удалось скачать стили: HTTP ${response.status}`);
  return addStyleSource(await response.text(), name, 'url', url);
}

/** Убирает один источник стилей. Вшитый убрать нельзя — только обновить. */
export async function removeStyleSource(id: string): Promise<void> {
  const sources = await readStyleSources();
  const source = sources.find((item) => item.id === id);
  if (source && isBundledSource(source.sourceValue)) {
    throw new Error('Встроенные стили удалить нельзя');
  }

  await saveStyleSources(sources.filter((item) => item.id !== id));
}

/** Перечитывает вшитые стили из поставки: установка при первом запуске и обновление. */
export async function refreshBundledStyles(): Promise<void> {
  const response = await fetch(BUNDLED_GLYPHS_URL);
  if (!response.ok) {
    throw new Error(`Не удалось прочитать встроенные стили: HTTP ${response.status}`);
  }
  const entries = parseStyleText(await response.text());

  const sources = await readStyleSources();
  const bundled = sources.find((source) => source.sourceValue === BUNDLED_GLYPHS_URL);
  const meta = {
    name: BUNDLED_GLYPHS_NAME,
    sourceKind: 'file' as FontSourceKind,
    sourceValue: BUNDLED_GLYPHS_URL,
    iconCount: entries.length,
    createdAt: bundled?.createdAt ?? Date.now(),
  };
  const source: StyleSource = bundled
    ? { ...bundled, ...meta, entries }
    : { ...meta, id: BUNDLED_STYLE_ID, entries };

  // Вшитый источник — база, поэтому он всегда идёт первым в списке.
  await saveStyleSources(
    bundled
      ? sources.map((item) => (item.id === bundled.id ? source : item))
      : [source, ...sources],
  );
}

/* ------------------------------------------------------------------ */
/* Показ настоящих символов в popup                                    */
/* ------------------------------------------------------------------ */

const popupFonts = new Set<string>();
const popupFontPending = new Map<string, Promise<boolean>>();

/**
 * Регистрирует шрифт в самом popup. Движок растеризует глифы в offscreen-документе,
 * но чтобы показать пользователю настоящий символ, а не бинарную маску,
 * шрифт должен быть доступен и здесь. Байты берём из общего IndexedDB.
 */
export async function ensurePopupFont(fontId: string, family: string): Promise<boolean> {
  if (popupFonts.has(fontId)) return true;

  const pending = popupFontPending.get(fontId);
  if (pending) return pending;

  const task = (async () => {
    try {
      const stored = await getStoredFont(fontId);
      if (!stored) return false;
      const face = new FontFace(family, stored.bytes);
      await face.load();
      document.fonts.add(face);
      popupFonts.add(fontId);
      return true;
    } catch {
      return false;
    }
  })();

  popupFontPending.set(fontId, task);
  try {
    return await task;
  } finally {
    popupFontPending.delete(fontId);
  }
}

/* ------------------------------------------------------------------ */
/* Настройки                                                           */
/* ------------------------------------------------------------------ */

/** Читает вшитый шрифт из поставки и кладёт его в хранилище вместе с индексом. */
async function installBundledFont(url: string, name: string): Promise<void> {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Не удалось прочитать встроенный шрифт: HTTP ${response.status}`);
  }
  await storeAndIndexFont(await response.arrayBuffer(), name, 'file', url);
}

/**
 * Ставит вшитые шрифты и стили при первом запуске и починяет половинчатые состояния.
 *
 * Иконки и глифы обязаны быть всегда: если хранилище почистили или браузер вытеснил
 * базу, расширение оставалось с пустыми «Глифы» и «Шрифт иконок», и поиск не работал.
 * Поэтому проверяем не флаг установки, а наличие самих файлов: флаг говорит лишь
 * о том, что пользователь уже видел расширение, а не о том, что файлы на месте.
 *
 * Пользовательский выбор при этом не трогаем: свои шрифты остаются, вшитые
 * добавляются к ним. Стили — исключение: вшитые нужны как основа, потому что без них
 * поиск идёт по всем глифам шрифта и в выдачу лезут эмодзи и рамки.
 *
 * @returns true, если что-то было установлено.
 */
export async function installBundledDefaults(): Promise<boolean> {
  const fonts = await fetchFonts();
  const installed = await getLocal<boolean>(DEFAULTS_FLAG_KEY);
  // Свои шрифты не трогаем: вшитые ставим на первом запуске или когда их стёрли.
  const canInstallFonts = installed || fonts.length === 0;

  let changed = false;

  // Файлы, выпавшие из поставки, убираем всегда: на состояние хранилища они
  // не смотрят, иначе прежний дубль остался бы у пользователя навсегда.
  for (const font of fonts) {
    if (!RETIRED_FONTS.includes(font.sourceValue)) continue;
    await dropFont(font.id);
    changed = true;
  }

  for (const bundled of BUNDLED_FONTS) {
    if (fonts.some((font) => font.sourceValue === bundled.url)) continue;
    if (!canInstallFonts) continue;
    await installBundledFont(bundled.url, bundled.name);
    changed = true;
  }

  const sources = await readStyleSources();
  if (!sources.some((source) => source.sourceValue === BUNDLED_GLYPHS_URL)) {
    await refreshBundledStyles();
    changed = true;
  }

  if (changed || installed) await setLocal(DEFAULTS_FLAG_KEY, true);
  return changed;
}

export async function getShowDebug(): Promise<boolean> {
  return (await getLocal<boolean>(SHOW_DEBUG_KEY)) ?? false;
}

/** Пересобирает индекс шрифтов, разобранных старой версией сканера. */
export async function reindexOutdatedFonts(): Promise<number> {
  await ensureEngine();
  const response = unwrap(
    await getTransport().send<{ reindexed: number } | ErrorResponse>({
      target: 'offscreen',
      type: 'reindex-fonts',
    }),
  );
  return response.reindexed;
}

export async function setShowDebug(value: boolean): Promise<void> {
  await setLocal(SHOW_DEBUG_KEY, value);
}

/* ------------------------------------------------------------------ */
/* Push-события от движка                                              */
/* ------------------------------------------------------------------ */

export function isProgressPush(message: unknown): message is ProgressPush {
  return (
    typeof message === 'object' &&
    message !== null &&
    (message as { target?: unknown }).target === 'popup' &&
    (message as { type?: unknown }).type === 'progress'
  );
}

export function isFontsChangedPush(message: unknown): message is FontsChangedPush {
  return (
    typeof message === 'object' &&
    message !== null &&
    (message as { target?: unknown }).target === 'popup' &&
    (message as { type?: unknown }).type === 'fonts-changed'
  );
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
