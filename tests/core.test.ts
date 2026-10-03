import { describe, expect, it } from 'vitest';
import { computeHog } from '../src/core/features/hog';
import { distanceTransform } from '../src/core/image/distanceTransform';
import { close, estimateStrokeWidth, fillHoles } from '../src/core/image/morphology';
import { boundary } from '../src/core/image/morphology';
import { intersectionOverUnion, normalizeMask } from '../src/core/image/normalize';
import { skeletonize } from '../src/core/image/skeleton';
import {
  buildResults,
  buildSketchFeatures,
  createGlyphEntry,
  searchGlyphs,
} from '../src/core/matching/matcher';
import { ICON_MARGIN, ICON_SIZE, PREVIEW_SIZE } from '../src/shared/constants';
import type { GlyphRecord } from '../src/shared/types';

function blank(size = ICON_SIZE): Uint8Array {
  return new Uint8Array(size * size);
}

function fillRect(
  mask: Uint8Array,
  size: number,
  x0: number,
  y0: number,
  x1: number,
  y1: number,
): void {
  for (let y = Math.max(0, y0); y <= Math.min(size - 1, y1); y += 1) {
    for (let x = Math.max(0, x0); x <= Math.min(size - 1, x1); x += 1) {
      mask[y * size + x] = 1;
    }
  }
}

/** Отрезок толщиной `thickness`, нарисованный по алгоритму Брезенхэма. */
function strokeLine(
  mask: Uint8Array,
  size: number,
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  thickness = 2,
): void {
  const steps = Math.max(Math.abs(x1 - x0), Math.abs(y1 - y0));
  const half = Math.floor(thickness / 2);
  for (let step = 0; step <= steps; step += 1) {
    const t = steps === 0 ? 0 : step / steps;
    const x = Math.round(x0 + (x1 - x0) * t);
    const y = Math.round(y0 + (y1 - y0) * t);
    fillRect(mask, size, x - half, y - half, x + half, y + half);
  }
}

function drawCircle(
  size: number,
  centerX: number,
  centerY: number,
  radius: number,
  thickness?: number,
): Uint8Array {
  const mask = blank(size);
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const distance = Math.hypot(x - centerX, y - centerY);
      const inside =
        thickness === undefined ? distance <= radius : Math.abs(distance - radius) <= thickness / 2;
      if (inside) mask[y * size + x] = 1;
    }
  }
  return mask;
}

function drawSquare(size: number, side: number): Uint8Array {
  const mask = blank(size);
  const offset = Math.floor((size - side) / 2);
  fillRect(mask, size, offset, offset, offset + side - 1, offset + side - 1);
  return mask;
}

function drawSquareOutline(size: number, side: number): Uint8Array {
  const mask = blank(size);
  const offset = Math.floor((size - side) / 2);
  const far = offset + side - 1;
  fillRect(mask, size, offset, offset, far, offset);
  fillRect(mask, size, offset, far, far, far);
  fillRect(mask, size, offset, offset + 1, offset, far - 1);
  fillRect(mask, size, far, offset + 1, far, far - 1);
  return mask;
}

function drawRotatedSquare(size: number, halfSide: number, angleDeg: number): Uint8Array {
  const mask = blank(size);
  const angle = (angleDeg * Math.PI) / 180;
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);
  const center = (size - 1) / 2;
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const dx = x - center;
      const dy = y - center;
      const sx = cos * dx + sin * dy;
      const sy = -sin * dx + cos * dy;
      if (Math.abs(sx) <= halfSide && Math.abs(sy) <= halfSide) mask[y * size + x] = 1;
    }
  }
  return mask;
}

/** Крестик — та самая ловушка: его скелет похож на скелет человечка без головы и ног. */
function drawPlus(size: number, halfArm = 20, halfBar = 2): Uint8Array {
  const mask = blank(size);
  const center = 31;
  fillRect(mask, size, center - halfArm, center - halfBar, center + halfArm, center + halfBar);
  fillRect(mask, size, center - halfBar, center - halfArm, center + halfBar, center + halfArm);
  return mask;
}

function drawCircledPlus(size: number): Uint8Array {
  const ring = drawCircle(size, 32, 32, 26, 3);
  const plus = drawPlus(size, 16, 2);
  const mask = blank(size);
  for (let i = 0; i < mask.length; i += 1) mask[i] = ring[i] || plus[i] ? 1 : 0;
  return mask;
}

/** Человечек, залитый как обычный глиф иконочного шрифта. */
function drawFilledPerson(size: number): Uint8Array {
  const mask = blank(size);
  const head = drawCircle(size, 32, 11, 7);
  for (let i = 0; i < mask.length; i += 1) if (head[i]) mask[i] = 1;
  fillRect(mask, size, 28, 20, 36, 38); // корпус
  fillRect(mask, size, 14, 22, 50, 26); // руки
  fillRect(mask, size, 26, 38, 31, 55); // левая нога
  fillRect(mask, size, 34, 38, 39, 55); // правая нога
  return mask;
}

/** Тот же человечек, но нарисованный «палка-палка-огуречик». */
function drawStickPerson(size: number): Uint8Array {
  const head = drawCircle(size, 32, 11, 7, 2);
  const arms = blank(size);
  strokeLine(arms, size, 13, 23, 51, 23, 2);
  const torso = blank(size);
  strokeLine(torso, size, 32, 18, 32, 38, 2);
  const legs = blank(size);
  strokeLine(legs, size, 32, 38, 23, 55, 2);
  strokeLine(legs, size, 32, 38, 41, 55, 2);

  const mask = blank(size);
  for (const layer of [head, arms, torso, legs]) {
    for (let i = 0; i < mask.length; i += 1) if (layer[i]) mask[i] = 1;
  }
  return mask;
}

/** В боевом конвейере маска глифа всегда нормализуется. Тесты повторяют этот путь. */
function normalize(raw: Uint8Array): Uint8Array {
  const result = normalizeMask(raw, ICON_SIZE, ICON_SIZE, ICON_SIZE, ICON_MARGIN);
  if (!result) throw new Error('Пустая маска');
  return result.mask;
}

function countInk(mask: Uint8Array): number {
  let count = 0;
  for (let i = 0; i < mask.length; i += 1) count += mask[i];
  return count;
}

function glyph(id: string, raw: Uint8Array): GlyphRecord {
  const mask = normalize(raw);
  return {
    id,
    fontId: 'test',
    fontName: 'Test',
    sourceKind: 'file',
    sourceValue: 'test.woff',
    codePoint: 0xe000,
    char: '\uE000',
    mask,
    inkPixels: countInk(mask),
    coverage: 0.5,
    aspect: 1,
  };
}

function sketchFrom(raw: Uint8Array, rotations?: number[]) {
  const normalized = normalizeMask(raw, ICON_SIZE, ICON_SIZE, ICON_SIZE, ICON_MARGIN)!;
  return buildSketchFeatures(normalized.mask, normalized, 2, rotations);
}

describe('distanceTransform', () => {
  it('даёт нули на чернилах и растёт по мере удаления', () => {
    const size = 5;
    const mask = blank(size);
    mask[2 * size + 2] = 1;
    const edt = distanceTransform(mask, size, size);

    expect(edt[2 * size + 2]).toBe(0);
    expect(edt[2 * size + 1]).toBe(3);
    expect(edt[1 * size + 1]).toBe(4);
    expect(edt[2 * size + 0]).toBe(6);
  });
});

describe('fillHoles', () => {
  it('превращает контур круга в залитый диск', () => {
    const filled = fillHoles(drawCircle(ICON_SIZE, 32, 32, 20, 2), ICON_SIZE, ICON_SIZE);
    expect(filled[32 * ICON_SIZE + 32]).toBe(1);
    expect(countInk(filled)).toBeGreaterThan(Math.PI * 20 * 20 * 0.9);
  });

  it('не заливает открытую фигуру', () => {
    const mask = blank();
    fillRect(mask, ICON_SIZE, 5, 32, 39, 32);
    expect(countInk(fillHoles(mask, ICON_SIZE, ICON_SIZE))).toBe(35);
  });
});

describe('estimateStrokeWidth', () => {
  it('оценивает толщину длинной полосы', () => {
    const horizontal = blank();
    fillRect(horizontal, ICON_SIZE, 5, 20, 57, 25);
    const horizontalWidth = estimateStrokeWidth(horizontal, ICON_SIZE, ICON_SIZE);
    expect(horizontalWidth).toBeGreaterThan(4.5);
    expect(horizontalWidth).toBeLessThan(7);
  });

  it('даёт ту же оценку для вертикальной полосы', () => {
    const vertical = blank();
    fillRect(vertical, ICON_SIZE, 20, 5, 25, 57);
    const verticalWidth = estimateStrokeWidth(vertical, ICON_SIZE, ICON_SIZE);
    expect(verticalWidth).toBeGreaterThan(4.5);
    expect(verticalWidth).toBeLessThan(7);
  });
});

describe('skeletonize', () => {
  it('вытянутый прямоугольник превращает в осевую линию', () => {
    const mask = blank();
    fillRect(mask, ICON_SIZE, 12, 28, 51, 35);
    const skeleton = skeletonize(mask, ICON_SIZE);

    let minX = ICON_SIZE;
    let maxX = -1;
    let minY = ICON_SIZE;
    let maxY = -1;
    const count = countInk(skeleton);

    for (let y = 0; y < ICON_SIZE; y += 1) {
      for (let x = 0; x < ICON_SIZE; x += 1) {
        if (!skeleton[y * ICON_SIZE + x]) continue;
        minX = Math.min(minX, x);
        maxX = Math.max(maxX, x);
        minY = Math.min(minY, y);
        maxY = Math.max(maxY, y);
      }
    }

    // Основная масса скелета лежит в центральной полосе: у вытянутой фигуры
    // это осевая линия, а не вся её площадь. Единичные точки в углах —
    // законные точки медиальной оси малого радиуса, они не мешают.
    let central = 0;
    for (let y = 30; y <= 33; y += 1) {
      for (let x = 0; x < ICON_SIZE; x += 1) {
        if (skeleton[y * ICON_SIZE + x]) central += 1;
      }
    }

    expect(maxX - minX).toBeGreaterThan(20);
    expect(central / count).toBeGreaterThan(0.85);
    expect(count).toBeLessThan(countInk(mask) / 3);
  });

  it('не тащит за собой границу залитой фигуры', () => {
    const mask = drawSquare(ICON_SIZE, 44);
    const skeleton = skeletonize(mask, ICON_SIZE);
    const edge = boundary(mask, ICON_SIZE, ICON_SIZE);

    let onEdge = 0;
    for (let i = 0; i < skeleton.length; i += 1) {
      if (skeleton[i] && edge[i]) onEdge += 1;
    }

    expect(onEdge / Math.max(1, countInk(skeleton))).toBeLessThan(0.2);
  });
});

describe('close', () => {
  it('закрывает разрыв в контуре, чтобы дырка залилась', () => {
    const ring = drawCircle(ICON_SIZE, 32, 32, 20, 3);
    for (let y = 31; y <= 33; y += 1) {
      for (let x = 32; x < ICON_SIZE; x += 1) ring[y * ICON_SIZE + x] = 0;
    }

    expect(fillHoles(ring, ICON_SIZE, ICON_SIZE)[32 * ICON_SIZE + 32]).toBe(0);
    const healed = fillHoles(close(ring, ICON_SIZE, ICON_SIZE, 3), ICON_SIZE, ICON_SIZE);
    expect(healed[32 * ICON_SIZE + 32]).toBe(1);
  });
});

describe('normalizeMask', () => {
  it('сохраняет пропорции и центрирует фигуру', () => {
    const size = 128;
    const mask = blank(size);
    fillRect(mask, size, 40, 40, 79, 59);

    const normalized = normalizeMask(mask, size, size, ICON_SIZE, ICON_MARGIN);
    expect(normalized?.aspect).toBeCloseTo(2, 2);

    let minX = ICON_SIZE;
    let maxX = -1;
    let minY = ICON_SIZE;
    let maxY = -1;
    const out = normalized!.mask;
    for (let y = 0; y < ICON_SIZE; y += 1) {
      for (let x = 0; x < ICON_SIZE; x += 1) {
        if (!out[y * ICON_SIZE + x]) continue;
        minX = Math.min(minX, x);
        maxX = Math.max(maxX, x);
        minY = Math.min(minY, y);
        maxY = Math.max(maxY, y);
      }
    }

    expect(maxX - minX + 1).toBeGreaterThan(maxY - minY + 1);
    expect(Math.abs(minX - (ICON_SIZE - 1 - maxX))).toBeLessThanOrEqual(1);
  });

  it('возвращает null на пустой маске', () => {
    expect(normalizeMask(blank(), ICON_SIZE, ICON_SIZE, ICON_SIZE, ICON_MARGIN)).toBeNull();
  });
});

describe('HOG', () => {
  it('выдаёт нормированный вектор нужной длины', () => {
    const hog = computeHog(drawCircle(ICON_SIZE, 32, 32, 24));
    expect(hog.length).toBe(576);

    let norm = 0;
    for (let i = 0; i < hog.length; i += 1) norm += hog[i] * hog[i];
    expect(Math.sqrt(norm)).toBeCloseTo(1, 5);
  });
});

describe('поиск', () => {
  const diskGlyph = drawCircle(ICON_SIZE, 32, 32, 24);
  const squareGlyph = drawSquare(ICON_SIZE, 44);
  const entries = [
    createGlyphEntry(glyph('disk', diskGlyph)),
    createGlyphEntry(glyph('square', squareGlyph)),
  ];

  it('набросок контуром круга находит круг, а не квадрат', () => {
    const outline = drawCircle(ICON_SIZE, 32, 32, 24, 3);
    const { scored, considered } = searchGlyphs(sketchFrom(outline), entries);

    expect(considered).toBe(2);
    expect(scored[0].entry.record.id).toBe('disk');
    expect(scored[0].metrics.score).toBeGreaterThan(scored[1].metrics.score);
  });

  it('набросок квадрата находит квадрат', () => {
    const { scored } = searchGlyphs(sketchFrom(drawSquareOutline(ICON_SIZE, 44)), entries);
    expect(scored[0].entry.record.id).toBe('square');
  });

  it('поворотный поиск компенсирует наклон на 8 градусов', () => {
    const rotated = drawRotatedSquare(ICON_SIZE, 22, 8);

    const withRotation = searchGlyphs(sketchFrom(rotated), entries).scored.find(
      (item) => item.entry.record.id === 'square',
    )!;
    const withoutRotation = searchGlyphs(sketchFrom(rotated, [0]), entries).scored.find(
      (item) => item.entry.record.id === 'square',
    )!;

    expect(withRotation.metrics.chamferFill).toBeLessThan(withoutRotation.metrics.chamferFill);
    expect(withRotation.metrics.bestRotation).not.toBe(0);
  });

  it('отдаёт base64-превью нужного размера', () => {
    const outline = drawCircle(ICON_SIZE, 32, 32, 24, 3);
    const results = buildResults(searchGlyphs(sketchFrom(outline), entries).scored);

    expect(results.length).toBe(2);
    expect(results[0].preview).toMatch(/^[A-Za-z0-9+/=]+$/);
    expect(atob(results[0].preview).length).toBe(PREVIEW_SIZE * PREVIEW_SIZE);
  });

  it('возвращает ровно пять результатов, если кандидатов больше', () => {
    const many = Array.from({ length: 8 }, (_, index) =>
      createGlyphEntry(
        glyph(`glyph-${index}`, drawRotatedSquare(ICON_SIZE, 20 + index, index * 3)),
      ),
    );
    const results = buildResults(searchGlyphs(sketchFrom(drawSquare(ICON_SIZE, 44)), many).scored);
    expect(results.length).toBe(5);
  });
});

/**
 * Главный регресс: «палка-палка-огуречик» против залитого человечка.
 * Силуэты у них почти не пересекаются, спасать должен скелет.
 */
describe('палочный набросок против залитого глифа', () => {
  const entries = [
    createGlyphEntry(glyph('person', drawFilledPerson(ICON_SIZE))),
    createGlyphEntry(glyph('square', drawSquare(ICON_SIZE, 44))),
    createGlyphEntry(glyph('disk', drawCircle(ICON_SIZE, 32, 32, 24))),
  ];

  it('находит залитого человечка, а не квадрат с кругом', () => {
    const { scored } = searchGlyphs(sketchFrom(drawStickPerson(ICON_SIZE)), entries);

    expect(scored[0].entry.record.id).toBe('person');

    const person = scored.find((item) => item.entry.record.id === 'person')!;
    const runnerUp = scored[1];
    expect(person.metrics.score).toBeGreaterThan(runnerUp.metrics.score);
  });

  it('все три гипотезы согласованно указывают именно на человечка', () => {
    const { scored } = searchGlyphs(sketchFrom(drawStickPerson(ICON_SIZE)), entries);
    const person = scored.find((item) => item.entry.record.id === 'person')!;
    const square = scored.find((item) => item.entry.record.id === 'square')!;
    const disk = scored.find((item) => item.entry.record.id === 'disk')!;

    // Каждая гипотеза по отдельности отличает человечка от квадрата и круга.
    expect(person.metrics.chamferSkeleton).toBeLessThan(square.metrics.chamferSkeleton);
    expect(person.metrics.chamferSkeleton).toBeLessThan(disk.metrics.chamferSkeleton);
    expect(person.metrics.chamferFill).toBeLessThan(square.metrics.chamferFill);
    expect(person.metrics.chamferContour).toBeLessThan(disk.metrics.chamferContour);

    // И запас по скору не маленький — иначе ранжирование было бы лотереей.
    expect(person.metrics.score).toBeGreaterThan(2 * scored[1].metrics.score);
  });

  it('человечек не выигрывает там, где его нет: квадрат остаётся квадратом', () => {
    const { scored } = searchGlyphs(sketchFrom(drawSquareOutline(ICON_SIZE, 44)), entries);
    expect(scored[0].entry.record.id).toBe('square');
  });

  it('чистый силуэтный случай не сломан: контур круга находит круг', () => {
    const { scored } = searchGlyphs(sketchFrom(drawCircle(ICON_SIZE, 32, 32, 24, 3)), entries);
    expect(scored[0].entry.record.id).toBe('disk');
  });
});

describe('грубый отбор', () => {
  it('не теряет залитого человечка среди похожих по площади фигур', () => {
    const distractors = Array.from({ length: 40 }, (_, index) =>
      createGlyphEntry(glyph(`d-${index}`, drawRotatedSquare(ICON_SIZE, 14 + (index % 10), index))),
    );
    const entries = [
      createGlyphEntry(glyph('person', drawFilledPerson(ICON_SIZE))),
      ...distractors,
    ];

    const { scored } = searchGlyphs(sketchFrom(drawStickPerson(ICON_SIZE)), entries);
    // Ключевое: силуэтный грубый отбор раньше выбрасывал человечка ещё до точного сравнения.
    expect(scored.some((item) => item.entry.record.id === 'person')).toBe(true);
    expect(scored[0].entry.record.id).toBe('person');
  });
});

describe('ловушка «крестик вместо человечка»', () => {
  const entries = [
    createGlyphEntry(glyph('person', drawFilledPerson(ICON_SIZE))),
    createGlyphEntry(glyph('plus', drawPlus(ICON_SIZE))),
    createGlyphEntry(glyph('circled-plus', drawCircledPlus(ICON_SIZE))),
    createGlyphEntry(glyph('square', drawSquare(ICON_SIZE, 44))),
  ];

  it('палочный человечек не проигрывает крестику и квадрату', () => {
    const { scored } = searchGlyphs(sketchFrom(drawStickPerson(ICON_SIZE)), entries);
    expect(scored[0].entry.record.id).toBe('person');
  });

  it('крестик не обгоняет человечка за счёт одного только скелета', () => {
    const { scored } = searchGlyphs(sketchFrom(drawStickPerson(ICON_SIZE)), entries);
    const person = scored.find((item) => item.entry.record.id === 'person')!;
    const plus = scored.find((item) => item.entry.record.id === 'plus')!;

    // Это и была ошибка: у крестика скелет почти как у человечка,
    // и на одном скелете он выигрывал. Согласие нескольких гипотез обязательно.
    expect(person.metrics.score).toBeGreaterThan(plus.metrics.score);
  });

  it('обратный случай не сломан: набросок крестика находит крестик', () => {
    const { scored } = searchGlyphs(sketchFrom(drawPlus(ICON_SIZE, 20, 2)), entries);
    expect(['plus', 'circled-plus']).toContain(scored[0].entry.record.id);
  });
});

describe('метрики для панели деталей', () => {
  it('заполнены и лежат в разумных диапазонах', () => {
    const entries = [createGlyphEntry(glyph('person', drawFilledPerson(ICON_SIZE)))];
    const results = buildResults(
      searchGlyphs(sketchFrom(drawStickPerson(ICON_SIZE)), entries).scored,
    );

    const { metrics } = results[0];
    expect(metrics.score).toBeGreaterThan(0);
    expect(metrics.score).toBeLessThanOrEqual(1);
    expect(metrics.iou).toBeGreaterThanOrEqual(0);
    expect(metrics.iou).toBeLessThanOrEqual(1);
    expect(['fill', 'skeleton', 'contour']).toContain(metrics.hypothesis);
    expect(results[0].inkPixels).toBeGreaterThan(0);
    expect(results[0].sourceValue).toBe('test.woff');
  });

  it('intersectionOverUnion считает корректно на простом примере', () => {
    const a = blank();
    fillRect(a, ICON_SIZE, 0, 0, 9, 9); // 100 пикселей
    const b = blank();
    fillRect(b, ICON_SIZE, 5, 0, 14, 9); // 100 пикселей, пересечение 50
    expect(intersectionOverUnion(a, b)).toBeCloseTo(50 / 150, 5);
  });
});
