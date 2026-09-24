/**
 * Auth helpers for the PDF-math API routes, ported from bookstore's Next.js
 * app (src/lib/auth-helpers.ts). Upgraded from a presence-only check to real
 * JWT signature verification, since this service is now a separate origin
 * reachable independently of bookstore's own request pipeline: Django issues
 * HS256-signed access tokens via djangorestframework-simplejwt with
 * SIGNING_KEY = settings.SECRET_KEY (no override in SIMPLE_JWT, so it's the
 * default). This service verifies against the same shared secret via
 * DJANGO_SECRET_KEY, so a forged/tampered token is rejected, not just an
 * absent one.
 */

import jwt from "jsonwebtoken";

export type AuthContext = {
  userId: string;
  email: string;
  role: string;
};

type RequireSessionSuccess = { ok: true; context: AuthContext };
type RequireSessionFailure = { ok: false; response: Response };
export type RequireSessionResult = RequireSessionSuccess | RequireSessionFailure;

function unauthorized(message: string): RequireSessionFailure {
  return {
    ok: false,
    response: Response.json({ success: false, error: message }, { status: 401 }),
  };
}

/**
 * Validates the request's bearer token against Django's SimpleJWT signing
 * key (HS256), matching djangorestframework-simplejwt's own verification -
 * rejects a missing header, a malformed token, an expired token, and a
 * token signed with the wrong key.
 */
export function requireSession(request: Request): RequireSessionResult {
  const authHeader = request.headers.get("authorization");

  if (!authHeader || !authHeader.startsWith("Bearer ") || authHeader.length <= 7) {
    return unauthorized("Authentication required.");
  }

  const token = authHeader.slice(7);
  const secret = process.env.DJANGO_SECRET_KEY;
  if (!secret) {
    // Fail closed - never accept unverifiable tokens.
    return unauthorized("Server auth misconfigured.");
  }

  let claims: jwt.JwtPayload;
  try {
    const verified = jwt.verify(token, secret, { algorithms: ["HS256"] });
    if (typeof verified === "string") return unauthorized("Invalid token.");
    claims = verified;
  } catch {
    return unauthorized("Invalid or expired token.");
  }

  if (claims.token_type && claims.token_type !== "access") {
    return unauthorized("Invalid token type.");
  }

  const userId = claims.user_id ?? claims.sub ?? "unknown";

  return {
    ok: true,
    context: {
      userId: String(userId),
      email: typeof claims.email === "string" ? claims.email : "",
      role: "user",
    },
  };
}

// ─── Internal service-to-service auth ───────────────────────────────────────

/**
 * Checks whether the request carries the shared internal-service secret, for
 * trusted server-to-server callers with no user session.
 *
 * Fail-closed: returns false when the secret is unset or too short.
 */
export function isInternalServiceRequest(request: Request): boolean {
  const expected = process.env.INTERNAL_API_SECRET;
  if (!expected || expected.length < 16) return false;

  const provided = request.headers.get("x-internal-secret");
  if (!provided) return false;

  const { timingSafeEqual } = require("node:crypto") as typeof import("node:crypto");
  const expectedBuf = Buffer.from(expected);
  const providedBuf = Buffer.from(provided);
  if (expectedBuf.length !== providedBuf.length) return false;

  return timingSafeEqual(expectedBuf, providedBuf);
}
