/**
 * Порог Отсу + бинаризация альфа-канала наброска.
 * Popup отдаёт альфу (0 = прозрачно, 255 = штрих), здесь она превращается в маску 0/1.
 */

export function otsuThreshold(histogram: Uint32Array, total: number): number {
  let sum = 0;
  for (let i = 0; i < 256; i += 1) sum += i * histogram[i];

  let sumBackground = 0;
  let weightBackground = 0;
  let best = -1;
  let threshold = 127;

  for (let t = 0; t < 256; t += 1) {
    weightBackground += histogram[t];
    if (weightBackground === 0) continue;
    const weightForeground = total - weightBackground;
    if (weightForeground === 0) break;

    sumBackground += t * histogram[t];
    const meanBackground = sumBackground / weightBackground;
    const meanForeground = (sum - sumBackground) / weightForeground;
    const delta = meanBackground - meanForeground;
    const between = weightBackground * weightForeground * delta * delta;

    if (between > best) {
      best = between;
      threshold = t;
    }
  }

  return threshold;
}

/**
 * Бинаризация массива «интенсивности чернил» (0..255).
 * Если порог не задан — считается автоматически по Отсу (для наброска).
 * Для глифов порог передаётся явно: там альфа практически бинарная и Отсу только жрёт время.
 */
export function grayToMask(values: Uint8Array, threshold?: number): Uint8Array {
  const total = values.length;
  const mask = new Uint8Array(total);

  let inkPixels = 0;
  for (let i = 0; i < total; i += 1) {
    if (values[i] > 0) inkPixels += 1;
  }
  // Пустой лист — пустая маска.
  if (inkPixels < 8) return mask;

  let level = threshold;
  if (level === undefined) {
    const histogram = new Uint32Array(256);
    for (let i = 0; i < total; i += 1) histogram[values[i]] += 1;
    level = Math.max(32, otsuThreshold(histogram, total));
  }

  for (let i = 0; i < total; i += 1) {
    mask[i] = values[i] >= level ? 1 : 0;
  }
  return mask;
}

/** Достаёт альфа-канал из RGBA-данных. */
export function extractAlpha(rgba: Uint8ClampedArray, width: number, height: number): Uint8Array {
  const total = width * height;
  const alpha = new Uint8Array(total);
  for (let i = 0; i < total; i += 1) alpha[i] = rgba[i * 4 + 3];
  return alpha;
}

export function alphaToMask(
  rgba: Uint8ClampedArray,
  width: number,
  height: number,
  threshold?: number,
): Uint8Array {
  return grayToMask(extractAlpha(rgba, width, height), threshold);
}

export function inkCount(mask: Uint8Array): number {
  let count = 0;
  for (let i = 0; i < mask.length; i += 1) count += mask[i];
  return count;
}
