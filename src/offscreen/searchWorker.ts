/**
 * Поиск живёт в отдельном потоке.
 *
 * Страницы одного расширения (popup и offscreen-документ) делят процесс и главный поток,
 * поэтому синхронный поиск на 200–400 мс в offscreen-документе подвешивал рисование в popup.
 * Здесь же — построение дескрипторов глифов и подсчёт иконок: всё, что считает много и долго.
 * Воркер сам читает глифы и карту имён из IndexedDB, а об их смене узнаёт сообщением
 * `invalidate`.
 */
import { base64ToBytes } from '../core/image/bits';
import {
  buildResults,
  createGlyphEntry,
  searchGlyphs,
  type GlyphEntry,
} from '../core/matching/matcher';
import { prepareSketch } from '../core/matching/prepare';
import * as db from '../core/store/db';
import type { SearchResponse } from '../shared/messaging';
import { yieldToEventLoop } from '../shared/schedule';
import type { GlyphRecord } from '../shared/types';
import type { IconCount, WorkerReply, WorkerRequest } from './searchProtocol';

const entriesByFont = new Map<string, GlyphEntry[]>();
const pendingLoad = new Map<string, Promise<void>>();
let iconNames: Map<number, string> | null = null;

async function iconNameMap(): Promise<Map<number, string>> {
  if (!iconNames) {
    const entries = await db.getIconMap();
    iconNames = new Map(entries.map((entry) => [entry.codePoint, entry.className]));
  }
  return iconNames;
}

/** Через столько миллисекунд построения дескрипторов отдаём поток. */
const ENTRY_BUILD_YIELD_MS = 8;

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

async function ensureFontLoaded(fontId: string): Promise<void> {
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

async function loadIndexedFonts(): Promise<void> {
  const fonts = await db.listFonts();
  for (const font of fonts) {
    if (font.indexed) await ensureFontLoaded(font.id);
  }
}

function distinctCodePoints(entries: GlyphEntry[]): number {
  return new Set(entries.map((entry) => entry.record.codePoint)).size;
}

async function iconCount(): Promise<IconCount> {
  await loadIndexedFonts();

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
  const missing = [...names.entries()]
    .filter(([codePoint]) => !found.has(codePoint))
    .map(([, className]) => className)
    .sort();

  return { total: distinctCodePoints(searchable), missing };
}

async function search(
  sketchBase64: string,
  width: number,
  height: number,
): Promise<SearchResponse> {
  const started = performance.now();
  const empty: SearchResponse = { results: [], considered: 0, tookMs: 0 };

  const bytes = base64ToBytes(sketchBase64);
  if (bytes.length !== width * height) throw new Error('Некорректный размер наброска');

  const features = prepareSketch(bytes, width, height);
  if (!features) return empty;

  await loadIndexedFonts();

  const entries: GlyphEntry[] = [];
  for (const list of entriesByFont.values()) for (const entry of list) entries.push(entry);
  if (entries.length === 0) return empty;

  // Если подключён .less со стилями иконок — ищем только по объявленным в нём символам:
  // это ускоряет поиск и убирает из выдачи мусор шрифта (математические знаки, рамки).
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

/* ------------------------------ обмен сообщениями ------------------------------ */

function reply(message: WorkerReply): void {
  (self as unknown as { postMessage(value: WorkerReply): void }).postMessage(message);
}

const messageOf = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

type SearchRequest = Extract<WorkerRequest, { type: 'search' }>;

/**
 * Из нескольких поисков, ждущих очереди, нужен только последний: при быстром рисовании
 * наброски сыплются один за другим, и считать устаревшие — значит заставлять ждать свежий.
 */
let pendingSearch: SearchRequest | null = null;
let searchRunning = false;

async function drainSearches(): Promise<void> {
  if (searchRunning) return;
  searchRunning = true;
  try {
    while (pendingSearch) {
      const request: SearchRequest = pendingSearch;
      pendingSearch = null;
      try {
        reply({
          id: request.id,
          result: await search(request.sketch, request.width, request.height),
        });
      } catch (error) {
        reply({ id: request.id, error: messageOf(error) });
      }
    }
  } finally {
    searchRunning = false;
  }
}

self.onmessage = (event: MessageEvent<WorkerRequest>) => {
  const request = event.data;

  switch (request.type) {
    case 'search':
      if (pendingSearch) {
        // Устаревший запрос получает пустой ответ: popup всё равно ждёт только последний.
        reply({ id: pendingSearch.id, result: { results: [], considered: 0, tookMs: 0 } });
      }
      pendingSearch = request;
      void drainSearches();
      return;
    case 'icon-count':
      iconCount().then(
        (result) => reply({ id: request.id, result }),
        (error: unknown) => reply({ id: request.id, error: messageOf(error) }),
      );
      return;
    case 'invalidate':
      if (request.fontId) entriesByFont.delete(request.fontId);
      else entriesByFont.clear();
      iconNames = null;
      reply({ id: request.id, result: true });
      return;
  }
};
