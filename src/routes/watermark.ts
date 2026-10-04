/**
 * PDF Watermark route.
 *
 * POST /api/pdf/watermark
 *
 * Form fields (multipart/form-data):
 *   file       — PDF file (required)
 *   mode       — "text" (default) | "image"
 *   pages      — JSON array of 1-based page numbers (optional, defaults to all)
 *   opacity    — Number in [0, 1] (optional, default 0.25)
 *
 *   Text mode (mode omitted or "text"):
 *     text     — Watermark text (required, non-empty)
 *     position — "center-diagonal" | "top-left" | "top-right" |
 *                "bottom-left" | "bottom-right" | "header" | "footer" |
 *                "custom" (default: center-diagonal)
 *     fontSize — Number 1-500 (optional; default depends on position and
 *                is shrunk so the stamp fits on the page)
 *     rotation — Degrees counter-clockwise, -360..360 (optional; default 45
 *                for center-diagonal, 0 otherwise; ignored for "custom")
 *     color    — JSON array [r, g, b] in [0,1] (optional)
 *     custom   — JSON {x, y, rotation} when position === "custom"
 *
 *   Image mode (mode === "image"):
 *     image       — Image file (required; PNG/JPEG/WebP/GIF/AVIF)
 *     anchor      — "center" (default) | "top-left" | "top-right" |
 *                   "bottom-left" | "bottom-right"
 *     width       — Target width in points (optional)
 *     height      — Target height in points (optional, keeps aspect ratio)
 *     rotation    — Rotation in degrees (optional, default 0)
 *     tile        — "true"|"false" — repeat across the page (optional)
 *
 * Returns the watermarked PDF as application/pdf.
 *
 * Error codes:
 *   400  — missing/invalid file or field
 *   401  — unauthenticated
 *   422  — PDF corrupted
 *   500  — unexpected server error
 */

import { addWatermark, addImageWatermark, PDFCorruptedError } from '@giga-pdf/pdf-engine';
import type { WatermarkPosition, ImageWatermarkAnchor } from '@giga-pdf/pdf-engine';
import { requireSession } from '../lib/auth-helpers';
import { sanitizeContentDisposition } from '../lib/content-disposition';
import { serverLogger } from '../lib/server-logger';
import { validatePdfFile, validateImageFile } from '../lib/request-validation';

const VALID_POSITIONS: WatermarkPosition[] = [
  'center-diagonal',
  'top-left',
  'top-right',
  'bottom-left',
  'bottom-right',
  'header',
  'footer',
  'custom',
];

const VALID_ANCHORS: ImageWatermarkAnchor[] = [
  'center',
  'top-left',
  'top-right',
  'bottom-left',
  'bottom-right',
];

/** Parse a 1-based `pages` JSON array; returns the parsed array or a 400. */
function parsePages(
  pagesRaw: string | null,
): { ok: true; pages: number[] | undefined } | { ok: false; response: Response } {
  if (!pagesRaw) return { ok: true, pages: undefined };
  try {
    const parsed = JSON.parse(pagesRaw);
    if (Array.isArray(parsed) && parsed.every((p) => Number.isInteger(p) && p >= 1)) {
      return { ok: true, pages: parsed };
    }
    throw new Error('Invalid pages');
  } catch {
    return {
      ok: false,
      response: Response.json(
        { success: false, error: 'pages must be a JSON array of positive integers.' },
        { status: 400 },
      ),
    };
  }
}

function pdfResponse(bytes: Uint8Array, fileName: string): Response {
  return new Response(Buffer.from(bytes), {
    status: 200,
    headers: {
      'Content-Type': 'application/pdf',
      'Content-Disposition': sanitizeContentDisposition(fileName),
      'Content-Length': String(bytes.byteLength),
    },
  });
}

/**
 * Stamp a raster image watermark. Reads the `image` file plus image-mode
 * fields (`anchor`, `width`, `height`, `rotation`, `tile`, `pages`) and the
 * shared `opacity`. Returns the watermarked PDF (or a 4xx on invalid input /
 * an undecodable image). Thrown PDF/engine errors bubble to the POST catch.
 */
async function handleImageWatermark(
  formData: FormData,
  file: File,
  opacity: number | undefined,
): Promise<Response> {
  const imageValidation = validateImageFile(formData.get('image'));
  if (!imageValidation.ok) return imageValidation.response;
  const image = imageValidation.file;

  const anchor =
    ((formData.get('anchor') as string | null) ?? 'center') as ImageWatermarkAnchor;
  if (!VALID_ANCHORS.includes(anchor)) {
    return Response.json(
      { success: false, error: `anchor must be one of: ${VALID_ANCHORS.join(', ')}.` },
      { status: 400 },
    );
  }

  const parseDimension = (
    raw: string | null,
    label: string,
  ): { ok: true; value: number | undefined } | { ok: false; response: Response } => {
    if (!raw) return { ok: true, value: undefined };
    const value = Number(raw);
    if (Number.isNaN(value) || value <= 0 || value > 10000) {
      return {
        ok: false,
        response: Response.json(
          { success: false, error: `${label} must be a number in (0, 10000].` },
          { status: 400 },
        ),
      };
    }
    return { ok: true, value };
  };

  const widthResult = parseDimension(formData.get('width') as string | null, 'width');
  if (!widthResult.ok) return widthResult.response;
  const heightResult = parseDimension(formData.get('height') as string | null, 'height');
  if (!heightResult.ok) return heightResult.response;

  const rotationRaw = formData.get('rotation') as string | null;
  const rotationDeg = rotationRaw ? Number(rotationRaw) : undefined;
  if (rotationDeg !== undefined && (Number.isNaN(rotationDeg) || Math.abs(rotationDeg) > 360)) {
    return Response.json(
      { success: false, error: 'rotation must be a number in [-360, 360].' },
      { status: 400 },
    );
  }

  const tile = (formData.get('tile') as string | null) === 'true';

  const pagesResult = parsePages(formData.get('pages') as string | null);
  if (!pagesResult.ok) return pagesResult.response;

  const pdfBytes = new Uint8Array(await file.arrayBuffer());
  const imageBytes = new Uint8Array(await image.arrayBuffer());

  const result = await addImageWatermark(pdfBytes, imageBytes, {
    pages: pagesResult.pages,
    anchor,
    width: widthResult.value,
    height: heightResult.value,
    rotationDeg,
    opacity,
    tile,
  });

  return pdfResponse(result.bytes, file.name);
}

export async function POST(request: Request): Promise<Response> {
  const authResult = await requireSession(request);
  if (!authResult.ok) return authResult.response;

  try {
    const formData = await request.formData();

    const fileValidation = validatePdfFile(formData.get('file'));
    if (!fileValidation.ok) return fileValidation.response;
    const file = fileValidation.file;

    const opacityRaw = formData.get('opacity') as string | null;
    const opacity = opacityRaw ? Number(opacityRaw) : undefined;
    if (opacity !== undefined && (Number.isNaN(opacity) || opacity < 0 || opacity > 1)) {
      return Response.json(
        { success: false, error: 'opacity must be in [0, 1].' },
        { status: 400 },
      );
    }

    const mode = ((formData.get('mode') as string | null) ?? 'text').toLowerCase();

    // ── Image watermark mode ────────────────────────────────────────────────
    if (mode === 'image') {
      return handleImageWatermark(formData, file, opacity);
    }

    // ── Text watermark mode (default) ───────────────────────────────────────
    const text = (formData.get('text') as string | null)?.trim();
    if (!text) {
      return Response.json(
        { success: false, error: 'text is required and must be non-empty.' },
        { status: 400 },
      );
    }

    const position =
      ((formData.get('position') as string | null) ?? 'center-diagonal') as WatermarkPosition;
    if (!VALID_POSITIONS.includes(position)) {
      return Response.json(
        {
          success: false,
          error: `position must be one of: ${VALID_POSITIONS.join(', ')}.`,
        },
        { status: 400 },
      );
    }

    const pagesResult = parsePages(formData.get('pages') as string | null);
    if (!pagesResult.ok) return pagesResult.response;
    const pages = pagesResult.pages;

    const fontSizeRaw = formData.get('fontSize') as string | null;
    const fontSize = fontSizeRaw ? Number(fontSizeRaw) : undefined;
    if (fontSize !== undefined && (Number.isNaN(fontSize) || fontSize < 1 || fontSize > 500)) {
      return Response.json(
        { success: false, error: 'fontSize must be a number between 1 and 500.' },
        { status: 400 },
      );
    }

    const rotationRaw = formData.get('rotation') as string | null;
    const rotation = rotationRaw ? Number(rotationRaw) : undefined;
    if (rotation !== undefined && (Number.isNaN(rotation) || Math.abs(rotation) > 360)) {
      return Response.json(
        { success: false, error: 'rotation must be a number in [-360, 360].' },
        { status: 400 },
      );
    }

    let color: [number, number, number] | undefined;
    const colorRaw = formData.get('color') as string | null;
    if (colorRaw) {
      try {
        const parsed = JSON.parse(colorRaw);
        if (
          Array.isArray(parsed) &&
          parsed.length === 3 &&
          parsed.every((c) => typeof c === 'number' && c >= 0 && c <= 1)
        ) {
          color = parsed as [number, number, number];
        } else {
          throw new Error('Invalid color');
        }
      } catch {
        return Response.json(
          { success: false, error: 'color must be JSON array [r,g,b] in [0,1].' },
          { status: 400 },
        );
      }
    }

    let custom: { x: number; y: number; rotation: number } | undefined;
    const customRaw = formData.get('custom') as string | null;
    if (customRaw) {
      try {
        const parsed = JSON.parse(customRaw);
        if (
          typeof parsed?.x === 'number' &&
          typeof parsed?.y === 'number' &&
          typeof parsed?.rotation === 'number'
        ) {
          custom = parsed;
        } else {
          throw new Error('Invalid custom');
        }
      } catch {
        return Response.json(
          { success: false, error: 'custom must be JSON {x:number, y:number, rotation:number}.' },
          { status: 400 },
        );
      }
    }

    const arrayBuffer = await file.arrayBuffer();
    const result = await addWatermark(new Uint8Array(arrayBuffer), {
      text,
      position,
      pages,
      fontSize,
      color,
      opacity,
      rotation,
      custom,
    });

    return pdfResponse(result.bytes, file.name);
  } catch (error: unknown) {
    if (error instanceof PDFCorruptedError) {
      return Response.json(
        { success: false, error: 'PDF file is corrupted.' },
        { status: 422 },
      );
    }
    serverLogger.error('api.pdf.watermark', { error });
    return Response.json(
      {
        success: false,
        error: 'Failed to add watermark.',
        message: error instanceof Error ? error.message : 'Unknown error',
      },
      { status: 500 },
    );
  }
}
