/** Бинарная морфология: разделяемая (box), O(n*r) вместо O(n*r^2). */

export function dilate(src: Uint8Array, width: number, height: number, radius: number): Uint8Array {
  if (radius <= 0) return src.slice();
  const horizontal = new Uint8Array(src.length);

  for (let y = 0; y < height; y += 1) {
    const row = y * width;
    for (let x = 0; x < width; x += 1) {
      let hit = 0;
      for (let k = -radius; k <= radius && !hit; k += 1) {
        const xx = x + k;
        if (xx >= 0 && xx < width && src[row + xx]) hit = 1;
      }
      horizontal[row + x] = hit;
    }
  }

  const out = new Uint8Array(src.length);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      let hit = 0;
      for (let k = -radius; k <= radius && !hit; k += 1) {
        const yy = y + k;
        if (yy >= 0 && yy < height && horizontal[yy * width + x]) hit = 1;
      }
      out[y * width + x] = hit;
    }
  }
  return out;
}

export function erode(src: Uint8Array, width: number, height: number, radius: number): Uint8Array {
  if (radius <= 0) return src.slice();
  const inverted = new Uint8Array(src.length);
  for (let i = 0; i < src.length; i += 1) inverted[i] = src[i] ? 0 : 1;
  const dilated = dilate(inverted, width, height, radius);
  const out = new Uint8Array(src.length);
  for (let i = 0; i < src.length; i += 1) out[i] = dilated[i] ? 0 : 1;
  return out;
}

export function close(src: Uint8Array, width: number, height: number, radius: number): Uint8Array {
  return erode(dilate(src, width, height, radius), width, height, radius);
}

/**
 * Заливает внутренние дырки: всё, что не достижимо фоном с границы, считается фигурой.
 * Нужно, чтобы сравнить «силуэты» — и набросок контуром, и залитый глиф дают одно и то же.
 */
export function fillHoles(src: Uint8Array, width: number, height: number): Uint8Array {
  const reachable = new Uint8Array(src.length);
  const stack = new Int32Array(src.length);
  let top = 0;

  const push = (index: number): void => {
    if (src[index] === 0 && reachable[index] === 0) {
      reachable[index] = 1;
      stack[top] = index;
      top += 1;
    }
  };

  for (let x = 0; x < width; x += 1) {
    push(x);
    push((height - 1) * width + x);
  }
  for (let y = 0; y < height; y += 1) {
    push(y * width);
    push(y * width + width - 1);
  }

  while (top > 0) {
    top -= 1;
    const index = stack[top];
    const x = index % width;
    const y = (index - x) / width;
    if (x > 0) push(index - 1);
    if (x < width - 1) push(index + 1);
    if (y > 0) push(index - width);
    if (y < height - 1) push(index + width);
  }

  const out = new Uint8Array(src.length);
  for (let i = 0; i < src.length; i += 1) {
    out[i] = src[i] === 1 || reachable[i] === 0 ? 1 : 0;
  }
  return out;
}

/** Границы фигуры: пиксель фигуры, у которого есть фон в 4-соседях. */
export function boundary(src: Uint8Array, width: number, height: number): Uint8Array {
  const out = new Uint8Array(src.length);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const index = y * width + x;
      if (src[index] === 0) continue;
      const left = x === 0 || src[index - 1] === 0;
      const right = x === width - 1 || src[index + 1] === 0;
      const up = y === 0 || src[index - width] === 0;
      const down = y === height - 1 || src[index + width] === 0;
      out[index] = left || right || up || down ? 1 : 0;
    }
  }
  return out;
}

/**
 * Оценка толщины штриха как 2·площадь / периметр.
 * Для полосы длиной L и толщиной t это даёт ровно t, причём при любой ориентации —
 * в отличие от подсчёта пробегов по строкам, который меряет длину, а не толщину.
 */
export function estimateStrokeWidth(src: Uint8Array, width: number, height: number): number {
  const edge = boundary(src, width, height);
  let ink = 0;
  let edgeCount = 0;
  for (let i = 0; i < src.length; i += 1) {
    ink += src[i];
    edgeCount += edge[i];
  }
  if (ink === 0 || edgeCount === 0) return 1;
  return Math.max(1, (2 * ink) / edgeCount);
}
