/**
 * Обученная модель ранжирования кандидатов: линейная часть плюс сеть в один скрытый слой.
 * Обучается скриптом `scripts/train-ranker.ts` на синтетических набросках, а здесь только
 * считается: несколько десятков умножений на кандидата.
 */
export interface RankModel {
  /** Названия признаков в порядке входа — для сверки с RANK_FEATURES при загрузке. */
  features: string[];
  mean: number[];
  std: number[];
  linear: number[];
  /** Веса скрытого слоя: `hidden[j][k]` — вес признака k у нейрона j. */
  hidden: number[][];
  bias: number[];
  output: number[];
  /** Температура softmax: логиты делятся на неё, чтобы вероятности не были чрезмерно резкими. */
  temperature?: number;
}

/** Логит модели для вектора признаков. Чем больше, тем вероятнее, что это та самая иконка. */
export function scoreModel(model: RankModel, features: ArrayLike<number>): number {
  const { mean, std, linear, hidden, bias, output } = model;
  const z = new Float64Array(linear.length);
  let out = 0;
  for (let k = 0; k < z.length; k += 1) {
    z[k] = (features[k] - mean[k]) / std[k];
    out += linear[k] * z[k];
  }
  for (let j = 0; j < hidden.length; j += 1) {
    let sum = bias[j];
    const row = hidden[j];
    for (let k = 0; k < z.length; k += 1) sum += row[k] * z[k];
    out += output[j] * Math.tanh(sum);
  }
  return out / (model.temperature ?? 1);
}
