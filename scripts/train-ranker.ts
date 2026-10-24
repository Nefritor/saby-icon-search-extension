/**
 * Обучение модели ранжирования:
 * `npm run train-ranker -- --data=/tmp/a,/tmp/b --out=src/core/matching/rankModel.json`
 * (необязательно: `--hidden=24 --epochs=50 --stride=2 --noise=0.2`).
 *
 * Данные собирает `npm run eval -- --collect=<префикс>` (префиксов можно дать несколько):
 * для каждого синтетического наброска
 * там лежат признаки кандидатов и метка «это та самая иконка». Модель — линейная часть плюс
 * небольшая сеть (один скрытый слой с tanh), потери — listwise softmax: верный кандидат
 * должен получить как можно большую долю вероятности в пуле. Оптимизатор — Adam.
 * Печатает точность на отложенной пятой части запросов.
 *
 * Против хрупкости: на входе обучения добавляется шум (`--noise`), а в конце подбирается
 * температура softmax по отложенной части — модель не должна уверенно врать на непривычных
 * входах. Результат — JSON с моделью (см. RankModel в src/core/matching/rank.ts).
 */
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, dirname, resolve } from 'node:path';
import { RANK_FEATURES } from '../src/core/matching/matcher.ts';
import { scoreModel, type RankModel } from '../src/core/matching/rank.ts';

interface Row {
  label: number;
  f: number[];
}

const flags = new Map(
  process.argv
    .slice(2)
    .filter((arg) => arg.startsWith('--'))
    .map((arg) => {
      const eq = arg.indexOf('=');
      return [arg.slice(2, eq < 0 ? undefined : eq), eq < 0 ? 'true' : arg.slice(eq + 1)] as const;
    }),
);
const prefixes = (flags.get('data') ?? '').split(',').filter(Boolean);
const outPath = flags.get('out') ?? 'rankModel.json';
if (prefixes.length === 0) throw new Error('Укажите данные: --data=/tmp/train/a,/tmp/train/b');
/** Шум на входе обучения в долях стандартного отклонения признака. */
const NOISE = Number(flags.get('noise') ?? 0.15);

const HIDDEN = Number(flags.get('hidden') ?? 16);
const EPOCHS = Number(flags.get('epochs') ?? 80);
/** Берём каждый k-й запрос, чтобы уложиться в память: 10 тысяч запросов — уже сотни МБ чисел. */
const STRIDE = Number(flags.get('stride') ?? 1);

const queries: Row[][] = [];
for (const prefix of prefixes) {
  const dir = dirname(resolve(prefix));
  for (const name of readdirSync(dir)) {
    if (!name.startsWith(`${basename(prefix)}.`) || !name.endsWith('.jsonl')) continue;
    let lineNumber = 0;
    for (const line of readFileSync(resolve(dir, name), 'utf8').split('\n')) {
      if (!line) continue;
      lineNumber += 1;
      if (lineNumber % STRIDE !== 0) continue;
      const rows = (JSON.parse(line) as Row[]).filter((row) => row.f);
      // Запрос без верного кандидата в пуле ничему не учит: ранжирование его не починит.
      if (rows.some((row) => row.label === 1) && rows.some((row) => row.label === 0)) {
        queries.push(rows);
      }
    }
  }
}
// Наборы идут подряд, поэтому перемешиваем: отложенная часть должна быть из всех источников.
{
  let state = 99;
  for (let i = queries.length - 1; i > 0; i -= 1) {
    state = (state * 1664525 + 1013904223) >>> 0;
    const j = state % (i + 1);
    [queries[i], queries[j]] = [queries[j], queries[i]];
  }
}

const dim = RANK_FEATURES.length;
const train = queries.filter((_, i) => i % 5 !== 0);
const test = queries.filter((_, i) => i % 5 === 0);
console.log(
  `запросов: ${queries.length} (обучение ${train.length}, проверка ${test.length}), признаков: ${dim}, скрытых: ${HIDDEN}`,
);

/* ------------------------------ стандартизация ------------------------------ */

const mean = new Array<number>(dim).fill(0);
const std = new Array<number>(dim).fill(0);
{
  let count = 0;
  for (const rows of train) {
    for (const row of rows) {
      count += 1;
      row.f.forEach((value, k) => (mean[k] += value));
    }
  }
  mean.forEach((_, k) => (mean[k] /= count));
  for (const rows of train) {
    for (const row of rows) row.f.forEach((value, k) => (std[k] += (value - mean[k]) ** 2));
  }
  std.forEach((_, k) => (std[k] = Math.sqrt(std[k] / count) || 1));
}
const standardize = (rows: Row[][]): Float64Array[][] =>
  rows.map((set) =>
    set.map((row) => Float64Array.from(row.f, (value, k) => (value - mean[k]) / std[k])),
  );
const trainZ = standardize(train);
const testZ = standardize(test);

/* ------------------------------ модель ------------------------------ */

const random = (() => {
  let state = 12345;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 4294967296;
  };
})();

const linear = new Float64Array(dim);
const W1 = Array.from({ length: HIDDEN }, () =>
  Float64Array.from({ length: dim }, () => (random() - 0.5) * 0.3),
);
const b1 = new Float64Array(HIDDEN);
const w2 = Float64Array.from({ length: HIDDEN }, () => (random() - 0.5) * 0.3);

/** Все обучаемые параметры одним вектором — для Adam. */
const sizeTotal = dim + HIDDEN * dim + HIDDEN + HIDDEN;
const flat = new Float64Array(sizeTotal);
const m = new Float64Array(sizeTotal);
const v = new Float64Array(sizeTotal);
function pack(): void {
  let o = 0;
  flat.set(linear, o);
  o += dim;
  for (const row of W1) {
    flat.set(row, o);
    o += dim;
  }
  flat.set(b1, o);
  o += HIDDEN;
  flat.set(w2, o);
}
function unpack(): void {
  let o = 0;
  linear.set(flat.subarray(o, o + dim));
  o += dim;
  for (const row of W1) {
    row.set(flat.subarray(o, o + dim));
    o += dim;
  }
  b1.set(flat.subarray(o, o + HIDDEN));
  o += HIDDEN;
  w2.set(flat.subarray(o, o + HIDDEN));
}
// Начало: линейная часть опирается на нормированные скоры — как ручная формула.
for (const name of ['normFill', 'normSkeleton', 'normContour'] as const) {
  linear[RANK_FEATURES.indexOf(name)] = 0.5;
}
pack();

function forward(z: Float64Array, hidden: Float64Array): number {
  let out = 0;
  for (let k = 0; k < dim; k += 1) out += linear[k] * z[k];
  for (let h = 0; h < HIDDEN; h += 1) {
    let sum = b1[h];
    const row = W1[h];
    for (let k = 0; k < dim; k += 1) sum += row[k] * z[k];
    hidden[h] = Math.tanh(sum);
    out += w2[h] * hidden[h];
  }
  return out;
}

function gaussian(): number {
  return Math.sqrt(-2 * Math.log(1 - random())) * Math.cos(2 * Math.PI * random());
}

/** Потери одного запроса; при `grad` — ещё и накопление градиента (с шумом на входе). */
function queryLoss(clean: Float64Array[], rows: Row[], grad?: Float64Array): number {
  const set =
    grad && NOISE > 0
      ? clean.map((z) => Float64Array.from(z, (value) => value + NOISE * gaussian()))
      : clean;
  const hiddens = set.map(() => new Float64Array(HIDDEN));
  const logits = set.map((z, i) => forward(z, hiddens[i]));
  const top = Math.max(...logits);
  const exps = logits.map((logit) => Math.exp(logit - top));
  const total = exps.reduce((a, b) => a + b, 0);
  let positive = 0;
  rows.forEach((row, i) => {
    if (row.label === 1) positive += exps[i];
  });

  if (grad) {
    set.forEach((z, i) => {
      const dLogit = exps[i] / total - (rows[i].label === 1 ? exps[i] / positive : 0);
      if (Math.abs(dLogit) < 1e-9) return;
      let o = 0;
      for (let k = 0; k < dim; k += 1) grad[o + k] += dLogit * z[k];
      o += dim;
      const hidden = hiddens[i];
      for (let h = 0; h < HIDDEN; h += 1) {
        const dHidden = dLogit * w2[h] * (1 - hidden[h] * hidden[h]);
        const base = o + h * dim;
        for (let k = 0; k < dim; k += 1) grad[base + k] += dHidden * z[k];
        grad[o + HIDDEN * dim + h] += dHidden;
        grad[o + HIDDEN * dim + HIDDEN + h] += dLogit * hidden[h];
      }
    });
  }
  return -Math.log(positive / total + 1e-12);
}

function evaluate(
  sets: Float64Array[][],
  source: Row[][],
): { top1: number; top5: number; loss: number } {
  let top1 = 0;
  let top5 = 0;
  let loss = 0;
  const hidden = new Float64Array(HIDDEN);
  sets.forEach((set, q) => {
    const ranked = set
      .map((z, i) => ({ label: source[q][i].label, logit: forward(z, hidden) }))
      .sort((a, b) => b.logit - a.logit);
    if (ranked[0].label === 1) top1 += 1;
    if (ranked.slice(0, 5).some((row) => row.label === 1)) top5 += 1;
    loss += queryLoss(set, source[q]);
  });
  return { top1: top1 / sets.length, top5: top5 / sets.length, loss: loss / sets.length };
}

const show = (r: { top1: number; top5: number; loss: number }) =>
  `top1 ${(100 * r.top1).toFixed(1)}% top5 ${(100 * r.top5).toFixed(1)}% loss ${r.loss.toFixed(3)}`;

console.log(`до обучения: проверка ${show(evaluate(testZ, test))}`);

const L2 = 2e-4;
const BATCH = 128;
let step = 0;
let bestLoss = Infinity;
let bestFlat = flat.slice();

for (let epoch = 1; epoch <= EPOCHS; epoch += 1) {
  const learningRate = 0.01 * (0.5 + 0.5 * Math.cos((Math.PI * epoch) / EPOCHS));
  const order = Array.from({ length: trainZ.length }, (_, i) => i).sort(() => random() - 0.5);

  for (let start = 0; start < order.length; start += BATCH) {
    const grad = new Float64Array(sizeTotal);
    const batch = order.slice(start, start + BATCH);
    for (const index of batch) queryLoss(trainZ[index], train[index], grad);

    step += 1;
    for (let k = 0; k < sizeTotal; k += 1) {
      const g = grad[k] / batch.length + L2 * flat[k];
      m[k] = 0.9 * m[k] + 0.1 * g;
      v[k] = 0.999 * v[k] + 0.001 * g * g;
      flat[k] -=
        (learningRate * (m[k] / (1 - 0.9 ** step))) /
        (Math.sqrt(v[k] / (1 - 0.999 ** step)) + 1e-8);
    }
    unpack();
  }

  if (epoch % 10 === 0 || epoch === EPOCHS) {
    const result = evaluate(testZ, test);
    console.log(
      `эпоха ${epoch}: обучение ${show(evaluate(trainZ.slice(0, 600), train.slice(0, 600)))} | проверка ${show(result)}`,
    );
    if (result.loss < bestLoss) {
      bestLoss = result.loss;
      bestFlat = flat.slice();
    }
  }
}

flat.set(bestFlat);
unpack();

// Температура softmax по отложенной части: ищем T, минимизирующее потери проверки.
let temperature = 1;
{
  let best = Infinity;
  for (let t = 0.6; t <= 4.01; t += 0.1) {
    let loss = 0;
    testZ.forEach((set, q) => {
      const logits = set.map((z) => forward(z, new Float64Array(HIDDEN)) / t);
      const top = Math.max(...logits);
      const exps = logits.map((logit) => Math.exp(logit - top));
      const total = exps.reduce((a, b) => a + b, 0);
      let positive = 0;
      test[q].forEach((row, i) => {
        if (row.label === 1) positive += exps[i];
      });
      loss += -Math.log(positive / total + 1e-12);
    });
    loss /= testZ.length;
    if (loss < best) {
      best = loss;
      temperature = Math.round(t * 10) / 10;
    }
  }
  console.log(`температура: ${temperature} (потери проверки ${best.toFixed(3)})`);
}

const round = (value: number) => Math.round(value * 1e5) / 1e5;
const model: RankModel = {
  features: [...RANK_FEATURES],
  mean: mean.map(round),
  std: std.map(round),
  linear: Array.from(linear, round),
  hidden: Array.from(W1, (row) => Array.from(row, round)),
  bias: Array.from(b1, round),
  output: Array.from(w2, round),
  temperature,
};

// Самопроверка: модель из JSON должна давать те же логиты, что и обучавшаяся.
const probe = test[0][0].f;
const z = Float64Array.from(probe, (value, k) => (value - mean[k]) / std[k]);
const drift = Math.abs(
  scoreModel(model, probe) * temperature - forward(z, new Float64Array(HIDDEN)),
);
console.log(`расхождение сериализации: ${drift.toExponential(2)}`);

writeFileSync(outPath, `${JSON.stringify(model)}\n`);
console.log(`модель записана в ${outPath}`);
