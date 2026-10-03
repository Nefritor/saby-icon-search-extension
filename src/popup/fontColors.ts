/** Кодпоинт в виде U+XXXX — для подписи глифа без имени класса. */
export function formatCodePoint(codePoint: number): string {
  return codePoint.toString(16).toUpperCase().padStart(4, '0');
}
