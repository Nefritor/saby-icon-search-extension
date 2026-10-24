import {
  COARSE_KEEP,
  HOG_WEIGHT_IN_FILL,
  IOU_WEIGHT_IN_FILL,
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
import type { RankModel } from './rank';
import defaultModel from './rankModel.json';

/**
 * Настраиваемые параметры сопоставления. Значения по умолчанию берутся из constants.ts;
 * объект изменяемый ради оценочного стенда (`npm run eval -- --set=ключ=значение`):
 * он перебирает веса, не пересобирая код. В расширении их никто не трогает.
 */
export const params = {
  sigmaFill: SIGMA_FILL,
  sigmaSkeleton: SIGMA_SKELETON,
  sigmaContour: SIGMA_CONTOUR,
  softness: SOFTNESS_PX,
  steepFill: STEEP_FILL,
  steepSkeleton: STEEP_SKELETON,
  steepContour: STEEP_CONTOUR,
  wFill: W_FILL,
  wSkeleton: W_SKELETON,
  wContour: W_CONTOUR,
  iouWeight: IOU_WEIGHT_IN_FILL,
  hogWeight: HOG_WEIGHT_IN_FILL,
  stretchThreshold: STRETCH_FRAME_THRESHOLD,
  coarseKeep: COARSE_KEEP,
  /** Сколько лучших кандидатов проходят подгонку сдвига и масштаба (0 — выключена). */
  alignTop: 60,
  alignPenalty: 0.15,
  alignMaxShift: 5,
  /** Обученная модель ранжирования (scripts/train-ranker.ts); null — ручная формула. */
  rankModel: defaultModel as RankModel | null,
  /** Сохранять признаки в метриках даже без весов: нужно обучению. */
  collectFeatures: false,
  /**
   * Порог альфа-канала наброска, 1…255; 0 — подбирать по Отсу. Тонкая линия кисти после
   * уменьшения холста бледнеет до альфы 60–150: Отсу на такой гистограмме рвал линии
   * и менял силуэт, а фиксированный низкий порог их сохраняет.
   */
  alphaThreshold: 48,
  /** Вес ручной формулы в итоговом логите: смесь двух разных оценщиков устойчивее каждого. */
  blend: 10,
  /** Доля направления «набросок → глиф» в симметричном расстоянии (0.5 — поровну). */
  precision: 0.5,
};

export type Params = typeof params;
