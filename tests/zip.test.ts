import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { inflateRawSync } from 'node:zlib';
import { afterEach, describe, expect, it } from 'vitest';
import { zipDirectory } from '../scripts/zip.ts';

/**
 * Архив релиза пишется руками, поэтому проверяем не «файл создался», а что
 * его можно прочитать: разбираем оглавление и распаковываем записи так же,
 * как это сделал бы любой распаковщик.
 */

interface ReadEntry {
  name: string;
  data: Buffer;
}

/** Минимальный разбор zip: идём по записям оглавления от его конца. */
function readZip(archive: Buffer): ReadEntry[] {
  const endOffset = archive.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  expect(endOffset).toBeGreaterThan(-1);

  const count = archive.readUInt16LE(endOffset + 10);
  let cursor = archive.readUInt32LE(endOffset + 16);
  const entries: ReadEntry[] = [];

  for (let index = 0; index < count; index += 1) {
    expect(archive.readUInt32LE(cursor)).toBe(0x02014b50);
    const nameLength = archive.readUInt16LE(cursor + 28);
    const localOffset = archive.readUInt32LE(cursor + 42);
    const name = archive.toString('utf8', cursor + 46, cursor + 46 + nameLength);

    expect(archive.readUInt32LE(localOffset)).toBe(0x04034b50);
    const storedName = archive.readUInt16LE(localOffset + 26);
    const compressed = archive.readUInt32LE(localOffset + 18);
    const dataStart = localOffset + 30 + storedName;
    const data = inflateRawSync(archive.subarray(dataStart, dataStart + compressed));

    entries.push({ name, data });
    cursor += 46 + nameLength;
  }

  return entries;
}

let workDir: string | null = null;

afterEach(() => {
  if (workDir) rmSync(workDir, { recursive: true, force: true });
  workDir = null;
});

describe('zipDirectory', () => {
  it('пакует вложенные каталоги в архив с папкой в корне', () => {
    workDir = mkdtempSync(join(tmpdir(), 'saby-zip-'));
    const source = join(workDir, 'extension');
    mkdirSync(join(source, 'assets'), { recursive: true });
    writeFileSync(join(source, 'manifest.json'), '{"version":"1"}');
    writeFileSync(join(source, 'assets', 'a.js'), 'console.log(1);'.repeat(50));

    const { files, rawBytes } = zipDirectory(source, join(workDir, 'extension.zip'));
    const entries = readZip(readFileSync(join(workDir, 'extension.zip')));

    expect(files).toBe(2);
    expect(rawBytes).toBe(
      Buffer.byteLength('{"version":"1"}') + Buffer.byteLength('console.log(1);') * 50,
    );
    expect(entries.map((entry) => entry.name)).toEqual([
      'extension/assets/a.js',
      'extension/manifest.json',
    ]);
    expect(entries[1].data.toString('utf8')).toBe('{"version":"1"}');
  });

  it('сохраняет имена файлов в UTF-8', () => {
    workDir = mkdtempSync(join(tmpdir(), 'saby-zip-'));
    const source = join(workDir, 'extension');
    mkdirSync(source, { recursive: true });
    writeFileSync(join(source, 'манифест.txt'), 'данные');

    zipDirectory(source, join(workDir, 'extension.zip'));
    const entries = readZip(readFileSync(join(workDir, 'extension.zip')));

    expect(entries[0].name).toBe('extension/манифест.txt');
    expect(entries[0].data.toString('utf8')).toBe('данные');
  });
});
