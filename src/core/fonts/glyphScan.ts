import {
  ICON_MARGIN,
  ICON_SIZE,
  RASTER_CANVAS,
  RASTER_FONT_PX,
  SCAN_RANGES,
} from '../../shared/constants';
import { yieldToEventLoop } from '../../shared/schedule';
import { alphaToMask } from '../image/binarize';
import { normalizeMask } from '../image/normalize';

export interface ScannedGlyph {
  codePoint: number;
  char: string;
  mask: Uint8Array;
  coverage: number;
  aspect: number;
}

export interface ScanOptions {
  onProgress?: (done: number, total: number) => void;
}

/** Регистрирует шрифт в документе под уникальным семейством. */
export async function registerFont(family: string, bytes: ArrayBuffer): Promise<void> {
  const face = new FontFace(family, bytes);
  await face.load();
  document.fonts.add(face);
}

export function unregisterFont(family: string): void {
  const faces = [...document.fonts].filter((face) => face.family === family);
  for (const face of faces) document.fonts.delete(face);
}

function candidatesCount(): number {
  let total = 0;
  for (const [start, end] of SCAN_RANGES) total += end - start + 1;
  return total;
}

function hashMask(mask: Uint8Array): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < mask.length; i += 1) {
    hash ^= mask[i];
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

interface Rasterizer {
  render: (family: string, char: string) => Uint8Array;
}

function createRasterizer(): Rasterizer {
  const canvas = new OffscreenCanvas(RASTER_CANVAS, RASTER_CANVAS);
  const context = canvas.getContext('2d', { willReadFrequently: true });
  if (!context) throw new Error('Не удалось получить 2D-контекст для растеризации шрифта');

  return {
    render(family: string, char: string): Uint8Array {
      context.clearRect(0, 0, RASTER_CANVAS, RASTER_CANVAS);
      context.fillStyle = '#000';
      context.textAlign = 'center';
      context.textBaseline = 'middle';
      context.font = `${RASTER_FONT_PX}px "${family}"`;
      context.fillText(char, RASTER_CANVAS / 2, RASTER_CANVAS / 2);
      const image = context.getImageData(0, 0, RASTER_CANVAS, RASTER_CANVAS);
      return alphaToMask(image.data, RASTER_CANVAS, RASTER_CANVAS, 128);
    },
  };
}

/**
 * Проверяем, умеет ли `document.fonts.check` отличать отсутствующий глиф.
 * U+FFFF — noncharacter, его нет ни в одном шрифте, поэтому корректная
 * реализация обязана вернуть false. Если вернула true — фильтру доверять нельзя.
 */
function coverageCheckIsReliable(family: string): boolean {
  try {
    return document.fonts.check(`${RASTER_FONT_PX}px "${family}"`, '\uFFFF') === false;
  } catch {
    return false;
  }
}

/**
 * Через сколько миллисекунд работы сканер отдаёт поток событийному циклу.
 * Меньше кадра: так интерфейс и очередь сообщений движка не «залипают».
 */
const YIELD_EVERY_MS = 12;

/**
 * Страховка для дешёвых шагов (проверка покрытия отсеивает почти все кодпоинты):
 * по времени такая порция может не набрать и миллисекунды, поэтому ограничиваем
 * её ещё и числом шагов.
 */
const YIELD_EVERY_STEPS = 512;

async function scanOnce(
  family: string,
  useCoverageCheck: boolean,
  options: ScanOptions,
): Promise<ScannedGlyph[]> {
  const rasterizer = createRasterizer();
  const total = candidatesCount();
  const fontSpec = `${RASTER_FONT_PX}px "${family}"`;

  // Подписи «глифа-заглушки» (.notdef) — чтобы не принять квадратик за иконку.
  const notdefHashes = new Set<number>([
    hashMask(rasterizer.render(family, '\uFFFF')),
    hashMask(rasterizer.render(family, '\u{10FFFE}')),
  ]);

  const glyphs: ScannedGlyph[] = [];
  let processed = 0;
  let stepsSinceYield = 0;
  let lastYield = performance.now();

  for (const [start, end] of SCAN_RANGES) {
    for (let codePoint = start; codePoint <= end; codePoint += 1) {
      const char = String.fromCodePoint(codePoint);
      const covered = !useCoverageCheck || document.fonts.check(fontSpec, char);

      if (covered) {
        processed += 1;
        if (processed % 256 === 0) options.onProgress?.(processed, total);

        const raster = rasterizer.render(family, char);

        let ink = 0;
        for (let i = 0; i < raster.length; i += 1) ink += raster[i];

        if (ink >= 6) {
          const normalized = normalizeMask(
            raster,
            RASTER_CANVAS,
            RASTER_CANVAS,
            ICON_SIZE,
            ICON_MARGIN,
          );

          // Дедупликации по маске здесь быть не должно. В иконочных шрифтах один и тот же
          // рисунок часто лежит в нескольких кодпоинтах (алиасы), и если оставить только
          // первый, часть имён классов из .less перестанет находиться вообще.
          // Проверено на cbuc-icons: дедупликация выбрасывала 327 объявленных иконок из 1321.
          if (normalized && !notdefHashes.has(hashMask(normalized.mask))) {
            glyphs.push({
              codePoint,
              char,
              mask: normalized.mask,
              coverage: normalized.coverage,
              aspect: normalized.aspect,
            });
          }
        }
      }

      // Сканирование идёт тысячи шагов подряд: без выхода в событийный цикл поток
      // не отвечает ни на поиск, ни на интерфейс, пока не закончится весь индекс.
      stepsSinceYield += 1;
      if (
        stepsSinceYield >= YIELD_EVERY_STEPS ||
        performance.now() - lastYield >= YIELD_EVERY_MS
      ) {
        await yieldToEventLoop();
        stepsSinceYield = 0;
        lastYield = performance.now();
      }
    }
    options.onProgress?.(processed, total);
  }

  return glyphs;
}

/**
 * Сканирует шрифт и возвращает нормализованные маски всех найденных глифов.
 * Работает для woff/woff2/ttf/otf одинаково: декодированием занимается сам браузер.
 *
 * Асинхронный и кооперативный: отдаёт поток между порциями работы, поэтому
 * индексация не блокирует интерфейс и не задерживает ответы движка.
 */
export async function scanFont(
  family: string,
  options: ScanOptions = {},
): Promise<ScannedGlyph[]> {
  if (coverageCheckIsReliable(family)) {
    const fast = await scanOnce(family, true, options);
    if (fast.length > 0) return fast;
  }
  // Медленный путь: рендерим всё подряд и отсеиваем по «чернилам» и .notdef.
  return scanOnce(family, false, options);
}
