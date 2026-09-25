/**
 * PDF Open / Parse route
 *
 * POST /api/pdf/open
 * Accepts a multipart/form-data request with a PDF file and returns the
 * full parsed document structure (scene graph). Unlike parse-from-s3.ts,
 * this takes the file directly via multipart — used to open a fresh
 * in-memory PDF that has no stored documentId yet (e.g.
 * content-edit-layer.tsx), not a document already persisted in Django.
 *
 * Form fields:
 *   file        — PDF file (required)
 *   password    — Decryption password for encrypted PDFs (optional)
 *   extractText — "true" | "false", default true
 *   extractImages — "true" | "false", default true
 *   extractAnnotations — "true" | "false", default true
 *   extractFormFields  — "true" | "false", default true
 *
 * Ported near-verbatim from GigaPDF's original
 * apps/web/src/app/api/pdf/open/route.ts.
 */

import {
  parseDocument,
  PDFEncryptedError,
  PDFInvalidPasswordError,
  PDFCorruptedError,
} from '@giga-pdf/pdf-engine';
import { requireSession } from '../lib/auth-helpers';
import { serverLogger } from '../lib/server-logger';
import { validatePdfFile } from '../lib/request-validation';

export async function POST(request: Request): Promise<Response> {
  const authResult = await requireSession(request);
  if (!authResult.ok) return authResult.response;

  try {
    const formData = await request.formData();

    const fileValidation = validatePdfFile(formData.get('file'));
    if (!fileValidation.ok) return fileValidation.response;
    const file = fileValidation.file;

    if (!file.name.toLowerCase().endsWith('.pdf') && file.type !== 'application/pdf') {
      return Response.json(
        { success: false, error: 'Uploaded file must be a PDF.' },
        { status: 400 },
      );
    }

    const arrayBuffer = await file.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);

    const extractText = formData.get('extractText') !== 'false';
    const extractImages = formData.get('extractImages') !== 'false';
    const extractAnnotations = formData.get('extractAnnotations') !== 'false';
    const extractFormFields = formData.get('extractFormFields') !== 'false';

    const document = await parseDocument(buffer, {
      extractText,
      extractImages,
      extractAnnotations,
      extractFormFields,
    });

    return Response.json({
      success: true,
      data: {
        documentId: document.documentId,
        pageCount: document.pages.length,
        metadata: document.metadata,
        pages: document.pages,
        bookmarks: document.outlines,
        layers: document.layers,
        embeddedFiles: document.embeddedFiles,
        filename: file.name,
        fileSize: buffer.byteLength,
      },
    });
  } catch (error: unknown) {
    if (error instanceof PDFEncryptedError) {
      return Response.json(
        { success: false, error: 'PDF is encrypted. Provide a password.' },
        { status: 422 },
      );
    }
    if (error instanceof PDFInvalidPasswordError) {
      return Response.json(
        { success: false, error: 'Invalid PDF password.' },
        { status: 401 },
      );
    }
    if (error instanceof PDFCorruptedError) {
      return Response.json(
        { success: false, error: 'PDF file is corrupted and cannot be parsed.' },
        { status: 422 },
      );
    }

    serverLogger.error('api.pdf.open', { error });
    return Response.json(
      { success: false, error: 'Failed to parse PDF document.' },
      { status: 500 },
    );
  }
}
