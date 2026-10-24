import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { zipDirectory } from '../scripts/zip.ts';
import { UpdateError, installArchive } from '../src/update/installer';

/**
 * Папку расширения подменяет бумажный двойник File System Access API: ровно те вызовы,
 * которыми пользуется установщик. Проверяем порядок записи, чистку старых файлов и отказы.
 */

class FakeFile {
  constructor(public text: string) {}
  getFile = async () => ({ text: async () => this.text });
  createWritable = async () => ({
    write: async (data: Uint8Array | string) => {
      this.text = typeof data === 'string' ? data : new TextDecoder().decode(data);
    },
    close: async () => {
      writes.push(this.name);
    },
  });
  name = '';
}

class FakeDir {
  kind = 'directory' as const;
  files = new Map<string, FakeFile>();
  dirs = new Map<string, FakeDir>();
  constructor(public name = '') {}

  queryPermission = async () => 'granted' as const;
  requestPermission = async () => 'granted' as const;

  getFileHandle = async (name: string, options?: { create?: boolean }) => {
    let file = this.files.get(name);
    if (!file) {
      if (!options?.create) throw new DOMException('нет файла', 'NotFoundError');
      file = new FakeFile('');
      file.name = name;
      this.files.set(name, file);
    }
    return file;
  };

  getDirectoryHandle = async (name: string, options?: { create?: boolean }) => {
    let dir = this.dirs.get(name);
    if (!dir) {
      if (!options?.create) throw new DOMException('нет папки', 'NotFoundError');
      dir = new FakeDir(name);
      this.dirs.set(name, dir);
    }
    return dir;
  };

  removeEntry = async (name: string) => {
    this.files.delete(name);
  };

  async *[Symbol.asyncIterator](): AsyncGenerator<[string, { kind: 'file' | 'directory' }]> {
    for (const name of this.files.keys()) yield [name, { kind: 'file' }];
    for (const name of this.dirs.keys()) yield [name, { kind: 'directory' }];
  }

  put(path: string, text: string): void {
    const parts = path.split('/');
    const fileName = parts.pop() as string;
    let dir: FakeDir = this;
    for (const part of parts) {
      if (!dir.dirs.has(part)) dir.dirs.set(part, new FakeDir(part));
      dir = dir.dirs.get(part) as FakeDir;
    }
    const file = new FakeFile(text);
    file.name = fileName;
    dir.files.set(fileName, file);
  }
}

/** Порядок завершённых записей — чтобы проверить, что manifest.json идёт последним. */
let writes: string[] = [];
let workDir: string | null = null;

afterEach(() => {
  if (workDir) rmSync(workDir, { recursive: true, force: true });
  workDir = null;
  writes = [];
});

function buildArchive(manifest: object, files: Record<string, string>): ArrayBuffer {
  workDir = mkdtempSync(join(tmpdir(), 'saby-install-'));
  const source = join(workDir, 'ext');
  mkdirSync(join(source, 'assets'), { recursive: true });
  writeFileSync(join(source, 'manifest.json'), JSON.stringify(manifest));
  for (const [name, text] of Object.entries(files)) writeFileSync(join(source, name), text);
  const zipPath = join(workDir, 'ext.zip');
  zipDirectory(source, zipPath);
  const bytes = readFileSync(zipPath);
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
}

function installedFolder(): FakeDir {
  const folder = new FakeDir('ext');
  folder.put('manifest.json', JSON.stringify({ name: 'Saby Icon Search', version: '1.0.0' }));
  folder.put('assets/old-123.js', 'старый бандл');
  folder.put('popup.html', 'старая страница');
  return folder;
}

const expected = { name: 'Saby Icon Search', version: '1.0.0' };

describe('installArchive', () => {
  it('заменяет файлы, убирает устаревшие бандлы и пишет manifest.json последним', async () => {
    const archive = buildArchive(
      { name: 'Saby Icon Search', version: '1.1.0' },
      { 'popup.html': 'новая страница', 'assets/new-456.js': 'новый бандл' },
    );
    const folder = installedFolder();

    await installArchive({
      folder: folder as unknown as FileSystemDirectoryHandle,
      archive,
      expected,
      releaseVersion: '1.1.0',
    });

    expect(folder.files.get('popup.html')?.text).toBe('новая страница');
    const assets = folder.dirs.get('assets') as FakeDir;
    expect(assets.files.get('new-456.js')?.text).toBe('новый бандл');
    expect(assets.files.has('old-123.js')).toBe(false);
    expect(JSON.parse(folder.files.get('manifest.json')?.text ?? '{}').version).toBe('1.1.0');
    expect(writes.at(-1)).toBe('manifest.json');
  });

  it('отказывает, если выбрана не папка этого расширения', async () => {
    const archive = buildArchive({ name: 'Saby Icon Search', version: '1.1.0' }, {});
    const folder = new FakeDir('Downloads');
    folder.put('manifest.json', JSON.stringify({ name: 'Другое расширение', version: '1.0.0' }));

    await expect(
      installArchive({
        folder: folder as unknown as FileSystemDirectoryHandle,
        archive,
        expected,
        releaseVersion: '1.1.0',
      }),
    ).rejects.toBeInstanceOf(UpdateError);
    expect(writes).toEqual([]);
  });

  it('не трогает папку, если версия в архиве не совпала с релизом', async () => {
    const archive = buildArchive({ name: 'Saby Icon Search', version: '1.0.5' }, {});
    const folder = installedFolder();

    await expect(
      installArchive({
        folder: folder as unknown as FileSystemDirectoryHandle,
        archive,
        expected,
        releaseVersion: '1.1.0',
      }),
    ).rejects.toThrow('не совпадает');
    expect(folder.files.get('popup.html')?.text).toBe('старая страница');
  });
});
