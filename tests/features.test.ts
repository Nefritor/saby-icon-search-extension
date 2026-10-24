import { describe, expect, it } from 'vitest';
import { distanceTransform, distanceTransformLabelled } from '../src/core/image/distanceTransform';
import { topology } from '../src/core/image/morphology';
import {
  NO_ORIENTATION,
  ORIENTATION_BINS,
  orientationGap,
  orientationMap,
} from '../src/core/image/orientation';
import { RANK_FEATURES } from '../src/core/matching/matcher';
import { params } from '../src/core/matching/params';
import { scoreModel } from '../src/core/matching/rank';

const SIZE = 32;

function blank(): Uint8Array {
  return new Uint8Array(SIZE * SIZE);
}

function set(mask: Uint8Array, x: number, y: number): void {
  mask[y * SIZE + x] = 1;
}

function hLine(mask: Uint8Array, y: number, from = 4, to = 27): void {
  for (let x = from; x <= to; x += 1) set(mask, x, y);
}

function vLine(mask: Uint8Array, x: number, from = 4, to = 27): void {
  for (let y = from; y <= to; y += 1) set(mask, x, y);
}

function ring(mask: Uint8Array, x0: number, y0: number, x1: number, y1: number): void {
  for (let x = x0; x <= x1; x += 1) {
    set(mask, x, y0);
    set(mask, x, y1);
  }
  for (let y = y0; y <= y1; y += 1) {
    set(mask, x0, y);
    set(mask, x1, y);
  }
}

describe('orientationMap', () => {
  it('различает горизонтальную и вертикальную линии', () => {
    const horizontal = blank();
    hLine(horizontal, 16);
    const vertical = blank();
    vLine(vertical, 16);

    const h = orientationMap(horizontal, SIZE)[16 * SIZE + 16];
    const v = orientationMap(vertical, SIZE)[16 * SIZE + 16];
    expect(h).toBe(0);
    expect(v).toBe(ORIENTATION_BINS / 2);
    expect(orientationGap(h, v)).toBe(ORIENTATION_BINS / 2);
  });

  it('не приписывает направление пятну и одиночной точке', () => {
    const blob = blank();
    for (let y = 12; y < 20; y += 1) for (let x = 12; x < 20; x += 1) set(blob, x, y);
    expect(orientationMap(blob, SIZE)[16 * SIZE + 16]).toBe(NO_ORIENTATION);

    const dot = blank();
    set(dot, 16, 16);
    expect(orientationMap(dot, SIZE)[16 * SIZE + 16]).toBe(NO_ORIENTATION);
  });

  it('штраф за разные направления не действует там, где направление неизвестно', () => {
    expect(orientationGap(NO_ORIENTATION, 3)).toBe(0);
    expect(orientationGap(7, 0)).toBe(1); // сектора замкнуты по кругу: 157.5° и 0° рядом
  });
});

describe('distanceTransformLabelled', () => {
  it('считает те же расстояния, что обычный, и переносит метку ближайшей точки', () => {
    const mask = blank();
    set(mask, 5, 16);
    set(mask, 26, 16);
    const labels = new Uint8Array(SIZE * SIZE);
    labels[16 * SIZE + 5] = 1;
    labels[16 * SIZE + 26] = 2;

    const plain = distanceTransform(mask, SIZE, SIZE);
    const { distance, nearest } = distanceTransformLabelled(mask, labels, SIZE, SIZE);
    expect(Array.from(distance)).toEqual(Array.from(plain));
    expect(nearest[16 * SIZE + 8]).toBe(1);
    expect(nearest[16 * SIZE + 23]).toBe(2);
  });
});

describe('topology', () => {
  it('считает куски и дырки', () => {
    const mask = blank();
    ring(mask, 4, 4, 14, 14); // кольцо: один кусок, одна дырка
    hLine(mask, 24, 4, 14); // отдельная линия
    expect(topology(mask, SIZE)).toEqual({ components: 2, holes: 1 });
  });

  it('рамка, достающая до края кадра, не создаёт дырки', () => {
    const mask = blank();
    for (let x = 4; x <= 14; x += 1) set(mask, x, 4);
    for (let y = 4; y <= 14; y += 1) set(mask, 4, y);
    expect(topology(mask, SIZE)).toEqual({ components: 1, holes: 0 });
  });

  it('диагональные соседи — один кусок', () => {
    const mask = blank();
    for (let i = 0; i < 10; i += 1) set(mask, 5 + i, 5 + i);
    expect(topology(mask, SIZE).components).toBe(1);
  });
});

describe('модель ранжирования', () => {
  it('вшитая модель обучена на том же наборе признаков, что считает матчер', () => {
    const model = params.rankModel;
    // Нет модели — поиск работает по ручной формуле; а вот модель от старого набора
    // признаков молча давала бы мусор, поэтому расхождение — ошибка.
    if (model) expect(model.features).toEqual([...RANK_FEATURES]);
  });

  it('scoreModel считает линейную и нелинейную части', () => {
    const model = {
      features: ['a', 'b'],
      mean: [0, 1],
      std: [1, 2],
      linear: [1, 0],
      hidden: [[0, 1]],
      bias: [0],
      output: [2],
    };
    // z = [3, (5-1)/2 = 2]; 1*3 + 2*tanh(2)
    expect(scoreModel(model, [3, 5])).toBeCloseTo(3 + 2 * Math.tanh(2), 10);
  });
});
