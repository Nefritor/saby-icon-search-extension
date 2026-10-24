/**
 * Прогон настоящего наброска из PNG: `npm run try-sketch -- рисунок.png [ещё.png] [--top=8]`.
 *
 * Рисунок готовится так же, как в popup (вписывается в 128×128 по центру, берётся альфа-канал),
 * затем идёт обычным путём поиска. Печатает топ по обученной модели и, для сравнения,
 * по прежней ручной формуле. Удобно, когда живой набросок ведёт себя хуже, чем синтетика:
 * такой PNG можно сохранить из холста (`canvas.toDataURL()`) и разбирать здесь.
 */
import { createCanvas, loadImage } from '@napi-rs/canvas';
import { searchGlyphs } from '../src/core/matching/matcher.ts';
import { params } from '../src/core/matching/params.ts';
import { prepareSketch } from '../src/core/matching/prepare.ts';
import { SKETCH_SOURCE_SIZE } from '../src/shared/constants.ts';
import { entries, itemByEntry } from './lib/glyphs.ts';

const files = process.argv.slice(2).filter((arg) => !arg.startsWith('--'));
const top = Number(process.argv.find((arg) => arg.startsWith('--top='))?.slice(6) ?? 8);
if (files.length === 0) throw new Error('Укажите PNG с наброском');

const defaultModel = params.rankModel;
// --alpha=40 — зафиксировать порог альфа-канала вместо подбора по Отсу.
const alphaArg = process.argv.find((arg) => arg.startsWith('--alpha='));
if (alphaArg) params.alphaThreshold = Number(alphaArg.slice(8));

for (const file of files) {
  const image = await loadImage(file);
  const canvas = createCanvas(SKETCH_SOURCE_SIZE, SKETCH_SOURCE_SIZE);
  const context = canvas.getContext('2d');
  const scale = Math.min(SKETCH_SOURCE_SIZE / image.width, SKETCH_SOURCE_SIZE / image.height);
  const width = image.width * scale;
  const height = image.height * scale;
  context.drawImage(
    image,
    (SKETCH_SOURCE_SIZE - width) / 2,
    (SKETCH_SOURCE_SIZE - height) / 2,
    width,
    height,
  );
  const rgba = context.getImageData(0, 0, SKETCH_SOURCE_SIZE, SKETCH_SOURCE_SIZE).data;
  const alpha = new Uint8Array(SKETCH_SOURCE_SIZE * SKETCH_SOURCE_SIZE);
  for (let i = 0; i < alpha.length; i += 1) alpha[i] = rgba[i * 4 + 3];

  const features = prepareSketch(alpha, SKETCH_SOURCE_SIZE, SKETCH_SOURCE_SIZE);
  if (!features) {
    console.log(`${file}: рисунка нет`);
    continue;
  }

  for (const [label, model] of [
    ['модель', defaultModel],
    ['ручная формула', null],
  ] as const) {
    params.rankModel = model;
    const { scored } = searchGlyphs(features, entries);
    console.log(`\n${file} — ${label}`);
    scored.slice(0, top).forEach(({ entry, metrics }, i) => {
      const name = itemByEntry.get(entry)?.className ?? `U+${entry.record.codePoint.toString(16)}`;
      console.log(
        `${String(i + 1).padStart(3)}. ${name.padEnd(28)} ${(metrics.score * 100).toFixed(1).padStart(5)}%`,
      );
    });
  }
}
