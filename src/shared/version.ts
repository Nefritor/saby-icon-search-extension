/**
 * Версии и автор показываются в панели настроек. Значения подставляет сборка
 * из package.json (см. `define` в vite.config.mts), поэтому в коде они взяты
 * в одном месте и не дублируются строкой.
 *
 * Проверка через `typeof` нужна на случай запуска без подстановок: в тестах и в
 * сторонней сборке этих имён просто нет, а `typeof` не бросает исключение.
 */
export const APP_AUTHOR = typeof __APP_AUTHOR__ === 'string' ? __APP_AUTHOR__ : '';
export const APP_VERSION = typeof __APP_VERSION__ === 'string' ? __APP_VERSION__ : '';
export const SABY_VERSION = typeof __SABY_VERSION__ === 'string' ? __SABY_VERSION__ : '';
