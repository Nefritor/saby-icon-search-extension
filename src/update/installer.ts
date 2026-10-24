import { openDB } from 'idb';
import { readZip, type ZipEntry } from '../shared/zipRead';
import type { ReleaseAsset } from '../shared/update';

/**
 * Установка обновления поверх распакованного расширения.
 *
 * Chrome сам обновляет только расширения из магазина. Распакованное он читает из папки на
 * диске, поэтому обновить его можно одним способом — заменить файлы в этой папке и
 * перезагрузить расширение. Писать на диск странице позволяет File System Access API:
 * пользователь один раз выбирает папку расширения, дальше доступ к ней запоминается.
 */

/** Нужные нам части API: в стандартных типах DOM их пока нет. */
interface PermissionAwareHandle extends FileSystemDirectoryHandle {
  queryPermission(descriptor: { mode: 'readwrite' }): Promise<PermissionState>;
  requestPermission(descriptor: { mode: 'readwrite' }): Promise<PermissionState>;
}

type DirectoryPicker = (options: {
  id?: string;
  mode?: 'readwrite';
}) => Promise<FileSystemDirectoryHandle>;

const DB_NAME = 'saby-update';
const HANDLE_KEY = 'extension-folder';

/** Сбой на понятном пользователю шаге: текст ошибки можно показывать как есть. */
export class UpdateError extends Error {}

export function isFolderAccessSupported(): boolean {
  return typeof (window as { showDirectoryPicker?: unknown }).showDirectoryPicker === 'function';
}

async function handleStore() {
  return openDB(DB_NAME, 1, {
    upgrade(db) {
      db.createObjectStore('handles');
    },
  });
}

export async function loadSavedFolder(): Promise<FileSystemDirectoryHandle | null> {
  try {
    const db = await handleStore();
    return ((await db.get('handles', HANDLE_KEY)) as FileSystemDirectoryHandle | undefined) ?? null;
  } catch {
    return null;
  }
}

async function saveFolder(handle: FileSystemDirectoryHandle): Promise<void> {
  const db = await handleStore();
  await db.put('handles', handle, HANDLE_KEY);
}

export async function forgetFolder(): Promise<void> {
  const db = await handleStore();
  await db.delete('handles', HANDLE_KEY);
}

/** Диалог выбора папки. Вызывать нужно из обработчика клика: иначе браузер откажет. */
export async function pickFolder(): Promise<FileSystemDirectoryHandle> {
  const picker = (window as unknown as { showDirectoryPicker: DirectoryPicker })
    .showDirectoryPicker;
  try {
    return await picker({ id: 'saby-icon-search', mode: 'readwrite' });
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') {
      throw new UpdateError('Выбор папки отменён');
    }
    throw error;
  }
}

async function ensureWritable(handle: FileSystemDirectoryHandle): Promise<void> {
  const aware = handle as PermissionAwareHandle;
  if ((await aware.queryPermission({ mode: 'readwrite' })) === 'granted') return;
  if ((await aware.requestPermission({ mode: 'readwrite' })) !== 'granted') {
    throw new UpdateError('Нет доступа на запись в папку расширения');
  }
}

async function readJson(dir: FileSystemDirectoryHandle, name: string): Promise<unknown> {
  const file = await (await dir.getFileHandle(name)).getFile();
  return JSON.parse(await file.text());
}

/**
 * Убеждаемся, что выбрана именно папка этого расширения: в ней лежит manifest.json
 * с тем же именем и версией, что у работающего сейчас. Без проверки неверный выбор
 * (например, «Загрузки») закончился бы россыпью чужих файлов и пустым расширением.
 */
export async function verifyFolder(
  dir: FileSystemDirectoryHandle,
  expected: { name: string; version: string },
): Promise<void> {
  let manifest: { name?: unknown; version?: unknown };
  try {
    manifest = (await readJson(dir, 'manifest.json')) as typeof manifest;
  } catch {
    throw new UpdateError(
      'В выбранной папке нет manifest.json — нужна папка, загруженная в Chrome',
    );
  }
  if (manifest.name !== expected.name || manifest.version !== expected.version) {
    throw new UpdateError(
      `Это не папка установленного расширения (в ней «${String(manifest.name)}» ${String(manifest.version)})`,
    );
  }
}

/** Скачивает архив релиза и сверяет контрольную сумму, если GitHub её отдал. */
export async function downloadAsset(
  asset: ReleaseAsset,
  onProgress?: (received: number, total: number) => void,
): Promise<ArrayBuffer> {
  const response = await fetch(asset.apiUrl, { headers: { Accept: 'application/octet-stream' } });
  if (!response.ok || !response.body) {
    throw new UpdateError(`Не удалось скачать архив: HTTP ${response.status}`);
  }

  const total = Number(response.headers.get('content-length')) || asset.size;
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let received = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    received += value.length;
    onProgress?.(received, total);
  }

  const bytes = new Uint8Array(received);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }

  const expected = /^sha256:([0-9a-f]{64})$/i.exec(asset.digest ?? '')?.[1];
  if (expected) {
    const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
    const actual = Array.from(digest, (byte) => byte.toString(16).padStart(2, '0')).join('');
    if (actual !== expected.toLowerCase()) {
      throw new UpdateError('Контрольная сумма архива не совпала — скачивание повреждено');
    }
  }
  return bytes.buffer;
}

async function writeFile(root: FileSystemDirectoryHandle, entry: ZipEntry): Promise<void> {
  const parts = entry.name.split('/');
  const fileName = parts.pop() as string;
  let dir = root;
  for (const part of parts) dir = await dir.getDirectoryHandle(part, { create: true });

  const writable = await (await dir.getFileHandle(fileName, { create: true })).createWritable();
  await writable.write(entry.data as unknown as FileSystemWriteChunkType);
  await writable.close();
}

/** Прежние файлы в assets/ с хешами в именах: после обновления они лишние. */
async function removeStaleAssets(
  root: FileSystemDirectoryHandle,
  keep: Set<string>,
): Promise<void> {
  let assets: FileSystemDirectoryHandle;
  try {
    assets = await root.getDirectoryHandle('assets');
  } catch {
    return;
  }
  const names: string[] = [];
  for await (const [name, handle] of assets as unknown as AsyncIterable<
    [string, FileSystemHandle]
  >) {
    if (handle.kind === 'file' && !keep.has(`assets/${name}`)) names.push(name);
  }
  for (const name of names) await assets.removeEntry(name).catch(() => undefined);
}

export interface InstallOptions {
  folder: FileSystemDirectoryHandle;
  archive: ArrayBuffer;
  expected: { name: string; version: string };
  /** Версия, которую обещал релиз: сверяется с манифестом из архива. */
  releaseVersion: string;
  onStep?: (step: 'verify' | 'unpack' | 'write') => void;
}

/**
 * Заменяет файлы расширения содержимым архива. manifest.json пишется последним:
 * если запись оборвётся на середине, в папке останется прежняя версия в манифесте,
 * и проверка покажет, что обновление всё ещё доступно, — его можно повторить.
 */
export async function installArchive(options: InstallOptions): Promise<void> {
  const { folder, archive, expected, releaseVersion, onStep } = options;

  onStep?.('verify');
  await ensureWritable(folder);
  await verifyFolder(folder, expected);

  onStep?.('unpack');
  const entries = await readZip(archive);
  const manifestEntry = entries.find((entry) => entry.name === 'manifest.json');
  if (!manifestEntry)
    throw new UpdateError('В архиве нет manifest.json — это не сборка расширения');

  const incoming = JSON.parse(new TextDecoder().decode(manifestEntry.data)) as {
    name?: unknown;
    version?: unknown;
  };
  if (incoming.name !== expected.name) {
    throw new UpdateError('Архив относится к другому расширению');
  }
  if (incoming.version !== releaseVersion) {
    throw new UpdateError(
      `Версия в архиве (${String(incoming.version)}) не совпадает с релизом (${releaseVersion})`,
    );
  }

  onStep?.('write');
  // Запомнить папку — удобство на следующий раз, а не условие обновления.
  await saveFolder(folder).catch(() => undefined);
  const rest = entries.filter((entry) => entry !== manifestEntry);
  for (const entry of rest) await writeFile(folder, entry);
  await removeStaleAssets(folder, new Set(entries.map((entry) => entry.name)));
  await writeFile(folder, manifestEntry);
}
