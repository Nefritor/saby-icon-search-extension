import type { Hypothesis } from './constants';

export type FontSourceKind = 'url' | 'file';

export interface FontMeta {
  id: string;
  /** Отображаемое имя (то, что ввёл пользователь). */
  name: string;
  /** Уникальное CSS-семейство, под которым шрифт зарегистрирован. */
  family: string;
  sourceKind: FontSourceKind;
  /** URL или имя файла — для информации. */
  sourceValue: string;
  glyphCount: number;
  indexed: boolean;
  /** Версия алгоритма сканирования, которым построен индекс. */
  indexVersion?: number;
  createdAt: number;
}

export interface StoredFont extends FontMeta {
  bytes: ArrayBuffer;
}

/** Соответствие «кодпоинт → имя класса» из .less со стилями иконочного шрифта. */
export interface IconEntry {
  codePoint: number;
  className: string;
  /** Имя файла или URL, откуда пришло соответствие. */
  sourceName: string;
}

/** Активный источник стилей. */
export interface LessSourceMeta {
  name: string;
  sourceKind: FontSourceKind;
  sourceValue: string;
  iconCount: number;
  createdAt: number;
}

/**
 * Источник стилей в списке. Их может быть несколько: файлы дополняют друг друга,
 * а при совпадении кодпоинта побеждает тот, что добавили позже.
 */
export interface StyleSourceMeta extends LessSourceMeta {
  id: string;
}

export interface GlyphRecord {
  id: string;
  fontId: string;
  fontName: string;
  sourceKind: FontSourceKind;
  sourceValue: string;
  codePoint: number;
  char: string;
  /** ICON_SIZE*ICON_SIZE байт, 0/1 — «чернила» глифа. */
  mask: Uint8Array;
  /** Количество пикселей чернил в нормализованной маске. */
  inkPixels: number;
  /** Доля чернил в bbox: отличает контурный глиф от залитого. */
  coverage: number;
  aspect: number;
}

/** Все числа, по которым ранжируется результат. Показываются в панели деталей. */
export interface GlyphMetrics {
  /** Итоговый скор = максимум по гипотезам, 0..1. */
  score: number;
  /** Победившая гипотеза. */
  hypothesis: Hypothesis;
  /** Кадр, в котором фигуры оказались ближе: с пропорциями или растянутый. */
  frame: 'fitted' | 'stretched';
  /** Поворот наброска, давший лучшее совпадение, градусы. */
  bestRotation: number;
  /** Chamfer по границам залитых силуэтов, px. */
  chamferFill: number;
  /** IoU залитых силуэтов, 0..1. */
  iou: number;
  /** Chamfer по медиальным осям, px. */
  chamferSkeleton: number;
  /** Chamfer «линии наброска ↔ контур глифа», px. */
  chamferContour: number;
  /** Нормированные скоры гипотез, 0..1. */
  fillScore: number;
  skeletonScore: number;
  contourScore: number;
  /**
   * Скоры гипотез, нормированные на лучшего кандидата в пуле, 0..1.
   * Именно они складываются в итоговый score — поэтому результат
   * относительный: 100% означает «лучше всех в этом пуле по этой гипотезе».
   */
  normFill: number;
  normSkeleton: number;
  normContour: number;
  /** Косинус HOG, 0..1. */
  hogSimilarity: number;
}

export interface SearchResult {
  glyphId: string;
  fontId: string;
  fontName: string;
  /** Имя класса из .less (например, icon-ClientChat), если стили подключены. */
  iconName: string | null;
  sourceKind: FontSourceKind;
  sourceValue: string;
  codePoint: number;
  char: string;
  metrics: GlyphMetrics;
  /**
   * Превью PREVIEW_SIZE*PREVIEW_SIZE (0/1), закодированное в base64.
   * Именно строка, а не Uint8Array: chrome.runtime.sendMessage сериализует
   * сообщения через JSON, и типизированные массивы в них выживают плохо.
   */
  preview: string;
  inkPixels: number;
  coverage: number;
  aspect: number;
}
