/**
 * Знак Saby для шапки popup.
 *
 * Это тот же контур, что в `design/icons/logo.svg`: геометрия снята по пикселям
 * образца, пропорции — 176.5×247.5 (габариты знака без полей), цвета — светлая
 * грань `#0B96FC` и тёмная `#0A70BE`. Инлайним, а не тянем файлом: значок
 * размером с заголовок, лишний запрос на него не нужен.
 */
export function BrandMark({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 176.5 247.5"
      className={className}
      role="img"
      aria-label="Saby"
      focusable="false"
    >
      <path d="M0 0 L121 79 L149 100.5 L102.5 161.5 L88.5 144 Z" fill="#0B96FC" />
      <path d="M132.5 50 L176.5 36.5 L145.5 81.5 L149 100.5 L121 79 Z" fill="#0B96FC" />
      <path d="M134.5 50.5 L121 79 L149 100.5 Z" fill="#0A70BE" />
      <path d="M88.5 144 L102.5 161.5 L38.5 247.5 Z" fill="#0A70BE" />
    </svg>
  );
}
