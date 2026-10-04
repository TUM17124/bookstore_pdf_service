/**
 * Backpressure for the expensive WASM routes.
 *
 * Measured in development (see bookstore_backend docs/FORMATS_AND_EDITOR_HUB_PLAN.md):
 * the engine rendering a document to PDF took ~23-40 s and grew the process by
 * 1.1-1.8 GB. The production host has 2 vCores / 4 GB that also run the API and
 * the database, so two such jobs at once (or one while memory is short) can
 * trigger the OOM killer. This gate keeps heavy work to one job at a time, makes
 * the rest wait briefly in a bounded queue, and answers "busy, retry in N s"
 * (HTTP 503 + Retry-After) instead of piling up.
 *
 * Only routes listed in HEAVY_ROUTES are gated: HTML/URL rendering and PDF ->
 * Office export, the two that run the document-rendering engine paths measured
 * above. Everything else (parse, preview, watermark, tables, ...) stays
 * unserialized. Add a route here only with a measurement that justifies it.
 *
 * The permit is always released in `finally`. Engine calls are synchronous and
 * cannot be interrupted, so there is deliberately no "give up on a running job"
 * timeout (it would release the permit while the memory is still in use);
 * systemd `MemoryMax` / `RuntimeMaxSec` on the unit is the backstop.
 *
 * Environment (all optional):
 *   HEAVY_CONCURRENCY      1      heavy jobs at once
 *   HEAVY_QUEUE_MAX        2      requests allowed to wait
 *   HEAVY_QUEUE_WAIT_MS    20000  longest wait before answering busy
 *   HEAVY_MIN_AVAILABLE_MB 2200   refuse to START a job below this MemAvailable (0 = off)
 *   HEAVY_MAX_BODY_MB      8      refuse bodies larger than this when Content-Length is known (0 = off)
 *   HEAVY_RETRY_AFTER_S    15     Retry-After sent with the busy answer
 */

import { readFileSync } from "node:fs";

export type Handler = (request: Request) => Promise<Response>;

export const HEAVY_ROUTES = ["/api/pdf/convert", "/api/office/export"] as const;

export interface HeavyGateOptions {
  concurrency: number;
  queueMax: number;
  queueWaitMs: number;
  minAvailableMb: number;
  maxBodyMb: number;
  retryAfterS: number;
  /** MemAvailable in MB, or null when unknown (guard then does not block). Injectable for tests. */
  availableMb: () => number | null;
}

export function memAvailableMb(): number | null {
  try {
    const m = /^MemAvailable:\s+(\d+) kB/m.exec(readFileSync("/proc/meminfo", "utf8"));
    return m ? Math.floor(Number(m[1]) / 1024) : null;
  } catch {
    return null;
  }
}

function num(name: string, fallback: number): number {
  const v = Number(process.env[name]);
  return Number.isFinite(v) && process.env[name] !== undefined && process.env[name] !== "" ? v : fallback;
}

export function optionsFromEnv(): HeavyGateOptions {
  return {
    concurrency: Math.max(1, num("HEAVY_CONCURRENCY", 1)),
    queueMax: Math.max(0, num("HEAVY_QUEUE_MAX", 2)),
    queueWaitMs: Math.max(0, num("HEAVY_QUEUE_WAIT_MS", 20_000)),
    minAvailableMb: Math.max(0, num("HEAVY_MIN_AVAILABLE_MB", 2200)),
    maxBodyMb: Math.max(0, num("HEAVY_MAX_BODY_MB", 8)),
    retryAfterS: Math.max(1, num("HEAVY_RETRY_AFTER_S", 15)),
    availableMb: memAvailableMb,
  };
}

export class BusyError extends Error {
  constructor(
    readonly reason: "queue_full" | "wait_timeout" | "low_memory",
    readonly retryAfterS: number,
  ) {
    super(reason);
  }
}

export class HeavyGate {
  private running = 0;
  private waiters: Array<{ grant: () => void; timer: ReturnType<typeof setTimeout> }> = [];

  constructor(readonly options: HeavyGateOptions) {}

  get active(): number {
    return this.running;
  }
  get queued(): number {
    return this.waiters.length;
  }

  private acquire(): Promise<void> {
    const o = this.options;
    if (o.minAvailableMb > 0) {
      const free = o.availableMb();
      if (free !== null && free < o.minAvailableMb) throw new BusyError("low_memory", o.retryAfterS);
    }
    if (this.running < o.concurrency) {
      this.running += 1;
      return Promise.resolve();
    }
    if (this.waiters.length >= o.queueMax) throw new BusyError("queue_full", o.retryAfterS);
    return new Promise<void>((resolve, reject) => {
      const waiter = {
        grant: () => {
          clearTimeout(waiter.timer);
          resolve();
        },
        timer: setTimeout(() => {
          this.waiters = this.waiters.filter((w) => w !== waiter);
          reject(new BusyError("wait_timeout", o.retryAfterS));
        }, o.queueWaitMs),
      };
      this.waiters.push(waiter);
    });
  }

  private release(): void {
    const next = this.waiters.shift();
    if (next) next.grant(); // hand the permit straight to the next waiter (running stays the same)
    else this.running = Math.max(0, this.running - 1);
  }

  /** Run `job` holding a permit; the permit is released whether it returns, rejects or throws synchronously. */
  async run<T>(job: () => Promise<T>): Promise<T> {
    await this.acquire();
    try {
      return await job();
    } finally {
      this.release();
    }
  }
}

export function busyResponse(err: BusyError): Response {
  const message =
    err.reason === "low_memory"
      ? "The server is short of memory for this operation right now. Try again shortly."
      : "The server is busy with another large document. Try again shortly.";
  return Response.json(
    { success: false, error: message, code: "busy", reason: err.reason, retryAfter: err.retryAfterS },
    { status: 503, headers: { "Retry-After": String(err.retryAfterS) } },
  );
}

/** Wrap one handler with the gate (body-size ceiling, then permit). */
export function guardHeavy(handler: Handler, gate: HeavyGate): Handler {
  return async (request) => {
    const maxBytes = gate.options.maxBodyMb * 1024 * 1024;
    const declared = Number(request.headers.get("content-length"));
    if (maxBytes > 0 && Number.isFinite(declared) && declared > maxBytes) {
      return Response.json(
        { success: false, error: `This request is larger than ${gate.options.maxBodyMb} MB, which is too large for this server.`, code: "too_large" },
        { status: 413 },
      );
    }
    try {
      return await gate.run(() => handler(request));
    } catch (err) {
      if (err instanceof BusyError) return busyResponse(err);
      throw err;
    }
  };
}

/** Return a copy of the route table in which only HEAVY_ROUTES are gated. */
export function applyHeavyGuard<T extends Record<string, Partial<Record<string, Handler>>>>(
  routes: T,
  gate: HeavyGate,
  heavy: readonly string[] = HEAVY_ROUTES,
): T {
  const out: Record<string, Partial<Record<string, Handler>>> = {};
  for (const [path, methods] of Object.entries(routes)) {
    if (!heavy.includes(path)) {
      out[path] = methods;
      continue;
    }
    out[path] = Object.fromEntries(
      Object.entries(methods).map(([method, handler]) => [method, handler ? guardHeavy(handler, gate) : handler]),
    );
  }
  return out as T;
}
