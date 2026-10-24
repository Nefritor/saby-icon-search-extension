import { useState } from 'react';
import type { SearchResult } from '../../shared/types';
import { formatCodePoint } from '../fontColors';
import { useT } from '../i18n';
import { GlyphVisual } from './GlyphVisual';

interface Props {
  result: SearchResult | null;
  family: string | null;
}

/** Галка — подтверждение копирования. */
function CheckIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      width="11"
      height="11"
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

/** Кнопка-«таблетка» копирования: после щелчка на секунду меняется на галку. */
function CopyChip({
  label,
  active,
  onClick,
}: {
  label: string;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`flex h-6 cursor-pointer items-center gap-1 rounded-full px-2.5 text-[10px] transition-colors duration-200 ${
        active
          ? 'bg-emerald-500/20 text-emerald-400'
          : 'glass-pill text-[var(--text-2)] hover:text-[var(--text)]'
      }`}
    >
      {active && <CheckIcon />}
      {label}
    </button>
  );
}

export function GlyphDetails({ result, family }: Props) {
  const [copied, setCopied] = useState<string | null>(null);
  const t = useT();

  if (!result) {
    return (
      <div className="flex h-full items-center justify-center glass rounded-3xl px-4 text-center text-[10px] leading-relaxed text-[var(--muted)]">
        {t('detailsHint')}
      </div>
    );
  }

  const { metrics } = result;
  const hex = formatCodePoint(result.codePoint);
  const title = result.iconName ?? `U+${hex}`;

  const copy = (value: string, mark: string) => {
    void navigator.clipboard
      .writeText(value)
      .then(() => {
        setCopied(mark);
        window.setTimeout(() => setCopied((current) => (current === mark ? null : current)), 1100);
      })
      .catch(() => undefined);
  };

  return (
    <div className="thin-scroll glass h-full overflow-y-auto rounded-3xl p-3">
      <div className="flex items-stretch gap-3">
        <div className="flex h-[76px] w-[76px] shrink-0 items-center justify-center rounded-2xl border border-[var(--canvas-line)] bg-[var(--canvas)]">
          <GlyphVisual
            char={result.char}
            preview={result.preview}
            family={family}
            size={48}
            className="text-zinc-900"
          />
        </div>

        <div className="flex min-w-0 flex-1 flex-col justify-between">
          <div className="min-w-0">
            <div className="truncate text-[13px] font-semibold text-[var(--text)]" title={title}>
              {title}
            </div>
            <div className="mt-0.5 font-mono text-[10px] text-[var(--muted)]">
              U+{hex} · {t('confidence')}{' '}
              <span className="text-emerald-500">{Math.round(metrics.score * 100)}%</span>
            </div>
          </div>

          <div className="flex flex-wrap gap-1">
            {result.iconName && (
              <CopyChip
                label={t('copyClass')}
                active={copied === 'class'}
                onClick={() => copy(result.iconName as string, 'class')}
              />
            )}
            {result.iconName && (
              <CopyChip
                label={t('copyHtml')}
                active={copied === 'html'}
                onClick={() => copy(`<span class="${result.iconName}"></span>`, 'html')}
              />
            )}
            <CopyChip
              label={t('copyCode')}
              active={copied === 'code'}
              onClick={() => copy(`\\${hex.toLowerCase()}`, 'code')}
            />
            <CopyChip
              label={t('symbol')}
              active={copied === 'char'}
              onClick={() => copy(result.char, 'char')}
            />
          </div>
        </div>
      </div>
    </div>
  );
}
