/**
 * Проверка на «живых» набросках: `npm run real-check [-- --weights=none|файл.json] [--verbose]`.
 *
 * В tests/sketches лежат PNG с холста popup (настоящий рендер: кисть 4 px, сглаженные линии,
 * лёгкое дрожание), нарисованные для разных понятий — конверт, домик, лупа, шестерёнка…
 * Для понятия задано регулярное выражение по именам классов: поиск считается удачным,
 * если среди пяти лучших есть любое подходящее имя (иконок «домик» в наборе много).
 * Это не замена честному набору рукописных рисунков, но ловит то, чего не видит синтетика:
 * хрупкость к сглаженным тонким линиям и к реальному рендеру холста.
 */
import { createCanvas, loadImage } from '@napi-rs/canvas';
import { readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { searchGlyphs } from '../src/core/matching/matcher.ts';
import { params } from '../src/core/matching/params.ts';
import { prepareSketch } from '../src/core/matching/prepare.ts';
import type { RankModel } from '../src/core/matching/rank.ts';
import { SKETCH_SOURCE_SIZE } from '../src/shared/constants.ts';
import { readFileSync } from 'node:fs';
import { entries, itemByEntry } from './lib/glyphs.ts';

/** Понятие → какие имена классов считать верным ответом. */
const CONCEPTS: Record<string, RegExp> = {
  envelope: /Mail|LetterNull/i,
  plus: /Plus/i,
  house: /Home/i,
  search: /Search/i,
  star: /Favorite|Star/i,
  trash: /Trash|Delete/i,
  gear: /Settings|Gear/i,
  calendar: /Calendar/i,
  clock: /^icon-Time|Clock/i,
  lock: /Lock/i,
  bell: /Bell/i,
  folder: /Folder/i,
  cloud: /Cloud/i,
  check: /Check|Yes|Success|Ok$/i,
  close: /Close|Cross/i,
  pencil: /Pencil|Edit/i,
  eye: /icon-eye/i,
  chat: /Chat|Message/i,
  arrowDown: /Arrow(Down|Up)|ArrowBig|MoveCell|Download|Trend/i,
  marker: /MapMarker/i,
};

const args = new Map(
  process.argv.slice(2).map((arg) => {
    const body = arg.replace(/^--/, '');
    const eq = body.indexOf('=');
    return (eq < 0 ? [body, 'true'] : [body.slice(0, eq), body.slice(eq + 1)]) as [string, string];
  }),
);
const weights = args.get('weights');
if (weights === 'none') params.rankModel = null;
else if (weights) params.rankModel = JSON.parse(readFileSync(weights, 'utf8')) as RankModel;
const verbose = args.has('verbose');
// --set=alignTop=0,coarseKeep=800 — подмена параметров поиска, как в eval.
for (const pair of (args.get('set') ?? '').split(',').filter(Boolean)) {
  const [key, value] = pair.split('=');
  if (!(key in params)) throw new Error(`Нет параметра ${key}`);
  (params as unknown as Record<string, number>)[key] = Number(value);
}
// --alpha=40 — зафиксировать порог альфа-канала вместо подбора по Отсу.
if (args.has('alpha')) params.alphaThreshold = Number(args.get('alpha'));

const dir = resolve(import.meta.dirname, '../tests/sketches');
let top1 = 0;
let top5 = 0;
let total = 0;
let mrr = 0;

for (const file of readdirSync(dir)
  .filter((name) => name.endsWith('.png'))
  .sort()) {
  const concept = file.replace(/\.png$/, '');
  const pattern = CONCEPTS[concept];
  if (!pattern) continue;

  const image = await loadImage(resolve(dir, file));
  const canvas = createCanvas(SKETCH_SOURCE_SIZE, SKETCH_SOURCE_SIZE);
  const context = canvas.getContext('2d');
  const scale = Math.min(SKETCH_SOURCE_SIZE / image.width, SKETCH_SOURCE_SIZE / image.height);
  context.drawImage(
    image,
    (SKETCH_SOURCE_SIZE - image.width * scale) / 2,
    (SKETCH_SOURCE_SIZE - image.height * scale) / 2,
    image.width * scale,
    image.height * scale,
  );
  const rgba = context.getImageData(0, 0, SKETCH_SOURCE_SIZE, SKETCH_SOURCE_SIZE).data;
  const alpha = new Uint8Array(SKETCH_SOURCE_SIZE * SKETCH_SOURCE_SIZE);
  for (let i = 0; i < alpha.length; i += 1) alpha[i] = rgba[i * 4 + 3];

  const features = prepareSketch(alpha, SKETCH_SOURCE_SIZE, SKETCH_SOURCE_SIZE);
  if (!features) continue;
  const { scored } = searchGlyphs(features, entries);
  const names = scored.map(({ entry }) => itemByEntry.get(entry)?.className ?? '');
  const rank = names.findIndex((name) => pattern.test(name));

  total += 1;
  if (rank === 0) top1 += 1;
  if (rank >= 0 && rank < 5) top5 += 1;
  mrr += rank >= 0 ? 1 / (rank + 1) : 0;
  const mark = rank === 0 ? '✓' : rank >= 0 && rank < 5 ? '~' : '✗';
  console.log(
    `${mark} ${concept.padEnd(10)} #${String(rank + 1).padEnd(4)} ${names
      .slice(0, verbose ? 6 : 3)
      .map(
        (name, i) => `${name.replace('icon-', '')} ${(scored[i].metrics.score * 100).toFixed(0)}%`,
      )
      .join(', ')}`,
  );
}

console.log(
  `\nИТОГО ${total} набросков: top-1 ${top1}, top-5 ${top5}, MRR ${(mrr / total).toFixed(3)}  [${params.rankModel ? 'модель' : 'ручная формула'}]`,
);
