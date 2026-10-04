/**
 * Watermark stamping on every page (or a selected subset), via the
 * zero-dependency WASM engine. `engine` draws rotated standard-Helvetica text
 * with opacity (`addWatermark`) — no font embedding, no third-party libraries — and the
 * output is then optimised through `optimizeAndSave` like every other flow.
 *
 * Position presets cover the 90% case (centre diagonal, corners, horizontal
 * banner). A fully-custom position (x, y, rotation) is also available.
 */

import { getEngine } from '../wasm';
import { optimizeAndSave } from './optimize-save';
import { engineLogger } from '../utils/logger';

export type WatermarkPosition =
  | 'center-diagonal'
  | 'top-left'
  | 'top-right'
  | 'bottom-left'
  | 'bottom-right'
  | 'header'
  | 'footer'
  | 'custom';

export interface WatermarkOptions {
  text: string;
  /** Pages to stamp (1-based). Defaults to all pages. */
  pages?: number[];
  position?: WatermarkPosition;
  /** Font size in PDF user-space. Default: ~page/8 (40-120) for the diagonal, 14 for header/footer, page/25 (10-24) for corners. Presets are shrunk to fit the page. */
  fontSize?: number;
  /** Colour [r, g, b] in [0, 1]. Defaults to mid-gray. */
  color?: [number, number, number];
  /** Opacity 0-1. Defaults to 0.25 (subtle). */
  opacity?: number;
  /** Angle in degrees, counter-clockwise, for the presets (default 45 for the diagonal, 0 otherwise). Ignored for 'custom'. */
  rotation?: number;
  /** Custom position (only used when position === 'custom'). */
  custom?: { x: number; y: number; rotation: number };
}

export interface WatermarkResult {
  bytes: Uint8Array;
  pagesStamped: number;
  outputBytes: number;
}

const DEFAULT_COLOR: [number, number, number] = [0.5, 0.5, 0.5];

/** Distance kept between corner/header/footer watermarks and the page edge. */
const EDGE_MARGIN = 36;
const BAND_MARGIN = 24;
/** Share of a Helvetica em that the glyph body sits above the baseline (x-height..cap-height centre). */
const BODY_CENTER_RATIO = 0.36;

export interface WatermarkPlacement {
  x: number;
  y: number;
  fontSize: number;
  rotation: number;
}

/** Default size for a preset: big for the diagonal stamp, small for corners/bands. */
export function defaultWatermarkFontSize(position: WatermarkPosition, w: number, h: number): number {
  if (position === 'header' || position === 'footer') return 14;
  if (position === 'center-diagonal' || position === 'custom') {
    return Math.max(40, Math.min(120, Math.sqrt(w * h) / 8));
  }
  // Corners: relative to the page, never the 88pt diagonal size (which ran off
  // the page: "CONFIDENTIAL" at 88pt is 649pt wide, an A4 page is 595pt).
  return Math.max(10, Math.min(24, Math.min(w, h) / 25));
}

/**
 * Where the stamp goes, in PDF user space (origin bottom-left, `x`/`y` = the
 * start of the text baseline). Pure so the editor tests can assert the exported
 * geometry. `widthAt(size)` is the Helvetica advance of the text at `size`.
 *
 * Every preset is anchored by the axis-aligned box around the (possibly
 * rotated) text box - advance x [-0.2em, 1em] - so corners and bands sit the
 * same distance from the page edge at any angle. Presets never run off the
 * page: the font size is reduced until that box fits inside the page minus its
 * margin. `custom` is returned as given.
 *
 * `rotation`: degrees counter-clockwise (PDF convention). Default 45 for the
 * diagonal, 0 for everything else.
 */
export function planWatermark(
  position: WatermarkPosition,
  w: number,
  h: number,
  widthAt: (size: number) => number,
  requestedSize?: number,
  custom?: { x: number; y: number; rotation: number },
  requestedRotation?: number,
): WatermarkPlacement {
  let fontSize = requestedSize ?? defaultWatermarkFontSize(position, w, h);
  if (position === 'custom') {
    if (!custom) throw new Error('addWatermark: custom position requires {x, y, rotation}');
    return { x: custom.x, y: custom.y, fontSize, rotation: custom.rotation };
  }

  const diagonal = position === 'center-diagonal';
  const rotation = requestedRotation ?? (diagonal ? 45 : 0);
  const band = diagonal || position === 'header' || position === 'footer';
  const margin = band ? BAND_MARGIN : EDGE_MARGIN;
  const rad = (rotation * Math.PI) / 180;
  const cos = Math.cos(rad);
  const sin = Math.sin(rad);

  /** AABB of the rotated text box relative to the baseline start. */
  const extentAt = (size: number) => {
    const tw = widthAt(size);
    const xs: number[] = [];
    const ys: number[] = [];
    for (const u of [0, tw]) {
      for (const v of [-0.2 * size, size]) {
        xs.push(u * cos - v * sin);
        ys.push(u * sin + v * cos);
      }
    }
    return { minX: Math.min(...xs), maxX: Math.max(...xs), minY: Math.min(...ys), maxY: Math.max(...ys), tw };
  };

  let ext = extentAt(fontSize);
  const scale = Math.min(1, (w - 2 * margin) / (ext.maxX - ext.minX), (h - 2 * margin) / (ext.maxY - ext.minY));
  if (scale < 1) {
    fontSize = Math.max(1, fontSize * scale);
    ext = extentAt(fontSize);
  }

  let x: number;
  let y: number;
  switch (position) {
    case 'top-left':
      x = EDGE_MARGIN - ext.minX;
      y = h - EDGE_MARGIN - ext.maxY;
      break;
    case 'top-right':
      x = w - EDGE_MARGIN - ext.maxX;
      y = h - EDGE_MARGIN - ext.maxY;
      break;
    case 'bottom-left':
      x = EDGE_MARGIN - ext.minX;
      y = EDGE_MARGIN - ext.minY;
      break;
    case 'bottom-right':
      x = w - EDGE_MARGIN - ext.maxX;
      y = EDGE_MARGIN - ext.minY;
      break;
    case 'header':
      x = w / 2 - (ext.minX + ext.maxX) / 2;
      y = h - BAND_MARGIN - ext.maxY;
      break;
    case 'footer':
      x = w / 2 - (ext.minX + ext.maxX) / 2;
      y = BAND_MARGIN - ext.minY;
      break;
    case 'center-diagonal':
    default: {
      // Centre the glyph body (not the baseline) on the page centre.
      const lift = BODY_CENTER_RATIO * fontSize;
      x = w / 2 - ((ext.tw / 2) * cos - lift * sin);
      y = h / 2 - ((ext.tw / 2) * sin + lift * cos);
    }
  }
  // Safety net: whatever the maths above says, keep the box on the page.
  x = Math.min(Math.max(x, -ext.minX), w - ext.maxX);
  y = Math.min(Math.max(y, -ext.minY), h - ext.maxY);
  return { x, y, fontSize, rotation };
}

/** Pack an [r, g, b] triple in [0, 1] into a `0xRRGGBB` integer. */
function packRgb([r, g, b]: [number, number, number]): number {
  const c = (v: number) => Math.max(0, Math.min(255, Math.round(v * 255)));
  return (c(r) << 16) | (c(g) << 8) | c(b);
}

export async function addWatermark(
  pdfBytes: Uint8Array,
  options: WatermarkOptions,
): Promise<WatermarkResult> {
  const {
    text,
    pages,
    position = 'center-diagonal',
    color = DEFAULT_COLOR,
    opacity = 0.25,
    custom,
  } = options;

  if (!text.trim()) {
    throw new Error('addWatermark: text is required');
  }

  const giga = await getEngine();
  const data = pdfBytes instanceof Uint8Array ? pdfBytes : new Uint8Array(pdfBytes);
  const doc = giga.open(data);

  try {
    const rgb = packRgb(color);
    const totalPages = doc.pageCount();
    const targetPages = pages
      ? pages.filter((p) => p >= 1 && p <= totalPages)
      : Array.from({ length: totalPages }, (_, i) => i + 1);

    let stamped = 0;

    for (const pageNumber of targetPages) {
      const { width: w, height: h } = doc.pageInfo(pageNumber);

      const { x, y, fontSize, rotation } = planWatermark(
        position,
        w,
        h,
        (size) => giga.helveticaWidth(size, text),
        options.fontSize,
        custom,
        options.rotation,
      );

      doc.addWatermark(pageNumber, x, y, fontSize, text, rgb, opacity, rotation);
      stamped++;
    }

    const stampedBytes = doc.save();
    const optimised = await optimizeAndSave(stampedBytes);

    engineLogger.info('watermark: applied', {
      pagesStamped: stamped,
      position,
      optimisedBytes: optimised.bytes.byteLength,
    });

    return {
      bytes: optimised.bytes,
      pagesStamped: stamped,
      outputBytes: optimised.bytes.byteLength,
    };
  } finally {
    doc.close();
  }
}
