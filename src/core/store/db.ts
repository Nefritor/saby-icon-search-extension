import { openDB, type DBSchema, type IDBPDatabase } from 'idb';
import type { FontMeta, GlyphRecord, IconEntry, StoredFont } from '../../shared/types';

interface IconMatcherDB extends DBSchema {
  fonts: { key: string; value: StoredFont };
  glyphs: { key: string; value: GlyphRecord; indexes: { 'by-font': string } };
  icons: { key: number; value: IconEntry };
}

const DB_NAME = 'icon-matcher';
/** v2: добавлено хранилище соответствий «кодпоинт → имя класса» из .less. */
const DB_VERSION = 2;

let dbPromise: Promise<IDBPDatabase<IconMatcherDB>> | null = null;

export function getDb(): Promise<IDBPDatabase<IconMatcherDB>> {
  if (!dbPromise) {
    dbPromise = openDB<IconMatcherDB>(DB_NAME, DB_VERSION, {
      upgrade(db) {
        if (!db.objectStoreNames.contains('fonts')) {
          db.createObjectStore('fonts', { keyPath: 'id' });
        }
        if (!db.objectStoreNames.contains('glyphs')) {
          const store = db.createObjectStore('glyphs', { keyPath: 'id' });
          store.createIndex('by-font', 'fontId');
        }
        if (!db.objectStoreNames.contains('icons')) {
          db.createObjectStore('icons', { keyPath: 'codePoint' });
        }
      },
    });
  }
  return dbPromise;
}

export function stripBytes(font: StoredFont): FontMeta {
  const { bytes: _bytes, ...meta } = font;
  return meta;
}

export async function listFonts(): Promise<FontMeta[]> {
  const db = await getDb();
  const fonts = await db.getAll('fonts');
  return fonts.map(stripBytes).sort((a, b) => a.createdAt - b.createdAt);
}

export async function getStoredFont(id: string): Promise<StoredFont | undefined> {
  const db = await getDb();
  return db.get('fonts', id);
}

export async function putStoredFont(font: StoredFont): Promise<void> {
  const db = await getDb();
  await db.put('fonts', font);
}

export async function patchFont(id: string, patch: Partial<FontMeta>): Promise<void> {
  const db = await getDb();
  const transaction = db.transaction('fonts', 'readwrite');
  const current = await transaction.store.get(id);
  if (current) await transaction.store.put({ ...current, ...patch });
  await transaction.done;
}

export async function deleteFont(id: string): Promise<void> {
  const db = await getDb();
  const transaction = db.transaction(['fonts', 'glyphs'], 'readwrite');
  await transaction.objectStore('fonts').delete(id);

  const index = transaction.objectStore('glyphs').index('by-font');
  let cursor = await index.openCursor(IDBKeyRange.only(id));
  while (cursor) {
    await cursor.delete();
    cursor = await cursor.continue();
  }

  await transaction.done;
}

export async function putGlyphs(glyphs: GlyphRecord[]): Promise<void> {
  if (glyphs.length === 0) return;
  const db = await getDb();
  const transaction = db.transaction('glyphs', 'readwrite');
  for (const glyph of glyphs) transaction.store.put(glyph);
  await transaction.done;
}

export async function getGlyphsByFont(fontId: string): Promise<GlyphRecord[]> {
  const db = await getDb();
  return db.getAllFromIndex('glyphs', 'by-font', IDBKeyRange.only(fontId));
}

/** Чистит индекс шрифта перед пересборкой: иначе в базе останутся мёртвые кодпоинты. */
export async function deleteGlyphsByFont(fontId: string): Promise<void> {
  const db = await getDb();
  const transaction = db.transaction('glyphs', 'readwrite');
  const index = transaction.store.index('by-font');
  let cursor = await index.openCursor(IDBKeyRange.only(fontId));
  while (cursor) {
    await cursor.delete();
    cursor = await cursor.continue();
  }
  await transaction.done;
}

/* ------------------------------------------------------------------ */
/* Соответствия из .less                                               */
/* ------------------------------------------------------------------ */

/** Полностью заменяет карту иконок: активный .less всегда один. */
export async function replaceIconMap(entries: IconEntry[]): Promise<void> {
  const db = await getDb();
  const transaction = db.transaction('icons', 'readwrite');
  await transaction.store.clear();
  for (const entry of entries) transaction.store.put(entry);
  await transaction.done;
}

export async function getIconMap(): Promise<IconEntry[]> {
  const db = await getDb();
  return db.getAll('icons');
}

export async function clearIconMap(): Promise<void> {
  const db = await getDb();
  await db.clear('icons');
}

export async function clearAll(): Promise<void> {
  const db = await getDb();
  await db.clear('glyphs');
  await db.clear('fonts');
}
