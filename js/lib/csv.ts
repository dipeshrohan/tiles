// CSV as historians and spreadsheets write it (RFC 4180): quoted fields may hold
// the delimiter, line breaks and doubled quotes. No dependencies, so the browser
// app stays free of runtime packages.

export type Delimiter = ',' | ';' | '\t';

// The delimiter that splits the first record into the most fields (outside quotes).
// European exports often use ';' because ',' is their decimal separator.
export function detectDelimiter(text: string): Delimiter {
  // The first record: up to the first line break outside quotes (a quoted header may span lines).
  let quoted = false;
  let end = 0;
  for (; end < text.length; end++) {
    const ch = text[end];
    if (ch === '"') quoted = !quoted;
    else if ((ch === '\n' || ch === '\r') && !quoted) break;
  }
  const first = text.slice(0, end);
  let best: Delimiter = ',';
  let bestCount = 0;
  for (const d of [',', ';', '\t'] as const) {
    let count = 0;
    let inside = false;
    for (const ch of first) {
      if (ch === '"') inside = !inside;
      else if (ch === d && !inside) count++;
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
