import type { FontMeta, SearchResult } from '../../shared/types';
import { formatCodePoint } from '../fontColors';
import { useT } from '../i18n';
import { GlyphVisual } from './GlyphVisual';

interface Props {
  results: SearchResult[];
  fonts: FontMeta[];
  /** Шрифты, уже зарегистрированные в popup: для них показываем настоящий символ. */
  loadedFontIds: Set<string>;
  selectedGlyphId: string | null;
  onSelect: (result: SearchResult) => void;
  /** Двойной щелчок по плитке копирует имя класса. */
  onCopy: (result: SearchResult) => void;
}

export function ResultsGrid({
  results,
  fonts,
  loadedFontIds,
  selectedGlyphId,
  onSelect,
  onCopy,
}: Props) {
  const t = useT();

  return (
    <div className="grid shrink-0 grid-cols-5 gap-2">
      {results.map((result, index) => {
        const font = fonts.find((item) => item.id === result.fontId);
        const family = font && loadedFontIds.has(font.id) ? font.family : null;
        const selected = result.glyphId === selectedGlyphId;
        const caption = result.iconName ?? `U+${formatCodePoint(result.codePoint)}`;
        const percent = Math.round(result.metrics.score * 100);

        return (
          <button
            key={result.glyphId}
            type="button"
            onClick={() => onSelect(result)}
            onDoubleClick={() => onCopy(result)}
            title={`${caption} · ${percent}% · ${t('copyHint')}`}
            className={`group relative flex cursor-pointer flex-col items-center gap-1 rounded-2xl px-1 pt-2 pb-1.5 transition ${
              selected
                ? 'z-[1] -translate-y-0.5 scale-[1.04] border-[var(--accent)] bg-[color-mix(in_srgb,var(--accent)_30%,transparent)] shadow-[inset_0_1px_0_rgb(255_255_255/0.35),0_0_0_2px_var(--accent),0_12px_24px_-8px_var(--accent)]'
                : 'glass hover:bg-[var(--soft-2)]'
            }`}
          >
            <span
              className={`absolute top-1 left-1.5 font-mono text-[8px] leading-none ${
                selected ? 'font-bold text-[var(--accent)]' : 'text-[var(--muted)] opacity-60'
              }`}
            >
              {index + 1}
            </span>
            <div className="flex h-[34px] items-center justify-center">
              <GlyphVisual
                char={result.char}
                preview={result.preview}
                family={family}
                size={28}
                className="text-[var(--text)]"
              />
            </div>
            <span
              className={`w-full truncate text-center font-mono text-[9px] leading-none ${
                selected ? 'font-semibold text-[var(--text)]' : 'text-[var(--text-2)]'
              }`}
            >
              {caption.replace(/^icon-/, '')}
            </span>
            <span
              className={`font-mono text-[9px] leading-none ${
                selected ? 'font-semibold text-[var(--text)]' : 'text-[var(--muted)]'
              }`}
            >
              {percent}%
            </span>
          </button>
        );
      })}
    </div>
  );
}
