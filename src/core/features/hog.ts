import { HOG_BINS, HOG_CELL, HOG_DIM, ICON_SIZE } from '../../shared/constants';

/**
 * HOG по бинарной маске: 8x8 ячеек по 8x8 пикселей, 9 корзин ориентаций.
 * Даёт устойчивость к толщине штриха — реагирует на направление границ, а не на заливку.
 */
export function computeHog(mask: Uint8Array, size: number = ICON_SIZE): Float32Array {
  const cells = size / HOG_CELL;
  const histogram = new Float32Array(cells * cells * HOG_BINS);

  const magnitude = new Float32Array(size * size);
  const orientation = new Float32Array(size * size);

  for (let y = 1; y < size - 1; y += 1) {
    for (let x = 1; x < size - 1; x += 1) {
      const index = y * size + x;
      const gx = mask[index + 1] - mask[index - 1];
      const gy = mask[index + size] - mask[index - size];
      magnitude[index] = Math.hypot(gx, gy);
      let angle = Math.atan2(gy, gx);
      if (angle < 0) angle += Math.PI;
      if (angle >= Math.PI) angle -= Math.PI;
      orientation[index] = angle;
    }
  }

  for (let cy = 0; cy < cells; cy += 1) {
    for (let cx = 0; cx < cells; cx += 1) {
      const cellBase = (cy * cells + cx) * HOG_BINS;
      for (let y = cy * HOG_CELL; y < (cy + 1) * HOG_CELL; y += 1) {
        for (let x = cx * HOG_CELL; x < (cx + 1) * HOG_CELL; x += 1) {
          const index = y * size + x;
          const mag = magnitude[index];
          if (mag === 0) continue;

          const position = (orientation[index] / Math.PI) * HOG_BINS - 0.5;
          const lower = Math.floor(position);
          const upper = lower + 1;
          const weight = position - lower;

          const lowerBin = ((lower % HOG_BINS) + HOG_BINS) % HOG_BINS;
          const upperBin = ((upper % HOG_BINS) + HOG_BINS) % HOG_BINS;
          histogram[cellBase + lowerBin] += mag * (1 - weight);
          histogram[cellBase + upperBin] += mag * weight;
        }
      }

      // L2-нормировка внутри ячейки.
      let norm = 0;
      for (let b = 0; b < HOG_BINS; b += 1) {
        const value = histogram[cellBase + b];
        norm += value * value;
      }
      norm = Math.sqrt(norm) + 1e-6;
      for (let b = 0; b < HOG_BINS; b += 1) histogram[cellBase + b] /= norm;
    }
  }

  let globalNorm = 0;
  for (let i = 0; i < histogram.length; i += 1) globalNorm += histogram[i] * histogram[i];
  globalNorm = Math.sqrt(globalNorm) + 1e-6;
  for (let i = 0; i < histogram.length; i += 1) histogram[i] /= globalNorm;

  return histogram.subarray(0, HOG_DIM) as Float32Array;
}

/** Косинусная близость, приведённая к диапазону [0, 1]. */
export function hogSimilarity(a: Float32Array, b: Float32Array): number {
  let dot = 0;
  for (let i = 0; i < a.length; i += 1) dot += a[i] * b[i];
  const clamped = Math.max(-1, Math.min(1, dot));
  return (clamped + 1) / 2;
}
