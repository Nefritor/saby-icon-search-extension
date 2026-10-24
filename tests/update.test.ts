import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { zipDirectory } from '../scripts/zip.ts';
import { compareVersions, parseRelease, parseVersion } from '../src/shared/update';
import { isSafeEntryName, readZip } from '../src/shared/zipRead';

describe('версии', () => {
  it('вытаскивает числа из тега', () => {
    expect(parseVersion('v1.2.3')).toEqual([1, 2, 3]);
    expect(parseVersion('Saby Icon Search v 1.0.0')).toEqual([1, 0, 0]);
    expect(parseVersion('latest')).toBeNull();
  });

  it('сравнивает по разрядам, а не по строкам', () => {
    expect(compareVersions('1.10.0', '1.9.9')).toBeGreaterThan(0);
    expect(compareVersions('1.0.0', '1.0.1')).toBeLessThan(0);
    expect(compareVersions('v2.0', '2.0.0')).toBe(0);
    expect(compareVersions('abc', '1.0.0')).toBe(0);
  });
});

describe('parseRelease', () => {
  const release = {
    tag_name: 'v1.1.0',
    body: 'Что нового',
    html_url: 'https://github.com/o/r/releases/tag/v1.1.0',
    assets: [
      { name: 'source.zip', url: 'https://api/1', size: 1 },
      {
        name: 'saby-icon-search-extension.zip',
        url: 'https://api/2',
        size: 460311,
        digest: 'sha256:ab',
      },
    ],
  };

  it('выбирает архив расширения среди файлов', () => {
    const parsed = parseRelease(release);
    expect(parsed?.version).toBe('1.1.0');
    expect(parsed?.asset?.apiUrl).toBe('https://api/2');
    expect(parsed?.asset?.digest).toBe('sha256:ab');
  });

  it('отбрасывает черновики и предрелизы', () => {
    expect(parseRelease({ ...release, draft: true })).toBeNull();
    expect(parseRelease({ ...release, prerelease: true })).toBeNull();
  });

  it('переживает релиз без файлов и мусор в ответе', () => {
    expect(parseRelease({ ...release, assets: [] })?.asset).toBeNull();
    expect(parseRelease(null)).toBeNull();
    expect(parseRelease({ tag_name: 'nightly' })).toBeNull();
  });
});

describe('isSafeEntryName', () => {
  it('пропускает обычные пути и режет выход из папки', () => {
    expect(isSafeEntryName('assets/popup-1.js')).toBe(true);
    expect(isSafeEntryName('../evil.js')).toBe(false);
    expect(isSafeEntryName('a/../../b')).toBe(false);
    expect(isSafeEntryName('/etc/passwd')).toBe(false);
    expect(isSafeEntryName('C:/x')).toBe(false);
    expect(isSafeEntryName('a\\b')).toBe(false);
  });
});

let workDir: string | null = null;

afterEach(() => {
  if (workDir) rmSync(workDir, { recursive: true, force: true });
  workDir = null;
});

describe('readZip', () => {
  it('читает архив, который пишет сборка релиза', async () => {
    workDir = mkdtempSync(join(tmpdir(), 'saby-unzip-'));
    const source = join(workDir, 'ext');
    mkdirSync(join(source, 'assets'), { recursive: true });
    writeFileSync(join(source, 'manifest.json'), '{"version":"1.2.3"}');
    writeFileSync(join(source, 'assets', 'a.js'), 'console.log("привет");'.repeat(40));
    writeFileSync(join(source, 'assets', 'b.bin'), Buffer.from([0, 1, 2, 255, 254]));
    const zipPath = join(workDir, 'ext.zip');
    zipDirectory(source, zipPath);

    const archive = readFileSync(zipPath);
    const entries = await readZip(
      archive.buffer.slice(archive.byteOffset, archive.byteOffset + archive.byteLength),
    );

    expect(entries.map((entry) => entry.name)).toEqual([
      'assets/a.js',
      'assets/b.bin',
      'manifest.json',
    ]);
    const byName = new Map(entries.map((entry) => [entry.name, entry.data]));
    expect(new TextDecoder().decode(byName.get('manifest.json'))).toBe('{"version":"1.2.3"}');
    expect([...(byName.get('assets/b.bin') ?? [])]).toEqual([0, 1, 2, 255, 254]);
  });

  it('замечает повреждённые данные и не-архивы', async () => {
    workDir = mkdtempSync(join(tmpdir(), 'saby-unzip-'));
    const source = join(workDir, 'ext');
    mkdirSync(source);
    writeFileSync(join(source, 'x.txt'), 'hello world hello world hello world');
    const zipPath = join(workDir, 'ext.zip');
    zipDirectory(source, zipPath);

    const archive = Buffer.from(readFileSync(zipPath));
    // Портим байт внутри сжатых данных (после 30-байтного заголовка и имени).
    archive[30 + 'x.txt'.length + 2] ^= 0xff;
    await expect(
      readZip(archive.buffer.slice(archive.byteOffset, archive.byteOffset + archive.byteLength)),
    ).rejects.toThrow();

    await expect(
      readZip(new TextEncoder().encode('not a zip at all, definitely').buffer),
    ).rejects.toThrow('zip');
  });
});
