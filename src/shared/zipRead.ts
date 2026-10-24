/**
 * Чтение zip-архива в браузере — без зависимостей.
 *
 * Нужно обновлению: архив релиза скачивается и распаковывается прямо в расширении.
 * Формат тот, что пишет `scripts/zip.ts` (и любой обычный упаковщик): один диск,
 * хранение или deflate, без Zip64 и шифрования. Распаковку делает сам браузер
 * через `DecompressionStream`.
 */

export interface ZipEntry {
  /** Путь внутри архива, всегда через прямой слэш. */
  name: string;
  data: Uint8Array;
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let index = 0; index < 256; index += 1) {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1) {
      value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    }
    table[index] = value >>> 0;
  }
  return table;
})();

export function crc32(data: Uint8Array): number {
  let crc = 0xffffffff;
  for (let i = 0; i < data.length; i += 1) {
    crc = CRC_TABLE[(crc ^ data[i]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

async function inflateRaw(compressed: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([compressed as BlobPart])
    .stream()
    .pipeThrough(new DecompressionStream('deflate-raw'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/**
 * Имя записи должно остаться внутри целевой папки. Архив приходит из сети,
 * поэтому `../x`, абсолютные пути и обратные слэши (на Windows это разделитель)
 * отвергаются, а не «исправляются»: честный архив расширения такого не содержит.
 */
export function isSafeEntryName(name: string): boolean {
  if (name === '' || name.includes('\\') || name.includes('\0')) return false;
  if (name.startsWith('/') || /^[a-zA-Z]:/.test(name)) return false;
  return name.split('/').every((part) => part !== '..' && part !== '.');
}

/** Разбирает архив целиком в память. Каталоги пропускаются, целостность проверяется по CRC-32. */
export async function readZip(buffer: ArrayBuffer): Promise<ZipEntry[]> {
  const bytes = new Uint8Array(buffer);
  const view = new DataView(buffer);
  const decoder = new TextDecoder();

  // Конец оглавления ищем с хвоста: после него может идти комментарий до 64 КБ.
  let end = -1;
  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 22 - 0xffff); i -= 1) {
    if (view.getUint32(i, true) === 0x06054b50) {
      end = i;
      break;
    }
  }
  if (end < 0) throw new Error('Это не zip-архив');

  const count = view.getUint16(end + 10, true);
  let cursor = view.getUint32(end + 16, true);
  const entries: ZipEntry[] = [];

  for (let index = 0; index < count; index += 1) {
    if (view.getUint32(cursor, true) !== 0x02014b50)
      throw new Error('Повреждено оглавление архива');

    const flags = view.getUint16(cursor + 8, true);
    const method = view.getUint16(cursor + 10, true);
    const crc = view.getUint32(cursor + 16, true);
    const compressedSize = view.getUint32(cursor + 20, true);
    const size = view.getUint32(cursor + 24, true);
    const nameLength = view.getUint16(cursor + 28, true);
    const extraLength = view.getUint16(cursor + 30, true);
    const commentLength = view.getUint16(cursor + 32, true);
    const localOffset = view.getUint32(cursor + 42, true);
    const name = decoder.decode(bytes.subarray(cursor + 46, cursor + 46 + nameLength));
    cursor += 46 + nameLength + extraLength + commentLength;

    if (name.endsWith('/')) continue;
    if (flags & 1) throw new Error('Зашифрованные архивы не поддерживаются');
    if (!isSafeEntryName(name)) throw new Error(`Небезопасный путь в архиве: ${name}`);
    if (view.getUint32(localOffset, true) !== 0x04034b50) throw new Error('Повреждён архив');

    const localName = view.getUint16(localOffset + 26, true);
    const localExtra = view.getUint16(localOffset + 28, true);
    const start = localOffset + 30 + localName + localExtra;
    const payload = bytes.subarray(start, start + compressedSize);

    let data: Uint8Array;
    if (method === 0) data = payload.slice();
    else if (method === 8) data = await inflateRaw(payload);
    else throw new Error(`Неизвестный способ сжатия: ${method}`);

    if (data.length !== size || crc32(data) !== crc) {
      throw new Error(`Файл повреждён: ${name}`);
    }
    entries.push({ name, data });
  }

  return entries;
}
