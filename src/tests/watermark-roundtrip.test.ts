/**
 * Watermark export -> re-parse round trip.
 *
 * For all 7 presets on A4 and Letter: export with `addWatermark`, re-parse the
 * PDF the way the editor does, and check that (1) the parsed geometry
 * reproduces the exported placement, (2) translucency and rotation survive,
 * (3) the stamp stays inside the page box.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GigaPdfEngine } from '@qrcommunication/gigapdf-lib';
import { addWatermark, planWatermark } from '../vendor/giga-pdf/pdf-engine/src/render/watermark';
import type { WatermarkPosition } from '../vendor/giga-pdf/pdf-engine/src/render/watermark';
import { extractTextElementsByPage, alphasForPage } from '../vendor/giga-pdf/pdf-engine/src/parse/text-extractor';
import { extractTextOpacityByPage, scanTextOps } from '../vendor/giga-pdf/pdf-engine/src/parse/text-opacity';

const PAGES = { A4: [595, 842], Letter: [612, 792] } as const;
const POSITIONS: WatermarkPosition[] = [
  'center-diagonal', 'top-left', 'top-right', 'bottom-left', 'bottom-right', 'header', 'footer',
];
const TEXT = 'CONFIDENTIAL';
const OPACITY = 0.25;

async function blank(w: number, h: number): Promise<Uint8Array> {
  const e = await GigaPdfEngine.loadDefault();
  return e.htmlRender('<!doctype html><html><head><meta charset="utf-8"></head><body></body></html>', [], w, h, 0);
}

const mod360 = (d: number) => ((d % 360) + 360) % 360;

// `undefined` = the preset's own default angle; the others are user-chosen.
for (const userRotation of [undefined, 30, -30, 90, 180]) {
  for (const [pageName, [W, H]] of Object.entries(PAGES)) {
    for (const position of POSITIONS) {
      const label = userRotation === undefined ? '' : ` rotated ${userRotation}deg`;
      test(`${position}${label} on ${pageName}: parsed geometry matches the export and stays on the page`, async () => {
      const e = await GigaPdfEngine.loadDefault();
      const out = await addWatermark(await blank(W, H), { text: TEXT, position, opacity: OPACITY, rotation: userRotation });

      const parsed = (await extractTextElementsByPage(out.bytes)).get(1) ?? [];
      assert.equal(parsed.length, 1, 'exactly the watermark run');
      const el = parsed[0]!;
      assert.equal(el.content, TEXT);

      // What the export planned for this page.
      const plan = planWatermark(position, W, H, (s) => e.helveticaWidth(s, TEXT), undefined, undefined, userRotation);

      // Opacity survives (not solid grey) and the colour is the grey default.
      assert.ok(Math.abs(el.style.opacity! - OPACITY) < 1e-6, `opacity ${el.style.opacity}`);
      assert.ok(Math.abs(el.style.fontSize - plan.fontSize) < 0.05, `fontSize ${el.style.fontSize} vs ${plan.fontSize}`);

      // Rotation: the editor's angle is clockwise = -PDF angle.
      assert.equal(mod360(el.transform.rotation), mod360(-plan.rotation));

      // Rebuild the baseline start from the editor bounds: the renderer anchors
      // a Fabric object at (bounds.x, bounds.y + 1.22em) and rotates about it.
      const fs = el.style.fontSize;
      const rad = (plan.rotation * Math.PI) / 180;
      const s = Math.sin(rad);
      const c = Math.cos(rad);
      const anchorX = el.bounds.x;
      const anchorY = H - (el.bounds.y + 1.22 * fs); // back to PDF space, Y up
      const baseX = anchorX - 0.22 * fs * s;
      const baseY = anchorY + 0.22 * fs * c;
      assert.ok(Math.abs(baseX - plan.x) < 0.5, `x ${baseX} vs ${plan.x}`);
      assert.ok(Math.abs(baseY - plan.y) < 0.5, `y ${baseY} vs ${plan.y}`);
      // The unrotated width is the Helvetica advance, not the enclosing box.
      assert.ok(Math.abs(el.bounds.width - e.helveticaWidth(fs, TEXT)) < 0.5, `width ${el.bounds.width}`);

      // Nothing outside the page: every corner of the rotated text box.
      const adv = el.bounds.width;
      const corners: Array<[number, number]> = [
        [0, -0.2 * fs], [adv, -0.2 * fs], [0, fs], [adv, fs],
      ].map(([u, v]) => [baseX + u! * c - v! * s, baseY + u! * s + v! * c]);
      for (const [x, y] of corners) {
        assert.ok(x >= -0.01 && x <= W + 0.01, `x ${x} outside 0..${W}`);
        assert.ok(y >= -0.01 && y <= H + 0.01, `y ${y} outside 0..${H}`);
      }
      });
    }
  }
}

test('centre-diagonal is centred on the page', async () => {
  const [W, H] = PAGES.A4;
  const out = await addWatermark(await blank(W, H), { text: TEXT, position: 'center-diagonal' });
  const el = (await extractTextElementsByPage(out.bytes)).get(1)![0]!;
  // The engine's enclosing box of the rotated text is what the render shows.
  const e = await GigaPdfEngine.loadDefault();
  const doc = e.open(out.bytes);
  const box = doc.textElements(1)[0]!;
  doc.close();
  assert.ok(Math.abs(box.x + box.width / 2 - W / 2) < 8, 'horizontally centred');
  assert.ok(Math.abs(box.y + box.height / 2 - H / 2) < 8, 'vertically centred');
  assert.equal(el.transform.rotation, -45);
});

test('corner watermarks use a page-relative size, not the 88pt diagonal size', async () => {
  const e = await GigaPdfEngine.loadDefault();
  for (const [W, H] of Object.values(PAGES)) {
    const diag = planWatermark('center-diagonal', W, H, (s) => e.helveticaWidth(s, TEXT));
    for (const pos of ['top-left', 'top-right', 'bottom-left', 'bottom-right'] as const) {
      const p = planWatermark(pos, W, H, (s) => e.helveticaWidth(s, TEXT));
      assert.ok(p.fontSize <= 24 && p.fontSize < diag.fontSize / 2, `${pos} size ${p.fontSize}`);
    }
  }
});

test('long text is shrunk to fit; an explicit size is honoured when it fits', async () => {
  const e = await GigaPdfEngine.loadDefault();
  const long = 'THIS IS A VERY LONG WATERMARK TEXT THAT CANNOT FIT ON ONE LINE AT ANY NORMAL SIZE';
  const [W, H] = PAGES.A4;
  for (const pos of ['top-left', 'top-right', 'header', 'center-diagonal'] as const) {
    const p = planWatermark(pos, W, H, (s) => e.helveticaWidth(s, long), 40);
    assert.ok(p.fontSize < 40, `${pos} shrunk (${p.fontSize})`);
    assert.ok(p.x >= 0 && p.x + (pos === 'center-diagonal' ? 0 : e.helveticaWidth(p.fontSize, long)) <= W + 0.01, `${pos} within width`);
  }
  assert.equal(planWatermark('top-left', W, H, (s) => e.helveticaWidth(s, TEXT), 18).fontSize, 18);
});

test('custom position is passed through untouched', () => {
  const p = planWatermark('custom', 595, 842, () => 100, 30, { x: 10, y: 20, rotation: 33 });
  assert.deepEqual(p, { x: 10, y: 20, fontSize: 30, rotation: 33 });
});

test('opacity scanner replays q/Q/gs and every text-showing operator', () => {
  const content = [
    'BT /F1 12 Tf (plain) Tj ET',
    'q /GS1 gs BT (faded (nested) \\) paren) Tj [(A) -20 (B)] TJ ET Q',
    'BT (after Q) Tj ET',
    'q /GS2 gs BT (x) \' ET Q',
    '% (comment) Tj',
    'q /Missing gs BT (y) Tj ET Q',
  ].join('\n');
  const r = scanTextOps(content, (n) => ({ GS1: 0.25, GS2: 0.5 } as Record<string, number>)[n]);
  assert.deepEqual(r.ops, ['Tj', 'Tj', 'TJ', 'Tj', "'", 'Tj']);
  assert.deepEqual(r.alphas, [1, 0.25, 0.25, 1, 0.5, 1]);
});

test('alphasForPage refuses a scan that does not match the engine runs', () => {
  const runs = [{ index: 0, operator: 'Tj' }, { index: 1, operator: 'Tj' }];
  assert.deepEqual(alphasForPage(runs, { ops: ['Tj', 'Tj'], alphas: [1, 0.3] }), [1, 0.3]);
  assert.equal(alphasForPage(runs, { ops: ['Tj'], alphas: [0.3] }), undefined);
  assert.equal(alphasForPage(runs, { ops: ['Tj', 'TJ'], alphas: [1, 0.3] }), undefined);
  assert.equal(alphasForPage(runs, { ops: ['Tj', 'Tj'], alphas: [1, 1] }), undefined, 'all opaque = nothing to apply');
  assert.equal(alphasForPage(runs, undefined), undefined);
});

test('a watermark on a page that already has text: only the stamp is translucent', async () => {
  const e = await GigaPdfEngine.loadDefault();
  const base = e.htmlRender('<!doctype html><html><body><p>Hello world</p></body></html>', [], 595, 842, 0);
  const out = await addWatermark(base, { text: TEXT, position: 'center-diagonal' });
  const scanned = extractTextOpacityByPage(out.bytes).get(1)!;
  assert.equal(scanned.ops.length, 3);
  assert.deepEqual(scanned.alphas.map((a) => +a.toFixed(2)), [1, 1, 0.25]);
  const els = (await extractTextElementsByPage(out.bytes)).get(1)!;
  assert.deepEqual(els.map((t) => t.style.opacity), [1, 1, 0.25]);
});

test('a PDF with no ExtGState opacity keeps opacity 1', async () => {
  const e = await GigaPdfEngine.loadDefault();
  const base = e.htmlRender('<!doctype html><html><body><p>Plain text</p></body></html>', [], 595, 842, 0);
  const els = (await extractTextElementsByPage(base)).get(1)!;
  assert.ok(els.length > 0 && els.every((t) => t.style.opacity === 1));
});
