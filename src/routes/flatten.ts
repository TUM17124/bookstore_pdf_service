/**
 * PDF Flatten route
 *
 * POST /api/pdf/flatten
 * Flattens form fields and/or annotations into static PDF content.
 * After flattening, interactive elements become non-editable graphics.
 *
 * Form fields (multipart/form-data):
 *   file        — PDF file (required)
 *   target      — "forms" | "annotations" | "all" (default: "all")
 *   pageNumber  — 1-based page number to flatten only that page (optional)
 *                 omit to flatten entire document
 *
 * Returns the flattened PDF as application/pdf binary.
 *
 * NOTE: uses the render module's `flattenForms`/`flattenAnnotations` (bake
 * AcroForm widget VALUES + annotation appearances into static page content
 * on an open document handle) — NOT `flattenFormXObjects` (aliased from the
 * forms module's `flattenForms`), which parse-from-s3.ts uses for a different
 * purpose: inlining reusable Form XObject templates at parse time so their
 * text gets real per-instance indices. Different function, same export name
 * disambiguated by import path — see parse-from-s3.ts's comment block.
 *
 * Ported near-verbatim from GigaPDF's original
 * apps/web/src/app/api/pdf/flatten/route.ts.
 */

import {
  openDocument,
  saveDocument,
  flattenForms,
  flattenAnnotations,
  PDFCorruptedError,
  PDFPageOutOfRangeError,
} from '@giga-pdf/pdf-engine';
import { requireSession } from '../lib/auth-helpers';
import { sanitizeContentDisposition } from '../lib/content-disposition';
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

    const target = (formData.get('target') as string | null) ?? 'all';
    if (target !== 'forms' && target !== 'annotations' && target !== 'all') {
      return Response.json(
        { success: false, error: 'target must be "forms", "annotations", or "all".' },
        { status: 400 },
      );
    }

    const pageNumberRaw = formData.get('pageNumber');
    let pageNumber: number | null = null;
    if (pageNumberRaw !== null && pageNumberRaw !== '') {
      pageNumber = Number(pageNumberRaw);
      if (!Number.isInteger(pageNumber) || pageNumber < 1) {
        return Response.json(
          { success: false, error: 'pageNumber must be a positive integer.' },
          { status: 400 },
        );
      }
    }

    const arrayBuffer = await file.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);
    const handle = await openDocument(buffer);

    if (target === 'forms' || target === 'all') {
      flattenForms(handle, pageNumber);
    }

    if (target === 'annotations' || target === 'all') {
      flattenAnnotations(handle, pageNumber);
    }

    const savedBytes = await saveDocument(handle);

    return new Response(new Uint8Array(savedBytes), {
      status: 200,
      headers: {
        'Content-Type': 'application/pdf',
        'Content-Disposition': sanitizeContentDisposition(file.name),
        'Content-Length': String(savedBytes.byteLength),
      },
    });
  } catch (error: unknown) {
    if (error instanceof PDFPageOutOfRangeError) {
      return Response.json(
        { success: false, error: error.message },
        { status: 400 },
      );
    }
    if (error instanceof PDFCorruptedError) {
      return Response.json(
        { success: false, error: 'PDF file is corrupted.' },
        { status: 422 },
      );
    }

    serverLogger.error('api.pdf.flatten', { error });
    return Response.json(
      { success: false, error: 'Failed to flatten PDF.' },
      { status: 500 },
    );
  }
}
