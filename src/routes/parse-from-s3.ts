/**
 * PDF Parse-from-storage route
 *
 * POST /api/pdf/parse-from-s3
 * Fetches a stored document's PDF bytes from the Django backend, parses it
 * with the TS pdf-engine, and returns the full DocumentObject (scene graph).
 *
 * Django remains authoritative for byte retrieval/persistence; the TS parser
 * is authoritative for the scene graph.
 *
 * Request:
 *   Content-Type: application/json
 *   Authorization: Bearer <JWT>   (forwarded to Django)
 *   Body: { documentId: string }
 *
 * Response (200):
 *   DocumentObject — full parsed scene graph
 *
 * Error codes:
 *   400  — Missing / invalid request body
 *   401  — Missing Authorization header
 *   404  — Document not found (documentId invalid)
 *   422  — PDF corrupted or unparseable
 *   500  — Unexpected server error
 *   504  — Downstream Django backend timeout
 */


import { z } from 'zod';
import {
  parseDocument,
  flattenFormXObjects,
} from '@giga-pdf/pdf-engine';
import {
  PDFParseError,
  PDFCorruptedError,
  PDFEncryptedError,
  PDFInvalidPasswordError,
} from '@giga-pdf/pdf-engine';
import { requireSession } from '../lib/auth-helpers';
import { serverLogger } from '../lib/server-logger';
import { attachPageBlockGroups } from '../lib/pdf-block-groups';
import {
  fetchDocumentBytesFromBackend,
  DocumentFetchAuthError,
  DocumentFetchNotFoundError,
} from '../lib/document-backend';

// ─── Zod schema ────────────────────────────────────────────────────────────────

const RequestBodySchema = z.object({
  documentId: z
    .string({ error: 'documentId is required and must be a string' })
    .min(1, 'documentId cannot be empty'),
  /**
   * When true (the editor sets this), inline Form XObjects before parsing so
   * invoice/template text becomes editable in place. Read-only viewers omit
   * it, so viewing never rewrites the PDF.
   */
  flatten: z.boolean().optional().default(false),
});

// ─── Route Handler ─────────────────────────────────────────────────────────────

export async function POST(request: Request): Promise<Response> {
  // ── 1. Auth check ────────────────────────────────────────────────────────
  const authResult = await requireSession(request);
  if (!authResult.ok) return authResult.response;

  // ── 2. Parse and validate request body ──────────────────────────────────────
  let rawBody: unknown;
  try {
    rawBody = await request.json();
  } catch {
    return Response.json(
      { success: false, error: 'Request body must be valid JSON.' },
      { status: 400 },
    );
  }

  const parsed = RequestBodySchema.safeParse(rawBody);
  if (!parsed.success) {
    const fieldErrors = parsed.error.flatten().fieldErrors;
    return Response.json(
      { success: false, error: 'Invalid request body.', details: fieldErrors },
      { status: 400 },
    );
  }

  const { documentId, flatten } = parsed.data;

  // ── 3. Fetch PDF bytes from Django backend ───────────────────────────────────
  serverLogger.info('[api/pdf/parse-from-s3] Fetching PDF bytes from backend', {
    documentId,
  });

  let pdfBuffer: Buffer;
  try {
    pdfBuffer = await fetchDocumentBytesFromBackend(
      documentId,
      request.headers.get('authorization'),
    );
    serverLogger.info('[api/pdf/parse-from-s3] PDF bytes received', {
      documentId,
      sizeBytes: pdfBuffer.byteLength,
    });
  } catch (err: unknown) {
    if (err instanceof DocumentFetchNotFoundError) {
      serverLogger.warn('[api/pdf/parse-from-s3] Document not found in backend', { documentId });
      return Response.json(
        {
          success: false,
          error: `Document '${documentId}' not found. It may have been deleted or never existed.`,
        },
        { status: 404 },
      );
    }
    if (err instanceof DocumentFetchAuthError) {
      serverLogger.warn('[api/pdf/parse-from-s3] Backend rejected auth token', { documentId });
      return Response.json(
        { success: false, error: 'Authentication rejected by backend.' },
        { status: 401 },
      );
    }
    if (err instanceof Error && err.name === 'AbortError') {
      serverLogger.error('[api/pdf/parse-from-s3] Django backend timeout', { documentId });
      return Response.json(
        { success: false, error: 'Backend timed out while retrieving PDF.' },
        { status: 504 },
      );
    }

    serverLogger.error('[api/pdf/parse-from-s3] Network error contacting backend', {
      documentId,
      error: err instanceof Error ? err.message : String(err),
    });
    return Response.json(
      { success: false, error: 'Failed to connect to backend.' },
      { status: 502 },
    );
  }

  // ── 4. (Editor only) Flatten Form XObjects before parsing ────────────────────
  // Invoice/template text lives inside reusable Form XObjects, where it carries
  // a sentinel run index → the engine's in-place edit path can't touch it and
  // the editor falls back to the redact+add overlay. Inlining the form XObjects
  // turns that text into ordinary page runs with REAL indices, so editing works
  // in place. We must parse the *flattened* bytes (so `elements` line up) AND
  // hand the flattened PDF back to the client so its `currentPdfFile` (the
  // binary source of truth for save + raster) stays consistent with `elements`.
  //
  // No-op safety: when 0 forms are inlined (form-less PDFs, or re-loading an
  // already-flattened doc), `flattenForms` returns the original bytes untouched
  // and we add no new response fields — byte-identical to the legacy behaviour.
  let bytesToParse: Buffer = pdfBuffer;
  let flattenCount = 0;
  let flattenedPdfBase64: string | null = null;

  if (flatten) {
    try {
      const { bytes, count } = await flattenFormXObjects(pdfBuffer);
      flattenCount = count;
      if (count > 0) {
        bytesToParse = Buffer.from(bytes);
        flattenedPdfBase64 = bytesToParse.toString('base64');
        serverLogger.info('[api/pdf/parse-from-s3] Flattened form XObjects', {
          documentId,
          flattenCount: count,
        });
      }
    } catch (err) {
      // Flatten is an optimisation, never a hard requirement: on failure we
      // fall back to parsing the original bytes (legacy overlay-edit behaviour).
      serverLogger.warn('[api/pdf/parse-from-s3] flattenFormXObjects failed — parsing original', {
        documentId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // ── 5. Parse PDF bytes via TS pdf-engine ─────────────────────────────────────
  serverLogger.info('[api/pdf/parse-from-s3] Parsing PDF with pdf-engine', { documentId });

  try {
    const documentObject = await parseDocument(bytesToParse, {
      extractText: true,
      extractImages: true,
      extractAnnotations: true,
      extractFormFields: true,
      extractDrawings: true,
      documentId,
    });

    serverLogger.info('[api/pdf/parse-from-s3] Parse complete', {
      documentId,
      pageCount: documentObject.pages?.length ?? 0,
    });

    // Editor load (`flatten` set): attach the native engine's STRUCTURAL block
    // grouping per page so the editor coalesces paragraphs/headings from the
    // lib (the source of structure) instead of its positional heuristic. The
    // grouping is expressed as engine `source_index`es that map 1:1 onto the
    // parsed `TextElement.index`, so the lossless in-place edit path is reused
    // unchanged. Best-effort (see attachPageBlockGroups): a failure leaves
    // `blockGroups` unset and the editor degrades to its heuristic grouping.
    // Read-only viewers omit `flatten`, so their response shape is
    // byte-identical to before.
    if (flatten && Array.isArray(documentObject.pages)) {
      await attachPageBlockGroups(documentObject.pages, bytesToParse, '[api/pdf/parse-from-s3]', {
        documentId,
      });
    }

    // Only attach flatten fields when something was actually inlined, so the
    // form-less response shape is unchanged from before.
    const responseBody =
      flattenCount > 0
        ? { ...documentObject, flattenCount, flattenedPdfBase64 }
        : documentObject;

    return Response.json(responseBody, { status: 200 });
  } catch (error: unknown) {
    if (error instanceof PDFEncryptedError || error instanceof PDFInvalidPasswordError) {
      return Response.json(
        { success: false, error: 'PDF is encrypted and cannot be parsed without a password.' },
        { status: 422 },
      );
    }

    if (error instanceof PDFCorruptedError) {
      serverLogger.warn('[api/pdf/parse-from-s3] PDF is corrupted', { documentId });
      return Response.json(
        { success: false, error: 'PDF file is corrupted and cannot be parsed.' },
        { status: 422 },
      );
    }

    if (error instanceof PDFParseError) {
      serverLogger.warn('[api/pdf/parse-from-s3] PDF parse error', {
        documentId,
        error: (error as Error).message,
      });
      return Response.json(
        { success: false, error: 'Failed to parse PDF document.' },
        { status: 422 },
      );
    }

    serverLogger.error('[api/pdf/parse-from-s3] Unexpected parse error', {
      documentId,
      error: error instanceof Error ? error.message : String(error),
    });
    return Response.json(
      { success: false, error: 'An unexpected error occurred while parsing the PDF.' },
      { status: 500 },
    );
  }
}
