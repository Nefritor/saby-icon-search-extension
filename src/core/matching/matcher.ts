import {
  COARSE_KEEP,
  COARSE_SIZE,
  HOG_WEIGHT_IN_FILL,
  ICON_MARGIN,
  ICON_SIZE,
  IOU_WEIGHT_IN_FILL,
  PREVIEW_SIZE,
  RESULT_COUNT,
  ROTATIONS_DEG,
  SIGMA_CONTOUR,
  SIGMA_FILL,
  SIGMA_SKELETON,
  SOFTNESS_PX,
  STEEP_CONTOUR,
  STEEP_FILL,
  STEEP_SKELETON,
  STRETCH_FRAME_THRESHOLD,
  W_CONTOUR,
  W_FILL,
  W_SKELETON,
} from '../../shared/constants';
import type { GlyphMetrics, GlyphRecord, SearchResult } from '../../shared/types';
import { computeHog, hogSimilarity } from '../features/hog';
import { bytesToBase64 } from '../image/bits';
import { distanceTransform, toPixels } from '../image/distanceTransform';
import { boundary, fillHoles } from '../image/morphology';
import {
  downsampleMask,
  intersectionOverUnion,
  normalizeMask,
  rotateMask,
  stretchMask,
  type NormalizedMask,
} from '../image/normalize';
import { skeletonize } from '../image/skeleton';

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
  size: number;
  /** Индексы точек probe. Считаются лениво: сканировать 4096 пикселей на каждый
   *  шампфер впустую — самая дорогая часть поиска. */
  indices?: Int32Array;
}

/** Три представления одной фигуры — по одному на каждую гипотезу. */
interface Shapes {
  /** Залитый силуэт: контур как probe, маска для IoU. */
  fill: Shape;
  /** Медиальная ось залитого силуэта. */
  skeleton: Shape;
  /** Исходные линии: у наброска — штрихи, у глифа — его чернила. */
  ink: Shape;
}

/** Заглушка «расстояние очень большое», когда у фигуры нет точек для сравнения. */
const NO_MATCH = 64;

function buildShape(mask: Uint8Array, probe: Uint8Array, size: number): Shape {
  let probeCount = 0;
  for (let i = 0; i < probe.length; i += 1) probeCount += probe[i];
  return { mask, probe, probeCount, edt: distanceTransform(probe, size, size), size };
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

  return { fill, skeleton, ink };
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
function softDistance(from: Shape, targetEdt: Uint16Array): number {
  if (from.probeCount === 0) return NO_MATCH;

  const indices = probeIndices(from);
  const scale = ICON_SIZE / from.size;
  let sum = 0;

  for (let i = 0; i < indices.length; i += 1) {
    const pixels = toPixels(targetEdt[indices[i]]) * scale;
    sum += Math.exp(pixels / SOFTNESS_PX);
  }

  return Math.log(sum / indices.length) * SOFTNESS_PX;
}

/** Симметричный chamfer: штрафует и «мимо», и «недобор покрытия». */
function symmetricChamfer(a: Shape, b: Shape): number {
  return (softDistance(a, b.edt) + softDistance(b, a.edt)) / 2;
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
    W_FILL * Math.exp(-match.chamferFill / SIGMA_FILL),
    W_SKELETON * Math.exp(-match.chamferSkeleton / SIGMA_SKELETON),
    W_CONTOUR * Math.exp(-match.chamferContour / SIGMA_CONTOUR),
  );
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

  const candidates = coarse.slice(0, Math.min(COARSE_KEEP, coarse.length));
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
    if (!best || bestAbsolute(best) < STRETCH_FRAME_THRESHOLD) {
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

  // Нормировка «относительно лучшего в пуле» по каждой гипотезе отдельно.
  let bestFill = Number.POSITIVE_INFINITY;
  let bestSkeleton = Number.POSITIVE_INFINITY;
  let bestContour = Number.POSITIVE_INFINITY;
  for (const { match } of fine) {
    bestFill = Math.min(bestFill, match.chamferFill);
    bestSkeleton = Math.min(bestSkeleton, match.chamferSkeleton);
    bestContour = Math.min(bestContour, match.chamferContour);
  }

  const weightSum = W_FILL + W_SKELETON + W_CONTOUR;
  const scored: ScoredGlyph[] = fine.map(({ entry, match }) => {
    const normFill = Math.exp(-(match.chamferFill - bestFill) / STEEP_FILL);
    const normSkeleton = Math.exp(-(match.chamferSkeleton - bestSkeleton) / STEEP_SKELETON);
    const normContour = Math.exp(-(match.chamferContour - bestContour) / STEEP_CONTOUR);

    const fillScore =
      (1 - IOU_WEIGHT_IN_FILL - HOG_WEIGHT_IN_FILL) * normFill +
      IOU_WEIGHT_IN_FILL * match.iou +
      HOG_WEIGHT_IN_FILL * match.hogSimilarity;

    const skeletonScore = Math.exp(-match.chamferSkeleton / SIGMA_SKELETON);

    const score =
      (W_FILL * fillScore + W_SKELETON * normSkeleton + W_CONTOUR * normContour) / weightSum;

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
      contourScore: Math.exp(-match.chamferContour / SIGMA_CONTOUR),
      normFill,
      normSkeleton,
      normContour,
      hogSimilarity: match.hogSimilarity,
    };

    // Победившая гипотеза — та, что дала наибольший вклад в итоговый скор.
    const contributions: Array<{ hypothesis: GlyphMetrics['hypothesis']; value: number }> = [
      { hypothesis: 'fill', value: W_FILL * fillScore },
      { hypothesis: 'skeleton', value: W_SKELETON * skeletonScore },
      { hypothesis: 'contour', value: W_CONTOUR * normContour },
    ];
    metrics.hypothesis = contributions.reduce((a, b) => (b.value > a.value ? b : a)).hypothesis;

    return { entry, metrics };
  });

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
      metrics,
      preview: bytesToBase64(makePreview(entry.fitted.fill.mask)),
      inkPixels: entry.record.inkPixels,
      coverage: entry.record.coverage,
      aspect: entry.record.aspect,
    });

    if (results.length >= limit) break;
  }

  return results;
}
