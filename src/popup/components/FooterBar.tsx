import { Spinner } from '@heroui/react';
import { useT } from '../i18n';

interface Props {
  /** Глифов, разобранных из .less и найденных в шрифте. */
  glyphTotal: number | null;
  busy: boolean;
  /** Версия новее установленной: кнопка «Обновить» встаёт слева от шестерёнки. */
  updateVersion?: string | null;
  onUpdate?: () => void;
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
      width="18"
      height="18"
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

function ArrowUpIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      width="12"
      height="12"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.4"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M12 19V5M5.5 11.5 12 5l6.5 6.5" />
    </svg>
  );
}

/**
 * Футер приложения: сколько иконок ищется, кнопка обновления (если вышла новая версия)
 * и вход в настройки.
 */
export function FooterBar({ glyphTotal, busy, updateVersion, onUpdate, onOpenSettings }: Props) {
  const t = useT();

  return (
    <div className="flex shrink-0 items-center gap-2">
      {glyphTotal === null ? (
        <Spinner size="sm" />
      ) : (
        <span className="shrink-0 text-[11px] whitespace-nowrap text-[var(--muted)]">
          {t('glyphsFound')} <span className="font-medium text-[var(--text-2)]">{glyphTotal}</span>
        </span>
      )}

      <span className="flex-1" />

      {updateVersion && onUpdate && (
        <button
          type="button"
          onClick={onUpdate}
          title={`${t('updateAvailable')} ${updateVersion}`}
          className="flex h-8 shrink-0 cursor-pointer items-center gap-1.5 rounded-full border border-white/30 bg-[var(--accent)] px-3 text-[11px] font-medium whitespace-nowrap text-white shadow-[inset_0_1px_0_rgb(255_255_255/0.4),0_8px_18px_-8px_var(--accent)] transition hover:brightness-110"
        >
          <ArrowUpIcon />
          {t('updateOpen')} · {updateVersion}
        </button>
      )}

      <button
        type="button"
        onClick={onOpenSettings}
        disabled={busy}
        aria-label={t('settings')}
        title={t('settings')}
        className="glass-pill flex h-8 w-8 shrink-0 cursor-pointer items-center justify-center rounded-full text-[var(--text-2)] transition hover:text-[var(--text)] disabled:opacity-40"
      >
        <GearIcon />
      </button>
    </div>
  );
}
