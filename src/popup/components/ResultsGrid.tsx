import type { FontMeta, SearchResult } from '../../shared/types';
import { formatCodePoint } from '../fontColors';
import { GlyphVisual } from './GlyphVisual';

interface Props {
  results: SearchResult[];
  fonts: FontMeta[];
  /** Шрифты, уже зарегистрированные в popup: для них показываем настоящий символ. */
  loadedFontIds: Set<string>;
  selectedGlyphId: string | null;
  onSelect: (result: SearchResult) => void;
}

export function ResultsGrid({ results, fonts, loadedFontIds, selectedGlyphId, onSelect }: Props) {
  return (
    <div className="grid shrink-0 grid-cols-5 gap-1.5">
      {results.map((result) => {
        const font = fonts.find((item) => item.id === result.fontId);
        const family = font && loadedFontIds.has(font.id) ? font.family : null;
        const selected = result.glyphId === selectedGlyphId;
        const caption = result.iconName ?? `U+${formatCodePoint(result.codePoint)}`;

        return (
          <button
            key={result.glyphId}
            type="button"
            onClick={() => onSelect(result)}
            title={`${caption} · ${Math.round(result.metrics.score * 100)}%`}
            className={`flex cursor-pointer flex-col items-center rounded-xl bg-zinc-100 px-1 py-1 transition ${
              selected
                ? 'ring-[3px] ring-[var(--accent)]'
                : 'ring-2 ring-transparent hover:bg-white'
            }`}
          >
            <div className="flex h-[38px] items-center justify-center">
              <GlyphVisual
                char={result.char}
                preview={result.preview}
                family={family}
                size={32}
                className="text-zinc-900"
              />
            </div>
            <span className="font-mono text-[11px] font-semibold leading-none text-zinc-800">
              {Math.round(result.metrics.score * 100)}%
            </span>
            <span className="mt-0.5 w-full truncate text-center font-mono text-[8px] leading-none text-zinc-500">
              {caption.replace(/^icon-/, '')}
            </span>
          </button>
        );
      })}
    </div>
  );
}
