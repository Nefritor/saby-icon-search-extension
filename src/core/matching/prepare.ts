import { ICON_MARGIN, ICON_SIZE } from '../../shared/constants';
import { grayToMask } from '../image/binarize';
import { close, estimateStrokeWidth } from '../image/morphology';
import { normalizeMask } from '../image/normalize';
import { buildSketchFeatures, type SketchFeatures } from './matcher';
import { params } from './params';

/** Меньше стольких пикселей штриха набросок считается пустым. */
const MIN_INK = 12;

/**
 * Превращает растр наброска (альфа-канал, 0 = фон) в признаки для поиска.
 * Отдельная функция, а не кусок движка: её же гоняет оценочный стенд (`npm run eval`),
 * и метрики должны считаться ровно по тому пути, которым идёт реальный поиск.
 *
 * @returns null, если рисунка нет или он слишком мал.
 */
export function prepareSketch(
  alpha: Uint8Array,
  width: number,
  height: number,
): SketchFeatures | null {
  const mask = grayToMask(alpha, params.alphaThreshold > 0 ? params.alphaThreshold : undefined);
  let ink = 0;
  for (let i = 0; i < mask.length; i += 1) ink += mask[i];
  if (ink < MIN_INK) return null;

  // Автоматическая оценка толщины штриха: закрываем разрывы ровно настолько, насколько нужно.
  const strokeWidth = estimateStrokeWidth(mask, width, height);
  const radius = Math.max(1, Math.min(3, Math.round(strokeWidth / 2)));
  const solid = close(mask, width, height, radius);

  const normalized = normalizeMask(solid, width, height, ICON_SIZE, ICON_MARGIN);
  if (!normalized) return null;

  return buildSketchFeatures(normalized.mask, normalized, strokeWidth);
}
