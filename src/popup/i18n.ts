import { createContext, useContext } from 'react';

export type Lang = 'ru' | 'en';

/**
 * Словарь интерфейса. Ключи — короткие имена, значения — готовые строки.
 * Подстановок нет намеренно: строки короткие, а склейка шаблонами в двух языках
 * расходится по порядку слов (в английском «248 ms» встаёт иначе, чем «248 мс»).
 */
const RU = {
  clear: 'Очистить',
  undo: 'Отменить',
  redo: 'Вернуть',
  topMatches: 'Топ-5 похожих',
  emptyHint: 'Нарисуйте иконку в области выше — пятёрка лучших совпадений появится здесь.',
  detailsHint: 'Кликните по иконке выше — здесь появится её имя класса и уверенность.',
  confidence: 'уверенность',
  copyClass: 'Скопировать имя класса',
  copied: 'скопировано',
  symbol: 'Символ',
  glyphsFound: 'Иконок',
  settings: 'Настройки',
  close: 'Закрыть',
  sectionDictionary: 'Словарь',
  sectionFont: 'Шрифт иконок',
  sectionDev: 'Для разработчиков',
  update: 'Обновить',
  add: 'Добавить',
  cancel: 'Отмена',
  remove: 'убрать',
  bundled: 'встроенный',
  bundledHint: 'Вшитый источник ставится при установке и удалению не подлежит',
  link: 'Ссылка',
  or: 'или',
  file: 'Файл',
  onlyLess: 'Можно добавить только .less',
  onlyFont: 'Можно добавить только .woff, .woff2, .ttf или .eot',
  addByUrl: 'Добавить по ссылке',
  glyphsEmpty: 'Не заданы — ищем по всем глифам шрифта',
  fontEmpty: 'Не выбран',
  language: 'Язык',
  theme: 'Тема',
  themeDark: 'Тёмная',
  themeLight: 'Светлая',
  debug: 'Показывать отладочные данные',
  processing: 'Обрабатываю…',
  glyphsCount: 'глифов',
  missingInFont: 'имён из стилей нет в шрифте',
  missingTitle: 'Имена без глифа',
  missingHint:
    'Эти имена не найдутся никогда: в шрифтах нет их рисунков. Обычно стили и шрифт из разных версий набора.',
  brush: 'Кисть',
  fill: 'Заливка',
  brushWidth: 'Толщина кисти',
  fillBlocked: 'Заливка отменена: краска дошла до края холста',
  allowHosts: 'Разрешить доступ к сайтам, чтобы добавлять шрифты и стили по ссылке',
  continuePending: 'Продолжить добавление',
  needHosts: 'нужно разрешение на доступ к сайтам',
  hypothesisFill: 'заливка',
  hypothesisSkeleton: 'скелет',
  hypothesisContour: 'контур',
  phaseFetch: 'загрузка',
  phaseScan: 'разбор глифов',
  phaseIndex: 'сохранение',
  author: 'Автор',
  version: 'Версия',
  icons: 'Иконки',
} as const;

const EN: Record<keyof typeof RU, string> = {
  clear: 'Clear',
  undo: 'Undo',
  redo: 'Redo',
  topMatches: 'Top 5 matches',
  emptyHint: 'Draw an icon in the area above — the five closest matches will appear here.',
  detailsHint: 'Click an icon above — its class name and confidence will show up here.',
  confidence: 'confidence',
  copyClass: 'Copy class name',
  copied: 'copied',
  symbol: 'Symbol',
  glyphsFound: 'Icons',
  settings: 'Settings',
  close: 'Close',
  sectionDictionary: 'Dictionary',
  sectionFont: 'Icon font',
  sectionDev: 'For developers',
  update: 'Update',
  add: 'Add',
  cancel: 'Cancel',
  remove: 'remove',
  bundled: 'built-in',
  bundledHint: 'Bundled source is installed with the extension and cannot be removed',
  link: 'URL',
  or: 'or',
  file: 'File',
  onlyLess: 'Only .less can be added',
  onlyFont: 'Only .woff, .woff2, .ttf or .eot can be added',
  addByUrl: 'Add by URL',
  glyphsEmpty: 'Not set — searching all glyphs of the font',
  fontEmpty: 'Not selected',
  language: 'Language',
  theme: 'Theme',
  themeDark: 'Dark',
  themeLight: 'Light',
  debug: 'Show debug data',
  processing: 'Processing…',
  glyphsCount: 'glyphs',
  missingInFont: 'names from the styles are missing in the font',
  missingTitle: 'Names without a glyph',
  missingHint:
    'These names can never be found: no font has their drawings. Usually it means the styles and the font come from different releases of the set.',
  brush: 'Brush',
  fill: 'Fill',
  brushWidth: 'Brush size',
  fillBlocked: 'Fill cancelled: the paint reached the canvas edge',
  allowHosts: 'Allow access to sites to add fonts and styles by URL',
  continuePending: 'Continue adding',
  needHosts: 'site access permission required',
  hypothesisFill: 'fill',
  hypothesisSkeleton: 'skeleton',
  hypothesisContour: 'outline',
  phaseFetch: 'download',
  phaseScan: 'glyph scan',
  phaseIndex: 'saving',
  author: 'Author',
  version: 'Version',
  icons: 'Icons',
};

export type TranslationKey = keyof typeof RU;

const DICTS: Record<Lang, Record<TranslationKey, string>> = { ru: RU, en: EN };

export const LangContext = createContext<Lang>('ru');

export function translate(lang: Lang, key: TranslationKey): string {
  return DICTS[lang][key] ?? key;
}

/** Возвращает `t` для текущего языка из контекста. */
export function useT(): (key: TranslationKey) => string {
  const lang = useContext(LangContext);
  return (key: TranslationKey) => translate(lang, key);
}
