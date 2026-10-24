/**
 * Ориентация линий в наборе точек — для chamfer с учётом направления.
 *
 * Обычный chamfer считает только расстояние: горизонтальный штрих «подходит» к вертикальному,
 * если они пересекаются, а плотная стопка горизонтальных линий оказывается недалеко от чего угодно.
 * Если у каждой точки есть направление линии, несовпадение направлений можно штрафовать.
 *
 * Направление линии определено с точностью до разворота (0°…180°), поэтому оно хранится
 * в одном байте — номере сектора по 22.5°.
 */

/** Число секторов на полуокружность. */
export const ORIENTATION_BINS = 8;
/** Точка без выраженного направления (пятно, перекрёсток, одиночный пиксель): штрафа нет. */
export const NO_ORIENTATION = ORIENTATION_BINS;

/** Радиус окна, по которому оценивается направление, px. */
const WINDOW_RADIUS = 3;
/** Ниже этой «вытянутости» окно считается пятном без направления. */
const MIN_ANISOTROPY = 0.4;

/**
 * Направление линии в каждой точке `probe`: главная ось облака точек в окне вокруг неё
 * (метод главных компонент). Остальные пиксели получают `NO_ORIENTATION`.
 */
export function orientationMap(probe: Uint8Array, size: number): Uint8Array {
  const out = new Uint8Array(size * size).fill(NO_ORIENTATION);

  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      if (!probe[y * size + x]) continue;

      let count = 0;
      let sumX = 0;
      let sumY = 0;
      let sumXX = 0;
      let sumYY = 0;
      let sumXY = 0;
      for (let dy = -WINDOW_RADIUS; dy <= WINDOW_RADIUS; dy += 1) {
        const yy = y + dy;
        if (yy < 0 || yy >= size) continue;
        for (let dx = -WINDOW_RADIUS; dx <= WINDOW_RADIUS; dx += 1) {
          const xx = x + dx;
          if (xx < 0 || xx >= size || !probe[yy * size + xx]) continue;
          count += 1;
          sumX += dx;
          sumY += dy;
          sumXX += dx * dx;
          sumYY += dy * dy;
          sumXY += dx * dy;
        }
      }
      if (count < 3) continue;

      const meanX = sumX / count;
      const meanY = sumY / count;
      const varX = sumXX / count - meanX * meanX;
      const varY = sumYY / count - meanY * meanY;
      const cov = sumXY / count - meanX * meanY;
      const trace = varX + varY;
      if (trace < 0.5) continue;

      const spread = Math.hypot(varX - varY, 2 * cov);
      if (spread / trace < MIN_ANISOTROPY) continue;

      const angle = 0.5 * Math.atan2(2 * cov, varX - varY);
      const bin = Math.round(angle / (Math.PI / ORIENTATION_BINS));
      out[y * size + x] = (bin + ORIENTATION_BINS) % ORIENTATION_BINS;
    }
  }

  return out;
}

/** Разность направлений в секторах: 0 — одинаково, 4 — перпендикулярно. */
export function orientationGap(a: number, b: number): number {
  if (a === NO_ORIENTATION || b === NO_ORIENTATION) return 0;
  const diff = Math.abs(a - b);
  return Math.min(diff, ORIENTATION_BINS - diff);
}
