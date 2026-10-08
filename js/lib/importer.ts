// Bulk import (T2.07): turns a parsed CSV or historian export into readings for
// the Tiles API, given how its columns map to signals. Pure logic, no DOM.
//
// Two shapes are common:
// - wide: one row per time, one column per signal (spreadsheets, most exports);
// - long: one row per reading, with the tag and the value in their own columns
//   (historian exports such as PI or Canary).
// Times are ISO 8601, day-first or month-first dates, or epoch seconds or
// milliseconds. Times written without an offset are in the chosen time zone.

export type TimeFormat = 'iso' | 'dmy' | 'mdy' | 'epoch-s' | 'epoch-ms';

export interface ImportMapping {
  timeColumn: number;
  timeFormat: TimeFormat;
  timeZone: string; // IANA, e.g. Europe/Berlin; for times without an offset
  decimalComma: boolean; // 21,5 rather than 21.5
  keepText: boolean; // keep text cells as text readings, rather than skipping them
  // wide: column index -> signal tag (columns left out are not imported)
  columns: Record<number, string>;
  // long: where the tag and the value are
  long: { tagColumn: number; valueColumn: number } | null;
}

export interface Reading {
  signal: string;
  at: string; // ISO 8601, UTC
  value: number | string;
}

// What a pass over the rows found; problems are counted by reason, with a few examples.
export interface ImportStats {
  readings: number;
  rows: number;
  signals: Set<string>;
  first: string | null;
  last: string | null;
  skipped: Record<string, number>;
  examples: { row: number; message: string }[];
  // long: the raw tag each signal name came from, to catch two tags that become one name
  tagSources: Map<string, string>;
}

export const TAG_PATTERN = /^[a-z0-9][a-z0-9._-]{0,127}$/;
const MAX_TEXT = 1000;
const MAX_AHEAD_MS = 24 * 3600 * 1000; // the API refuses readings stamped further ahead
const MAX_EXAMPLES = 5;

// A signal tag from a column or tag name: "Press 1 Temp [°C]" -> "press-1-temp-c".
export function slugTag(name: string): string | null {
  const tag = name
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^[^a-z0-9]+/, '')
    .replace(/-+$/, '')
    .slice(0, 128)
    .replace(/-+$/, '');
  return TAG_PATTERN.test(tag) ? tag : null;
}

// ---- values -----------------------------------------------------------------

const NUMBER = /^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/;
const COMMA_NUMBER = /^[+-]?(\d+(,\d*)?|,\d+)([eE][+-]?\d+)?$/;

// A cell as a number, or null if it isn't one.
export function parseNumber(cell: string, decimalComma: boolean): number | null {
  const s = cell.trim();
  if (decimalComma ? !COMMA_NUMBER.test(s) : !NUMBER.test(s)) return null;
  const n = Number(decimalComma ? s.replace(',', '.') : s);
  return Number.isFinite(n) ? n : null;
}

// ---- times ------------------------------------------------------------------

const formatters = new Map<string, Intl.DateTimeFormat>();

function formatter(zone: string): Intl.DateTimeFormat {
  let f = formatters.get(zone);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone: zone,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
    formatters.set(zone, f);
  }
  return f;
}

export function isTimeZone(zone: string): boolean {
  try {
    formatter(zone);
    return true;
  } catch {
    return false;
  }
}

// How far `zone` is ahead of UTC at the instant `utcMs`, in milliseconds.
function zoneOffset(utcMs: number, zone: string): number {
  const parts: Record<string, number> = {};
  for (const p of formatter(zone).formatToParts(new Date(utcMs))) if (p.type !== 'literal') parts[p.type] = +p.value;
  const wall = Date.UTC(parts.year ?? 0, (parts.month ?? 1) - 1, parts.day, parts.hour, parts.minute, parts.second);
  return wall - Math.floor(utcMs / 1000) * 1000;
}

// The instant a wall-clock time in `zone` refers to. In the hour a clock goes back, the
// earlier of the two instants; a time skipped when it goes forward moves on by the gap.
export function zonedTime(wall: number, zone: string): number {
  const day = 24 * 3600 * 1000;
  // The offsets in force a day either side cover any single change around `wall`.
  const offsets = [zoneOffset(wall - day, zone), zoneOffset(wall + day, zone)];
  const valid = offsets.map((o) => wall - o).filter((t) => wall - zoneOffset(t, zone) === t);
  // No valid instant: `wall` fell in a gap; read it with the offset from before the change.
  return valid.length ? Math.min(...valid) : wall - (offsets[0] ?? 0);
}

const ISO =
  /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2})(?:[.,](\d{1,9}))?)?)?\s*(Z|[+-]\d{2}(?::?\d{2})?)?$/i;
const DAY_MONTH = /^(\d{1,2})[./-](\d{1,2})[./-](\d{4})(?:[ T](\d{1,2}):(\d{2})(?::(\d{2})(?:[.,](\d{1,9}))?)?)?$/;

// Times keep microseconds, the database's own precision: historian exports often have them,
// and rounding to milliseconds would merge readings. Finer digits are dropped.
function wallClock(y: number, mo: number, d: number, h: number, mi: number, s: number, frac: string): number | null {
  const micros = Number(frac.padEnd(6, '0').slice(0, 6));
  const t = Date.UTC(y, mo - 1, d, h, mi, s, Math.floor(micros / 1000));
  const back = new Date(t);
  // Reject 31.02. or 25:00, which Date.UTC would quietly roll over.
  if (back.getUTCFullYear() !== y || back.getUTCMonth() !== mo - 1 || back.getUTCDate() !== d) return null;
  if (h > 23 || mi > 59 || s > 59) return null;
  return t + (micros % 1000) / 1000;
}

// An instant (milliseconds, with microseconds as the fraction) as ISO 8601 in UTC, always with
// six fractional digits, so the strings also sort in time order.
export function isoTime(t: number): string {
  let whole = Math.floor(t);
  let micros = Math.round((t - whole) * 1000);
  if (micros === 1000) [whole, micros] = [whole + 1, 0];
  return `${new Date(whole).toISOString().slice(0, -1)}${String(micros).padStart(3, '0')}Z`;
}

// A cell as an instant (milliseconds since the epoch, UTC, with microseconds as the fraction),
// or null if it isn't a time in this format.
export function parseTime(cell: string, format: TimeFormat, zone: string): number | null {
  const s = cell.trim();
  if (format === 'epoch-s' || format === 'epoch-ms') {
    const n = parseNumber(s, false);
    if (n === null) return null;
    const t = format === 'epoch-s' ? n * 1000 : n;
    return Math.abs(t) < 8.64e15 ? Math.round(t * 1000) / 1000 : null;
  }
  if (format === 'iso') {
    const m = ISO.exec(s);
    if (!m) return null;
    const [, y, mo, d, h = '0', mi = '0', sec = '0', frac = '', offset] = m;
    const wall = wallClock(+(y ?? 0), +(mo ?? 0), +(d ?? 0), +h, +mi, +sec, frac);
    if (wall === null) return null;
    if (!offset) return zonedTime(wall, zone);
    if (offset.toUpperCase() === 'Z') return wall;
    const sign = offset.startsWith('-') ? -1 : 1;
    const digits = offset.slice(1).replace(':', '');
    const [hours, minutes] = [Number(digits.slice(0, 2)), Number(digits.slice(2, 4) || 0)];
    if (hours > 23 || minutes > 59) return null; // +24:00 or +00:99 is no offset
    return wall - sign * (hours * 60 + minutes) * 60_000;
  }
  const m = DAY_MONTH.exec(s);
  if (!m) return null;
  const [, a = '', b = '', y = '', h = '0', mi = '0', sec = '0', frac = ''] = m;
  const [d, mo] = format === 'dmy' ? [+a, +b] : [+b, +a];
  const wall = wallClock(+y, mo, d, +h, +mi, +sec, frac);
  return wall === null ? null : zonedTime(wall, zone);
}

// The format that reads every one of these cells, preferring ISO and day-first dates.
export function guessTimeFormat(cells: string[]): TimeFormat | null {
  const filled = cells.map((c) => c.trim()).filter(Boolean);
  if (!filled.length) return null;
  const reads = (f: TimeFormat) => filled.every((c) => parseTime(c, f, 'UTC') !== null);
  if (reads('iso')) return 'iso';
  if (reads('dmy')) return 'dmy';
  if (reads('mdy')) return 'mdy';
  // Epoch: seconds are 10 digits these days, milliseconds 13.
  if (filled.every((c) => /^\d{9,11}(\.\d+)?$/.test(c))) return 'epoch-s';
  if (filled.every((c) => /^\d{12,14}$/.test(c))) return 'epoch-ms';
  return null;
}

// ---- mapping ----------------------------------------------------------------

const TAG_NAMES = /^(tag|tagname|tag name|name|signal|point|item|variable)$/i;
const VALUE_NAMES = /^(value|val|wert|valeur|reading)$/i;

// A first guess at the mapping, for the person to check: the first column that reads as
// times is the time; a tag and a value column make it a long export, otherwise each
// mostly numeric column becomes a signal.
export function suggestMapping(header: string[], rows: string[][], timeZone: string): ImportMapping {
  const sample = rows.slice(0, 50);
  const column = (i: number) => sample.map((r) => r[i] ?? '');
  // Dates beat epoch numbers: a column of plain numbers could be anything.
  const formats = header.map((_, i) => guessTimeFormat(column(i)));
  const dated = formats.findIndex((f) => f === 'iso' || f === 'dmy' || f === 'mdy');
  const timeColumn =
    dated >= 0
      ? dated
      : Math.max(
          0,
          formats.findIndex((f) => f !== null),
        );
  const timeFormat: TimeFormat = formats[timeColumn] ?? 'iso';
  const commaNumbers = sample.some((r) => r.some((c, i) => i !== timeColumn && /^[+-]?\d+,\d+$/.test(c.trim())));
  const tagColumn = header.findIndex((h, i) => i !== timeColumn && TAG_NAMES.test(h.trim()));
  const valueColumn = header.findIndex((h, i) => i !== timeColumn && VALUE_NAMES.test(h.trim()));
  const base = { timeColumn, timeFormat, timeZone, decimalComma: commaNumbers, keepText: false };
  if (tagColumn >= 0 && valueColumn >= 0) return { ...base, columns: {}, long: { tagColumn, valueColumn } };
  const columns: Record<number, string> = {};
  header.forEach((h, i) => {
    if (i === timeColumn) return;
    const cells = column(i).filter((c) => c.trim() !== '');
    const numeric = cells.filter((c) => parseNumber(c, commaNumbers) !== null).length;
    const tag = slugTag(h);
    if (tag && cells.length && numeric / cells.length >= 0.5) columns[i] = tag;
  });
  return { ...base, columns, long: null };
}

// Problems with the mapping itself, before any row is read.
export function mappingProblems(header: string[], m: ImportMapping): string[] {
  const problems: string[] = [];
  if (!(m.timeColumn >= 0 && m.timeColumn < header.length)) problems.push('Choose the column with the times.');
  if (!isTimeZone(m.timeZone)) problems.push(`“${m.timeZone}” isn't a time zone, e.g. UTC or Europe/Berlin.`);
  if (m.long) {
    const { tagColumn, valueColumn } = m.long;
    const inFile = (i: number) => i >= 0 && i < header.length;
    if (!inFile(tagColumn) || !inFile(valueColumn)) problems.push('Choose the tag column and the value column.');
    else if (new Set([m.timeColumn, tagColumn, valueColumn]).size < 3)
      problems.push('The time, tag and value columns must be three different columns.');
  } else {
    const tags = Object.values(m.columns);
    if (!tags.length) problems.push('Choose at least one column to import.');
    const bad = tags.filter((t) => !TAG_PATTERN.test(t));
    if (bad.length)
      problems.push(
        `${bad.map((t) => `“${t}”`).join(', ')}: signal names use lower-case letters, digits, dot, dash and underscore.`,
      );
    if (new Set(tags).size < tags.length) problems.push('Two columns map to the same signal.');
  }
  return problems;
}

function emptyStats(): ImportStats {
  return {
    readings: 0,
    rows: 0,
    signals: new Set(),
    first: null,
    last: null,
    skipped: {},
    examples: [],
    tagSources: new Map(),
  };
}

// The readings in `rows` (data rows, without the header), in file order. `stats` counts what
// was read and what was skipped, and why; `now` is for spotting times from a wrong clock.
export function* readings(
  rows: string[][],
  m: ImportMapping,
  stats: ImportStats = emptyStats(),
  now: number = Date.now(),
): Generator<Reading, ImportStats> {
  const skip = (row: number, reason: string, detail: string) => {
    stats.skipped[reason] = (stats.skipped[reason] ?? 0) + 1;
    if (stats.examples.length < MAX_EXAMPLES) stats.examples.push({ row, message: `${reason}: ${detail}` });
  };
  for (let r = 0; r < rows.length; r++) {
    const row = rows[r] ?? [];
    const line = r + 2; // the header is line 1
    stats.rows++;
    const timeCell = row[m.timeColumn] ?? '';
    if (!timeCell.trim()) {
      skip(line, 'no time', 'the time cell is empty');
      continue;
    }
    const t = parseTime(timeCell, m.timeFormat, m.timeZone);
    if (t === null) {
      skip(line, 'unreadable time', `“${timeCell}”`);
      continue;
    }
    if (t > now + MAX_AHEAD_MS) {
      skip(line, 'time in the future', `“${timeCell}”`);
      continue;
    }
    const at = isoTime(t);
    const cells: [string, string][] = m.long
      ? (() => {
          const raw = row[m.long.tagColumn] ?? '';
          const tag = slugTag(raw);
          if (!tag) {
            skip(line, 'unusable tag', `“${raw}”`);
            return [];
          }
          // TT 101 and TT-101 both become tt-101: the first one seen keeps the name, and the
          // other is skipped rather than merged into it.
          const source = stats.tagSources.get(tag);
          if (source === undefined) stats.tagSources.set(tag, raw);
          else if (source !== raw) {
            skip(line, 'tag that clashes with another', `“${raw}” and “${source}” both become ${tag}`);
            return [];
          }
          return [[tag, row[m.long.valueColumn] ?? '']];
        })()
      : Object.entries(m.columns).map(([i, tag]) => [tag, row[+i] ?? '']);
    for (const [signal, cell] of cells) {
      if (cell.trim() === '') continue; // no reading for this signal at this time
      let value: number | string | null = parseNumber(cell, m.decimalComma);
      if (value === null) {
        if (!m.keepText) {
          skip(line, 'not a number', `“${cell.slice(0, 40)}” in ${signal}`);
          continue;
        }
        value = cell.trim();
        if (value.length > MAX_TEXT || value.includes('\0')) {
          skip(line, 'text too long or not plain', `in ${signal}`);
          continue;
        }
      } else if (Number.isInteger(value) && !Number.isSafeInteger(value)) {
        // Beyond 2^53 a double can't tell neighbouring integers apart: 2^53 + 1 reads as 2^53.
        skip(line, 'number too large to store exactly', `${cell} in ${signal}`);
        continue;
      }
      stats.readings++;
      stats.signals.add(signal);
      if (stats.first === null || at < stats.first) stats.first = at;
      if (stats.last === null || at > stats.last) stats.last = at;
      yield { signal, at, value };
    }
  }
  return stats;
}

// One pass without keeping the readings: what an import would do.
export function summarize(rows: string[][], m: ImportMapping, now: number = Date.now()): ImportStats {
  const stats = emptyStats();
  for (const _ of readings(rows, m, stats, now)) void _;
  return stats;
}

// Takes up to `size` items at a time from an iterator.
export function* inBatches<T>(items: Iterator<T>, size: number): Generator<T[]> {
  let batch: T[] = [];
  for (let next = items.next(); !next.done; next = items.next()) {
    batch.push(next.value);
    if (batch.length === size) {
      yield batch;
      batch = [];
    }
  }
  if (batch.length) yield batch;
}
