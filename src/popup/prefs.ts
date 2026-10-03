import { getLocal, setLocal } from '../shared/storage';

export type ThemeName = 'dark' | 'light';
export type Lang = 'ru' | 'en';

const THEME_KEY = 'theme';
const LANG_KEY = 'lang';

/**
 * Акцент один — синий, и настройки для него нет: он задан переменной `--accent`
 * в styles.css. Переменная остаётся точкой входа на случай смены палитры,
 * но из интерфейса её выбирать больше нечего.
 */

/** Длительность перехода по цветам: совпадает с правилом `.theme-anim` в styles.css. */
const THEME_ANIM_MS = 260;

/** Смена темы — одна операция над классом: от него зависят все цвета интерфейса. */
export function applyTheme(theme: ThemeName): void {
  document.documentElement.classList.toggle('dark', theme === 'dark');
}

/**
 * Смена темы переходами по цветам. Класс вешается на `<html>` только на время
 * переключения: постоянно такие переходы тормозили бы все hover-эффекты.
 *
 * Снимки вида (`startViewTransition`) не используются намеренно. Браузер вправе
 * пропустить их анимацию, и смена выглядела бы мгновенной; попытка доиграть её
 * после пропуска — вернуть прежнюю тему, пересчитать стили и включить переходы —
 * давала вспышку и выглядела хуже, чем отсутствие анимации вовсе.
 */
export function withThemeTransition(update: () => void): void {
  const root = document.documentElement;
  root.classList.add('theme-anim');
  update();
  window.setTimeout(() => root.classList.remove('theme-anim'), THEME_ANIM_MS);
}

export function applyLang(lang: Lang): void {
  document.documentElement.lang = lang;
}

export async function getTheme(): Promise<ThemeName> {
  return (await getLocal<ThemeName>(THEME_KEY)) ?? 'dark';
}

export async function saveTheme(theme: ThemeName): Promise<void> {
  // Только сохранение: сам класс темы ставит `applyTheme` внутри перехода.
  await setLocal(THEME_KEY, theme);
}

export async function getLang(): Promise<Lang> {
  return (await getLocal<Lang>(LANG_KEY)) ?? 'ru';
}

export async function saveLang(lang: Lang): Promise<void> {
  applyLang(lang);
  await setLocal(LANG_KEY, lang);
}

/** Применяет сохранённые настройки до первого рендера — чтобы не мигала тема. */
export async function applyStoredAppearance(): Promise<ThemeName> {
  const [theme, lang] = await Promise.all([getTheme(), getLang()]);
  applyTheme(theme);
  applyLang(lang);
  return theme;
}
