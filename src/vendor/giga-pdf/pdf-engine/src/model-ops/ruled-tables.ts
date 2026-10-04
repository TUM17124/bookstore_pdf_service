/**
 * Ruled-table detector ("lattice" style): finds tables from the horizontal and
 * vertical RULING LINES a PDF draws, then fills the cells with the text runs
 * that fall inside them.
 *
 * Why this exists: the native engine's table recogniser (`toModel()`) works from
 * text geometry only. A table that is clearly drawn with rules but whose text
 * columns are close together (the typical ReportLab / Word / spreadsheet
 * export) is flattened into a justified PARAGRAPH, so `listPdfTables` returned
 * nothing for it - and two ruled tables stacked closely were merged into one,
 * and a ruled grid with empty cells was never a table at all. The rules are the
 * ground truth for those tables, so we read them directly.
 *
 * Pure: takes plain data (vector paths + text runs in PDF user space, origin
 * bottom-left) and returns tables in the same space. Row 0 is the TOP row.
 */

export interface RulePathSegment {
  op: string;
  pts: number[];
}

/** The subset of the engine's `VectorPathInfo` the detector reads. */
export interface RulePath {
  segments: RulePathSegment[];
  fill: number[] | null;
  stroke: number[] | null;
  strokeWidth: number;
}

/** The subset of the engine's `TextElementInfo` the detector reads. */
export interface RuleTextRun {
  index: number;
  text: string;
  x: number;
  y: number;
  width: number;
  height: number;
  fontSize: number;
}

export interface RuledCell {
  row: number;
  col: number;
  rowSpan: number;
  colSpan: number;
  sourceIndices: number[];
  text: string;
}

export interface RuledTable {
  /** PDF user space, origin bottom-left. */
  frame: { x: number; y: number; w: number; h: number };
  rowCount: number;
  colCount: number;
  cells: RuledCell[];
}

/** A line is axis-aligned when it deviates less than this (pt). */
const AXIS_TOL = 0.75;
/** Rules closer than this (pt) are the same rule (double borders, rounding). */
const CLUSTER_TOL = 1.5;
/** Rules this close to each other (pt) are connected. */
const JOIN_TOL = 2;
/** Shorter rules are glyph decoration / ticks, not table rules (pt). */
const MIN_RULE_LEN = 4;
/** A filled rectangle thinner than this (pt) is a rule drawn as a bar. */
const MAX_BAR_THICKNESS = 3;
/** Share of a cell edge that must be ruled for the boundary to exist. */
const COVERAGE = 0.7;

interface HSeg { y: number; a: number; b: number }
interface VSeg { x: number; a: number; b: number }

function pushEdge(h: HSeg[], v: VSeg[], x0: number, y0: number, x1: number, y1: number): void {
  const dx = Math.abs(x1 - x0);
  const dy = Math.abs(y1 - y0);
  if (dy <= AXIS_TOL && dx >= MIN_RULE_LEN) {
    h.push({ y: (y0 + y1) / 2, a: Math.min(x0, x1), b: Math.max(x0, x1) });
  } else if (dx <= AXIS_TOL && dy >= MIN_RULE_LEN) {
    v.push({ x: (x0 + x1) / 2, a: Math.min(y0, y1), b: Math.max(y0, y1) });
  }
}

/** Turn paths into axis-aligned rules: stroked edges, plus thin filled bars. */
export function collectRules(paths: RulePath[]): { h: HSeg[]; v: VSeg[] } {
  const h: HSeg[] = [];
  const v: VSeg[] = [];
  for (const path of paths) {
    // Polylines made of M/L/Z only (curves are never table rules).
    const subpaths: Array<{ pts: Array<[number, number]>; closed: boolean }> = [];
    let cur: { pts: Array<[number, number]>; closed: boolean } | null = null;
    let simple = true;
    for (const seg of path.segments) {
      const op = seg.op.toUpperCase();
      if (op === 'M' && seg.pts.length >= 2) {
        cur = { pts: [[seg.pts[0]!, seg.pts[1]!]], closed: false };
        subpaths.push(cur);
      } else if (op === 'L' && seg.pts.length >= 2 && cur) {
        cur.pts.push([seg.pts[0]!, seg.pts[1]!]);
      } else if ((op === 'Z' || op === 'H') && cur) {
        cur.closed = true;
      } else {
        simple = false;
        break;
      }
    }
    if (!simple) continue;

    for (const sp of subpaths) {
      const pts = sp.pts;
      if (pts.length < 2) continue;
      const stroked = path.stroke !== null && path.strokeWidth > 0;
      // A closed axis-aligned box.
      const xs = pts.map((p) => p[0]);
      const ys = pts.map((p) => p[1]);
      const minX = Math.min(...xs);
      const maxX = Math.max(...xs);
      const minY = Math.min(...ys);
      const maxY = Math.max(...ys);
      const isBox =
        sp.closed &&
        (pts.length === 4 || (pts.length === 5 && pts[0]![0] === pts[4]![0] && pts[0]![1] === pts[4]![1])) &&
        pts.every((p) => (Math.abs(p[0] - minX) <= AXIS_TOL || Math.abs(p[0] - maxX) <= AXIS_TOL) && (Math.abs(p[1] - minY) <= AXIS_TOL || Math.abs(p[1] - maxY) <= AXIS_TOL));

      if (isBox && path.fill !== null && path.stroke === null) {
        // Filled bar: a rule if it is thin on one axis.
        const w = maxX - minX;
        const hgt = maxY - minY;
        if (hgt <= MAX_BAR_THICKNESS && w >= MIN_RULE_LEN) h.push({ y: (minY + maxY) / 2, a: minX, b: maxX });
        else if (w <= MAX_BAR_THICKNESS && hgt >= MIN_RULE_LEN) v.push({ x: (minX + maxX) / 2, a: minY, b: maxY });
        continue;
      }
      if (!stroked) continue;
      for (let i = 0; i + 1 < pts.length; i += 1) {
        pushEdge(h, v, pts[i]![0], pts[i]![1], pts[i + 1]![0], pts[i + 1]![1]);
      }
      if (sp.closed && pts.length > 2) {
        pushEdge(h, v, pts[pts.length - 1]![0], pts[pts.length - 1]![1], pts[0]![0], pts[0]![1]);
      }
    }
  }
  return { h, v };
}

/** Merge collinear, overlapping/touching segments of the same rule. */
function mergeSegments<T extends { a: number; b: number }>(segs: T[], pos: (s: T) => number, make: (p: number, a: number, b: number) => T): T[] {
  // 1) group segments lying on the same line (position within CLUSTER_TOL)
  const sorted = [...segs].sort((p, q) => pos(p) - pos(q));
  const lines: T[][] = [];
  for (const s of sorted) {
    const line = lines[lines.length - 1];
    if (line && pos(s) - pos(line[line.length - 1]!) <= CLUSTER_TOL) line.push(s);
    else lines.push([s]);
  }
  // 2) on each line, union the intervals that overlap or touch
  const out: T[] = [];
  for (const line of lines) {
    const p = line.reduce((sum, s) => sum + pos(s), 0) / line.length;
    const byStart = [...line].sort((x, y) => x.a - y.a);
    let a = byStart[0]!.a;
    let b = byStart[0]!.b;
    for (let i = 1; i < byStart.length; i += 1) {
      const s = byStart[i]!;
      if (s.a <= b + JOIN_TOL) b = Math.max(b, s.b);
      else {
        out.push(make(p, a, b));
        a = s.a;
        b = s.b;
      }
    }
    out.push(make(p, a, b));
  }
  return out;
}

/** Cluster sorted numbers that are within CLUSTER_TOL into their means. */
function clusterValues(values: number[]): number[] {
  const sorted = [...values].sort((a, b) => a - b);
  const out: number[] = [];
  let group: number[] = [];
  for (const val of sorted) {
    if (group.length > 0 && val - group[group.length - 1]! > CLUSTER_TOL) {
      out.push(group.reduce((s, n) => s + n, 0) / group.length);
      group = [];
    }
    group.push(val);
  }
  if (group.length > 0) out.push(group.reduce((s, n) => s + n, 0) / group.length);
  return out;
}

function coverage(segs: Array<{ a: number; b: number }>, lo: number, hi: number): number {
  const len = hi - lo;
  if (len <= 0) return 0;
  const clipped = segs
    .map((s) => [Math.max(s.a, lo), Math.min(s.b, hi)] as const)
    .filter(([a, b]) => b > a)
    .sort((p, q) => p[0] - q[0]);
  let covered = 0;
  let end = -Infinity;
  for (const [a, b] of clipped) {
    const start = Math.max(a, end);
    if (b > start) covered += b - start;
    end = Math.max(end, b);
  }
  return covered / len;
}

class UnionFind {
  private parent: number[];
  constructor(n: number) {
    this.parent = Array.from({ length: n }, (_, i) => i);
  }
  find(i: number): number {
    while (this.parent[i] !== i) {
      this.parent[i] = this.parent[this.parent[i]!]!;
      i = this.parent[i]!;
    }
    return i;
  }
  union(a: number, b: number): void {
    this.parent[this.find(a)] = this.find(b);
  }
}

/**
 * Find ruled tables. `runs` are the page's text runs (user space). A table
 * needs at least two vertical and two horizontal rules that cross.
 */
export function detectRuledTables(paths: RulePath[], runs: RuleTextRun[]): RuledTable[] {
  const raw = collectRules(paths);
  const hs = mergeSegments<HSeg & { a: number; b: number }>(
    raw.h.map((s) => ({ ...s })),
    (s) => s.y,
    (y, a, b) => ({ y, a, b }),
  );
  const vs = mergeSegments<VSeg & { a: number; b: number }>(
    raw.v.map((s) => ({ ...s })),
    (s) => s.x,
    (x, a, b) => ({ x, a, b }),
  );
  if (hs.length < 2 || vs.length < 2) return [];

  // Connected components: a horizontal and a vertical rule are joined when they cross.
  const uf = new UnionFind(hs.length + vs.length);
  hs.forEach((hSeg, i) => {
    vs.forEach((vSeg, j) => {
      if (
        vSeg.x >= hSeg.a - JOIN_TOL &&
        vSeg.x <= hSeg.b + JOIN_TOL &&
        hSeg.y >= vSeg.a - JOIN_TOL &&
        hSeg.y <= vSeg.b + JOIN_TOL
      ) {
        uf.union(i, hs.length + j);
      }
    });
  });
  const groups = new Map<number, { h: typeof hs; v: typeof vs }>();
  hs.forEach((s, i) => {
    const g = groups.get(uf.find(i)) ?? { h: [], v: [] };
    g.h.push(s);
    groups.set(uf.find(i), g);
  });
  vs.forEach((s, j) => {
    const root = uf.find(hs.length + j);
    const g = groups.get(root) ?? { h: [], v: [] };
    g.v.push(s);
    groups.set(root, g);
  });

  const tables: RuledTable[] = [];
  for (const g of groups.values()) {
    if (g.h.length < 2 || g.v.length < 2) continue;
    const table = buildTable(g.h, g.v, runs);
    if (table) tables.push(table);
  }
  // Top-to-bottom, then left-to-right (reading order).
  tables.sort((p, q) => q.frame.y + q.frame.h - (p.frame.y + p.frame.h) || p.frame.x - q.frame.x);
  return tables;
}

function buildTable(h: HSeg[], v: VSeg[], runs: RuleTextRun[]): RuledTable | null {
  const xs = clusterValues(v.map((s) => s.x)); // left -> right
  const ysAsc = clusterValues(h.map((s) => s.y));
  const ys = [...ysAsc].reverse(); // top -> bottom
  if (xs.length < 2 || ys.length < 2) return null;

  const vAt = (x: number) => v.filter((s) => Math.abs(s.x - x) <= CLUSTER_TOL);
  const hAt = (y: number) => h.filter((s) => Math.abs(s.y - y) <= CLUSTER_TOL);
  const vBoundary = (c: number, r: number) => coverage(vAt(xs[c]!), ys[r + 1]!, ys[r]!) >= COVERAGE;
  const hBoundary = (r: number, c: number) => coverage(hAt(ys[r]!), xs[c]!, xs[c + 1]!) >= COVERAGE;

  const nRows = ys.length - 1;
  const nCols = xs.length - 1;

  // Inner ruling is optional: a table with only an outline plus a header rule
  // still has rows. Rows without ANY inner horizontal rule are split by the
  // text lines inside them (see below), so start from the rule grid.
  const rowEdges = [...ys]; // top -> bottom y positions

  const textRuns = runs.filter((r) => r.text.trim() !== '' && r.width > 0);
  const inside = textRuns.filter((r) => {
    const cx = r.x + r.width / 2;
    const cy = r.y + r.height / 2;
    return cx >= xs[0]! && cx <= xs[xs.length - 1]! && cy >= ys[ys.length - 1]! && cy <= ys[0]!;
  });

  // Split a band that has NO internal horizontal rule and several text lines
  // that repeat across columns (an outline table whose rows are only implied by
  // the text) into one row per line.
  // Only a table drawn as an OUTLINE (at most one rule between its top and
  // bottom, e.g. a header underline) has rows that exist only as text lines.
  // With a full grid, a cell that wraps onto two lines is still one row.
  const outlineOnly = ys.length <= 3;
  const refined: number[] = [rowEdges[0]!];
  const bandSplitCounts: number[] = [];
  for (let r = 0; r < nRows; r += 1) {
    const top = rowEdges[r]!;
    const bottom = rowEdges[r + 1]!;
    const bandRuns = inside.filter((run) => {
      const cy = run.y + run.height / 2;
      return cy <= top && cy >= bottom;
    });
    const lines = clusterLines(bandRuns);
    const colsHit = (line: RuleTextRun[]) => new Set(line.map((run) => colOf(xs, run.x + run.width / 2))).size;
    const multiColumnLines = lines.filter((line) => colsHit(line) >= 2).length;
    const splittable =
      outlineOnly &&
      lines.length >= 3 &&
      multiColumnLines >= Math.max(2, Math.ceil(lines.length * 0.7)) &&
      !hasInnerHRule(h, top, bottom, xs);
    if (splittable) {
      for (let i = 0; i + 1 < lines.length; i += 1) {
        const upper = lineMidY(lines[i]!);
        const lower = lineMidY(lines[i + 1]!);
        refined.push((upper + lower) / 2);
      }
      bandSplitCounts.push(lines.length);
    } else {
      bandSplitCounts.push(1);
    }
    refined.push(bottom);
  }
  const rowYs = refined;
  const rowCount = rowYs.length - 1;
  if (rowCount < 1 || nCols < 1 || rowCount * nCols < 2) return null;

  // Map each refined row back to its original band to look up rules.
  const bandOfRow: number[] = [];
  bandSplitCounts.forEach((count, band) => {
    for (let i = 0; i < count; i += 1) bandOfRow.push(band);
  });

  // Spans.
  const taken = Array.from({ length: rowCount }, () => Array<boolean>(nCols).fill(false));
  const cells: RuledCell[] = [];
  for (let r = 0; r < rowCount; r += 1) {
    for (let c = 0; c < nCols; c += 1) {
      if (taken[r]![c]) continue;
      let colSpan = 1;
      while (c + colSpan < nCols && !taken[r]![c + colSpan] && !vBoundary(c + colSpan, bandOfRow[r]!)) colSpan += 1;
      let rowSpan = 1;
      while (r + rowSpan < rowCount) {
        // Only original bands can end a span: a refined split row is separate.
        const sameBand = bandOfRow[r + rowSpan] === bandOfRow[r + rowSpan - 1];
        if (sameBand) break;
        let open = true;
        for (let k = 0; k < colSpan; k += 1) {
          if (taken[r + rowSpan]![c + k] || hBoundary(bandOfRow[r + rowSpan]!, c + k)) open = false;
        }
        if (!open) break;
        rowSpan += 1;
      }
      for (let i = 0; i < rowSpan; i += 1) for (let k = 0; k < colSpan; k += 1) taken[r + i]![c + k] = true;
      cells.push({ row: r, col: c, rowSpan, colSpan, sourceIndices: [], text: '' });
    }
  }

  // Text -> cell.
  const cellRect = (cell: RuledCell) => ({
    x0: xs[cell.col]!,
    x1: xs[cell.col + cell.colSpan]!,
    yTop: rowYs[cell.row]!,
    yBottom: rowYs[cell.row + cell.rowSpan]!,
  });
  const perCell = new Map<RuledCell, RuleTextRun[]>();
  for (const run of inside) {
    const cx = run.x + run.width / 2;
    const cy = run.y + run.height / 2;
    const owner = cells.find((cell) => {
      const rc = cellRect(cell);
      return cx >= rc.x0 && cx <= rc.x1 && cy <= rc.yTop && cy >= rc.yBottom;
    });
    if (owner) perCell.set(owner, [...(perCell.get(owner) ?? []), run]);
  }
  for (const cell of cells) {
    const cellRuns = perCell.get(cell) ?? [];
    const lines = clusterLines(cellRuns);
    cell.text = lines.map((line) => line.sort((p, q) => p.x - q.x).map((run) => run.text.trim()).join(' ')).join('\n');
    cell.sourceIndices = cellRuns.filter((run) => run.index >= 0).map((run) => run.index);
  }

  const left = xs[0]!;
  const right = xs[xs.length - 1]!;
  const top = rowYs[0]!;
  const bottom = rowYs[rowYs.length - 1]!;
  return {
    frame: { x: left, y: bottom, w: right - left, h: top - bottom },
    rowCount,
    colCount: nCols,
    cells,
  };
}

function colOf(xs: number[], x: number): number {
  for (let c = 0; c + 1 < xs.length; c += 1) if (x >= xs[c]! && x <= xs[c + 1]!) return c;
  return -1;
}

function lineMidY(line: RuleTextRun[]): number {
  return line.reduce((s, r) => s + r.y + r.height / 2, 0) / line.length;
}

/** Group runs into visual lines (same baseline within half a font size), top first. */
function clusterLines(runs: RuleTextRun[]): RuleTextRun[][] {
  const sorted = [...runs].sort((p, q) => q.y + q.height / 2 - (p.y + p.height / 2));
  const lines: RuleTextRun[][] = [];
  for (const run of sorted) {
    const mid = run.y + run.height / 2;
    const line = lines.find((l) => Math.abs(lineMidY(l) - mid) <= Math.max(2, run.fontSize * 0.45));
    if (line) line.push(run);
    else lines.push([run]);
  }
  return lines;
}

function hasInnerHRule(h: HSeg[], top: number, bottom: number, xs: number[]): boolean {
  const width = xs[xs.length - 1]! - xs[0]!;
  return h.some((s) => s.y < top - CLUSTER_TOL && s.y > bottom + CLUSTER_TOL && s.b - s.a >= width * 0.3);
}
