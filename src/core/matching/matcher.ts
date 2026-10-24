import {
  COARSE_SIZE,
  ICON_MARGIN,
  ICON_SIZE,
  PREVIEW_SIZE,
  RESULT_COUNT,
  ROTATIONS_DEG,
} from '../../shared/constants';
import type { GlyphMetrics, GlyphRecord, SearchResult } from '../../shared/types';
import { computeHog, hogSimilarity } from '../features/hog';
import { bytesToBase64 } from '../image/bits';
import { distanceTransformLabelled, toPixels } from '../image/distanceTransform';
import { boundary, fillHoles, topology } from '../image/morphology';
import {
  downsampleMask,
  intersectionOverUnion,
  normalizeMask,
  rotateMask,
  stretchMask,
  type NormalizedMask,
} from '../image/normalize';
import { ORIENTATION_BINS, orientationGap, orientationMap } from '../image/orientation';
import { skeletonize } from '../image/skeleton';
import { params } from './params';
import { scoreModel, type RankModel } from './rank';

/**
 * Множество точек, по которому считается расстояние:
 * `probe` — сами точки (границы силуэта или пиксели скелета),
 * `edt` — карта расстояний до них, `mask` — область для IoU.
 */
interface Shape {
  mask: Uint8Array;
  probe: Uint8Array;
  probeCount: number;
  edt: Uint16Array;
  /** Площадь маски, px. */
  area: number;
  /** Направление линии у ближайшей к пикселю точки probe (см. image/orientation). */
  nearOri: Uint8Array;
  /** Направление линии в каждой точке probe, в порядке `indices`. */
  probeOri: Uint8Array;
  size: number;
  /** Индексы точек probe. Считаются лениво: сканировать 4096 пикселей на каждый
   *  шампфер впустую — самая дорогая часть поиска. */
  indices?: Int32Array;
  /** Координаты точек probe — для сдвигов и масштабов при выравнивании. */
  xs?: Int16Array;
  ys?: Int16Array;
}

/** Три представления одной фигуры — по одному на каждую гипотезу. */
interface Shapes {
  /** Залитый силуэт: контур как probe, маска для IoU. */
  fill: Shape;
  /** Медиальная ось залитого силуэта. */
  skeleton: Shape;
  /** Исходные линии: у наброска — штрихи, у глифа — его чернила. */
  ink: Shape;
  /** Связные куски и дырки в исходных чернилах. */
  components: number;
  holes: number;
  /** Профили проекций залитого силуэта на оси: PROFILE_BINS столбцов, затем PROFILE_BINS строк. */
  profile: Float32Array;
}

const PROFILE_BINS = 16;

/** Проекции маски на оси в PROFILE_BINS корзин, нормированные по длине: «где лежит масса». */
function projectionProfile(mask: Uint8Array, size: number): Float32Array {
  const profile = new Float32Array(PROFILE_BINS * 2);
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      if (!mask[y * size + x]) continue;
      profile[Math.floor((x * PROFILE_BINS) / size)] += 1;
      profile[PROFILE_BINS + Math.floor((y * PROFILE_BINS) / size)] += 1;
    }
  }
  for (const [from, to] of [
    [0, PROFILE_BINS],
    [PROFILE_BINS, PROFILE_BINS * 2],
  ]) {
    let norm = 0;
    for (let i = from; i < to; i += 1) norm += profile[i] * profile[i];
    norm = Math.sqrt(norm) || 1;
    for (let i = from; i < to; i += 1) profile[i] /= norm;
  }
  return profile;
}

/** Косинус двух профилей по одной оси (`offset` — 0 для X, PROFILE_BINS для Y). */
function profileSimilarity(a: Float32Array, b: Float32Array, offset: number): number {
  let sum = 0;
  for (let i = offset; i < offset + PROFILE_BINS; i += 1) sum += a[i] * b[i];
  return sum;
}

/** Заглушка «расстояние очень большое», когда у фигуры нет точек для сравнения. */
const NO_MATCH = 64;

function buildShape(mask: Uint8Array, probe: Uint8Array, size: number): Shape {
  const own = orientationMap(probe, size);
  const { distance, nearest } = distanceTransformLabelled(probe, own, size, size);

  let probeCount = 0;
  for (let i = 0; i < probe.length; i += 1) probeCount += probe[i];
  let area = 0;
  for (let i = 0; i < mask.length; i += 1) area += mask[i];

  const probeOri = new Uint8Array(probeCount);
  let cursor = 0;
  for (let i = 0; i < probe.length; i += 1) {
    if (probe[i]) {
      probeOri[cursor] = own[i];
      cursor += 1;
    }
  }

  return { mask, probe, probeCount, area, edt: distance, nearOri: nearest, probeOri, size };
}

function deriveShapes(inkMask: Uint8Array, size: number, withInk = true): Shapes {
  const filled = fillHoles(inkMask, size, size);
  // Медиальная ось считается по штрихам, а не по залитому силуэту. Заливка —
  // это интерпретация, и у наброска с глифом она разная: у глифа голова-кольцо
  // и ноги замыкаются в треугольник, заливка превращает ноги в монолит,
  // а у наброска те же ноги остаются двумя линиями. Ось «по штрихам» читается
  // одинаково и у контурной, и у залитой иконки: это скелет фигуры.
  const skeletonMask = skeletonize(inkMask, size);
  const fill = buildShape(filled, boundary(filled, size, size), size);
  const skeleton = buildShape(skeletonMask, skeletonMask, size);
  // Контур глифа не используется: chamferContour сравнивает штрихи наброска
  // с силуэтом глифа. Держать его копию — значит платить 16 КБ на каждый
  // из нескольких тысяч глифов впустую, поэтому отдаём ту же фигуру.
  const ink = withInk ? buildShape(inkMask, inkMask, size) : fill;

  const { components, holes } = topology(inkMask, size);
  return {
    fill,
    skeleton,
    ink,
    components,
    holes,
    profile: projectionProfile(filled, size),
  };
}

/**
 * Кадр нормализации:
 * - `fitted` — пропорции сохранены (вытянутая стрелка остаётся вытянутой);
 * - `stretched` — bbox растянут в квадрат (пропорции игнорируются).
 *
 * Матчер считает обе и берёт ту, где фигуры ближе. Причина: узкий палочный
 * человечек и широкий палочный человечек из шрифта — для человека одна фигура,
 * но в кадре с сохранением пропорций их границы расходятся ровно на разницу
 * пропорций, и chamfer «не видит» совпадения структуры.
 */
export type FrameKind = 'fitted' | 'stretched';

interface ShapeFrames {
  fitted: Shapes;
  stretched: Shapes;
}

function deriveFrames(
  mask: Uint8Array,
  size: number,
  margin: number,
  withInk: boolean,
): ShapeFrames {
  return {
    fitted: deriveShapes(mask, size, withInk),
    stretched: deriveShapes(stretchMask(mask, size, margin), size, withInk),
  };
}

function marginFor(size: number): number {
  return Math.max(1, Math.round((ICON_MARGIN * size) / ICON_SIZE));
}

function probeIndices(shape: Shape): Int32Array {
  if (!shape.indices) {
    const list = new Int32Array(shape.probeCount);
    let cursor = 0;
    for (let i = 0; i < shape.probe.length; i += 1) {
      if (shape.probe[i]) {
        list[cursor] = i;
        cursor += 1;
      }
    }
    shape.indices = list;
  }
  return shape.indices;
}

/**
 * Среднее расстояние от точек `from` до точек цели — экспоненциальное (soft-max).
 * Обычное среднее прощает выбросы: если девять штрихов совпали, а десятый уехал
 * на 10 px, оно всё равно покажет «почти идеально». Здесь далёкие точки весят
 * заметно больше, и формы, у которых часть линий не на месте, проваливаются.
 */
function softDistance(from: Shape, target: Shape): number {
  if (from.probeCount === 0) return NO_MATCH;

  const indices = probeIndices(from);
  const scale = ICON_SIZE / from.size;
  let sum = 0;

  for (let i = 0; i < indices.length; i += 1) {
    const pixels = toPixels(target.edt[indices[i]]) * scale;
    sum += Math.exp(pixels / params.softness);
  }

  return Math.log(sum / indices.length) * params.softness;
}

/** Симметричный chamfer: штрафует и «мимо», и «недобор покрытия». */
function symmetricChamfer(a: Shape, b: Shape): number {
  return params.precision * softDistance(a, b) + (1 - params.precision) * softDistance(b, a);
}

/** Сдвиг и масштаб наброска относительно глифа: поправка на неточность рамки. */
interface Transform {
  dx: number;
  dy: number;
  sx: number;
  sy: number;
}

const IDENTITY: Transform = { dx: 0, dy: 0, sx: 1, sy: 1 };

function probeCoordinates(shape: Shape): { xs: Int16Array; ys: Int16Array } {
  if (!shape.xs || !shape.ys) {
    const indices = probeIndices(shape);
    const xs = new Int16Array(indices.length);
    const ys = new Int16Array(indices.length);
    for (let i = 0; i < indices.length; i += 1) {
      xs[i] = indices[i] % shape.size;
      ys[i] = Math.floor(indices[i] / shape.size);
    }
    shape.xs = xs;
    shape.ys = ys;
  }
  return { xs: shape.xs, ys: shape.ys };
}

/** Среднее несовпадение направлений, набранное последним вызовом `softDistanceAt`. */
let lastOrientationGap = 0;

/**
 * То же, что softDistance, но точки сначала переносятся преобразованием `tf` (вокруг центра кадра),
 * а заодно считается среднее несовпадение направлений линий — оно уходит в признаки ранжирования.
 */
function softDistanceAt(from: Shape, target: Shape, tf: Transform): number {
  if (from.probeCount === 0) {
    lastOrientationGap = 0;
    return NO_MATCH;
  }

  const { xs, ys } = probeCoordinates(from);
  const size = from.size;
  const centre = (size - 1) / 2;
  const scale = ICON_SIZE / size;
  let sum = 0;
  let gapSum = 0;

  for (let i = 0; i < xs.length; i += 1) {
    let x = Math.round(centre + tf.sx * (xs[i] - centre) + tf.dx);
    let y = Math.round(centre + tf.sy * (ys[i] - centre) + tf.dy);
    // Точка вылетела за кадр: берём ближайший пиксель края и штрафуем на расстояние до него.
    let outside = 0;
    if (x < 0) {
      outside -= x;
      x = 0;
    } else if (x >= size) {
      outside += x - size + 1;
      x = size - 1;
    }
    if (y < 0) {
      outside -= y;
      y = 0;
    } else if (y >= size) {
      outside += y - size + 1;
      y = size - 1;
    }
    const at = y * size + x;
    gapSum += orientationGap(from.probeOri[i], target.nearOri[at]);
    sum += Math.exp(((toPixels(target.edt[at]) + outside) * scale) / params.softness);
  }

  lastOrientationGap = gapSum / xs.length / (ORIENTATION_BINS / 2);
  return Math.log(sum / xs.length) * params.softness;
}

function invert(tf: Transform): Transform {
  return { sx: 1 / tf.sx, sy: 1 / tf.sy, dx: -tf.dx / tf.sx, dy: -tf.dy / tf.sy };
}

/** Расстояния в обе стороны и несовпадение направлений: из них модель ранжирования берёт, что ей нужно. */
interface Chamfer {
  /** Набросок → глиф: всё ли нарисованное лежит на глифе. */
  forward: number;
  /** Глиф → набросок: всё ли из глифа нарисовано. */
  backward: number;
  gapForward: number;
  gapBackward: number;
}

function chamferStats(a: Shape, b: Shape, tf: Transform): Chamfer {
  const forward = softDistanceAt(a, b, tf);
  const gapForward = lastOrientationGap;
  const backward = softDistanceAt(b, a, tf === IDENTITY ? tf : invert(tf));
  return { forward, backward, gapForward, gapBackward: lastOrientationGap };
}

/** Свёртка пары расстояний в одно число — то, что видит ручная формула и отладка. */
function combine(chamfer: Chamfer): number {
  return params.precision * chamfer.forward + (1 - params.precision) * chamfer.backward;
}

interface Alignment {
  chamfer: Chamfer;
  /** Ручная стоимость: расстояние плюс штраф за отклонение. */
  cost: number;
  shift: number;
  zoom: number;
}

/**
 * Chamfer с подгонкой сдвига и масштаба (спуск по координатам из тождественного положения).
 *
 * Рамка по bbox хрупкая: недорисованная ножка или лишний штрих меняют габариты,
 * и вся фигура съезжает на несколько пикселей относительно эталона. Chamfer при этом
 * растёт у верного глифа не меньше, чем у чужого. Небольшая свобода по сдвигу/масштабу
 * возвращает верному глифу его расстояние, а штраф за отклонение не даёт чужому
 * «подогнаться» под набросок.
 */
function alignedChamfer(a: Shape, b: Shape): Alignment {
  const start = chamferStats(a, b, IDENTITY);
  const startCost = combine(start);
  if (a.probeCount === 0 || b.probeCount === 0) {
    return { chamfer: start, cost: startCost, shift: 0, zoom: 0 };
  }

  const displacement = (tf: Transform): number =>
    Math.abs(tf.dx) +
    Math.abs(tf.dy) +
    12 * (Math.abs(Math.log(tf.sx)) + Math.abs(Math.log(tf.sy)));

  let best: Transform = IDENTITY;
  let bestChamfer = start;
  let bestCost = startCost;
  let shift = 1.5;
  let zoom = 0.06;

  for (let round = 0; round < 8; round += 1) {
    let moved = false;
    const neighbours: Transform[] = [
      { ...best, dx: best.dx + shift },
      { ...best, dx: best.dx - shift },
      { ...best, dy: best.dy + shift },
      { ...best, dy: best.dy - shift },
      { ...best, sx: best.sx * (1 + zoom) },
      { ...best, sx: best.sx / (1 + zoom) },
      { ...best, sy: best.sy * (1 + zoom) },
      { ...best, sy: best.sy / (1 + zoom) },
    ];
    for (const tf of neighbours) {
      if (Math.abs(tf.dx) > params.alignMaxShift || Math.abs(tf.dy) > params.alignMaxShift)
        continue;
      if (Math.abs(Math.log(tf.sx)) > 0.25 || Math.abs(Math.log(tf.sy)) > 0.25) continue;
      const chamfer = chamferStats(a, b, tf);
      const candidate = combine(chamfer) + params.alignPenalty * displacement(tf);
      if (candidate < bestCost) {
        bestCost = candidate;
        bestChamfer = chamfer;
        best = tf;
        moved = true;
      }
    }
    if (!moved) {
      shift /= 2;
      zoom /= 2;
      if (shift < 0.4) break;
    }
  }

  return {
    chamfer: bestChamfer,
    cost: bestCost,
    shift: Math.abs(best.dx) + Math.abs(best.dy),
    zoom: Math.abs(Math.log(best.sx)) + Math.abs(Math.log(best.sy)),
  };
}

export interface GlyphEntry {
  record: GlyphRecord;
  fitted: Shapes;
  stretched: Shapes;
  coarse: ShapeFrames;
  hog: Float32Array;
}

export function createGlyphEntry(record: GlyphRecord): GlyphEntry {
  const mask = record.mask;
  const fitted = deriveShapes(mask, ICON_SIZE, false);
  return {
    record,
    fitted,
    stretched: deriveShapes(stretchMask(mask, ICON_SIZE, ICON_MARGIN), ICON_SIZE, false),
    coarse: deriveFrames(
      downsampleMask(mask, ICON_SIZE, COARSE_SIZE),
      COARSE_SIZE,
      marginFor(COARSE_SIZE),
      false,
    ),
    hog: computeHog(fitted.fill.mask),
  };
}

export interface SketchVariant {
  rotation: number;
  fitted: Shapes;
  stretched: Shapes;
}

export interface SketchFeatures {
  variants: SketchVariant[];
  coarse: ShapeFrames;
  hog: Float32Array;
  normalized: NormalizedMask;
  strokeWidth: number;
  inkPixels: number;
}

/** Пере-нормализация по собственному bbox: нужна после поворота, который меняет габариты. */
function refit(mask: Uint8Array): Uint8Array {
  const fitted = normalizeMask(mask, ICON_SIZE, ICON_SIZE, ICON_SIZE, ICON_MARGIN);
  return fitted ? fitted.mask : mask;
}

export function buildSketchFeatures(
  mask64: Uint8Array,
  normalized: NormalizedMask,
  strokeWidth: number,
  rotations: number[] = ROTATIONS_DEG,
): SketchFeatures {
  const base = refit(mask64);

  // Для каждой ориентации: повернуть → заново вписать в кадр → построить представления.
  // Повторная нормализация обязательна: у повёрнутого квадрата bbox больше,
  // и без неё фигура «сжималась» бы относительно эталона.
  const variants = rotations.map((rotation) => {
    const rotated = rotation === 0 ? base : refit(rotateMask(base, ICON_SIZE, rotation));
    return {
      rotation,
      fitted: deriveShapes(rotated, ICON_SIZE, true),
      stretched: deriveShapes(stretchMask(rotated, ICON_SIZE, ICON_MARGIN), ICON_SIZE, true),
    };
  });

  let inkPixels = 0;
  for (let i = 0; i < base.length; i += 1) inkPixels += base[i];

  return {
    variants,
    coarse: deriveFrames(
      downsampleMask(base, ICON_SIZE, COARSE_SIZE),
      COARSE_SIZE,
      marginFor(COARSE_SIZE),
      true,
    ),
    hog: computeHog(variants[0].fitted.fill.mask),
    normalized,
    strokeWidth,
    inkPixels,
  };
}

/** Сырое сравнение одной пары представлений. */
interface RawMatch {
  rotation: number;
  frame: FrameKind;
  chamferFill: number;
  chamferSkeleton: number;
  chamferContour: number;
  iou: number;
  hogSimilarity: number;
  /** Подробности для ранжирования: заполняются у кандидатов точной ступени. */
  stats?: {
    fill: Chamfer;
    skeleton: Chamfer;
    contour: Chamfer;
    shift: number;
    zoom: number;
    aligned: boolean;
  };
}

function matchFrame(
  sketch: Shapes,
  glyph: Shapes,
  rotation: number,
  frame: FrameKind,
  hogSim: number,
): RawMatch {
  return {
    rotation,
    frame,
    chamferFill: symmetricChamfer(sketch.fill, glyph.fill),
    chamferSkeleton: symmetricChamfer(sketch.skeleton, glyph.skeleton),
    chamferContour: symmetricChamfer(sketch.ink, glyph.fill),
    iou: 0,
    hogSimilarity: hogSim,
  };
}

/** Абсолютная оценка по лучшей из гипотез — только для грубого отбора. */
function bestAbsolute(match: RawMatch): number {
  return Math.max(
    params.wFill * Math.exp(-match.chamferFill / params.sigmaFill),
    params.wSkeleton * Math.exp(-match.chamferSkeleton / params.sigmaSkeleton),
    params.wContour * Math.exp(-match.chamferContour / params.sigmaContour),
  );
}

/**
 * Признаки пары «набросок — глиф» для обучаемого ранжирования. Порядок важен:
 * вход модели params.rankModel идёт в том же порядке (см. scripts/train-ranker.ts).
 */
const HYPOTHESES = ['Fill', 'Skeleton', 'Contour'] as const;
export const RANK_FEATURES = [
  ...HYPOTHESES.flatMap((h) => [
    `norm${h}`,
    `near${h}`,
    `sym${h}`,
    `forward${h}`,
    `backward${h}`,
    `gapForward${h}`,
    `gapBackward${h}`,
  ]),
  'iou',
  'hog',
  'stretched',
  'rotation',
  'areaMismatch',
  'skeletonMismatch',
  'boundaryMismatch',
  'glyphDensity',
  'alignShift',
  'alignZoom',
  'aligned',
  'holesGap',
  'holesExtra',
  'componentsGap',
  'componentsExtra',
  'profileX',
  'profileY',
] as const;

/**
 * Модель из params, если она обучена на тех же признаках, что считает этот код.
 * Модель от другого набора признаков молча давала бы мусор, поэтому при расхождении
 * поиск откатывается к ручной формуле.
 */
function usableModel(): RankModel | null {
  const model = params.rankModel;
  if (!model || model.features.length !== RANK_FEATURES.length) return null;
  return model.features.every((name, i) => name === RANK_FEATURES[i]) ? model : null;
}

/** |ln(a / b)| с защитой от нулей: во сколько раз различаются две величины. */
function logGap(a: number, b: number): number {
  return Math.abs(Math.log((a + 1) / (b + 1)));
}

function rankFeatures(
  sketch: Shapes,
  glyph: Shapes,
  match: RawMatch,
  norm: [number, number, number],
): number[] {
  const stats = match.stats;
  const parts = stats ? [stats.fill, stats.skeleton, stats.contour] : [];
  const features: number[] = [];

  parts.forEach((chamfer, i) => {
    const distance = combine(chamfer);
    features.push(
      norm[i],
      Math.exp(-distance / 1.5),
      Math.exp(-distance / 4),
      Math.exp(-chamfer.forward / 3),
      Math.exp(-chamfer.backward / 3),
      chamfer.gapForward,
      chamfer.gapBackward,
    );
  });

  features.push(
    match.iou,
    match.hogSimilarity,
    match.frame === 'stretched' ? 1 : 0,
    Math.abs(match.rotation) / 10,
    logGap(sketch.fill.area, glyph.fill.area),
    logGap(sketch.skeleton.probeCount, glyph.skeleton.probeCount),
    logGap(sketch.fill.probeCount, glyph.fill.probeCount),
    glyph.fill.area / (ICON_SIZE * ICON_SIZE),
    (stats?.shift ?? 0) / 5,
    stats?.zoom ?? 0,
    stats?.aligned ? 1 : 0,
    // Топология: лишняя дырка или лишний кусок у наброска (знак важен) и просто разница.
    Math.min(3, Math.abs(sketch.holes - glyph.holes)) / 3,
    Math.max(-3, Math.min(3, sketch.holes - glyph.holes)) / 3,
    Math.min(3, Math.abs(sketch.components - glyph.components)) / 3,
    Math.max(-3, Math.min(3, sketch.components - glyph.components)) / 3,
    profileSimilarity(sketch.profile, glyph.profile, 0),
    profileSimilarity(sketch.profile, glyph.profile, PROFILE_BINS),
  );
  return features;
}

export interface ScoredGlyph {
  entry: GlyphEntry;
  metrics: GlyphMetrics;
}

/**
 * Двухступенчатый поиск.
 *
 * 1. Грубый отбор по 32×32: оценка по лучшей гипотезе. Здесь важна полнота —
 *    потерять кандидата дороже, чем притащить лишних.
 * 2. Точное сравнение 64×64 с поворотами.
 * 3. Нормировка скоров гипотез на лучшего кандидата пула и взвешенная сумма.
 *
 * Третий шаг принципиален: без него итог равен максимуму по гипотезам, а значит
 * крестик, идеально совпавший по скелету, обгоняет человечка, у которого совпали
 * и скелет, и силуэт, и контур. Сумма требует согласия нескольких сигналов.
 */
export function searchGlyphs(
  sketch: SketchFeatures,
  entries: GlyphEntry[],
): { scored: ScoredGlyph[]; considered: number } {
  if (entries.length === 0) return { scored: [], considered: 0 };
  const model = usableModel();

  const coarse: Array<{ entry: GlyphEntry; value: number }> = new Array(entries.length);
  for (let i = 0; i < entries.length; i += 1) {
    const entry = entries[i];
    // Максимум по кадрам: узкая фигура может вылететь из отбора в кадре
    // с сохранением пропорций, хотя растянутая совпадает отлично.
    const fitted = bestAbsolute(
      matchFrame(sketch.coarse.fitted, entry.coarse.fitted, 0, 'fitted', 0),
    );
    const stretched = bestAbsolute(
      matchFrame(sketch.coarse.stretched, entry.coarse.stretched, 0, 'stretched', 0),
    );
    coarse[i] = { entry, value: Math.max(fitted, stretched) };
  }
  coarse.sort((a, b) => b.value - a.value);

  const candidates = coarse.slice(0, Math.min(params.coarseKeep, coarse.length));
  const fine: Array<{ entry: GlyphEntry; match: RawMatch }> = [];

  for (const { entry } of candidates) {
    const hogSim = hogSimilarity(sketch.hog, entry.hog);
    let best: RawMatch | null = null;

    for (const variant of sketch.variants) {
      const match = matchFrame(variant.fitted, entry.fitted, variant.rotation, 'fitted', hogSim);
      if (!best || bestAbsolute(match) > bestAbsolute(best)) best = match;
    }

    // Растянутый кадр — второй шанс для фигур, нарисованных «не в тех» пропорциях.
    // Считаем его только когда обычный кадр не дал уверенного совпадения: точная
    // ступень от этого дорожает вдвое, а нужен он в меньшинстве случаев.
    if (!best || bestAbsolute(best) < params.stretchThreshold) {
      for (const variant of sketch.variants) {
        const match = matchFrame(
          variant.stretched,
          entry.stretched,
          variant.rotation,
          'stretched',
          hogSim,
        );
        if (!best || bestAbsolute(match) > bestAbsolute(best)) best = match;
      }
    }

    if (!best) continue;

    // IoU считаем только для победившей пары «поворот + кадр» — это полный проход по маске.
    const variant = sketch.variants.find((item) => item.rotation === best?.rotation);
    if (variant) {
      const frames = best.frame === 'stretched' ? 'stretched' : 'fitted';
      best.iou = intersectionOverUnion(variant[frames].fill.mask, entry[frames].fill.mask);
    }

    fine.push({ entry, match: best });
  }

  if (fine.length === 0) return { scored: [], considered: entries.length };

  // Подробные расстояния нужны всем кандидатам, а подгонка сдвига и масштаба дорогая:
  // она достаётся только лучшим по предварительной оценке.
  const preliminary = (match: RawMatch): number =>
    params.wFill * Math.exp(-match.chamferFill / params.sigmaFill) +
    params.wSkeleton * Math.exp(-match.chamferSkeleton / params.sigmaSkeleton) +
    params.wContour * Math.exp(-match.chamferContour / params.sigmaContour);
  const shortlist = new Set(
    [...fine].sort((a, b) => preliminary(b.match) - preliminary(a.match)).slice(0, params.alignTop),
  );

  for (const item of fine) {
    const { entry, match } = item;
    const variant = sketch.variants.find((candidate) => candidate.rotation === match.rotation);
    if (!variant) continue;
    const frames = match.frame === 'stretched' ? 'stretched' : 'fitted';
    const pairs: Array<[Shape, Shape]> = [
      [variant[frames].fill, entry[frames].fill],
      [variant[frames].skeleton, entry[frames].skeleton],
      [variant[frames].ink, entry[frames].fill],
    ];

    if (shortlist.has(item)) {
      const [fill, skeleton, contour] = pairs.map(([a, b]) => alignedChamfer(a, b));
      match.chamferFill = fill.cost;
      match.chamferSkeleton = skeleton.cost;
      match.chamferContour = contour.cost;
      match.stats = {
        fill: fill.chamfer,
        skeleton: skeleton.chamfer,
        contour: contour.chamfer,
        shift: (fill.shift + skeleton.shift + contour.shift) / 3,
        zoom: (fill.zoom + skeleton.zoom + contour.zoom) / 3,
        aligned: true,
      };
    } else {
      const [fill, skeleton, contour] = pairs.map(([a, b]) => chamferStats(a, b, IDENTITY));
      match.stats = { fill, skeleton, contour, shift: 0, zoom: 0, aligned: false };
    }
  }

  // Нормировка «относительно лучшего в пуле» по каждой гипотезе отдельно.
  let bestFill = Number.POSITIVE_INFINITY;
  let bestSkeleton = Number.POSITIVE_INFINITY;
  let bestContour = Number.POSITIVE_INFINITY;
  for (const { match } of fine) {
    bestFill = Math.min(bestFill, match.chamferFill);
    bestSkeleton = Math.min(bestSkeleton, match.chamferSkeleton);
    bestContour = Math.min(bestContour, match.chamferContour);
  }

  const weightSum = params.wFill + params.wSkeleton + params.wContour;
  const scored: ScoredGlyph[] = fine.map(({ entry, match }) => {
    const normFill = Math.exp(-(match.chamferFill - bestFill) / params.steepFill);
    const normSkeleton = Math.exp(-(match.chamferSkeleton - bestSkeleton) / params.steepSkeleton);
    const normContour = Math.exp(-(match.chamferContour - bestContour) / params.steepContour);

    const fillScore =
      (1 - params.iouWeight - params.hogWeight) * normFill +
      params.iouWeight * match.iou +
      params.hogWeight * match.hogSimilarity;

    const skeletonScore = Math.exp(-match.chamferSkeleton / params.sigmaSkeleton);

    const score =
      (params.wFill * fillScore + params.wSkeleton * normSkeleton + params.wContour * normContour) /
      weightSum;

    const metrics: GlyphMetrics = {
      score,
      hypothesis: 'fill',
      frame: match.frame,
      bestRotation: match.rotation,
      chamferFill: match.chamferFill,
      iou: match.iou,
      chamferSkeleton: match.chamferSkeleton,
      chamferContour: match.chamferContour,
      fillScore,
      skeletonScore,
      contourScore: Math.exp(-match.chamferContour / params.sigmaContour),
      normFill,
      normSkeleton,
      normContour,
      hogSimilarity: match.hogSimilarity,
    };

    // Победившая гипотеза — та, что дала наибольший вклад в итоговый скор.
    const contributions: Array<{ hypothesis: GlyphMetrics['hypothesis']; value: number }> = [
      { hypothesis: 'fill', value: params.wFill * fillScore },
      { hypothesis: 'skeleton', value: params.wSkeleton * skeletonScore },
      { hypothesis: 'contour', value: params.wContour * normContour },
    ];
    metrics.hypothesis = contributions.reduce((a, b) => (b.value > a.value ? b : a)).hypothesis;

    if (model || params.collectFeatures) {
      const variant = sketch.variants.find((item) => item.rotation === match.rotation);
      const frames = match.frame === 'stretched' ? 'stretched' : 'fitted';
      if (variant) {
        metrics.features = rankFeatures(variant[frames], entry[frames], match, [
          normFill,
          normSkeleton,
          normContour,
        ]);
      }
    }

    return { entry, metrics };
  });

  if (model) {
    // Обученное ранжирование: модель даёт логит кандидата, а скор — softmax по пулу,
    // то есть оценка вероятности того, что это та самая иконка.
    const logits = scored.map(({ metrics }) =>
      metrics.features
        ? scoreModel(model, metrics.features) + params.blend * metrics.score
        : -Infinity,
    );
    const top = Math.max(...logits);
    const exps = logits.map((logit) => Math.exp(logit - top));
    const total = exps.reduce((sum, value) => sum + value, 0);
    scored.forEach((item, i) => {
      item.metrics.score = exps[i] / total;
    });
  }

  scored.sort((a, b) => b.metrics.score - a.metrics.score);
  return { scored, considered: entries.length };
}

export function makePreview(fillMask: Uint8Array): Uint8Array {
  return downsampleMask(fillMask, ICON_SIZE, PREVIEW_SIZE, 0.25);
}

export function buildResults(
  scored: ScoredGlyph[],
  iconNames: Map<number, string> | null = null,
  limit = RESULT_COUNT,
): SearchResult[] {
  const results: SearchResult[] = [];
  const seen = new Set<string>();

  for (const { entry, metrics } of scored) {
    const iconName = iconNames?.get(entry.record.codePoint) ?? null;
    // Одна и та же иконка может лежать в нескольких шрифтах (набор и его версия):
    // в пятёрке нужны разные варианты, а не один и тот же класс дважды.
    if (iconName !== null) {
      if (seen.has(iconName)) continue;
      seen.add(iconName);
    }

    results.push({
      glyphId: entry.record.id,
      fontId: entry.record.fontId,
      fontName: entry.record.fontName,
      iconName,
      sourceKind: entry.record.sourceKind,
      sourceValue: entry.record.sourceValue,
      codePoint: entry.record.codePoint,
      char: entry.record.char,
      // Признаки ранжирования нужны оценочному стенду, а не popup: в сообщении они лишние.
      metrics: { ...metrics, features: undefined },
      preview: bytesToBase64(makePreview(entry.fitted.fill.mask)),
      inkPixels: entry.record.inkPixels,
      coverage: entry.record.coverage,
      aspect: entry.record.aspect,
    });

    if (results.length >= limit) break;
  }

  return results;
}
