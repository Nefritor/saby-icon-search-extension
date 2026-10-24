import { describe, expect, it } from 'vitest';
import { prepareSketch } from '../src/core/matching/prepare';

const SIZE = 128;

/**
 * Контур прямоугольника, у которого две стороны нарисованы уверенно, а две — бледно:
 * так выглядят тонкие линии на уменьшенном холсте, когда штрих попал между пикселями.
 */
function frame(strong: number, weak: number): Uint8Array {
  const out = new Uint8Array(SIZE * SIZE);
  for (let x = 20; x <= 108; x += 1) {
    for (const dy of [0, 1]) {
      out[(30 + dy) * SIZE + x] = strong;
      out[(89 + dy) * SIZE + x] = weak;
    }
  }
  for (let y = 30; y <= 90; y += 1) {
    for (const dx of [0, 1]) {
      out[y * SIZE + 20 + dx] = strong;
      out[y * SIZE + 107 + dx] = weak;
    }
  }
  return out;
}

describe('prepareSketch', () => {
  it('контур с бледными сторонами остаётся замкнутым и заливается', () => {
    const features = prepareSketch(frame(255, 60), SIZE, SIZE);
    expect(features).not.toBeNull();
    const fill = features?.variants.find((variant) => variant.rotation === 0)?.fitted.fill;
    // Залитый прямоугольник занимает почти весь кадр; незамкнутый контур дал бы одну рамку.
    expect(fill?.area).toBeGreaterThan(2000);
  });

  it('пустой лист и случайная точка — не набросок', () => {
    expect(prepareSketch(new Uint8Array(SIZE * SIZE), SIZE, SIZE)).toBeNull();
    const dot = new Uint8Array(SIZE * SIZE);
    dot[64 * SIZE + 64] = 255;
    expect(prepareSketch(dot, SIZE, SIZE)).toBeNull();
  });
});
