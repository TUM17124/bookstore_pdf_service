/**
 * PDF Parse route
 *
 * POST /api/pdf/parse
 * Parses a PDF and returns the full DocumentObject (scene graph) as JSON.
 *
 * Requires authentication (Authorization: Bearer <token>).
 *
 * Accepted body formats:
 *
 *   1. multipart/form-data
 *      file              — PDF file bytes (required, ≤ 250 MB)
 *      extractText       — "true" | "false" (default: true)
 *      extractImages     — "true" | "false" (default: true)
 *      extractDrawings   — "true" | "false" (default: true)
 *      extractAnnotations— "true" | "false" (default: true)
 *      extractFormFields — "true" | "false" (default: true)
 *      extractBookmarks  — "true" | "false" (default: true)
 *      blockGroups       — "true" | "false" (default: false) — when true
 *                          (the editor's re-parse sets it), attach the native
 *                          engine's structural block grouping to each page
 *                          (same best-effort contract as /api/pdf/parse-from-s3)
 *      documentId        — optional UUID to embed in the result
 *
 *   2. application/json
 *      { "documentId": "<uuid>", "blockGroups": false }
 *      Fetches the PDF bytes from the Django backend, then parses the fetched
 *      bytes.
 *
 * Response (200):
 *   {
 *     success: true,
 *     data: DocumentObject   // full scene graph
 *   }
 *
 * Error codes:
 *   401 — not authenticated
 *   400 — missing/invalid input
 *   413 — file too large (> 250 MB)
 *   422 — PDF is encrypted or corrupted
 *   500 — internal error
 */

import { z } from 'zod';
import {
  parseDocument,
  PDFParseError,
  PDFCorruptedError,
  PDFEncryptedError,
  PDFInvalidPasswordError,
  PDFPageOutOfRangeError,
} from '@giga-pdf/pdf-engine';
import type { ParseOptions } from '@giga-pdf/pdf-engine';
import { requireSession } from '../lib/auth-helpers';
import { serverLogger } from '../lib/server-logger';
import { MAX_FILE_SIZE_BYTES } from '../lib/request-validation';
import { attachPageBlockGroups } from '../lib/pdf-block-groups';
import {
  fetchDocumentBytesFromBackend,
  DocumentFetchAuthError,
  DocumentFetchNotFoundError,
} from '../lib/document-backend';

// ─── Validation schemas ───────────────────────────────────────────────────────

const jsonBodySchema = z.object({
  documentId: z.string().uuid('documentId must be a valid UUID'),
  /**
   * When true (the editor sets this), attach the native engine's structural
   * block grouping to each parsed page. Opt-in so plain text extraction
   * callers keep the exact same cost and response shape as before.
   */
  blockGroups: z.boolean().optional().default(false),
});

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Parse a boolean query flag from a FormData field.
 * Returns `true` by default when the field is absent.
 */
function parseBooleanField(formData: FormData, key: string): boolean {
  return formData.get(key) !== 'false';
}

// ─── Route handler ────────────────────────────────────────────────────────────

export async function POST(request: Request): Promise<Response> {
  // ── 1. Auth check ──────────────────────────────────────────────────────────
  const authResult = await requireSession(request);
  if (!authResult.ok) return authResult.response;

  const userId = authResult.context.userId;

  try {
    const contentType = request.headers.get('content-type') ?? '';
    let pdfBuffer: Buffer;
    let parseOptions: ParseOptions = {};
    let wantBlockGroups = false;

    // ── 2a. multipart/form-data path ────────────────────────────────────────
    if (contentType.includes('multipart/form-data')) {
      const formData = await request.formData();

      const file = formData.get('file');
      if (!file || !(file instanceof File)) {
        return Response.json(
          { success: false, error: 'Missing required field: file' },
          { status: 400 },
        );
      }

      if (!file.name.toLowerCase().endsWith('.pdf') && file.type !== 'application/pdf') {
        return Response.json(
          { success: false, error: 'Uploaded file must be a PDF.' },
          { status: 400 },
        );
      }

      if (file.size > MAX_FILE_SIZE_BYTES) {
        serverLogger.warn('[api/pdf/parse] File too large', {
          userId,
          fileSizeBytes: file.size,
          limitBytes: MAX_FILE_SIZE_BYTES,
        });
        return Response.json(
          { success: false, error: 'File exceeds the 250 MB size limit.' },
          { status: 413 },
        );
      }

      const arrayBuffer = await file.arrayBuffer();
      pdfBuffer = Buffer.from(arrayBuffer);

      const documentIdField = formData.get('documentId');

      parseOptions = {
        extractText: parseBooleanField(formData, 'extractText'),
        extractImages: parseBooleanField(formData, 'extractImages'),
        extractDrawings: parseBooleanField(formData, 'extractDrawings'),
        extractAnnotations: parseBooleanField(formData, 'extractAnnotations'),
        extractFormFields: parseBooleanField(formData, 'extractFormFields'),
        extractBookmarks: parseBooleanField(formData, 'extractBookmarks'),
        ...(typeof documentIdField === 'string' && documentIdField.length > 0
          ? { documentId: documentIdField }
          : {}),
      };

      // Opt-in (unlike the extract* flags): only the editor requests block
      // grouping, so the absent-field default is `false`, not `true`.
      wantBlockGroups = formData.get('blockGroups') === 'true';

      serverLogger.info('[api/pdf/parse] Parsing uploaded file', {
        userId,
        filename: file.name,
        fileSizeBytes: pdfBuffer.byteLength,
      });

    // ── 2b. JSON path (documentId) ───────────────────────────────────────────
    } else if (contentType.includes('application/json')) {
      let rawBody: unknown;
      try {
        rawBody = await request.json();
      } catch {
        return Response.json(
          { success: false, error: 'Request body must be valid JSON.' },
          { status: 400 },
        );
      }

      const parsed = jsonBodySchema.safeParse(rawBody);
      if (!parsed.success) {
        return Response.json(
          {
            success: false,
            error: 'Invalid request body.',
            details: parsed.error.flatten().fieldErrors,
          },
          { status: 400 },
        );
      }

      const { documentId } = parsed.data;

      serverLogger.info('[api/pdf/parse] Fetching document from backend', {
        userId,
        documentId,
      });

      try {
        pdfBuffer = await fetchDocumentBytesFromBackend(
          documentId,
          request.headers.get('authorization'),
        );
      } catch (err) {
        if (err instanceof DocumentFetchAuthError) {
          return Response.json(
            { success: false, error: 'Access denied to the requested document.' },
            { status: 403 },
          );
        }
        if (err instanceof DocumentFetchNotFoundError) {
          return Response.json(
            { success: false, error: 'Document not found.' },
            { status: 404 },
          );
        }
        serverLogger.error('[api/pdf/parse] Failed to fetch document from backend', {
          userId,
          documentId,
          error: err instanceof Error ? err.message : String(err),
        });
        return Response.json(
          { success: false, error: 'Failed to retrieve document from storage.' },
          { status: 502 },
        );
      }

      parseOptions = { documentId };
      wantBlockGroups = parsed.data.blockGroups;

    } else {
      return Response.json(
        {
          success: false,
          error:
            'Unsupported Content-Type. Use multipart/form-data (with a file field) or application/json (with a documentId field).',
        },
        { status: 400 },
      );
    }

    // ── 3. Parse the PDF ─────────────────────────────────────────────────────
    const documentObject = await parseDocument(pdfBuffer, parseOptions);

    // Editor re-parse (`blockGroups` requested): attach the native engine's
    // STRUCTURAL block grouping per page — same best-effort contract as
    // /api/pdf/parse-from-s3 — so the paragraph grouping survives page
    // operations (rotate, apply-elements, watermark, forms, …) instead of
    // silently degrading to the editor's positional heuristic after the first
    // op of a session. Callers that omit the flag (e.g. plain text extraction)
    // keep the exact same response shape and cost as before.
    if (wantBlockGroups && Array.isArray(documentObject.pages)) {
      await attachPageBlockGroups(documentObject.pages, pdfBuffer, '[api/pdf/parse]', {
        userId,
        documentId: documentObject.documentId,
      });
    }

    serverLogger.info('[api/pdf/parse] Document parsed successfully', {
      userId,
      documentId: documentObject.documentId,
      pageCount: documentObject.pages.length,
    });

    return Response.json({ success: true, data: documentObject });

  } catch (error: unknown) {
    // ── 4. Typed error handling ───────────────────────────────────────────────
    if (error instanceof PDFEncryptedError) {
      return Response.json(
        { success: false, error: 'PDF is encrypted. Provide a password to decrypt it first.' },
        { status: 422 },
      );
    }

    if (error instanceof PDFInvalidPasswordError) {
      return Response.json(
        { success: false, error: 'Invalid PDF password.' },
        { status: 422 },
      );
    }

    if (error instanceof PDFCorruptedError) {
      return Response.json(
        { success: false, error: 'PDF file is corrupted and cannot be parsed.' },
        { status: 422 },
      );
    }

    if (error instanceof PDFPageOutOfRangeError) {
      return Response.json(
        { success: false, error: error.message },
        { status: 400 },
      );
    }

    if (error instanceof PDFParseError) {
      serverLogger.warn('[api/pdf/parse] PDF parse error', {
        error: error.message,
      });
      return Response.json(
        { success: false, error: 'Failed to parse the PDF document.' },
        { status: 422 },
      );
    }

    serverLogger.error('[api/pdf/parse] Unexpected error', {
      error: error instanceof Error ? error.message : String(error),
    });

    return Response.json(
      { success: false, error: 'An internal error occurred while parsing the PDF.' },
      { status: 500 },
    );
  }
}
