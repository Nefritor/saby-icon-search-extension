/**
 * Индекс вшитого набора иконок для скриптов: растеризует шрифт через @napi-rs/canvas
 * теми же параметрами, что расширение, и строит дескрипторы глифов тем же кодом.
 */
import { GlobalFonts, createCanvas } from '@napi-rs/canvas';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { alphaToMask } from '../../src/core/image/binarize.ts';
import { normalizeMask } from '../../src/core/image/normalize.ts';
import { parseLessIcons } from '../../src/core/less/parseLess.ts';
import { createGlyphEntry, type GlyphEntry } from '../../src/core/matching/matcher.ts';
import {
  ICON_MARGIN,
  ICON_SIZE,
  RASTER_CANVAS,
  RASTER_FONT_PX,
} from '../../src/shared/constants.ts';
import type { GlyphRecord } from '../../src/shared/types.ts';

const root = resolve(import.meta.dirname, '../..');

/** Размер растра, из которого синтезируются наброски: крупнее индексного, чтобы не терять детали. */
export const SOURCE = 256;

GlobalFonts.registerFromPath(resolve(root, 'public/defaults/cbuc-icons.ttf'), 'EvalIcons');
const icons = parseLessIcons(readFileSync(resolve(root, 'public/defaults/_glyphs.less'), 'utf8'));

export function rasterize(char: string, canvasSize: number, fontPx: number): Uint8Array {
  const canvas = createCanvas(canvasSize, canvasSize);
  const context = canvas.getContext('2d');
  context.fillStyle = '#000';
  context.textAlign = 'center';
  context.textBaseline = 'middle';
  context.font = `${fontPx}px "EvalIcons"`;
  context.fillText(char, canvasSize / 2, canvasSize / 2);
  const image = context.getImageData(0, 0, canvasSize, canvasSize);
  return alphaToMask(image.data as unknown as Uint8ClampedArray, canvasSize, canvasSize, 128);
}

export interface Item {
  className: string;
  entry: GlyphEntry;
  /** Крупный растр глифа — материал для синтетических набросков. */
  source: Uint8Array;
  /** Подпись маски: глифы с одной картинкой (алиасы) неразличимы и считаются одним ответом. */
  hash: string;
}

export const items: Item[] = [];
export const itemByEntry = new Map<GlyphEntry, Item>();

for (const icon of icons) {
  const char = String.fromCodePoint(icon.codePoint);
  const raster = rasterize(char, RASTER_CANVAS, RASTER_FONT_PX);
  const normalized = normalizeMask(raster, RASTER_CANVAS, RASTER_CANVAS, ICON_SIZE, ICON_MARGIN);
  if (!normalized) continue;
  const record: GlyphRecord = {
    id: `eval:${icon.codePoint}`,
    fontId: 'eval',
    fontName: 'eval',
    sourceKind: 'file',
    sourceValue: 'eval',
    codePoint: icon.codePoint,
    char,
    mask: normalized.mask,
    inkPixels: normalized.mask.reduce((a, b) => a + b, 0),
    coverage: normalized.coverage,
    aspect: normalized.aspect,
  };
  const item: Item = {
    className: icon.className,
    entry: createGlyphEntry(record),
    source: rasterize(char, SOURCE, SOURCE * 0.625),
    hash: Buffer.from(normalized.mask).toString('base64'),
  };
  items.push(item);
  itemByEntry.set(item.entry, item);
}

export const entries = items.map((item) => item.entry);
