import { inflateSync } from 'node:zlib';

// ---------------------------------------------------------------------------
// Text fill opacity from the page content stream.
//
// The native engine's `textElements()` reports position, font, colour and
// rotation but NOT the constant opacity a run is painted with (the `/ca` of the
// `/ExtGState` selected by a `gs` operator). Without it a re-parsed watermark
// (drawn at 25% by `addWatermark`) shows up in the editor as solid grey.
//
// This is a small, read-only, best-effort scanner: it finds the page content
// streams, replays `q` / `Q` / `gs` and records the active fill alpha for every
// text-showing operator (`Tj` `TJ` `'` `"`), in stream order. The engine's text
// run index is the ordinal of that operator, and the caller checks that the
// operator sequence matches `textRuns(page)` before trusting the result, so a
// PDF this scanner cannot read (encrypted, exotic filters, form-XObject text)
// simply keeps opacity 1 as before.
// ---------------------------------------------------------------------------

export interface PageTextOps {
  /** Text-showing operators in stream order (`Tj`, `TJ`, `'`, `"`). */
  ops: string[];
  /** Fill alpha (`/ca`) active for each operator, 0..1. */
  alphas: number[];
}

type PdfName = { n: string };
type PdfRef = { r: number };
type PdfDict = Map<string, PdfValue>;
type PdfValue = number | string | boolean | null | PdfName | PdfRef | PdfDict | PdfValue[];

const isName = (v: unknown): v is PdfName => typeof v === 'object' && v !== null && 'n' in (v as object);
const isRef = (v: unknown): v is PdfRef => typeof v === 'object' && v !== null && 'r' in (v as object);
const isDict = (v: unknown): v is PdfDict => v instanceof Map;

const WS = /[\s\0]/;
const DELIM = /[()<>[\]{}/%]/;

class Reader {
  constructor(private s: string, public pos: number) {}

  private skipWs(): void {
    const s = this.s;
    for (;;) {
      const c = s[this.pos];
      if (c === undefined) return;
      if (WS.test(c)) this.pos++;
      else if (c === '%') {
        while (this.pos < s.length && s[this.pos] !== '\n' && s[this.pos] !== '\r') this.pos++;
      } else return;
    }
  }

  value(depth = 0): PdfValue | undefined {
    if (depth > 24) return undefined;
    this.skipWs();
    const s = this.s;
    const c = s[this.pos];
    if (c === undefined) return undefined;
    if (c === '<' && s[this.pos + 1] === '<') {
      this.pos += 2;
      const d: PdfDict = new Map();
      for (;;) {
        this.skipWs();
        if (s[this.pos] === '>' && s[this.pos + 1] === '>') {
          this.pos += 2;
          return d;
        }
        const k = this.value(depth + 1);
        if (!isName(k)) return undefined;
        const v = this.value(depth + 1);
        if (v === undefined) return undefined;
        d.set(k.n, v);
      }
    }
    if (c === '[') {
      this.pos++;
      const a: PdfValue[] = [];
      for (;;) {
        this.skipWs();
        if (s[this.pos] === ']') {
          this.pos++;
          return a;
        }
        const v = this.value(depth + 1);
        if (v === undefined) return undefined;
        a.push(v);
      }
    }
    if (c === '/') {
      let e = this.pos + 1;
      while (e < s.length && !WS.test(s[e]!) && !DELIM.test(s[e]!)) e++;
      const raw = s.slice(this.pos + 1, e);
      this.pos = e;
      return { n: raw.replace(/#([0-9a-fA-F]{2})/g, (_, h: string) => String.fromCharCode(parseInt(h, 16))) };
    }
    if (c === '(') {
      let depthP = 1;
      let e = this.pos + 1;
      while (e < s.length && depthP > 0) {
        const ch = s[e];
        if (ch === '\\') e++;
        else if (ch === '(') depthP++;
        else if (ch === ')') depthP--;
        e++;
      }
      const str = s.slice(this.pos + 1, e - 1);
      this.pos = e;
      return str;
    }
    if (c === '<') {
      const e = s.indexOf('>', this.pos);
      if (e < 0) return undefined;
      this.pos = e + 1;
      return '';
    }
    // number / ref / keyword
    let e = this.pos;
    while (e < s.length && !WS.test(s[e]!) && !DELIM.test(s[e]!)) e++;
    if (e === this.pos) {
      this.pos++;
      return undefined;
    }
    const tok = s.slice(this.pos, e);
    this.pos = e;
    if (/^[+-]?(\d+\.?\d*|\.\d+)$/.test(tok)) {
      const num = Number(tok);
      if (/^\d+$/.test(tok)) {
        // "N G R" indirect reference?
        const save = this.pos;
        this.skipWs();
        const m = /^(\d+)[\s\0]+R(?![A-Za-z0-9])/.exec(s.slice(this.pos, this.pos + 24));
        if (m) {
          this.pos += m[0].length;
          return { r: num };
        }
        this.pos = save;
      }
      return num;
    }
    if (tok === 'true') return true;
    if (tok === 'false') return false;
    if (tok === 'null') return null;
    return undefined;
  }
}

interface ObjStreamEntry {
  stream: number;
  offset: number;
}

class PdfFile {
  private s: string;
  private offsets = new Map<number, number>();
  private fromStm = new Map<number, ObjStreamEntry>();
  private stmCache = new Map<number, { text: string; first: number }>();
  private stmIndexed = false;

  constructor(bytes: Uint8Array) {
    this.s = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString('latin1');
    const re = /(?:^|[\s\0])(\d+)[ \t]+(\d+)[ \t]+obj\b/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(this.s))) this.offsets.set(Number(m[1]), m.index + m[0].length); // later wins (incremental updates)
  }

  get isEncrypted(): boolean {
    return /\/Encrypt\s+\d+\s+\d+\s+R|\/Encrypt\s*<</.test(this.s.slice(Math.max(0, this.s.length - 4096)));
  }

  private indexObjectStreams(): void {
    if (this.stmIndexed) return;
    this.stmIndexed = true;
    for (const [num, off] of this.offsets) {
      if (!this.s.slice(off, off + 300).includes('/ObjStm')) continue;
      const parsed = this.readAt(off);
      if (!parsed || !isDict(parsed.dict) || !isName(parsed.dict.get('Type')) || (parsed.dict.get('Type') as PdfName).n !== 'ObjStm') continue;
      const stm = this.decodeStream(parsed.dict, parsed.data);
      const n = Number(this.resolve(parsed.dict.get('N')));
      const first = Number(this.resolve(parsed.dict.get('First')));
      if (stm === null || !Number.isFinite(n) || !Number.isFinite(first)) continue;
      this.stmCache.set(num, { text: stm, first });
      const nums = stm.slice(0, first).trim().split(/\s+/).map(Number);
      for (let i = 0; i + 1 < nums.length && i / 2 < n; i += 2) {
        this.fromStm.set(nums[i]!, { stream: num, offset: first + nums[i + 1]! });
      }
    }
  }

  private readAt(off: number): { dict: PdfValue; data: string | null } | null {
    const r = new Reader(this.s, off);
    const dict = r.value();
    if (dict === undefined) return null;
    if (!isDict(dict)) return { dict, data: null };
    let p = r.pos;
    while (p < this.s.length && WS.test(this.s[p]!)) p++;
    if (!this.s.startsWith('stream', p)) return { dict, data: null };
    p += 6;
    if (this.s[p] === '\r') p++;
    if (this.s[p] === '\n') p++;
    const len = dict.get('Length');
    let end = -1;
    if (typeof len === 'number' && this.s.startsWith('endstream', this.skipWsFrom(p + len))) end = p + len;
    if (end < 0) {
      const e = this.s.indexOf('endstream', p);
      if (e < 0) return null;
      end = e;
      while (end > p && (this.s[end - 1] === '\n' || this.s[end - 1] === '\r')) end--;
    }
    return { dict, data: this.s.slice(p, end) };
  }

  private skipWsFrom(p: number): number {
    while (p < this.s.length && WS.test(this.s[p]!)) p++;
    return p;
  }

  /** The object's value (dict streams return their dict), or undefined. */
  get(num: number): PdfValue | undefined {
    const off = this.offsets.get(num);
    if (off !== undefined) return this.readAt(off)?.dict;
    this.indexObjectStreams();
    const e = this.fromStm.get(num);
    const stm = e && this.stmCache.get(e.stream);
    if (!e || !stm) return undefined;
    return new Reader(stm.text, e.offset).value() ?? undefined;
  }

  resolve(v: PdfValue | undefined): PdfValue | undefined {
    for (let i = 0; i < 8 && isRef(v); i++) v = this.get(v.r);
    return v;
  }

  dictOf(v: PdfValue | undefined): PdfDict | undefined {
    const r = this.resolve(v);
    return isDict(r) ? r : undefined;
  }

  /** Decoded content of a stream object, or null (missing / unsupported filter). */
  streamText(num: number): string | null {
    const off = this.offsets.get(num);
    if (off === undefined) return null;
    const parsed = this.readAt(off);
    if (!parsed || !isDict(parsed.dict) || parsed.data === null) return null;
    return this.decodeStream(parsed.dict, parsed.data);
  }

  private decodeStream(dict: PdfDict, data: string | null): string | null {
    if (data === null) return null;
    let filter = this.resolve(dict.get('Filter'));
    if (Array.isArray(filter)) filter = filter.length === 1 ? this.resolve(filter[0]) : filter.length === 0 ? undefined : null;
    if (filter === undefined) return data;
    if (!isName(filter) || (filter.n !== 'FlateDecode' && filter.n !== 'Fl')) return null;
    if (dict.get('DecodeParms') !== undefined && dict.get('DecodeParms') !== null) {
      const parms = this.resolve(dict.get('DecodeParms'));
      const p = Array.isArray(parms) ? this.resolve(parms[0]) : parms;
      if (isDict(p) && Number(this.resolve(p.get('Predictor')) ?? 1) > 1) return null;
    }
    try {
      return inflateSync(Buffer.from(data, 'latin1')).toString('latin1');
    } catch {
      return null;
    }
  }

  root(): number | null {
    const all = [...this.s.matchAll(/\/Root[\s\0]+(\d+)[\s\0]+\d+[\s\0]+R/g)];
    const last = all[all.length - 1];
    return last ? Number(last[1]) : null;
  }
}

interface PageRef {
  contents: PdfValue | undefined;
  resources: PdfValue | undefined;
}

function collectPages(file: PdfFile): PageRef[] {
  const rootNum = file.root();
  if (rootNum === null) return [];
  const catalog = file.dictOf({ r: rootNum });
  const pages: PageRef[] = [];
  const seen = new Set<number>();
  const walk = (node: PdfValue | undefined, inheritedRes: PdfValue | undefined, depth: number): void => {
    if (depth > 40) return;
    if (isRef(node)) {
      if (seen.has(node.r)) return;
      seen.add(node.r);
    }
    const d = file.dictOf(node);
    if (!d) return;
    const res = d.get('Resources') ?? inheritedRes;
    const kids = file.resolve(d.get('Kids'));
    const type = file.resolve(d.get('Type'));
    if (Array.isArray(kids) && !(isName(type) && type.n === 'Page')) {
      for (const k of kids) walk(k, res, depth + 1);
    } else {
      pages.push({ contents: d.get('Contents'), resources: res });
    }
  };
  walk(catalog?.get('Pages'), undefined, 0);
  return pages;
}

function pageContent(file: PdfFile, contents: PdfValue | undefined): string | null {
  const c = file.resolve(contents);
  const refs: PdfValue[] = Array.isArray(c) ? c : contents !== undefined ? [contents] : [];
  const parts: string[] = [];
  for (const r of refs) {
    if (!isRef(r)) return null;
    const t = file.streamText(r.r);
    if (t === null) return null;
    parts.push(t);
  }
  return parts.join('\n');
}

const SHOW_OPS = new Set(['Tj', 'TJ', "'", '"']);

/** Replay a content stream, returning the fill alpha at each text-showing operator. */
export function scanTextOps(content: string, extGState: (name: string) => number | undefined): PageTextOps {
  const ops: string[] = [];
  const alphas: number[] = [];
  const stack: number[] = [];
  let alpha = 1;
  let lastName: string | null = null;
  const r = new Reader(content, 0);
  const n = content.length;
  let guard = 0;
  while (r.pos < n && guard++ < 5_000_000) {
    const before = r.pos;
    // Operators are bare keywords; operands parse through Reader.value().
    const skip = /[\s\0]*/y;
    skip.lastIndex = r.pos;
    skip.exec(content);
    r.pos = skip.lastIndex;
    if (r.pos >= n) break;
    const ch = content[r.pos]!;
    if (ch === '%') {
      while (r.pos < n && content[r.pos] !== '\n' && content[r.pos] !== '\r') r.pos++;
      continue;
    }
    if (ch === '/' || ch === '(' || ch === '[' || ch === '<' || /[0-9+\-.]/.test(ch)) {
      const v = r.value();
      if (isName(v)) lastName = v.n;
      if (r.pos === before) r.pos++;
      continue;
    }
    if (ch === ']' || ch === '>' || ch === ')') {
      r.pos++;
      continue;
    }
    let e = r.pos;
    while (e < n && !WS.test(content[e]!) && !DELIM.test(content[e]!)) e++;
    if (e === r.pos) {
      // single-char operators ' and " are not in the delimiter set, so this is a stray delimiter
      r.pos++;
      continue;
    }
    const op = content.slice(r.pos, e);
    r.pos = e;
    if (op === 'q') stack.push(alpha);
    else if (op === 'Q') alpha = stack.pop() ?? 1;
    else if (op === 'gs' && lastName !== null) {
      const a = extGState(lastName);
      if (a !== undefined) alpha = a;
    } else if (SHOW_OPS.has(op)) {
      ops.push(op);
      alphas.push(alpha);
    } else if (op === 'BI') {
      // inline image: skip to the EI that follows ID
      const id = content.indexOf('ID', r.pos);
      const ei = id < 0 ? -1 : content.indexOf('EI', id);
      r.pos = ei < 0 ? n : ei + 2;
    }
    lastName = null;
  }
  return { ops, alphas };
}

/**
 * Per page (1-based): the text-showing operators and the fill alpha each is
 * painted with. Pages that cannot be read are omitted. Never throws.
 */
export function extractTextOpacityByPage(pdfBytes: Uint8Array): Map<number, PageTextOps> {
  const out = new Map<number, PageTextOps>();
  try {
    const file = new PdfFile(pdfBytes);
    if (file.isEncrypted) return out;
    const pages = collectPages(file);
    pages.forEach((page, i) => {
      const content = pageContent(file, page.contents);
      if (content === null) return;
      const res = file.dictOf(page.resources);
      const gsDict = file.dictOf(res?.get('ExtGState'));
      out.set(
        i + 1,
        scanTextOps(content, (name) => {
          const g = file.dictOf(gsDict?.get(name));
          const ca = file.resolve(g?.get('ca'));
          return typeof ca === 'number' ? Math.max(0, Math.min(1, ca)) : undefined;
        }),
      );
    });
  } catch {
    // best effort only
  }
  return out;
}
