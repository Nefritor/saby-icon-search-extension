import { Chip, Spinner } from '@heroui/react';
import { useT } from '../i18n';

interface Props {
  /** Глифов, разобранных из .less и найденных в шрифте. */
  glyphTotal: number | null;
  /** Время последнего поиска — показывается только при включённой отладке. */
  debugMs: number | null;
  busy: boolean;
  onOpenSettings: () => void;
}

/**
 * Шестерёнка контуром: восемь трапециевидных зубцов и круглое отверстие.
 * Именно контур, а не заливка: залитый вариант на 20 px сливался в пятно,
 * а тонкие спицы читались как солнце.
 */
function GearIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      width="21"
      height="21"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M9.62 4.47L9.88 2.02L14.12 2.02L14.38 4.47L15.65 4.99L17.56 3.45L20.55 6.44L19.01 8.35L19.53 9.62L21.98 9.88L21.98 14.12L19.53 14.38L19.01 15.65L20.55 17.56L17.56 20.55L15.65 19.01L14.38 19.53L14.12 21.98L9.88 21.98L9.62 19.53L8.35 19.01L6.44 20.55L3.45 17.56L4.99 15.65L4.47 14.38L2.02 14.12L2.02 9.88L4.47 9.62L4.99 8.35L3.45 6.44L6.44 3.45L8.35 4.99Z" />
      <circle cx="12" cy="12" r="3.4" />
    </svg>
  );
}

/**
 * Футер приложения: сколько иконок ищется и вход в настройки.
 * Настройки внешнего вида сюда не входят — они лежат в футере самой панели настроек.
 */
export function FooterBar({ glyphTotal, debugMs, busy, onOpenSettings }: Props) {
  const t = useT();

  return (
    <div className="flex shrink-0 items-center gap-2 items-end">
      {glyphTotal === null ? (
        <Spinner size="sm" />
      ) : (
        <Chip size="sm" variant="soft" color="success" className="shrink-0 whitespace-nowrap">
          <span className="text-[10px] px-1">
            {t('glyphsFound')}: {glyphTotal}
          </span>
        </Chip>
      )}

      {debugMs !== null && (
        <span className="shrink-0 font-mono text-[10px] text-[var(--muted)]">{debugMs} мс</span>
      )}

      <span className="flex-1" />

      <button
        type="button"
        onClick={onOpenSettings}
        disabled={busy}
        aria-label={t('settings')}
        title={t('settings')}
        className="flex h-10 w-10 shrink-0 cursor-pointer items-center justify-center rounded-xl bg-[var(--soft-2)] text-[var(--text-2)] transition hover:bg-[var(--soft-3)] hover:text-[var(--text)] disabled:opacity-50"
      >
        <GearIcon />
      </button>
    </div>
  );
}
