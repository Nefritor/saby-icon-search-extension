import { distanceTransform } from './distanceTransform';

/**
 * Медиальная ось (скелет) фигуры как хребет distance transform.
 *
 * Тонкость: наивное «локальный максимум по 8 соседям» даёт ложный скелет —
 * у залитого квадрата в него попадает вся граница, где EDT постоянна вдоль кромки.
 * Условие «локальный максимум отдельно по X и отдельно по Y» это чинит:
 *  - у залитой фигуры граница отсеивается (по направлению внутрь EDT строго растёт);
 *  - у линии толщиной 1 пиксель скелет остаётся — иначе палочные наброски теряли бы всё.
 *
 * Полноценное прореживание (Zhang-Suen) дало бы идеальную 1-пиксельную ось,
 * но оно в разы дороже, а для сравнения двух скелетов чампфером избыточно.
 */
export function skeletonize(filled: Uint8Array, size: number): Uint8Array {
  // distanceTransform считает расстояние ДО чернил (0 внутри фигуры).
  // Для скелета нужно обратное: расстояние до ФОНА, то есть «полуширина» фигуры.
  // Поэтому инвертируем маску: фон становится чернилами.
  const inverted = new Uint8Array(filled.length);
  for (let i = 0; i < filled.length; i += 1) inverted[i] = filled[i] ? 0 : 1;

  const edt = distanceTransform(inverted, size, size);
  const out = new Uint8Array(filled.length);

  for (let y = 1; y < size - 1; y += 1) {
    for (let x = 1; x < size - 1; x += 1) {
      const index = y * size + x;
      const value = edt[index];
      if (value === 0) continue;

      const left = edt[index - 1];
      const right = edt[index + 1];
      const up = edt[index - size];
      const down = edt[index + size];

      // Точка оси — нестрогий локальный максимум ОТДЕЛЬНО по X и ОТДЕЛЬНО по Y.
      // Строгое сравнение здесь не годится: на плато (ось вытянутой фигуры)
      // соседи равны, и строгое неравенство выкосило бы весь скелет.
      if (value < left || value < right) continue;
      if (value < up || value < down) continue;

      out[index] = 1;
    }
  }

  return out;
}
