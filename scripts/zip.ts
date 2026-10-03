import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { deflateRawSync } from 'node:zlib';

/**
 * Сборка zip-архива из каталога — без зависимостей.
 *
 * Нужен ровно один сценарий: положить рядом с собранным расширением архив того же
 * содержимого, чтобы приложить его к релизу на GitHub. Ради этого тянуть пакет
 * вроде `archiver` незачем, а `Compress-Archive`/`zip` привязали бы сборку
 * к конкретной системе.
 *
 * Формат пишем сами, но по минимуму: одна дискета, deflate, имена в UTF-8,
 * без Zip64 — файлы расширения до этого не дотягивают с большим запасом.
 */

/** Таблица CRC-32: считается один раз, дальше только поиск по байту. */
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

function crc32(data: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of data) {
    crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

/** Время для zip — два 16-битных поля, отсчёт от 1980 года и с точностью до 2 секунд. */
function dosStamp(date: Date): { time: number; date: number } {
  const time = (date.getHours() << 11) | (date.getMinutes() << 5) | (date.getSeconds() >> 1);
  const day = ((date.getFullYear() - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate();
  return { time: time & 0xffff, date: Math.max(0, day) & 0xffff };
}

interface Entry {
  /** Имя внутри архива, всегда через прямой слэш. */
  name: string;
  data: Buffer;
  mtime: Date;
}

/** Обходит каталог рекурсивно. Порядок — по алфавиту, чтобы архив был воспроизводимым. */
function collect(dir: string, prefix: string): Entry[] {
  const entries: Entry[] = [];
  for (const name of readdirSync(dir).sort()) {
    const full = join(dir, name);
    const stats = statSync(full);
    if (stats.isDirectory()) {
      entries.push(...collect(full, `${prefix}${name}/`));
    } else {
      entries.push({ name: `${prefix}${name}`, data: readFileSync(full), mtime: stats.mtime });
    }
  }
  return entries;
}

export interface ZipResult {
  files: number;
  /** Сколько занимают файлы до сжатия. */
  rawBytes: number;
  zipBytes: number;
}

/**
 * Пакует содержимое каталога в zip. Корнем архива становится само содержимое,
 * без папки-обёртки: распаковка сразу даёт файлы расширения, и её результат
 * можно указать Chrome как распакованное расширение.
 */
export function zipDirectory(sourceDir: string, zipPath: string): ZipResult {
  const entries = collect(sourceDir, '');

  const body: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  let rawBytes = 0;

  for (const entry of entries) {
    const name = Buffer.from(entry.name, 'utf8');
    const deflated = deflateRawSync(entry.data, { level: 9 });
    const crc = crc32(entry.data);
    const { time, date } = dosStamp(entry.mtime);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0); // сигнатура заголовка файла
    local.writeUInt16LE(20, 4); // версия, которая нужна для распаковки
    local.writeUInt16LE(0x0800, 6); // имена в UTF-8
    local.writeUInt16LE(8, 8); // deflate
    local.writeUInt16LE(time, 10);
    local.writeUInt16LE(date, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(deflated.length, 18);
    local.writeUInt32LE(entry.data.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28); // дополнительных полей нет

    body.push(local, name, deflated);

    const header = Buffer.alloc(46);
    header.writeUInt32LE(0x02014b50, 0); // сигнатура записи оглавления
    header.writeUInt16LE(20, 4); // версия упаковщика
    header.writeUInt16LE(20, 6);
    header.writeUInt16LE(0x0800, 8);
    header.writeUInt16LE(8, 10);
    header.writeUInt16LE(time, 12);
    header.writeUInt16LE(date, 14);
    header.writeUInt32LE(crc, 16);
    header.writeUInt32LE(deflated.length, 20);
    header.writeUInt32LE(entry.data.length, 24);
    header.writeUInt16LE(name.length, 28);
    header.writeUInt16LE(0, 30); // доп. поля
    header.writeUInt16LE(0, 32); // комментарий
    header.writeUInt16LE(0, 34); // номер диска
    header.writeUInt16LE(0, 36); // внутренние атрибуты
    header.writeUInt32LE(0, 38); // внешние атрибуты
    header.writeUInt32LE(offset, 42); // где лежит заголовок файла

    central.push(header, name);
    offset += local.length + name.length + deflated.length;
    rawBytes += entry.data.length;
  }

  const centralSize = central.reduce((sum, chunk) => sum + chunk.length, 0);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); // сигнатура конца оглавления
  end.writeUInt16LE(0, 4); // номер диска
  end.writeUInt16LE(0, 6); // диск с оглавлением
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralSize, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(0, 20); // комментария нет

  mkdirSync(
    zipPath.slice(0, Math.max(zipPath.lastIndexOf('/'), zipPath.lastIndexOf('\\'))) || '.',
    {
      recursive: true,
    },
  );
  const archive = Buffer.concat([...body, ...central, end]);
  writeFileSync(zipPath, archive);

  return { files: entries.length, rawBytes, zipBytes: archive.length };
}
