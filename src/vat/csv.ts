/** Reads CSV text into rows of cells. Handles quoted cells, doubled quotes, line breaks inside quotes, and , ; or tab separators. */

export function detectDelimiter(text: string): string {
  const firstLine = text.split(/\r?\n/, 1)[0] ?? '';
  let best = ',', bestCount = 0;
  for (const d of [',', ';', '\t']) {
    let n = 0, inQ = false;
    for (const ch of firstLine) { if (ch === '"') inQ = !inQ; else if (ch === d && !inQ) n++; }
    if (n > bestCount) { best = d; bestCount = n; }
  }
  return best;
}

export function parseCsv(text: string, maxRows = 50_001): string[][] {
  const delim = detectDelimiter(text);
  const rows: string[][] = [];
  let row: string[] = [], cell = '', inQ = false;
  const endRow = () => { row.push(cell); cell = ''; rows.push(row); row = []; };
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (inQ) {
      if (ch === '"') { if (text[i + 1] === '"') { cell += '"'; i++; } else inQ = false; }
      else cell += ch;
    } else if (ch === '"' && cell === '') inQ = true;
    else if (ch === delim) { row.push(cell); cell = ''; }
    else if (ch === '\n') { endRow(); if (rows.length > maxRows) return rows; }
    else if (ch === '\r') { if (text[i + 1] === '\n') i++; endRow(); if (rows.length > maxRows) return rows; }
    else cell += ch;
  }
  if (cell !== '' || row.length > 0) endRow();
  return rows;
}
