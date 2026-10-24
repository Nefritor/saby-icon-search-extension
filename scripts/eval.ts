/**
 * Оценочный стенд поиска: `npm run eval`.
 *
 * Берёт вшитые шрифт и стили, для случайных глифов синтезирует «рукописные» наброски
 * (поворот, перекос, дрожание линии, разная толщина кисти, четыре манеры рисования)
 * и считает, на каком месте в выдаче оказывается исходная иконка. Это замена гаданию
 * по отдельным примерам: любое изменение весов или алгоритма проверяется числами.
 *
 * Растеризация глифов идёт через @napi-rs/canvas с теми же параметрами, что в расширении,
 * а набросок проходит тот же `prepareSketch` и `searchGlyphs`, что и реальный поиск.
 *
 * Ключи: `--n=120` наброска на манеру, `--seed=1`, `--styles=outline,stroke`, `--verbose`,
 * `--jobs=16` процессов параллельно, `--set=precision=0.7,sigmaFill=3` — подмена параметров.
 */
import { createCanvas } from '@napi-rs/canvas';
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { boundary, fillHoles } from '../src/core/image/morphology.ts';
import { skeletonize } from '../src/core/image/skeleton.ts';
import { searchGlyphs } from '../src/core/matching/matcher.ts';
import { params } from '../src/core/matching/params.ts';
import { prepareSketch } from '../src/core/matching/prepare.ts';
import type { RankModel } from '../src/core/matching/rank.ts';
import { ICON_SIZE } from '../src/shared/constants.ts';
import { entries, itemByEntry, items, SOURCE, type Item } from './lib/glyphs.ts';

const args = new Map(
  process.argv.slice(2).map((arg) => {
    const body = arg.replace(/^--/, '');
    const eq = body.indexOf('=');
    return (eq < 0 ? [body, 'true'] : [body.slice(0, eq), body.slice(eq + 1)]) as [string, string];
  }),
);
const PER_STYLE = Number(args.get('n') ?? 120);
const SEED = Number(args.get('seed') ?? 1);
const VERBOSE = args.has('verbose');
/** Сила искажений: 0 — набросок равен глифу, 1 — стандартная, 2 — вдвое грубее. */
const LEVEL_ARG = args.get('level') ?? '1';
let LEVEL = Number(LEVEL_ARG);
const JOBS = Number(args.get('jobs') ?? 1);
const SKETCH = 128;

/* ------------------------------ случайность ------------------------------ */

function rng(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function gauss(random: () => number): number {
  return Math.sqrt(-2 * Math.log(1 - random())) * Math.cos(2 * Math.PI * random());
}

/* ------------------------------ наброски ------------------------------ */

type Style = 'solid' | 'silhouette' | 'outline' | 'stroke' | 'sloppy' | 'simplified';
const ALL_STYLES: Style[] = ['solid', 'silhouette', 'outline', 'stroke', 'sloppy', 'simplified'];

/** Отрезок кистью: точки вдоль линии, затем утолщение. */
function drawSegment(mask: Uint8Array, x0: number, y0: number, x1: number, y1: number): void {
  const steps = Math.ceil(Math.hypot(x1 - x0, y1 - y0));
  for (let i = 0; i <= steps; i += 1) {
    const x = Math.round(x0 + ((x1 - x0) * i) / Math.max(1, steps));
    const y = Math.round(y0 + ((y1 - y0) * i) / Math.max(1, steps));
    if (x >= 0 && y >= 0 && x < SKETCH && y < SKETCH) mask[y * SKETCH + x] = 1;
  }
}

/** Размытие + порог: скругляет углы и съедает мелкие детали, как неточная рука. */
function soften(mask: Uint8Array, size: number, radius: number): Uint8Array {
  const out = new Uint8Array(mask.length);
  const area = (2 * radius + 1) ** 2;
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      let sum = 0;
      for (let dy = -radius; dy <= radius; dy += 1) {
        for (let dx = -radius; dx <= radius; dx += 1) {
          const yy = y + dy;
          const xx = x + dx;
          if (yy >= 0 && xx >= 0 && yy < size && xx < size) sum += mask[yy * size + xx];
        }
      }
      out[y * size + x] = sum / area >= 0.45 ? 1 : 0;
    }
  }
  return out;
}

function distort(source: Uint8Array, random: () => number): Uint8Array {
  let x0 = SOURCE;
  let y0 = SOURCE;
  let x1 = -1;
  let y1 = -1;
  for (let y = 0; y < SOURCE; y += 1) {
    for (let x = 0; x < SOURCE; x += 1) {
      if (!source[y * SOURCE + x]) continue;
      x0 = Math.min(x0, x);
      x1 = Math.max(x1, x);
      y0 = Math.min(y0, y);
      y1 = Math.max(y1, y);
    }
  }
  const cx = (x0 + x1) / 2;
  const cy = (y0 + y1) / 2;
  const span = Math.max(x1 - x0, y1 - y0, 1);
  const scale = span / (SKETCH * (0.55 + random() * 0.35)); // пикселей источника на пиксель наброска
  const stretch = Math.exp(gauss(random) * 0.14 * LEVEL);
  const angle = (gauss(random) * 5 * LEVEL * Math.PI) / 180;
  const shear = gauss(random) * 0.05 * LEVEL;
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);
  const offsetX = (random() - 0.5) * 8;
  const offsetY = (random() - 0.5) * 8;

  // Дрожание руки: низкочастотные волны по каждой оси.
  const amp = random() * 3.2 * LEVEL;
  const waves = [0, 1, 2, 3].map(() => ({
    f: 0.04 + random() * 0.07,
    p: random() * 6.28,
  }));

  const out = new Uint8Array(SKETCH * SKETCH);
  const half = SKETCH / 2;
  for (let y = 0; y < SKETCH; y += 1) {
    for (let x = 0; x < SKETCH; x += 1) {
      const wx =
        amp * (Math.sin(waves[0].f * y + waves[0].p) + Math.sin(waves[1].f * x + waves[1].p));
      const wy =
        amp * (Math.sin(waves[2].f * x + waves[2].p) + Math.sin(waves[3].f * y + waves[3].p));
      const dx = x - half - offsetX + wx;
      const dy = y - half - offsetY + wy;
      const rx = (cos * dx + sin * dy) * stretch + shear * dy;
      const ry = -sin * dx + cos * dy;
      const sx = Math.round(cx + rx * scale);
      const sy = Math.round(cy + ry * scale);
      if (sx < 0 || sy < 0 || sx >= SOURCE || sy >= SOURCE) continue;
      out[y * SKETCH + x] = source[sy * SOURCE + sx];
    }
  }
  return out;
}

function makeSketch(source: Uint8Array, style: Style, random: () => number): Uint8Array {
  let ink = distort(source, random);
  if (random() < 0.6 * Math.min(1, LEVEL)) ink = soften(ink, SKETCH, 1 + Math.floor(random() * 2));

  // fill — пиксели закрашиваются целиком; curve — тонкая линия, которую потом обводит кисть.
  let kind: 'fill' | 'curve' = 'fill';
  let drawn: Uint8Array;
  switch (style) {
    case 'solid':
      drawn = ink;
      break;
    case 'silhouette':
      drawn = fillHoles(ink, SKETCH, SKETCH);
      break;
    case 'outline':
      drawn = boundary(fillHoles(ink, SKETCH, SKETCH), SKETCH, SKETCH);
      kind = 'curve';
      break;
    case 'stroke':
      drawn = skeletonize(ink, SKETCH);
      kind = 'curve';
      break;
    case 'sloppy': {
      // Штрихи с разрывами и лишними росчерками: рука уводит линию и дорисовывает не то.
      const lines = skeletonize(ink, SKETCH);
      const points: number[] = [];
      for (let i = 0; i < lines.length; i += 1) if (lines[i]) points.push(i);
      for (let k = 0; k < 3 + Math.floor(random() * 4) && points.length > 0; k += 1) {
        const centre = points[Math.floor(random() * points.length)];
        const cx = centre % SKETCH;
        const cy = Math.floor(centre / SKETCH);
        const radius = 2 + random() * 2.5;
        for (
          let y = Math.max(0, Math.floor(cy - radius));
          y < Math.min(SKETCH, cy + radius);
          y += 1
        ) {
          for (
            let x = Math.max(0, Math.floor(cx - radius));
            x < Math.min(SKETCH, cx + radius);
            x += 1
          ) {
            lines[y * SKETCH + x] = 0;
          }
        }
      }
      for (let k = 0; k < Math.floor(random() * 3) && points.length > 0; k += 1) {
        const start = points[Math.floor(random() * points.length)];
        const angle = random() * Math.PI * 2;
        const length = 8 + random() * 18;
        const sx = start % SKETCH;
        const sy = Math.floor(start / SKETCH);
        drawSegment(lines, sx, sy, sx + Math.cos(angle) * length, sy + Math.sin(angle) * length);
      }
      drawn = lines;
      kind = 'curve';
      break;
    }
    case 'simplified': {
      // Сильное упрощение: детали сглажены в пятно, дальше рисуем его по-разному.
      let blob = soften(fillHoles(ink, SKETCH, SKETCH), SKETCH, 3);
      if (random() < 0.5) blob = soften(blob, SKETCH, 2);
      const pick = random();
      if (pick < 0.4) {
        drawn = blob;
      } else if (pick < 0.75) {
        drawn = boundary(blob, SKETCH, SKETCH);
        kind = 'curve';
      } else {
        drawn = skeletonize(blob, SKETCH);
        kind = 'curve';
      }
      break;
    }
  }
  // Ленивая рука: часть деталей просто не дорисована. Стираем несколько пятен с самого рисунка.
  if (random() < 0.5 * Math.min(1, LEVEL)) {
    const points: number[] = [];
    for (let i = 0; i < drawn.length; i += 1) if (drawn[i]) points.push(i);
    const patches = 1 + Math.floor(random() * 3);
    for (let k = 0; k < patches && points.length > 0; k += 1) {
      const centre = points[Math.floor(random() * points.length)];
      const cx = centre % SKETCH;
      const cy = Math.floor(centre / SKETCH);
      const radius = 5 + random() * 8;
      for (
        let y = Math.max(0, Math.floor(cy - radius));
        y < Math.min(SKETCH, cy + radius);
        y += 1
      ) {
        for (
          let x = Math.max(0, Math.floor(cx - radius));
          x < Math.min(SKETCH, cx + radius);
          x += 1
        ) {
          if ((x - cx) ** 2 + (y - cy) ** 2 <= radius * radius) drawn[y * SKETCH + x] = 0;
        }
      }
    }
  }

  return renderLikeUi(drawn, kind, random);
}

/** Холст popup, как в SketchCanvas: 324×226, кисть 4…20 px, цвет штриха, сглаживание. */
const UI_WIDTH = 324;
const UI_HEIGHT = 226;

/**
 * Рисует набросок так, как его получит движок из реального popup: линии кистью на холсте
 * 324×226 со сглаженными краями, затем вписывание в 128×128 и альфа-канал (exportSketch).
 * Без этого стенд видит идеально чёткие бинарные штрихи, которых в жизни не бывает, и модель,
 * обученная на них, ошибается на тонких сглаженных линиях настоящего холста.
 */
function renderLikeUi(
  pixels: Uint8Array,
  kind: 'fill' | 'curve',
  random: () => number,
): Uint8Array {
  const canvas = createCanvas(UI_WIDTH, UI_HEIGHT);
  const context = canvas.getContext('2d');
  context.fillStyle = 'rgb(24, 24, 27)';

  // Ширина кисти: чаще всего минимальная, как по умолчанию в интерфейсе.
  const roll = random();
  const width = roll < 0.45 ? 4 : roll < 0.7 ? 6 : roll < 0.85 ? 8 : roll < 0.95 ? 12 : 20;
  // Насколько крупно нарисован значок: от 80% до 100% высоты холста.
  const scale = (UI_HEIGHT / SKETCH) * (0.8 + random() * 0.2);

  for (let y = 0; y < SKETCH; y += 1) {
    for (let x = 0; x < SKETCH; x += 1) {
      if (!pixels[y * SKETCH + x]) continue;
      const cx = UI_WIDTH / 2 + (x - SKETCH / 2) * scale;
      const cy = UI_HEIGHT / 2 + (y - SKETCH / 2) * scale;
      if (kind === 'curve') {
        context.beginPath();
        context.arc(cx, cy, width / 2, 0, Math.PI * 2);
        context.fill();
      } else {
        context.fillRect(cx - scale / 2 - 0.3, cy - scale / 2 - 0.3, scale + 0.6, scale + 0.6);
      }
    }
  }

  // Дальше — ровно exportSketch из SketchCanvas.
  const exported = createCanvas(SKETCH, SKETCH);
  const exportContext = exported.getContext('2d');
  const fit = Math.min(SKETCH / UI_WIDTH, SKETCH / UI_HEIGHT);
  exportContext.drawImage(
    canvas,
    (SKETCH - UI_WIDTH * fit) / 2,
    (SKETCH - UI_HEIGHT * fit) / 2,
    UI_WIDTH * fit,
    UI_HEIGHT * fit,
  );
  const rgba = exportContext.getImageData(0, 0, SKETCH, SKETCH).data;
  const alpha = new Uint8Array(SKETCH * SKETCH);
  for (let i = 0; i < alpha.length; i += 1) alpha[i] = rgba[i * 4 + 3];
  return alpha;
}

/* ------------------------------ прогон ------------------------------ */

interface Counts {
  n: number;
  top1: number;
  top5: number;
  top10: number;
  mrr: number;
  ms: number;
  misses: string[];
}
type Result = Record<string, Counts>;

const DUMP = args.get('dump');
const dumped: Array<{
  alpha: Uint8Array;
  target: Item;
  tops: Item[];
  rank: number;
  style: string;
}> = [];

const emptyCounts = (): Counts => ({ n: 0, top1: 0, top5: 0, top10: 0, mrr: 0, ms: 0, misses: [] });

const styles = (args.get('styles')?.split(',') as Style[] | undefined) ?? ALL_STYLES;

// Перебор параметров: --set=precision=0.7,sigmaFill=3
for (const pair of (args.get('set') ?? '').split(',').filter(Boolean)) {
  const [key, value] = pair.split('=');
  if (!(key in params)) throw new Error(`Нет параметра ${key}`);
  // Массивы задаются через «;»: --set=ключ=1;2;3 (массив)
  (params as unknown as Record<string, number | number[]>)[key] = value.includes(';')
    ? value.split(';').map(Number)
    : Number(value);
}
const WEIGHTS = args.get('weights');
// --weights=файл.json — другая модель, --weights=none — ручная формула без модели.
if (WEIGHTS === 'none') params.rankModel = null;
else if (WEIGHTS) params.rankModel = JSON.parse(readFileSync(WEIGHTS, 'utf8')) as RankModel;
const COLLECT = args.get('collect');
if (COLLECT) params.collectFeatures = true;

const pool = items.map((_, index) => index);
{
  const shuffle = rng(SEED);
  for (let i = pool.length - 1; i > 0; i -= 1) {
    const j = Math.floor(shuffle() * (i + 1));
    [pool[i], pool[j]] = [pool[j], pool[i]];
  }
}

function runShard(shard: number, shards: number): Result {
  const result: Result = {};
  styles.forEach((style, styleIndex) => {
    const stat = (result[style] = emptyCounts());
    for (let k = shard; k < PER_STYLE; k += shards) {
      const item = items[pool[k % pool.length]];
      // Свой генератор на каждый набросок: результат не зависит от разбиения на процессы.
      const random = rng(SEED * 1_000_003 + styleIndex * 10_007 + k);
      // --level=mixed: сила искажений своя у каждого наброска (для обучения).
      if (LEVEL_ARG === 'mixed') LEVEL = 0.4 + 1.2 * random();
      const alpha = makeSketch(item.source, style, random);
      const features = prepareSketch(alpha, SKETCH, SKETCH);
      if (!features) continue;

      const started = performance.now();
      const { scored } = searchGlyphs(features, entries);
      stat.ms += performance.now() - started;

      if (COLLECT) {
        // Для обучения ранжирования: признаки лучших кандидатов (по ручной формуле) и положительных.
        const rows = scored
          .map(({ entry, metrics }, position) => ({
            position,
            label: itemByEntry.get(entry)?.hash === item.hash ? 1 : 0,
            f: metrics.features?.map((v) => Math.round(v * 10000) / 10000),
          }))
          .filter((row) => row.position < 100 || row.label === 1);
        appendFileSync(
          `${COLLECT}.${shard}.jsonl`,
          `${JSON.stringify(rows)}
`,
        );
      }

      // Попадание — любой глиф с той же маской: алиасы одной картинки неразличимы.
      const rank = scored.findIndex(({ entry }) => itemByEntry.get(entry)?.hash === item.hash);
      stat.n += 1;
      if (rank === 0) stat.top1 += 1;
      if (rank >= 0 && rank < 5) stat.top5 += 1;
      if (rank >= 0 && rank < 10) stat.top10 += 1;
      stat.mrr += rank >= 0 ? 1 / (rank + 1) : 0;
      if (DUMP && rank >= 3 && dumped.length < 24) {
        dumped.push({
          alpha,
          target: item,
          tops: scored.slice(0, 3).map(({ entry }) => itemByEntry.get(entry) as Item),
          rank,
          style,
        });
      }
      if (rank >= 5 || rank < 0) {
        const top = scored
          .slice(0, 2)
          .map(({ entry }) => itemByEntry.get(entry)?.className.replace('icon-', ''));
        stat.misses.push(`${item.className.replace('icon-', '')}(#${rank + 1}→${top.join('/')})`);
      }
    }
  });
  return result;
}

function report(result: Result): void {
  const total = emptyCounts();
  for (const style of styles) {
    const stat = result[style];
    const pct = (value: number) => `${((100 * value) / stat.n).toFixed(1)}%`.padStart(6);
    console.log(
      `${style.padEnd(11)} top1 ${pct(stat.top1)}  top5 ${pct(stat.top5)}  top10 ${pct(stat.top10)}  MRR ${(stat.mrr / stat.n).toFixed(3)}`,
    );
    if (VERBOSE && stat.misses.length > 0)
      console.log(`   промахи: ${stat.misses.slice(0, 25).join(', ')}`);
    for (const key of ['n', 'top1', 'top5', 'top10', 'mrr', 'ms'] as const) total[key] += stat[key];
  }
  console.log(
    `ИТОГО       top1 ${((100 * total.top1) / total.n).toFixed(1)}%  top5 ${((100 * total.top5) / total.n).toFixed(1)}%  MRR ${(total.mrr / total.n).toFixed(3)}  ср. поиск ${(total.ms / total.n).toFixed(0)} мс`,
  );
}

function merge(parts: Result[]): Result {
  const out: Result = {};
  for (const style of styles) {
    const sum = emptyCounts();
    for (const part of parts) {
      const stat = part[style];
      for (const key of ['n', 'top1', 'top5', 'top10', 'mrr', 'ms'] as const) sum[key] += stat[key];
      sum.misses.push(...stat.misses);
    }
    out[style] = sum;
  }
  return out;
}

const workerArg = args.get('worker');
if (workerArg !== undefined) {
  // Дочерний процесс: считает свою долю и отдаёт сырые числа.
  console.log(`RESULT ${JSON.stringify(runShard(Number(workerArg), JOBS))}`);
} else if (JOBS > 1) {
  const { spawn } = await import('node:child_process');
  const passthrough = process.argv.slice(2).filter((arg) => !arg.startsWith('--worker'));
  const runWorker = (index: number) =>
    new Promise<Result>((resolveWorker, reject) => {
      const child = spawn(
        process.execPath,
        ['--import', 'tsx', fileURLToPath(import.meta.url), ...passthrough, `--worker=${index}`],
        { stdio: ['ignore', 'pipe', 'inherit'] },
      );
      let output = '';
      child.stdout.on('data', (chunk) => (output += chunk));
      child.on('close', (code) => {
        const line = output.split('\n').find((row) => row.startsWith('RESULT '));
        if (code === 0 && line) resolveWorker(JSON.parse(line.slice(7)) as Result);
        else reject(new Error(`worker ${index} завершился с кодом ${code}`));
      });
    });
  const parts = await Promise.all(Array.from({ length: JOBS }, (_, index) => runWorker(index)));
  console.log(
    `глифов в индексе: ${entries.length}, наброска на манеру: ${PER_STYLE}, seed=${SEED}, jobs=${JOBS}`,
  );
  report(merge(parts));
} else {
  console.log(
    `глифов в индексе: ${entries.length}, наброска на манеру: ${PER_STYLE}, seed=${SEED}`,
  );
  report(runShard(0, 1));
  if (DUMP) {
    const cell = 96;
    const canvas = createCanvas(cell * 5, cell * dumped.length);
    const context = canvas.getContext('2d');
    context.fillStyle = '#fff';
    context.fillRect(0, 0, canvas.width, canvas.height);
    const draw = (mask: Uint8Array, size: number, col: number, row: number, color: string) => {
      const image = context.createImageData(size, size);
      for (let i = 0; i < mask.length; i += 1) {
        const v = mask[i] ? 0 : 255;
        image.data[i * 4] = color === 'red' && mask[i] ? 220 : v;
        image.data[i * 4 + 1] = v;
        image.data[i * 4 + 2] = v;
        image.data[i * 4 + 3] = 255;
      }
      const tmp = createCanvas(size, size);
      tmp.getContext('2d').putImageData(image, 0, 0);
      context.imageSmoothingEnabled = false;
      context.drawImage(tmp, col * cell, row * cell, cell, cell);
    };
    dumped.forEach((d, row) => {
      draw(
        d.alpha.map((v) => (v > 100 ? 1 : 0)),
        SKETCH,
        0,
        row,
        'red',
      );
      draw(d.target.entry.record.mask, ICON_SIZE, 1, row, 'black');
      d.tops.forEach((top, i) => draw(top.entry.record.mask, ICON_SIZE, 2 + i, row, 'black'));
      context.fillStyle = '#06f';
      context.font = '10px sans-serif';
      context.fillText(
        d.style + ' #' + (d.rank + 1) + ' ' + d.target.className.replace('icon-', ''),
        2,
        row * cell + 10,
      );
    });
    writeFileSync(DUMP, canvas.toBuffer('image/png'));
  }
}
