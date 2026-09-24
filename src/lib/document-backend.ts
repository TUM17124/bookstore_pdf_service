/**
 * Fetches a stored document's PDF bytes from the PlugYard Django backend.
 *
 * GigaPDF's equivalent routes (parse-from-s3, office/export) fetch bytes from
 * its FastAPI backend at GET /api/v1/documents/{id}/download. Django's real
 * equivalent endpoint is being built in a parallel task (see
 * bookstore_backend/docs/PDF_EDITOR_MIGRATION.md's endpoint table, proposed as
 * GET /api/editor/documents/{id}/download/) - verify the exact path against
 * that implementation once it lands; this is a reasonable first pass, not a
 * confirmed-final contract.
 */


const DJANGO_API_BASE =
  process.env.DJANGO_API_BASE_URL ?? "http://localhost:8000";

const DOWNLOAD_TIMEOUT_MS = 30_000;

export class DocumentFetchAuthError extends Error {}
export class DocumentFetchNotFoundError extends Error {}

/**
 * Fetch PDF bytes from Django for a given documentId, forwarding the
 * incoming request's Authorization header so Django can authorize the
 * download against the requesting user.
 */
export async function fetchDocumentBytesFromBackend(
  documentId: string,
  authorizationHeader: string | null,
): Promise<Buffer> {
  const url = `${DJANGO_API_BASE}/api/editor/documents/${documentId}/download/`;

  const abortController = new AbortController();
  const timeout = setTimeout(() => abortController.abort(), DOWNLOAD_TIMEOUT_MS);

  try {
    const forwardHeaders: HeadersInit = {};
    if (authorizationHeader) forwardHeaders["Authorization"] = authorizationHeader;

    const response = await fetch(url, {
      method: "GET",
      headers: forwardHeaders,
      signal: abortController.signal,
    });

    if (response.status === 401 || response.status === 403) {
      throw new DocumentFetchAuthError(`Access denied to document ${documentId}`);
    }
    if (response.status === 404) {
      throw new DocumentFetchNotFoundError(`Document ${documentId} not found`);
    }
    if (!response.ok) {
      throw new Error(`Backend returned HTTP ${response.status} for document ${documentId}`);
    }

    const arrayBuffer = await response.arrayBuffer();
    return Buffer.from(arrayBuffer);
  } finally {
    clearTimeout(timeout);
  }
}
