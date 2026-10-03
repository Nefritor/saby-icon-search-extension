import { GlyphPreview } from './GlyphPreview';

interface Props {
  char: string;
  preview: string;
  /**
   * CSS-семейство, если шрифт загружен в popup.
   * Пока шрифт не готов — показываем растровую маску, она есть всегда.
   */
  family: string | null;
  size: number;
  className?: string;
}

/** Настоящий символ шрифта. Если шрифт ещё не загружен в popup — запасная маска. */
export function GlyphVisual({ char, preview, family, size, className }: Props) {
  if (!family) {
    return <GlyphPreview preview={preview} size={size} className={className} />;
  }

  return (
    <span
      className={className}
      style={{
        fontFamily: `"${family}"`,
        fontSize: size,
        lineHeight: 1,
        display: 'inline-block',
      }}
    >
      {char}
    </span>
  );
}
