/**
 * Standalone PDF-math HTTP service for the PlugYard editor.
 *
 * bookstore (the Next.js frontend) deploys as a static export
 * (`output: "export"`), which cannot run Next.js API route handlers - they
 * require a live server. This service runs the SAME route handler logic
 * (ported near-verbatim from bookstore/src/app/api/pdf/*, /api/office/*,
 * which already used the standard Fetch API Request/Response under the
 * NextRequest/NextResponse aliases) as a plain Node HTTP server instead,
 * with no framework in between - Node 18+'s built-in Request/Response/
 * FormData already do everything Next.js's route handlers relied on.
 */

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";

import * as preview from "./routes/preview.js";
import * as parse from "./routes/parse.js";
import * as parseFromS3 from "./routes/parse-from-s3.js";
import * as replaceImage from "./routes/replace-image.js";
import * as ink from "./routes/ink.js";
import * as ocrPage from "./routes/ocr-page.js";
import * as links from "./routes/links.js";
import * as insertSvg from "./routes/insert-svg.js";
import * as structure from "./routes/structure.js";
import * as annotations from "./routes/annotations.js";
import * as textStyle from "./routes/text-style.js";
import * as attachments from "./routes/attachments.js";
import * as officeExport from "./routes/office-export.js";
import * as blank from "./routes/blank.js";
import * as merge from "./routes/merge.js";
import * as split from "./routes/split.js";
import * as compress from "./routes/compress.js";
import * as convert from "./routes/convert.js";
import * as pages from "./routes/pages.js";
import * as encrypt from "./routes/encrypt.js";
import * as sign from "./routes/sign.js";
import * as watermark from "./routes/watermark.js";
import * as forms from "./routes/forms.js";
import * as metadata from "./routes/metadata.js";
import * as ocr from "./routes/ocr.js";
import * as tableStructure from "./routes/table-structure.js";
import * as search from "./routes/search.js";
import * as flatten from "./routes/flatten.js";
import * as open from "./routes/open.js";
import * as applyElements from "./routes/apply-elements.js";
import * as applyModelOps from "./routes/apply-model-ops.js";
import * as ocg from "./routes/ocg.js";
import * as pageBoxes from "./routes/page-boxes.js";
import * as pageLabels from "./routes/page-labels.js";
import * as pdfa from "./routes/pdfa.js";
import * as presentation from "./routes/presentation.js";
import * as color from "./routes/color.js";
import * as imposition from "./routes/imposition.js";
import * as fonts from "./routes/fonts.js";
import { applyHeavyGuard, HeavyGate, optionsFromEnv } from "./lib/heavy-guard.js";

type Handler = (request: Request) => Promise<Response>;
type RouteTable = Record<string, Partial<Record<"GET" | "POST", Handler>>>;

const rawRoutes: RouteTable = {
  "/api/pdf/preview": { POST: preview.POST },
  "/api/pdf/parse": { POST: parse.POST },
  "/api/pdf/parse-from-s3": { POST: parseFromS3.POST },
  "/api/pdf/replace-image": { POST: replaceImage.POST },
  "/api/pdf/ink": { POST: ink.POST },
  "/api/pdf/ocr-page": { POST: ocrPage.POST },
  "/api/pdf/links": { POST: links.POST },
  "/api/pdf/insert-svg": { POST: insertSvg.POST },
  "/api/pdf/structure": { POST: structure.POST },
  "/api/pdf/annotations": { POST: annotations.POST },
  "/api/pdf/text-style": { POST: textStyle.POST },
  "/api/pdf/attachments": { GET: attachments.GET, POST: attachments.POST },
  "/api/office/export": { POST: officeExport.POST },
  "/api/pdf/blank": { POST: blank.POST },
  "/api/pdf/merge": { POST: merge.POST },
  "/api/pdf/split": { POST: split.POST },
  "/api/pdf/compress": { POST: compress.POST },
  "/api/pdf/convert": { POST: convert.POST },
  "/api/pdf/pages": { POST: pages.POST },
  "/api/pdf/encrypt": { POST: encrypt.POST },
  "/api/pdf/sign": { POST: sign.POST },
  "/api/pdf/watermark": { POST: watermark.POST },
  "/api/pdf/forms": { POST: forms.POST },
  "/api/pdf/metadata": { POST: metadata.POST },
  "/api/pdf/ocr": { GET: ocr.GET, POST: ocr.POST },
  "/api/pdf/table-structure": { POST: tableStructure.POST },
  "/api/pdf/search": { POST: search.POST },
  "/api/pdf/flatten": { POST: flatten.POST },
  "/api/pdf/open": { POST: open.POST },
  "/api/pdf/apply-elements": { POST: applyElements.POST },
  "/api/pdf/apply-model-ops": { POST: applyModelOps.POST },
  "/api/pdf/ocg": { POST: ocg.POST },
  "/api/pdf/page-boxes": { POST: pageBoxes.POST },
  "/api/pdf/page-labels": { POST: pageLabels.POST },
  "/api/pdf/pdfa": { POST: pdfa.POST },
  "/api/pdf/presentation": { POST: presentation.POST },
  "/api/pdf/color": { POST: color.POST },
  "/api/pdf/imposition": { POST: imposition.POST },
  "/api/pdf/fonts": { GET: fonts.GET },
};

// Heavy WASM routes run one at a time (see lib/heavy-guard.ts); the rest are untouched.
const routes: RouteTable = applyHeavyGuard(rawRoutes, new HeavyGate(optionsFromEnv()));

const PORT = Number(process.env.PORT ?? 8002);
const DEFAULT_ALLOWED_ORIGINS = ["https://plugyard.com", "https://www.plugyard.com"];
const ALLOWED_ORIGINS = (process.env.CORS_ALLOWED_ORIGINS ?? DEFAULT_ALLOWED_ORIGINS.join(","))
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

function corsHeaders(origin: string | null): Record<string, string> {
  if (!origin || !ALLOWED_ORIGINS.includes(origin)) return {};
  return {
    "Access-Control-Allow-Origin": origin,
    // The editor's fetch calls use credentials: "include" (matches
    // bookstore's existing call sites, unchanged by this port) - the spec
    // requires this alongside a non-wildcard Allow-Origin, or the browser
    // blocks the response from being read even though the request succeeds.
    "Access-Control-Allow-Credentials": "true",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Authorization, Content-Type",
    "Access-Control-Max-Age": "86400",
    Vary: "Origin",
  };
}

/** Builds a standard Fetch API Request from a Node IncomingMessage. */
async function toWebRequest(req: IncomingMessage, url: URL): Promise<Request> {
  const headers = new Headers();
  for (const [key, value] of Object.entries(req.headers)) {
    if (value === undefined) continue;
    if (Array.isArray(value)) {
      for (const v of value) headers.append(key, v);
    } else {
      headers.set(key, value);
    }
  }

  const canHaveBody = req.method !== "GET" && req.method !== "HEAD";
  const body = canHaveBody ? (req as unknown as ReadableStream<Uint8Array>) : undefined;

  const request = new Request(url, {
    method: req.method,
    headers,
    body,
    // Node's fetch Request requires this when a stream body is provided.
    duplex: canHaveBody ? "half" : undefined,
  } as RequestInit & { duplex?: "half" });

  // The Fetch spec forbids a body on GET/HEAD Request construction, but a
  // GET request (e.g. attachments.ts's list endpoint) may still carry a real
  // multipart body over the wire. Buffer it and let route handlers read it
  // via the usual request.formData()/arrayBuffer()/text()/json() - routed
  // through a same-origin Response, which has no such method restriction, so
  // this reuses Node's own multipart parser rather than reimplementing one.
  if (!canHaveBody && (req.headers["content-length"] || req.headers["transfer-encoding"])) {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const bodyBuffer = Buffer.concat(chunks);
    if (bodyBuffer.length > 0) {
      const bodyHeaders = new Headers();
      const contentType = headers.get("content-type");
      if (contentType) bodyHeaders.set("content-type", contentType);
      Object.defineProperties(request, {
        formData: { value: () => new Response(bodyBuffer, { headers: bodyHeaders }).formData() },
        arrayBuffer: { value: () => new Response(bodyBuffer).arrayBuffer() },
        text: { value: () => new Response(bodyBuffer).text() },
        json: { value: () => new Response(bodyBuffer).json() },
      });
    }
  }

  return request;
}

/** Writes a standard Fetch API Response back onto a Node ServerResponse. */
async function writeWebResponse(res: ServerResponse, response: Response): Promise<void> {
  const headers: Record<string, string> = {};
  response.headers.forEach((value, key) => {
    headers[key] = value;
  });
  res.writeHead(response.status, headers);

  if (!response.body) {
    res.end();
    return;
  }

  const reader = response.body.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    res.write(value);
  }
  res.end();
}

const server = createServer((req, res) => {
  void (async () => {
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
    const origin = req.headers.origin ?? null;
    const cors = corsHeaders(origin);

    if (req.method === "OPTIONS") {
      res.writeHead(204, cors);
      res.end();
      return;
    }

    if (url.pathname === "/health") {
      res.writeHead(200, { ...cors, "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
      return;
    }

    const routeHandlers = routes[url.pathname];
    const handler = routeHandlers?.[req.method as "GET" | "POST"];

    if (!handler) {
      res.writeHead(404, { ...cors, "Content-Type": "application/json" });
      res.end(JSON.stringify({ success: false, error: "Not found." }));
      return;
    }

    try {
      const request = await toWebRequest(req, url);
      const response = await handler(request);
      const merged = new Response(response.body, {
        status: response.status,
        statusText: response.statusText,
        headers: response.headers,
      });
      for (const [key, value] of Object.entries(cors)) {
        merged.headers.set(key, value);
      }
      await writeWebResponse(res, merged);
    } catch (err) {
      console.error(`[pdf-service] ${url.pathname} handler error:`, err);
      if (!res.headersSent) {
        res.writeHead(500, { ...cors, "Content-Type": "application/json" });
      }
      res.end(JSON.stringify({ success: false, error: "Internal server error." }));
    }
  })();
});

server.listen(PORT, () => {
  console.log(`[pdf-service] listening on http://localhost:${PORT}`);
  console.log(`[pdf-service] CORS allowed origins: ${ALLOWED_ORIGINS.join(", ") || "(none)"}`);
});
