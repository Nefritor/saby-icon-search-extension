/**
 * Distance transform (Chamfer 3-4, два прохода).
 * Возвращает Uint16Array, где 0 — «чернила», остальное — расстояние до ближайших чернил,
 * умноженное на 3 (единица измерения — 1/3 пикселя).
 */
const ORTHOGONAL = 3;
const DIAGONAL = 4;
const INF = 0xffff;

export function distanceTransform(mask: Uint8Array, width: number, height: number): Uint16Array {
  const size = width * height;
  const distance = new Uint16Array(size);

  for (let i = 0; i < size; i += 1) {
    distance[i] = mask[i] ? 0 : INF;
  }

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const index = y * width + x;
      if (distance[index] === 0) continue;

      let best = distance[index];
      if (x > 0) best = Math.min(best, distance[index - 1] + ORTHOGONAL);
      if (y > 0) best = Math.min(best, distance[index - width] + ORTHOGONAL);
      if (x > 0 && y > 0) best = Math.min(best, distance[index - width - 1] + DIAGONAL);
      if (x < width - 1 && y > 0) best = Math.min(best, distance[index - width + 1] + DIAGONAL);
      distance[index] = best;
    }
  }

  for (let y = height - 1; y >= 0; y -= 1) {
    for (let x = width - 1; x >= 0; x -= 1) {
      const index = y * width + x;
      if (distance[index] === 0) continue;

      let best = distance[index];
      if (x < width - 1) best = Math.min(best, distance[index + 1] + ORTHOGONAL);
      if (y < height - 1) best = Math.min(best, distance[index + width] + ORTHOGONAL);
      if (x < width - 1 && y < height - 1) {
        best = Math.min(best, distance[index + width + 1] + DIAGONAL);
      }
      if (x > 0 && y < height - 1) best = Math.min(best, distance[index + width - 1] + DIAGONAL);
      distance[index] = best;
    }
  }

  return distance;
}

/** Расстояние в пикселях (float) по значению из distanceTransform. */
export function toPixels(value: number): number {
  return value / ORTHOGONAL;
}

/**
 * Distance transform, который заодно переносит метку ближайшей точки: для каждого пикселя
 * `label[i]` — метка того «чернильного» пикселя, до которого расстояние минимально.
 * Нужен chamfer'у с ориентацией: ему важно, какое направление у ближайшей линии.
 */
export function distanceTransformLabelled(
  mask: Uint8Array,
  labels: Uint8Array,
  width: number,
  height: number,
): { distance: Uint16Array; nearest: Uint8Array } {
  const size = width * height;
  const distance = new Uint16Array(size);
  const nearest = new Uint8Array(size);

  for (let i = 0; i < size; i += 1) {
    distance[i] = mask[i] ? 0 : INF;
    nearest[i] = mask[i] ? labels[i] : 0;
  }

  const relax = (index: number, from: number, step: number): void => {
    const candidate = distance[from] + step;
    if (candidate < distance[index]) {
      distance[index] = candidate;
      nearest[index] = nearest[from];
    }
  };

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const index = y * width + x;
      if (distance[index] === 0) continue;
      if (x > 0) relax(index, index - 1, ORTHOGONAL);
      if (y > 0) relax(index, index - width, ORTHOGONAL);
      if (x > 0 && y > 0) relax(index, index - width - 1, DIAGONAL);
      if (x < width - 1 && y > 0) relax(index, index - width + 1, DIAGONAL);
    }
  }

  for (let y = height - 1; y >= 0; y -= 1) {
    for (let x = width - 1; x >= 0; x -= 1) {
      const index = y * width + x;
      if (distance[index] === 0) continue;
      if (x < width - 1) relax(index, index + 1, ORTHOGONAL);
      if (y < height - 1) relax(index, index + width, ORTHOGONAL);
      if (x < width - 1 && y < height - 1) relax(index, index + width + 1, DIAGONAL);
      if (x > 0 && y < height - 1) relax(index, index + width - 1, DIAGONAL);
    }
  }

  return { distance, nearest };
}
