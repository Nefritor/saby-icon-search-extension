import { ICON_MARGIN, ICON_SIZE } from '../../shared/constants';

/**
 * Порог покрытия при уменьшении маски. Ниже — пиксель считается фоном.
 * Подобран так, чтобы линия толщиной в 2 исходных пикселя оставалась непрерывной.
 */
const AREA_COVERAGE_THRESHOLD = 0.35;

export interface Box {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

export function boundingBox(mask: Uint8Array, width: number, height: number): Box | null {
  let minX = width;
  let minY = height;
  let maxX = -1;
  let maxY = -1;

  for (let y = 0; y < height; y += 1) {
    const row = y * width;
    for (let x = 0; x < width; x += 1) {
      if (mask[row + x] === 0) continue;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
  }

  if (maxX < 0 || maxY < 0) return null;
  return { x0: minX, y0: minY, x1: maxX, y1: maxY };
}

export interface NormalizedMask {
  mask: Uint8Array;
  /** Доля «чернил» внутри bbox (после нормализации) — отличает контур от заливки. */
  coverage: number;
  aspect: number;
  box: Box;
}

/**
 * Режим приведения к квадрату:
 * - `fit` — пропорции сохраняются (вытянутая стрелка не «сжимается» в квадрат);
 * - `stretch` — bbox растягивается по каждой оси независимо, пропорции игнорируются.
 *
 * Второй режим нужен, потому что сравнение силуэтов через chamfer крайне чувствительно
 * к пропорциям: узкий палочный человечек и широкий палочный человечек из шрифта —
 * «одна и та же» фигура для человека, но их границы расходятся на всю разницу
 * пропорций. Матчер пробует оба кадра и берёт тот, где фигуры ближе: сохранение
 * пропорций остаётся полезным для вытянутых объектов, растяжение — для фигур,
 * нарисованных «не в тех» пропорциях.
 *
 * Уменьшение делается усреднением по площади, а не выборкой ближайшего соседа.
 * Это принципиально: при уменьшении в 2 раза тонкая линия толщиной 2 px попадает
 * не в каждый целевой пиксель, и ближайший сосед рвёт её в пунктир. Рваные линии
 * дают рваный скелет, а скелет — основной сигнал для палочных набросков.
 */
export function normalizeMask(
  mask: Uint8Array,
  width: number,
  height: number,
  size: number = ICON_SIZE,
  margin: number = ICON_MARGIN,
  mode: 'fit' | 'stretch' = 'fit',
): NormalizedMask | null {
  const box = boundingBox(mask, width, height);
  if (!box) return null;

  const boxWidth = box.x1 - box.x0 + 1;
  const boxHeight = box.y1 - box.y0 + 1;
  const inner = size - margin * 2;
  const base = inner / Math.max(boxWidth, boxHeight);
  const scaleX = mode === 'stretch' ? inner / boxWidth : base;
  const scaleY = mode === 'stretch' ? inner / boxHeight : base;

  const drawWidth = Math.max(1, Math.round(boxWidth * scaleX));
  const drawHeight = Math.max(1, Math.round(boxHeight * scaleY));
  const offsetX = Math.floor((size - drawWidth) / 2);
  const offsetY = Math.floor((size - drawHeight) / 2);

  const out = new Uint8Array(size * size);
  let ink = 0;

  for (let y = 0; y < drawHeight; y += 1) {
    // Исходный прямоугольник, попадающий в целевой пиксель.
    const y0 = box.y0 + Math.floor(y / scaleY);
    const y1 = Math.min(box.y1, Math.max(y0, box.y0 + Math.ceil((y + 1) / scaleY) - 1));

    for (let x = 0; x < drawWidth; x += 1) {
      const x0 = box.x0 + Math.floor(x / scaleX);
      const x1 = Math.min(box.x1, Math.max(x0, box.x0 + Math.ceil((x + 1) / scaleX) - 1));

      let covered = 0;
      let total = 0;
      for (let sourceY = y0; sourceY <= y1; sourceY += 1) {
        const row = sourceY * width;
        for (let sourceX = x0; sourceX <= x1; sourceX += 1) {
          total += 1;
          covered += mask[row + sourceX];
        }
      }

      const value = total > 0 && covered / total >= AREA_COVERAGE_THRESHOLD ? 1 : 0;
      out[(offsetY + y) * size + offsetX + x] = value;
      ink += value;
    }
  }

  return {
    mask: out,
    coverage: ink / (drawWidth * drawHeight),
    aspect: boxWidth / boxHeight,
    box,
  };
}

/**
 * Дотягивает уже нормализованную маску до квадрата `inner × inner`, растягивая
 * bbox по каждой оси независимо (ближайший сосед).
 *
 * Здесь выборка ближайшим соседом безопасна: вторая ось только увеличивается
 * (первая при `fit` уже равна `inner`), а при увеличении сосед не рвёт линии,
 * а лишь размножает пиксели. Ломать штрихи, как при уменьшении, тут нечем.
 */
export function stretchMask(mask: Uint8Array, size: number, margin: number): Uint8Array {
  const box = boundingBox(mask, size, size);
  if (!box) return mask;

  const boxWidth = box.x1 - box.x0 + 1;
  const boxHeight = box.y1 - box.y0 + 1;
  const inner = size - margin * 2;
  if (boxWidth === inner && boxHeight === inner) return mask;

  const out = new Uint8Array(size * size);
  for (let y = 0; y < inner; y += 1) {
    const sourceY = box.y0 + Math.min(boxHeight - 1, Math.floor((y * boxHeight) / inner));
    const row = sourceY * size;
    for (let x = 0; x < inner; x += 1) {
      const sourceX = box.x0 + Math.min(boxWidth - 1, Math.floor((x * boxWidth) / inner));
      out[(margin + y) * size + margin + x] = mask[row + sourceX];
    }
  }

  return out;
}

/** Уменьшение бинарной маски max-pooling'ом: пиксель зажигается, если в блоке есть чернила. */
export function downsampleMask(
  mask: Uint8Array,
  size: number,
  target: number,
  coverageThreshold = 0.25,
): Uint8Array {
  const factor = size / target;
  const out = new Uint8Array(target * target);

  for (let y = 0; y < target; y += 1) {
    for (let x = 0; x < target; x += 1) {
      const startX = Math.floor(x * factor);
      const startY = Math.floor(y * factor);
      const endX = Math.min(size, Math.floor((x + 1) * factor));
      const endY = Math.min(size, Math.floor((y + 1) * factor));
      let ink = 0;
      let total = 0;
      for (let sy = startY; sy < endY; sy += 1) {
        for (let sx = startX; sx < endX; sx += 1) {
          total += 1;
          ink += mask[sy * size + sx];
        }
      }
      out[y * target + x] = total > 0 && ink / total >= coverageThreshold ? 1 : 0;
    }
  }

  return out;
}

/** Поворот маски вокруг центра (обратное проецирование, ближайший сосед). */
export function rotateMask(mask: Uint8Array, size: number, angleDeg: number): Uint8Array {
  if (angleDeg === 0) return mask;

  const out = new Uint8Array(size * size);
  const radians = (angleDeg * Math.PI) / 180;
  const cos = Math.cos(radians);
  const sin = Math.sin(radians);
  const center = (size - 1) / 2;

  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const dx = x - center;
      const dy = y - center;
      const sourceX = Math.round(cos * dx + sin * dy + center);
      const sourceY = Math.round(-sin * dx + cos * dy + center);
      if (sourceX < 0 || sourceY < 0 || sourceX >= size || sourceY >= size) continue;
      out[y * size + x] = mask[sourceY * size + sourceX];
    }
  }

  return out;
}

export function intersectionOverUnion(a: Uint8Array, b: Uint8Array): number {
  let intersection = 0;
  let union = 0;
  for (let i = 0; i < a.length; i += 1) {
    const av = a[i];
    const bv = b[i];
    if (av && bv) intersection += 1;
    if (av || bv) union += 1;
  }
  return union === 0 ? 0 : intersection / union;
}
