/**
 * Blank PDF route — create a fresh, empty single-page PDF to start editing
 * from scratch (the "New blank document" entry point). Ported near-verbatim
 * from GigaPDF's real apps/web/src/app/api/pdf/blank/route.ts - the generated
 * PDF is returned as binary so the caller can store it through the normal
 * document upload flow (saveDocument) and open it in the editor like any
 * other PDF.
 *
 * POST /api/pdf/blank   (application/json)
 * Body (all optional):
 *   size        — "a4" | "letter" | "legal"          (default "a4")
 *   orientation — "portrait" | "landscape"            (default "portrait")
 *   width       — page width in POINTS  (overrides size; requires `height`)
 *   height      — page height in POINTS (overrides size; requires `width`)
 *
 * Returns the generated PDF as application/pdf binary (one blank page).
 */

import { GigaPdfEngine } from '@qrcommunication/gigapdf-lib';
import { requireSession } from '../lib/auth-helpers';
import { serverLogger } from '../lib/server-logger';

const PAGE_SIZES = {
  a4: { width: 595, height: 842 },
  letter: { width: 612, height: 792 },
  legal: { width: 612, height: 1008 },
} as const;
type PageSizeName = keyof typeof PAGE_SIZES;
const SIZE_NAMES = new Set<string>(Object.keys(PAGE_SIZES));

const MIN_DIMENSION_PT = 72;
const MAX_DIMENSION_PT = 14400;

let enginePromise: Promise<GigaPdfEngine> | null = null;
function getEngine(): Promise<GigaPdfEngine> {
  enginePromise ??= GigaPdfEngine.loadDefault();
  return enginePromise;
}

const EMPTY_HTML =
  '<!doctype html><html><head><meta charset="utf-8"></head><body></body></html>';

function resolveDimensions(
  body: Record<string, unknown>,
): { width: number; height: number } | { error: string } {
  const { size, orientation, width, height } = body;

  const hasWidth = width !== undefined && width !== null;
  const hasHeight = height !== undefined && height !== null;

  if (hasWidth || hasHeight) {
    if (!hasWidth || !hasHeight) {
      return { error: 'Both "width" and "height" must be provided together (in points).' };
    }
    if (
      typeof width !== 'number' ||
      typeof height !== 'number' ||
      !Number.isFinite(width) ||
      !Number.isFinite(height)
    ) {
      return { error: '"width" and "height" must be finite numbers (points).' };
    }
    if (
      width < MIN_DIMENSION_PT ||
      height < MIN_DIMENSION_PT ||
      width > MAX_DIMENSION_PT ||
      height > MAX_DIMENSION_PT
    ) {
      return {
        error: `"width" and "height" must be between ${MIN_DIMENSION_PT} and ${MAX_DIMENSION_PT} points.`,
      };
    }
    return { width, height };
  }

  const sizeName = size ?? 'a4';
  if (typeof sizeName !== 'string' || !SIZE_NAMES.has(sizeName)) {
    return { error: `"size" must be one of: ${[...SIZE_NAMES].join(', ')}.` };
  }
  const orient = orientation ?? 'portrait';
  if (orient !== 'portrait' && orient !== 'landscape') {
    return { error: '"orientation" must be "portrait" or "landscape".' };
  }

  const base = PAGE_SIZES[sizeName as PageSizeName];
  return orient === 'landscape'
    ? { width: base.height, height: base.width }
    : { width: base.width, height: base.height };
}

function generateBlankPdf(engine: GigaPdfEngine, width: number, height: number): Uint8Array {
  try {
    const bytes = engine.htmlRender(EMPTY_HTML, [], width, height, 0);
    const doc = engine.open(bytes);
    try {
      if (doc.pageCount() >= 1) return bytes;
      doc.addPage(width, height, 0);
      return doc.save();
    } finally {
      doc.close();
    }
  } catch (htmlErr) {
    serverLogger.warn('api.pdf.blank.htmlRenderFallback', {
      error: htmlErr instanceof Error ? htmlErr.message : String(htmlErr),
    });
    const empty = engine.mergePdfs([]);
    const doc = engine.open(empty);
    try {
      doc.addPage(width, height, 0);
      return doc.save();
    } finally {
      doc.close();
    }
  }
}

export async function POST(request: Request): Promise<Response> {
  const authResult = await requireSession(request);
  if (!authResult.ok) return authResult.response;

  let body: Record<string, unknown> = {};
  try {
    const parsed: unknown = await request.json();
    if (parsed && typeof parsed === 'object') body = parsed as Record<string, unknown>;
  } catch {
    body = {};
  }

  const resolved = resolveDimensions(body);
  if ('error' in resolved) {
    return Response.json({ success: false, error: resolved.error }, { status: 400 });
  }

  try {
    const engine = await getEngine();
    const pdfBytes = generateBlankPdf(engine, resolved.width, resolved.height);

    return new Response(Buffer.from(pdfBytes), {
      status: 200,
      headers: {
        'Content-Type': 'application/pdf',
        'Content-Length': String(pdfBytes.byteLength),
      },
    });
  } catch (error: unknown) {
    serverLogger.error('api.pdf.blank', { error });
    return Response.json(
      { success: false, error: 'Failed to create blank document.' },
      { status: 500 },
    );
  }
}
