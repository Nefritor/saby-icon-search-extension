/**
 * Разбор .less со стилями иконочного шрифта.
 *
 * Ожидаемый формат:
 *   .icon-Button::before { content: '\eb7e'; }
 *   .icon-ClientChat::before { content: "\eb80"; }
 *
 * Интересует только пара «имя класса → кодпоинт» из `content`.
 */

export interface ParsedIcon {
  codePoint: number;
  className: string;
}

/** Блок правила: селектор без скобок и тело без вложенных скобок. */
const RULE = /([^{}]*)\{([^{}]*)\}/g;
/**
 * Первый класс в селекторе. Буквы берём из Unicode, а не только латинские:
 * в наборе Saby есть `.icon-Сollapse` с кириллической «С», и на ASCII-шаблоне
 * имя обрезалось до `icon-` — такая иконка потом ищется под неправильным именем.
 */
const CLASS_NAME = /\.(-?[_\p{L}][_\p{L}\p{N}-]*)/u;
/** Значение content — в одинарных, двойных кавычках или без них. */
const CONTENT = /content\s*:\s*(?:'([^']*)'|"([^"]*)"|([^;}\s]+))/;

/** Ключевые слова, которые не являются символом. */
const CONTENT_KEYWORDS = new Set(['none', 'normal', 'inherit', 'initial', 'unset', 'revert']);

/**
 * Раскрывает CSS/LESS-экранирование: `\eb7e` → символ с кодом U+EB7E.
 * Поддерживаются до шести шестнадцатеричных цифр и экранированные литералы (`\:`).
 */
export function decodeCssEscapes(value: string): string {
  let result = '';

  for (let i = 0; i < value.length; i += 1) {
    const char = value[i];
    if (char !== '\\') {
      result += char;
      continue;
    }

    const rest = value.slice(i + 1);
    const hex = /^([0-9a-fA-F]{1,6})[ ]?/.exec(rest);
    if (hex) {
      result += String.fromCodePoint(parseInt(hex[1], 16));
      i += hex[0].length;
      continue;
    }

    // Экранированный литерал: `\:` → `:`.
    i += 1;
    if (i < value.length) result += value[i];
  }

  return result;
}

export function parseLessIcons(source: string): ParsedIcon[] {
  const byCodePoint = new Map<number, string>();

  RULE.lastIndex = 0;
  let rule: RegExpExecArray | null;

  while ((rule = RULE.exec(source)) !== null) {
    const className = CLASS_NAME.exec(rule[1])?.[1];
    if (!className) continue;

    const raw = CONTENT.exec(rule[2]);
    if (!raw) continue;

    const value = raw[1] ?? raw[2] ?? raw[3] ?? '';
    if (value === '' || CONTENT_KEYWORDS.has(value.toLowerCase())) continue;

    const decoded = decodeCssEscapes(value);
    // Ровно один символ: `content: "ab"` или `content: "\eb7e\eb7f"` — это не иконка.
    const characters = [...decoded];
    if (characters.length !== 1) continue;

    const codePoint = characters[0].codePointAt(0);
    if (codePoint === undefined) continue;

    // При дублях оставляем первое объявление: обычно это основной алиас.
    if (!byCodePoint.has(codePoint)) byCodePoint.set(codePoint, className);
  }

  return [...byCodePoint.entries()]
    .map(([codePoint, className]) => ({ codePoint, className }))
    .sort((a, b) => a.codePoint - b.codePoint);
}
