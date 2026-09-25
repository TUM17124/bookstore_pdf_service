/**
 * Embedded-font routes
 *
 * GET /api/pdf/fonts?documentId=...
 *   -> { success, data: { documentId, fonts, total } }
 * GET /api/pdf/fonts?documentId=...&fontId=...
 *   -> { success, data: ExtractedFontBinary }
 *
 * Ported from GigaPDF's real apps/web/src/app/api/pdf/fonts/[documentId]/
 * route.ts and .../[documentId]/[fontId]/route.ts, adapted to this service's
 * flat (no dynamic-segment) router: both documentId and the optional fontId
 * travel as query params on ONE route instead of two path-parameterised
 * ones. The frontend passes a custom fetchFontList/fetchFontData to
 * useEmbeddedFonts to match (its built-in defaults still hit the never-
 * migrated Next.js path-based routes).
 *
 * Bytes come from Django (fetchDocumentBytesFromBackend), same as
 * parse-from-s3.ts; fonts are extracted with the gigapdf engine (correct
 * Unicode cmap, no glyph garbling).
 */

import { listDocumentFonts, getDocumentFont } from '@giga-pdf/pdf-engine';
import { requireSession } from '../lib/auth-helpers';
import { serverLogger } from '../lib/server-logger';
import {
  fetchDocumentBytesFromBackend,
  DocumentFetchAuthError,
  DocumentFetchNotFoundError,
} from '../lib/document-backend';

export async function GET(request: Request): Promise<Response> {
  const authResult = await requireSession(request);
  if (!authResult.ok) return authResult.response;

  const url = new URL(request.url);
  const documentId = url.searchParams.get('documentId');
  const fontId = url.searchParams.get('fontId');

  if (!documentId) {
    return Response.json(
      { success: false, error: 'documentId is required.' },
      { status: 400 },
    );
  }

  let pdfBuffer: Buffer;
  try {
    pdfBuffer = await fetchDocumentBytesFromBackend(
      documentId,
      request.headers.get('authorization'),
    );
  } catch (err: unknown) {
    if (err instanceof DocumentFetchNotFoundError) {
      serverLogger.warn('[api/pdf/fonts] Document not found in backend', { documentId });
      return Response.json(
        { success: false, error: `Document '${documentId}' not found.` },
        { status: 404 },
      );
    }
    if (err instanceof DocumentFetchAuthError) {
      serverLogger.warn('[api/pdf/fonts] Backend rejected auth token', { documentId });
      return Response.json(
        { success: false, error: 'Authentication rejected by backend.' },
        { status: 401 },
      );
    }
    serverLogger.error('[api/pdf/fonts] Failed to fetch document bytes', {
      documentId,
      error: err instanceof Error ? err.message : String(err),
    });
    return Response.json(
      { success: false, error: 'Failed to connect to backend.' },
      { status: 502 },
    );
  }

  if (fontId) {
    try {
      const font = await getDocumentFont(pdfBuffer, fontId);
      if (!font) {
        return Response.json(
          {
            success: false,
            error: `Font '${fontId}' is not embedded or could not be loaded for the browser.`,
          },
          { status: 404 },
        );
      }
      return Response.json({ success: true, data: font });
    } catch (err) {
      serverLogger.error('[api/pdf/fonts] Font binary extraction failed', {
        documentId,
        fontId,
        error: err instanceof Error ? err.message : String(err),
      });
      return Response.json(
        { success: false, error: 'Could not extract the font from the document.' },
        { status: 422 },
      );
    }
  }

  try {
    const fonts = await listDocumentFonts(pdfBuffer);
    return Response.json({
      success: true,
      data: { documentId, fonts, total: fonts.length },
    });
  } catch (err) {
    serverLogger.error('[api/pdf/fonts] Font list extraction failed', {
      documentId,
      error: err instanceof Error ? err.message : String(err),
    });
    return Response.json(
      { success: false, error: 'Could not extract fonts from the document.' },
      { status: 422 },
    );
  }
}
