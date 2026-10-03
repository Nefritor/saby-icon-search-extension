import { useEffect, useRef } from 'react';
import { base64ToBytes } from '../../core/image/bits';
import { PREVIEW_SIZE } from '../../shared/constants';

interface Props {
  preview: string;
  /** Размер отображения в пикселях. */
  size: number;
  className?: string;
}

/** Реальная иконка глифа: маска 48×48, отрисованная без сглаживания. */
export function GlyphPreview({ preview, size, className }: Props) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const context = canvas.getContext('2d');
    if (!context) return;

    const bytes = base64ToBytes(preview);
    const image = context.createImageData(PREVIEW_SIZE, PREVIEW_SIZE);
    for (let i = 0; i < PREVIEW_SIZE * PREVIEW_SIZE; i += 1) {
      const ink = bytes[i] === 1;
      image.data[i * 4] = 24;
      image.data[i * 4 + 1] = 24;
      image.data[i * 4 + 2] = 27;
      image.data[i * 4 + 3] = ink ? 255 : 0;
    }
    context.putImageData(image, 0, 0);
  }, [preview]);

  return (
    <canvas
      ref={canvasRef}
      width={PREVIEW_SIZE}
      height={PREVIEW_SIZE}
      className={className}
      style={{ width: size, height: size, imageRendering: 'pixelated' }}
    />
  );
}
