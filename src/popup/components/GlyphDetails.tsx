import { useState } from 'react';
import type { Hypothesis } from '../../shared/constants';
import type { SearchResult } from '../../shared/types';
import { formatCodePoint } from '../fontColors';
import { useT, type TranslationKey } from '../i18n';
import { GlyphVisual } from './GlyphVisual';

interface Props {
  result: SearchResult | null;
  /** Показывать ли сырые метрики. Управляется галкой в настройках. */
  showDebug: boolean;
  family: string | null;
}

const HYPOTHESIS_KEYS: Record<Hypothesis, TranslationKey> = {
  fill: 'hypothesisFill',
  skeleton: 'hypothesisSkeleton',
  contour: 'hypothesisContour',
};

/** Минималистичная иконка буфера обмена: доска и зажим сверху. */
function ClipboardIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      width="13"
      height="13"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <rect x="5" y="5" width="14" height="16" rx="2.5" />
      <path d="M9.5 3h5a1 1 0 0 1 1 1v2h-7V4a1 1 0 0 1 1-1Z" />
    </svg>
  );
}

/** Галка — подтверждение копирования. */
function CheckIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      width="13"
      height="13"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.4"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="m4.5 12.5 5 5 10-11" />
    </svg>
  );
}
export function GlyphDetails({ result, showDebug, family }: Props) {
  const [copied, setCopied] = useState<string | null>(null);
  const t = useT();

  if (!result) {
    return (
      <div className="flex h-full items-center justify-center rounded-xl bg-[var(--panel)] px-4 text-center text-[10px] leading-relaxed text-[var(--muted)] ring-1 ring-[var(--line)]">
        {t('detailsHint')}
      </div>
    );
  }

  const { metrics } = result;
  const title = result.iconName ?? `U+${formatCodePoint(result.codePoint)}`;

  const copy = (value: string, mark: string) => {
    void navigator.clipboard
      .writeText(value)
      .then(() => {
        setCopied(mark);
        window.setTimeout(() => setCopied(null), 900);
      })
      .catch(() => undefined);
  };

  const debugRows: Array<[string, string]> = [
    ['score', `${(metrics.score * 100).toFixed(1)}%`],
    ['hypothesis', metrics.hypothesis],
    ['frame', metrics.frame],
    ['bestRotation', `${metrics.bestRotation}°`],
    ['chamferFill', `${metrics.chamferFill.toFixed(2)} px`],
    ['iou', metrics.iou.toFixed(3)],
    ['chamferSkeleton', `${metrics.chamferSkeleton.toFixed(2)} px`],
    ['chamferContour', `${metrics.chamferContour.toFixed(2)} px`],
    ['normFill', metrics.normFill.toFixed(3)],
    ['normSkeleton', metrics.normSkeleton.toFixed(3)],
    ['normContour', metrics.normContour.toFixed(3)],
    ['fillScore', metrics.fillScore.toFixed(3)],
    ['skeletonScore', metrics.skeletonScore.toFixed(3)],
    ['contourScore', metrics.contourScore.toFixed(3)],
    ['hogSimilarity', metrics.hogSimilarity.toFixed(3)],
    ['inkPixels', String(result.inkPixels)],
    ['coverage', result.coverage.toFixed(3)],
    ['aspect', result.aspect.toFixed(3)],
    ['codePoint', `${result.codePoint} (0x${formatCodePoint(result.codePoint)})`],
  ];

  return (
    <div className="thin-scroll h-full overflow-y-auto rounded-xl bg-[var(--panel)] p-2 ring-1 ring-[var(--line)]">
      {/* Квадрат задан обеими сторонами: при растягивании высота не «определённая»,
          и aspect-ratio к флекс-элементу браузер не применяет. */}
      <div className="flex items-stretch gap-2">
        <div className="flex h-[84px] w-[84px] shrink-0 items-center justify-center rounded-lg bg-zinc-100">
          <GlyphVisual
            char={result.char}
            preview={result.preview}
            family={family}
            size={54}
            className="text-zinc-900"
          />
        </div>

        <div className="min-w-0 flex-1 space-y-0.5 text-[10px]">
          <div className="flex items-center gap-2">
            <span className="truncate text-[12px] font-semibold text-[var(--text)]" title={title}>
              {title}
            </span>
            {result.iconName && (
              <>
                <button
                  type="button"
                  onClick={() => copy(result.iconName as string, 'class')}
                  aria-label={t('copyClass')}
                  title={t('copyClass')}
                  className={`flex h-[22px] w-[22px] shrink-0 cursor-pointer items-center justify-center rounded-full transition-colors duration-300 ${
                    copied === 'class'
                      ? 'bg-emerald-500/25 text-emerald-300'
                      : 'bg-[var(--soft-2)] text-[var(--text-2)] hover:bg-[var(--soft-3)] hover:text-[var(--text)]'
                  }`}
                >
                  {copied === 'class' ? <CheckIcon /> : <ClipboardIcon />}
                </button>
                {/* Место под подпись зарезервировано, поэтому при копировании
                                    ничего не дёргается — меняется только прозрачность. */}
                <span
                  className={`w-[62px] shrink-0 text-[9px] text-emerald-500 transition-opacity duration-300 ${
                    copied === 'class' ? 'opacity-100' : 'opacity-0'
                  }`}
                >
                  {t('copied')}
                </span>
              </>
            )}
          </div>

          <div className="font-mono text-[var(--muted)]">
            {result.char} · U+{formatCodePoint(result.codePoint)}
          </div>

          <div className="text-[var(--muted)]">
            {t('confidence')}{' '}
            <span className="font-mono text-emerald-500">{Math.round(metrics.score * 100)}%</span> ·{' '}
            {t(HYPOTHESIS_KEYS[metrics.hypothesis])}
          </div>

          <div className="flex gap-1.5 pt-1">
            <button
              type="button"
              onClick={() => copy(result.char, 'char')}
              className="cursor-pointer rounded-md bg-[var(--soft-2)] px-2 py-0.5 text-[10px] text-[var(--text)] transition hover:bg-[var(--soft-3)]"
            >
              {copied === 'char' ? t('copied') : t('symbol')}
            </button>
          </div>
        </div>
      </div>

      {showDebug && (
        <div className="mt-2 grid grid-cols-2 gap-x-3 gap-y-0.5 font-mono text-[10px]">
          {debugRows.map(([key, value]) => (
            <div
              key={key}
              className="flex items-baseline justify-between gap-2 border-b border-[var(--line)] pb-0.5"
            >
              <span className="truncate text-[var(--muted)]" title={key}>
                {key}
              </span>
              <span className="shrink-0 text-[var(--text-2)]">{value}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
