// CSV as historians and spreadsheets write it (RFC 4180): quoted fields may hold
// the delimiter, line breaks and doubled quotes. No dependencies, so the browser
// app stays free of runtime packages.

export type Delimiter = ',' | ';' | '\t';

// The delimiter that splits the first line into the most fields (outside quotes).
// European exports often use ';' because ',' is their decimal separator.
export function detectDelimiter(text: string): Delimiter {
  const body = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text; // a byte-order mark
  const firstLine = body.split(/\r?\n/, 1)[0] ?? '';
  let best: Delimiter = ',';
  let bestCount = 0;
  for (const d of [',', ';', '\t'] as const) {
    let count = 0;
    let quoted = false;
    for (const ch of firstLine) {
      if (ch === '"') quoted = !quoted;
      else if (ch === d && !quoted) count++;
    }
    if (count > bestCount) [best, bestCount] = [d, count];
  }
  return best;
}

// Rows of fields. A byte-order mark is dropped, blank lines are skipped, and an
// unclosed quote runs to the end of the text (as spreadsheets read it).
export function parseCsv(text: string, delimiter: Delimiter = detectDelimiter(text)): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;
  let i = text.charCodeAt(0) === 0xfeff ? 1 : 0;
  const endRow = () => {
    row.push(cell);
    if (row.length > 1 || row[0] !== '') rows.push(row);
    row = [];
    cell = '';
  };
  for (; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          cell += '"';
          i++;
        } else quoted = false;
      } else cell += ch;
    } else if (ch === '"' && cell === '') quoted = true;
    else if (ch === delimiter) {
      row.push(cell);
      cell = '';
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      endRow();
    } else cell += ch;
  }
  if (cell !== '' || row.length) endRow();
  return rows;
}
