import { inflateRawSync } from 'node:zlib';

/**
 * A small, dependency-free reader for .xlsx files (the first worksheet only). It returns every cell as text, with
 * date cells converted to YYYY-MM-DD. Limits keep a hostile file (a "zip bomb") from using up the server.
 */

export class XlsxError extends Error {}

const MAX_UNCOMPRESSED = 40 * 1024 * 1024;
const MAX_ROWS = 50_001;
const MAX_COLS = 200;

function zipEntries(buf: Buffer): Map<string, () => Buffer> {
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 22 - 65_535); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new XlsxError('not a zip');
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  const out = new Map<string, () => Buffer>();
  let budget = MAX_UNCOMPRESSED;
  for (let n = 0; n < count && n < 2000; n++) {
    if (p + 46 > buf.length || buf.readUInt32LE(p) !== 0x02014b50) throw new XlsxError('bad zip directory');
    const method = buf.readUInt16LE(p + 10);
    const csize = buf.readUInt32LE(p + 20);
    const usize = buf.readUInt32LE(p + 24);
    const nlen = buf.readUInt16LE(p + 28), elen = buf.readUInt16LE(p + 30), clen = buf.readUInt16LE(p + 32);
    const local = buf.readUInt32LE(p + 42);
    const name = buf.subarray(p + 46, p + 46 + nlen).toString('utf8');
    p += 46 + nlen + elen + clen;
    out.set(name, () => {
      if (usize > budget) throw new XlsxError('too large');
      budget -= usize;
      if (local + 30 > buf.length || buf.readUInt32LE(local) !== 0x04034b50) throw new XlsxError('bad zip entry');
      const start = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
      const data = buf.subarray(start, start + csize);
      if (method === 0) return Buffer.from(data);
      if (method === 8) return inflateRawSync(data, { maxOutputLength: Math.max(usize, 1) + 1024 });
      throw new XlsxError('unsupported compression');
    });
  }
  return out;
}

const decodeEntities = (s: string) =>
  s.replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos);/gi, (_m, e: string) => {
    if (e[0] === '#') {
      const cp = e[1]!.toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(cp) && cp > 0 && cp < 0x110000 ? String.fromCodePoint(cp) : '';
    }
    return { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" }[e.toLowerCase()] ?? '';
  });

const textOf = (xml: string) => [...xml.matchAll(/<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/g)].map((m) => decodeEntities(m[1]!)).join('');

function colIndex(ref: string): number {
  let n = 0;
  for (const ch of ref.replace(/[^A-Z]/gi, '').toUpperCase()) n = n * 26 + ch.charCodeAt(0) - 64;
  return n - 1;
}

const BUILTIN_DATE = new Set([14, 15, 16, 17, 18, 19, 20, 21, 22, 45, 46, 47]);

/** Which cell styles are dates (so a 46000 in that column is shown as a date, not a number). */
function dateStyles(xml: string | null): Set<number> {
  const out = new Set<number>();
  if (!xml) return out;
  const custom = new Set<number>();
  for (const m of xml.matchAll(/<numFmt\s+[^>]*numFmtId="(\d+)"[^>]*formatCode="([^"]*)"/g)) {
    const code = decodeEntities(m[2]!).replace(/"[^"]*"|\[[^\]]*\]|\\.|_.|\*./g, '');
    if (/[dmyh]/i.test(code) && !/^[#0.,%$\s-]*$/.test(code)) custom.add(Number(m[1]));
  }
  const xfs = xml.match(/<cellXfs[^>]*>([\s\S]*?)<\/cellXfs>/)?.[1] ?? '';
  let i = 0;
  for (const m of xfs.matchAll(/<xf\b([^>]*?)(?:\/>|>)/g)) {
    const id = Number(m[1]!.match(/numFmtId="(\d+)"/)?.[1] ?? 0);
    if (BUILTIN_DATE.has(id) || custom.has(id)) out.add(i);
    i++;
  }
  return out;
}

function serialToIso(serial: number): string {
  const ms = Math.round((serial - 25569) * 86_400_000); // 25569 = days from 1900-01-00 to 1970-01-01
  const d = new Date(ms);
  return Number.isNaN(d.getTime()) ? String(serial) : d.toISOString().slice(0, 10);
}

/** Rows of text cells from the first worksheet. Throws XlsxError if the file is not a readable workbook. */
export function readXlsx(bytes: Uint8Array): string[][] {
  try {
    const files = zipEntries(Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength));
    const get = (name: string) => files.get(name)?.().toString('utf8') ?? null;

    // Find the first sheet's file through the workbook relationships; fall back to the conventional name.
    let sheetPath = 'xl/worksheets/sheet1.xml';
    const wb = get('xl/workbook.xml');
    const rels = get('xl/_rels/workbook.xml.rels');
    const rid = wb?.match(/<sheet\b[^>]*r:id="([^"]+)"/)?.[1];
    if (rid && rels) {
      for (const m of rels.matchAll(/<Relationship\b([^>]*)>/g)) {
        if (m[1]!.includes(`Id="${rid}"`)) {
          const t = m[1]!.match(/Target="([^"]+)"/)?.[1];
          if (t) sheetPath = t.startsWith('/') ? t.slice(1) : `xl/${t}`;
        }
      }
    }
    const sheet = get(sheetPath);
    if (!sheet) throw new XlsxError('no worksheet');

    const shared: string[] = [];
    const ss = get('xl/sharedStrings.xml');
    if (ss) for (const m of ss.matchAll(/<si\b[^>]*>([\s\S]*?)<\/si>/g)) shared.push(textOf(m[1]!.replace(/<rPh\b[\s\S]*?<\/rPh>/g, '')));
    const dates = dateStyles(get('xl/styles.xml'));

    const rows: string[][] = [];
    let rowNo = 0;
    for (const r of sheet.matchAll(/<row\b([^>]*?)(?:\/>|>([\s\S]*?)<\/row>)/g)) {
      const explicit = Number(r[1]!.match(/\br="(\d+)"/)?.[1] ?? 0);
      rowNo = explicit > 0 ? explicit : rowNo + 1;
      if (rowNo > MAX_ROWS) throw new XlsxError('too many rows');
      const cells: string[] = [];
      let next = 0;
      for (const c of (r[2] ?? '').matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
        const attrs = c[1]!;
        const ref = attrs.match(/\br="([A-Z]+\d+)"/)?.[1];
        const col = ref ? colIndex(ref) : next;
        if (col >= MAX_COLS) continue;
        next = col + 1;
        const type = attrs.match(/\bt="(\w+)"/)?.[1] ?? 'n';
        const style = Number(attrs.match(/\bs="(\d+)"/)?.[1] ?? 0);
        const inner = c[2] ?? '';
        const v = inner.match(/<v>([\s\S]*?)<\/v>/)?.[1];
        let value = '';
        if (type === 's') value = shared[Number(v)] ?? '';
        else if (type === 'inlineStr') value = textOf(inner);
        else if (type === 'str' || type === 'e') value = v === undefined ? '' : decodeEntities(v);
        else if (type === 'b') value = v === '1' ? 'TRUE' : 'FALSE';
        else if (v !== undefined) value = dates.has(style) && Number.isFinite(Number(v)) ? serialToIso(Number(v)) : decodeEntities(v);
        while (cells.length < col) cells.push('');
        cells[col] = value;
      }
      while (rows.length < rowNo - 1) rows.push([]);
      rows[rowNo - 1] = cells;
    }
    return rows;
  } catch (e) {
    if (e instanceof XlsxError) throw e;
    throw new XlsxError('unreadable workbook');
  }
}
