/**
 * Table detection for PDFs whose tables are drawn with ruling lines.
 *
 * Root cause covered here: the engine's recogniser (`toModel()`) only looks at
 * text geometry, so a ReportLab/Word-style ruled table with tight columns is
 * flattened into a paragraph and `listPdfTables` returned 0 tables. The ruling
 * lines are read directly by `detectRuledTables` / `listPdfTablesDetailed`.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { GigaPdfEngine } from '@qrcommunication/gigapdf-lib';
import { listPdfTables, listPdfTablesDetailed, userRectToDisplayed } from '../vendor/giga-pdf/pdf-engine/src/model-ops/index';
import { detectRuledTables } from '../vendor/giga-pdf/pdf-engine/src/model-ops/ruled-tables';

const fixture = new Uint8Array(readFileSync(fileURLToPath(new URL('./fixtures/ruled-tables.pdf', import.meta.url))));

const grid = (cells: Array<Array<string>>) => ({ cells });

/** Draw a ruled grid (+ text) on a blank page; `rowH`/`colW` in points, origin = top-left of the grid in PDF space. */
async function ruledPdf(
  opts: { x0?: number; yTop?: number; colW?: number[]; rowH?: number[]; text?: string[][]; skipH?: number[]; skipV?: number[]; rotate?: number } = {},
): Promise<Uint8Array> {
  const e = await GigaPdfEngine.loadDefault();
  const colW = opts.colW ?? [120, 120, 120];
  const rowH = opts.rowH ?? [28, 28, 28, 28];
  const x0 = opts.x0 ?? 60;
  const yTop = opts.yTop ?? 700;
  const d = e.open(e.htmlRender('<html><body></body></html>', [], 595, 842, 0));
  const totalW = colW.reduce((a, b) => a + b, 0);
  const totalH = rowH.reduce((a, b) => a + b, 0);
  let y = yTop;
  for (let r = 0; r <= rowH.length; r += 1) {
    if (!opts.skipH?.includes(r)) d.drawLine(1, x0, y, x0 + totalW, y, 0x000000, 1);
    y -= rowH[r] ?? 0;
  }
  let x = x0;
  for (let c = 0; c <= colW.length; c += 1) {
    if (!opts.skipV?.includes(c)) d.drawLine(1, x, yTop, x, yTop - totalH, 0x000000, 1);
    x += colW[c] ?? 0;
  }
  const text = opts.text ?? [];
  let ry = yTop;
  text.forEach((row, r) => {
    let cx = x0;
    row.forEach((t, c) => {
      if (t) d.addStandardText(1, cx + 8, ry - rowH[r]! / 2 - 4, 12, t, 'Helvetica', 0);
      cx += colW[c]!;
    });
    ry -= rowH[r]!;
  });
  if (opts.rotate) d.rotatePage(1, opts.rotate);
  const out = d.save();
  d.close();
  return out;
}
void grid;

test('the engine alone finds no table in the ruled fixture (the bug), the detector finds all of them', async () => {
  // The engine's text-only recogniser gets this page wrong: it reports one bogus 1x7
  // "table" and none of the four drawn grids (originally: 0 tables for such files).
  const engineOnly = await listPdfTables(fixture);
  assert.ok(engineOnly.every((t) => !(t.rowCount === 8 && t.colCount === 3)), 'engine does not see the 8x3 inventory grid');
  assert.notEqual(engineOnly.length, 4);
  const found = await listPdfTablesDetailed(fixture);
  assert.deepEqual(
    found.map((t) => [t.pageNumber, t.rowCount, t.colCount, t.source, t.editable]),
    [
      [1, 8, 3, 'rules', false],
      [1, 4, 3, 'rules', false],
      [2, 3, 3, 'rules', false],
      [2, 5, 2, 'rules', false],
    ],
  );
});

test('cell text of the ruled fixture is complete and in the right cells', async () => {
  const [inventory, regions, , scores] = await listPdfTablesDetailed(fixture);
  const text = (t: NonNullable<typeof inventory>) => {
    const rows: string[][] = [];
    for (const c of t.cells) (rows[c.row] ??= [])[c.col] = c.text;
    return rows;
  };
  assert.deepEqual(text(inventory!)[0], ['Item', 'Qty', 'Price']);
  assert.deepEqual(text(inventory!)[7], ['Item 7', '7', '10.50']);
  // "Region" spans two columns.
  const region = regions!.cells.find((c) => c.row === 0 && c.col === 0)!;
  assert.equal(region.colSpan, 2);
  assert.equal(region.text, 'Region');
  assert.equal(regions!.cells.find((c) => c.row === 3 && c.col === 2)!.text, '30');
  // An outline table (box + header rule) still gets one row per text line.
  assert.deepEqual(text(scores!), [['Name', 'Score'], ['Ada', '98'], ['Bo', '87'], ['Cy', '76'], ['Di', '65']]);
});

test('a ruled grid with empty cells is still a table', async () => {
  const empty = (await listPdfTablesDetailed(fixture)).find((t) => t.pageNumber === 2 && t.rowCount === 3)!;
  assert.equal(empty.colCount, 3);
  assert.ok(empty.cells.every((c) => c.text === ''));
});

test('two ruled tables on one page stay two tables', async () => {
  const e = await GigaPdfEngine.loadDefault();
  const d = e.open(await ruledPdf({ text: [['a', 'b', 'c'], ['d', 'e', 'f'], ['g', 'h', 'i'], ['j', 'k', 'l']] }));
  // second grid 40pt below the first
  for (let r = 0; r <= 2; r += 1) d.drawLine(1, 60, 520 - r * 28, 300, 520 - r * 28, 0x000000, 1);
  for (let c = 0; c <= 2; c += 1) d.drawLine(1, 60 + c * 120, 520, 60 + c * 120, 464, 0x000000, 1);
  const bytes = d.save();
  d.close();
  const tables = await listPdfTablesDetailed(bytes);
  assert.deepEqual(tables.map((t) => [t.rowCount, t.colCount]), [[4, 3], [2, 2]]);
});

test('detectRuledTables: spans come from missing inner rules', () => {
  const line = (x0: number, y0: number, x1: number, y1: number) => ({
    segments: [{ op: 'M', pts: [x0, y0] }, { op: 'L', pts: [x1, y1] }],
    fill: null,
    stroke: [0, 0, 0],
    strokeWidth: 1,
  });
  // 2x2 grid whose middle vertical rule is missing on row 0 -> that row is one wide cell.
  const paths = [
    line(0, 100, 200, 100), line(0, 50, 200, 50), line(0, 0, 200, 0),
    line(0, 100, 0, 0), line(200, 100, 200, 0), line(100, 50, 100, 0),
  ];
  const [t] = detectRuledTables(paths, []);
  assert.equal(t!.rowCount, 2);
  assert.equal(t!.colCount, 2);
  const top = t!.cells.find((c) => c.row === 0)!;
  assert.equal(top.colSpan, 2);
  assert.equal(t!.cells.length, 3);
});

test('rules are recognised as stroked boxes, stroked lines and thin filled bars; decoration is not a table', () => {
  const rect = (x: number, y: number, w: number, h: number, fill: number[] | null, stroke: number[] | null) => ({
    segments: [
      { op: 'M', pts: [x, y] }, { op: 'L', pts: [x + w, y] }, { op: 'L', pts: [x + w, y + h] }, { op: 'L', pts: [x, y + h] }, { op: 'Z', pts: [] },
    ],
    fill,
    stroke,
    strokeWidth: 1,
  });
  const cells = [rect(0, 30, 50, 30, null, [0, 0, 0]), rect(50, 30, 50, 30, null, [0, 0, 0]), rect(0, 0, 50, 30, null, [0, 0, 0]), rect(50, 0, 50, 30, null, [0, 0, 0])];
  assert.equal(detectRuledTables(cells, [])[0]!.rowCount, 2);
  const bars = [rect(0, 59.5, 100, 1, [0, 0, 0], null), rect(0, 29.5, 100, 1, [0, 0, 0], null), rect(0, -0.5, 100, 1, [0, 0, 0], null), rect(-0.5, 0, 1, 60, [0, 0, 0], null), rect(49.5, 0, 1, 60, [0, 0, 0], null), rect(99.5, 0, 1, 60, [0, 0, 0], null)];
  const [t] = detectRuledTables(bars, []);
  assert.deepEqual([t!.rowCount, t!.colCount], [2, 2]);
  // A page border / underline: no crossing rules, no table.
  assert.deepEqual(detectRuledTables([rect(10, 10, 500, 700, null, [0, 0, 0])], []), []);
  assert.deepEqual(detectRuledTables([rect(0, 0, 100, 1, [0, 0, 0], null)], []), []);
});

test('frames are reported in displayed space for every page rotation', async () => {
  const base = await ruledPdf({ text: [['a', 'b', 'c']], rowH: [28, 28], colW: [120, 120, 120] });
  const expected = { x: 60, w: 360, h: 56 };
  for (const rotate of [0, 90, 180, 270]) {
    const e = await GigaPdfEngine.loadDefault();
    let bytes = base;
    if (rotate) {
      const d = e.open(base);
      d.rotatePage(1, rotate);
      bytes = d.save();
      d.close();
    }
    const [t] = await listPdfTablesDetailed(bytes);
    assert.ok(t, `rotation ${rotate}`);
    const want = userRectToDisplayed({ x: expected.x, y: 700 - 56, w: expected.w, h: expected.h }, 595, 842, rotate);
    assert.ok(Math.abs(t.frame!.x - want.x) < 1 && Math.abs(t.frame!.y - want.y) < 1, `rotation ${rotate}: ${JSON.stringify(t.frame)} vs ${JSON.stringify(want)}`);
    assert.ok(Math.abs(t.frame!.w - want.w) < 1 && Math.abs(t.frame!.h - want.h) < 1);
  }
  // The unrotated frame matches what the engine's own model reports (top-left origin).
  const [t0] = await listPdfTablesDetailed(base);
  assert.ok(Math.abs(t0!.frame!.y - (842 - 700)) < 1);
});

test('engine tables that the rules agree with stay editable and keep their handle', async () => {
  const e = await GigaPdfEngine.loadDefault();
  const html = '<!doctype html><html><head><style>td{border:1px solid #000;padding:6px 10px;font:12px Helvetica} table{border-collapse:collapse}</style></head><body><table><tr><td>Item</td><td>Qty</td></tr><tr><td>Apple</td><td>3</td></tr></table></body></html>';
  const tables = await listPdfTablesDetailed(e.htmlRender(html, [], 595, 842, 36));
  assert.equal(tables.length, 1);
  assert.deepEqual([tables[0]!.source, tables[0]!.editable, tables[0]!.tableIndexOnPage], ['model', true, 0]);
  assert.deepEqual(tables[0]!.cells.map((c) => c.text), ['Item', 'Qty', 'Apple', '3']);
});

test('a page with no rules and no text grid has no tables', async () => {
  const e = await GigaPdfEngine.loadDefault();
  assert.deepEqual(await listPdfTablesDetailed(e.htmlRender('<html><body><p>Just a paragraph of text.</p></body></html>', [], 595, 842, 36)), []);
});
