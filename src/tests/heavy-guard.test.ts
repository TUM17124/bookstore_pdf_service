import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyHeavyGuard, BusyError, HEAVY_ROUTES, HeavyGate, guardHeavy, type HeavyGateOptions } from '../lib/heavy-guard';

const opts = (over: Partial<HeavyGateOptions> = {}): HeavyGateOptions => ({
  concurrency: 1, queueMax: 2, queueWaitMs: 200, minAvailableMb: 0, maxBodyMb: 8, retryAfterS: 15, availableMb: () => null, ...over,
});
const tick = (ms = 10) => new Promise((r) => setTimeout(r, ms));
function deferred<T = void>() {
  let resolve!: (v: T) => void; let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

test('only one heavy job runs at a time; the next starts when the first finishes', async () => {
  const gate = new HeavyGate(opts({ queueWaitMs: 2000 }));
  const order: string[] = [];
  const first = deferred();
  const a = gate.run(async () => { order.push('a:start'); await first.promise; order.push('a:end'); });
  const b = gate.run(async () => { order.push('b:start'); });
  await tick();
  assert.deepEqual(order, ['a:start']);
  assert.equal(gate.active, 1);
  assert.equal(gate.queued, 1);
  first.resolve();
  await Promise.all([a, b]);
  assert.deepEqual(order, ['a:start', 'a:end', 'b:start']);
  assert.equal(gate.active, 0);
  assert.equal(gate.queued, 0);
});

test('the permit is released after success, after a rejection and after a synchronous throw', async () => {
  const gate = new HeavyGate(opts());
  await gate.run(async () => 'ok');
  assert.equal(gate.active, 0);
  await assert.rejects(gate.run(async () => { throw new Error('boom'); }), /boom/);
  assert.equal(gate.active, 0);
  await assert.rejects(gate.run((() => { throw new Error('sync'); }) as () => Promise<void>), /sync/);
  assert.equal(gate.active, 0);
  // and the gate still works afterwards (no deadlock)
  assert.equal(await gate.run(async () => 42), 42);
});

test('a crashing job hands the permit to the waiting one', async () => {
  const gate = new HeavyGate(opts({ queueWaitMs: 2000 }));
  const hold = deferred();
  const crashing = gate.run(async () => { await hold.promise; throw new Error('crash'); }).catch((e) => (e as Error).message);
  const next = gate.run(async () => 'ran');
  await tick();
  hold.resolve();
  assert.equal(await crashing, 'crash');
  assert.equal(await next, 'ran');
  assert.equal(gate.active, 0);
});

test('backpressure: a full queue answers busy at once; a long wait times out without leaking a slot', async () => {
  const gate = new HeavyGate(opts({ queueMax: 1, queueWaitMs: 60 }));
  const hold = deferred();
  const running = gate.run(() => hold.promise);
  const waiting = gate.run(async () => 'late');
  await assert.rejects(gate.run(async () => 'x'), (e) => e instanceof BusyError && e.reason === 'queue_full');
  await assert.rejects(waiting, (e) => e instanceof BusyError && e.reason === 'wait_timeout');
  assert.equal(gate.queued, 0);
  hold.resolve();
  await running;
  assert.equal(gate.active, 0);
  assert.equal(await gate.run(async () => 'fine'), 'fine');
});

test('low memory refuses to start a job and does not consume a permit', async () => {
  let free: number | null = 1000;
  const gate = new HeavyGate(opts({ minAvailableMb: 2200, availableMb: () => free }));
  await assert.rejects(gate.run(async () => 'x'), (e) => e instanceof BusyError && e.reason === 'low_memory');
  assert.equal(gate.active, 0);
  free = 3000;
  assert.equal(await gate.run(async () => 'ok'), 'ok');
  free = null; // unknown (non-Linux): do not block
  assert.equal(await gate.run(async () => 'ok2'), 'ok2');
});

test('concurrency is configurable', async () => {
  const gate = new HeavyGate(opts({ concurrency: 2, queueMax: 0 }));
  const hold = deferred();
  const a = gate.run(() => hold.promise);
  const b = gate.run(() => hold.promise);
  await tick();
  assert.equal(gate.active, 2);
  await assert.rejects(gate.run(async () => 1), BusyError);
  hold.resolve();
  await Promise.all([a, b]);
});

test('HTTP: busy answer is 503 with Retry-After; oversized body is 413; handler errors still release', async () => {
  const gate = new HeavyGate(opts({ queueMax: 0, maxBodyMb: 1 }));
  const hold = deferred();
  const handler = guardHeavy(async () => { await hold.promise; return new Response('done'); }, gate);
  const first = handler(new Request('http://x/api/pdf/convert', { method: 'POST' }));
  await tick();
  const busy = await handler(new Request('http://x/api/pdf/convert', { method: 'POST' }));
  assert.equal(busy.status, 503);
  assert.equal(busy.headers.get('retry-after'), '15');
  const body = (await busy.json()) as { code: string; retryAfter: number };
  assert.deepEqual([body.code, body.retryAfter], ['busy', 15]);
  hold.resolve();
  assert.equal(await (await first).text(), 'done');

  const big = await guardHeavy(async () => new Response('no'), gate)(
    new Request('http://x/', { method: 'POST', headers: { 'content-length': String(2 * 1024 * 1024) } }),
  );
  assert.equal(big.status, 413);

  const failing = guardHeavy(async () => { throw new Error('engine failed'); }, gate);
  await assert.rejects(failing(new Request('http://x/', { method: 'POST' })), /engine failed/);
  assert.equal(gate.active, 0);
});

test('only the heavy routes are gated; lightweight routes keep running in parallel', async () => {
  const gate = new HeavyGate(opts({ queueMax: 0 }));
  const hold = deferred();
  const light = async (_r: Request) => { await hold.promise; return new Response('light'); };
  const routes = applyHeavyGuard(
    {
      '/api/pdf/convert': { POST: light },
      '/api/office/export': { POST: light },
      '/api/pdf/watermark': { POST: light },
      '/api/pdf/parse': { POST: light },
    },
    gate,
  );
  assert.deepEqual([...HEAVY_ROUTES].sort(), ['/api/office/export', '/api/pdf/convert']);
  const req = () => new Request('http://x/', { method: 'POST' });
  // two lightweight calls at once: both run
  const l1 = routes['/api/pdf/watermark']!.POST!(req());
  const l2 = routes['/api/pdf/parse']!.POST!(req());
  // heavy ones: the second is refused while the first runs
  const h1 = routes['/api/pdf/convert']!.POST!(req());
  await tick();
  assert.equal((await routes['/api/office/export']!.POST!(req())).status, 503);
  hold.resolve();
  assert.deepEqual(await Promise.all([l1, l2, h1].map(async (p) => (await p).status)), [200, 200, 200]);
  assert.equal(gate.active, 0);
});
