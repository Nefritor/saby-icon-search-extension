import { useEffect, useRef, useState } from 'react';
import { useT } from '../i18n';
import type { Lang, ThemeName } from '../prefs';

interface Props {
  theme: ThemeName;
  lang: Lang;
  onTheme: (theme: ThemeName) => void;
  onLang: (lang: Lang) => void;
}

/**
 * Цвета свитча темы. Акцент здесь не используется намеренно: кружок сам показывает
 * время суток — янтарный с солнцем или синий с луной, — и переключение темы не
 * должно выглядеть как смена акцента.
 */
const KNOB_LIGHT = { background: '#f5c542', color: '#7a5a15' } as const;
const KNOB_DARK = { background: '#5b8def', color: '#ffffff' } as const;

function MoonIcon() {
  return (
    <svg viewBox="0 0 24 24" width="12" height="12" fill="currentColor" aria-hidden="true">
      <path d="M20 14.5A8.5 8.5 0 0 1 9.5 4a8.5 8.5 0 1 0 10.5 10.5Z" />
    </svg>
  );
}

function SunIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      width="12"
      height="12"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.4"
      strokeLinecap="round"
      aria-hidden="true"
    >
      <circle cx="12" cy="12" r="4.4" fill="currentColor" stroke="none" />
      <path d="M12 2.4v2.2M12 19.4v2.2M2.4 12h2.2M19.4 12h2.2M5.3 5.3l1.6 1.6M17.1 17.1l1.6 1.6M18.7 5.3l-1.6 1.6M6.9 17.1l-1.6 1.6" />
    </svg>
  );
}

function ChevronIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      width="11"
      height="11"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="m6 9 6 6 6-6" />
    </svg>
  );
}

function CheckIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      width="13"
      height="13"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="m4.5 12.5 5 5 10-11" />
    </svg>
  );
}

/**
 * Настройки внешнего вида: тема слева, язык справа. Живут в футере панели настроек
 * и выровнены по центру — обе настройки одной высоты, поэтому центрирование здесь
 * читается ровнее, чем выравнивание по низу.
 *
 * Список языков раскрывается вниз и позиционирован абсолютно: в потоке он раздвигал
 * бы соседей, а обрезанный краем прокручиваемого блока — пропадал бы совсем.
 */
export function AppearanceControls({ theme, lang, onTheme, onLang }: Props) {
  const t = useT();
  const [langOpen, setLangOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement | null>(null);

  // Клик мимо блока закрывает список.
  useEffect(() => {
    if (!langOpen) return undefined;

    const onPointerDown = (event: MouseEvent) => {
      if (rootRef.current?.contains(event.target as Node)) return;
      setLangOpen(false);
    };

    document.addEventListener('mousedown', onPointerDown);
    return () => document.removeEventListener('mousedown', onPointerDown);
  }, [langOpen]);

  const dark = theme === 'dark';

  return (
    <div ref={rootRef} className="relative flex w-full items-center justify-between">
      {/* Свитч темы: положение и иконка показывают текущую тему. */}
      <button
        type="button"
        role="switch"
        aria-checked={dark}
        aria-label={t('theme')}
        title={dark ? t('themeLight') : t('themeDark')}
        onClick={() => onTheme(dark ? 'light' : 'dark')}
        className="flex h-6 w-11 shrink-0 cursor-pointer items-center rounded-full bg-[var(--soft-2)] px-[2px] ring-1 ring-[var(--line)] transition-colors"
      >
        <span
          className={`flex h-5 w-5 items-center justify-center rounded-full shadow-sm transition-transform duration-300 ${
            dark ? 'translate-x-0' : 'translate-x-5'
          }`}
          style={dark ? KNOB_DARK : KNOB_LIGHT}
        >
          {dark ? <MoonIcon /> : <SunIcon />}
        </span>
      </button>

      {/* Язык — свой список, а не нативный select: нативный не вписывается в тему. */}
      <div className="relative shrink-0">
        <button
          type="button"
          aria-haspopup="listbox"
          aria-expanded={langOpen}
          aria-label={t('language')}
          onClick={() => setLangOpen((open) => !open)}
          className="flex cursor-pointer items-center gap-1.5 rounded-lg bg-[var(--soft-2)] px-2.5 py-1.5 text-[12px] text-[var(--text)] transition hover:bg-[var(--soft-3)]"
        >
          {lang === 'ru' ? 'Русский' : 'English'}
          <ChevronIcon />
        </button>

        {langOpen && (
          <div className="absolute top-full right-0 z-30 mt-1 min-w-full">
            <div
              role="listbox"
              className="popover-in overflow-hidden rounded-xl bg-[var(--panel)] py-1 shadow-lg ring-1 ring-[var(--line)]"
            >
              {(['ru', 'en'] as Lang[]).map((code) => (
                <button
                  key={code}
                  type="button"
                  role="option"
                  aria-selected={lang === code}
                  onClick={() => {
                    onLang(code);
                    setLangOpen(false);
                  }}
                  className={`flex w-full cursor-pointer items-center gap-2 px-3 py-2 text-left text-[13px] whitespace-nowrap transition ${
                    lang === code
                      ? 'bg-[var(--accent)] font-medium text-white'
                      : 'text-[var(--text-2)] hover:bg-[var(--soft-2)]'
                  }`}
                >
                  {/* Галка слева и в своём слоте: иначе подписи пунктов разъезжались бы. */}
                  <span className="flex w-[13px] shrink-0 justify-start">
                    {lang === code && <CheckIcon />}
                  </span>
                  {code === 'ru' ? 'Русский' : 'English'}
                </button>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
