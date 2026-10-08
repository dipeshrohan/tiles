import { test } from 'vitest';
import assert from 'node:assert/strict';
import { detectDelimiter, parseCsv } from '../js/lib/csv.ts';
import {
  guessTimeFormat,
  inBatches,
  isoTime,
  mappingProblems,
  parseNumber,
  parseTime,
  readings,
  slugTag,
  suggestMapping,
  summarize,
  zonedTime,
} from '../js/lib/importer.ts';

const NOW = Date.parse('2026-10-08T12:00:00Z');

test('CSV fields may be quoted, hold delimiters, quotes and line breaks', () => {
  const text =
    '\uFEFFtime,"Press 1, Temp","Note"\r\n2026-10-01 08:00,21.5,"said ""ok""\nthen left"\r\n\r\n2026-10-01 08:01,,x\n';
  assert.deepEqual(parseCsv(text), [
    ['time', 'Press 1, Temp', 'Note'],
    ['2026-10-01 08:00', '21.5', 'said "ok"\nthen left'],
    ['2026-10-01 08:01', '', 'x'],
  ]);
  assert.deepEqual(parseCsv('a;b\n1,5;2'), [
    ['a', 'b'],
    ['1,5', '2'],
  ]);
  assert.equal(detectDelimiter('Zeit;Temp;"a;b"\n'), ';');
  assert.equal(detectDelimiter('time\ttemp\n'), '\t');
  assert.equal(detectDelimiter('"a,b";c\n'), ';'); // commas inside quotes don't count
  assert.equal(detectDelimiter('"Temp\nin °C";"Druck, bar";Zeit\n1;2;3\n'), ';'); // a header spanning lines
  assert.deepEqual(parseCsv('a,b'), [['a', 'b']]); // no final line break
});

test('column and tag names become signal tags', () => {
  assert.equal(slugTag('Press 1 Temp [°C]'), 'press-1-temp-c');
  assert.equal(slugTag('  Drücke_Ölpumpe.PV '), 'drucke_olpumpe.pv');
  assert.equal(slugTag('TT-101'), 'tt-101');
  assert.equal(slugTag('---'), null);
  assert.equal(slugTag('x'.repeat(300)).length, 128);
});

test('numbers, with a decimal point or comma', () => {
  assert.equal(parseNumber(' 21.5 ', false), 21.5);
  assert.equal(parseNumber('-1e3', false), -1000);
  assert.equal(parseNumber('21,5', false), null);
  assert.equal(parseNumber('21,5', true), 21.5);
  assert.equal(parseNumber('Bad', false), null);
  assert.equal(parseNumber('', false), null);
  assert.equal(parseNumber('1e999', false), null);
});

test('times in each format, with or without an offset', () => {
  const at = (s, f, z = 'UTC') => {
    const t = parseTime(s, f, z);
    return t === null ? null : new Date(t).toISOString();
  };
  assert.equal(at('2026-10-01T08:00:00Z', 'iso'), '2026-10-01T08:00:00.000Z');
  assert.equal(at('2026-10-01 08:00:00.250+02:00', 'iso'), '2026-10-01T06:00:00.250Z');
  assert.equal(at('2026-10-01 08:00', 'iso', 'Europe/Berlin'), '2026-10-01T06:00:00.000Z'); // CEST
  assert.equal(at('2026-12-01 08:00', 'iso', 'Europe/Berlin'), '2026-12-01T07:00:00.000Z'); // CET
  assert.equal(at('2026-10-01', 'iso', 'America/New_York'), '2026-10-01T04:00:00.000Z');
  assert.equal(at('01.10.2026 08:00', 'dmy', 'Europe/Berlin'), '2026-10-01T06:00:00.000Z');
  assert.equal(at('10/01/2026 08:00:30', 'mdy'), '2026-10-01T08:00:30.000Z');
  assert.equal(at('1790000000', 'epoch-s'), '2026-09-21T14:13:20.000Z');
  assert.equal(at('1790000000123', 'epoch-ms'), '2026-09-21T14:13:20.123Z');
  // Offsets that aren't offsets are refused, not applied.
  assert.equal(at('2026-10-01T08:00+24:00', 'iso'), null);
  assert.equal(at('2026-10-01T08:00+00:99', 'iso'), null);
  // Impossible dates and times are refused, not rolled over.
  assert.equal(at('2026-02-30 08:00', 'iso'), null);
  assert.equal(at('31.04.2026', 'dmy'), null);
  assert.equal(at('2026-10-01 25:00', 'iso'), null);
  assert.equal(at('yesterday', 'iso'), null);
});

test('times keep microseconds, so close readings stay apart', () => {
  const t1 = parseTime('2026-10-01T08:00:00.0001Z', 'iso', 'UTC');
  const t2 = parseTime('2026-10-01T08:00:00.0004Z', 'iso', 'UTC');
  assert.equal(isoTime(t1), '2026-10-01T08:00:00.000100Z');
  assert.equal(isoTime(t2), '2026-10-01T08:00:00.000400Z');
  assert.equal(
    isoTime(parseTime('01.10.2026 10:00:00.123456789', 'dmy', 'Europe/Berlin')),
    '2026-10-01T08:00:00.123456Z',
  );
  assert.equal(isoTime(parseTime('1790000000.000123', 'epoch-s', 'UTC')), '2026-09-21T14:13:20.000123Z');
  assert.equal(isoTime(Date.UTC(2026, 9, 1) + 0.9996), '2026-10-01T00:00:00.001000Z'); // rounds up across a millisecond
  const rows = [
    ['2026-10-01T08:00:00.0001Z', '1'],
    ['2026-10-01T08:00:00.0004Z', '2'],
  ];
  const m = {
    timeColumn: 0,
    timeFormat: 'iso',
    timeZone: 'UTC',
    decimalComma: false,
    keepText: false,
    columns: { 1: 'v' },
    long: null,
  };
  assert.deepEqual(
    [...readings(rows, m, undefined, NOW)].map((r) => r.at),
    ['2026-10-01T08:00:00.000100Z', '2026-10-01T08:00:00.000400Z'],
  );
});

test('wall-clock times across daylight-saving changes', () => {
  const berlin = (y, mo, d, h, mi) => new Date(zonedTime(Date.UTC(y, mo - 1, d, h, mi), 'Europe/Berlin')).toISOString();
  // Clocks go back on 25 October 2026: 02:30 happens twice; the first is taken.
  assert.equal(berlin(2026, 10, 25, 2, 30), '2026-10-25T00:30:00.000Z');
  assert.equal(berlin(2026, 10, 25, 3, 30), '2026-10-25T02:30:00.000Z');
  // Clocks go forward on 29 March 2026: 02:30 doesn't exist and moves on by the gap.
  assert.equal(berlin(2026, 3, 29, 2, 30), '2026-03-29T01:30:00.000Z');
  assert.equal(berlin(2026, 3, 29, 3, 30), '2026-03-29T01:30:00.000Z');
});

test('the time format is guessed from the cells', () => {
  assert.equal(guessTimeFormat(['2026-10-01T08:00:00Z', '2026-10-01 08:01']), 'iso');
  assert.equal(guessTimeFormat(['25.10.2026 08:00', '01.11.2026 08:00']), 'dmy');
  assert.equal(guessTimeFormat(['10/25/2026 08:00']), 'mdy');
  assert.equal(guessTimeFormat(['1790000000', '1790000060']), 'epoch-s');
  assert.equal(guessTimeFormat(['1790000000000']), 'epoch-ms');
  assert.equal(guessTimeFormat(['21.5', 'x']), null);
});

test('a wide file maps each numeric column to a signal', () => {
  const [header, ...rows] = parseCsv(
    'Timestamp;Press 1 Temp;Press 1 State;Comment\n01.10.2026 08:00;21,5;1;ok\n01.10.2026 08:01;22,0;1;\n',
  );
  const m = suggestMapping(header, rows, 'Europe/Berlin');
  assert.deepEqual(
    { ...m, long: m.long },
    {
      timeColumn: 0,
      timeFormat: 'dmy',
      timeZone: 'Europe/Berlin',
      decimalComma: true,
      keepText: false,
      columns: { 1: 'press-1-temp', 2: 'press-1-state' },
      long: null,
    },
  );
  assert.deepEqual(mappingProblems(header, m), []);
  assert.deepEqual(
    [...readings(rows, m, undefined, NOW)],
    [
      { signal: 'press-1-temp', at: '2026-10-01T06:00:00.000000Z', value: 21.5 },
      { signal: 'press-1-state', at: '2026-10-01T06:00:00.000000Z', value: 1 },
      { signal: 'press-1-temp', at: '2026-10-01T06:01:00.000000Z', value: 22 },
      { signal: 'press-1-state', at: '2026-10-01T06:01:00.000000Z', value: 1 },
    ],
  );
});

test('a historian export maps each row by its tag', () => {
  const [header, ...rows] = parseCsv(
    'TagName,TimeStamp,Value\nTT-101,2026-10-01T08:00:00Z,21.5\nPT-7,2026-10-01T08:00:00Z,3.5\nTT-101,2026-10-01T08:01:00Z,Bad\n???,2026-10-01T08:01:00Z,1\n',
  );
  const m = suggestMapping(header, rows, 'UTC');
  assert.deepEqual(m.long, { tagColumn: 0, valueColumn: 2 });
  assert.equal(m.timeColumn, 1);
  const stats = summarize(rows, m, NOW);
  assert.equal(stats.readings, 2);
  assert.deepEqual([...stats.signals], ['tt-101', 'pt-7']);
  assert.deepEqual(stats.skipped, { 'not a number': 1, 'unusable tag': 1 });
  assert.deepEqual(stats.examples[0], { row: 4, message: 'not a number: “Bad” in tt-101' });
  assert.equal(summarize(rows, { ...m, keepText: true }, NOW).readings, 3); // "Bad" kept as text
});

test('two historian tags that become one signal name are not merged', () => {
  const header = ['tag', 'time', 'value'];
  const rows = [
    ['TT 101', '2026-10-01T08:00:00Z', '1'],
    ['TT-101', '2026-10-01T08:00:00Z', '2'],
    ['TT 101', '2026-10-01T08:01:00Z', '3'],
  ];
  const m = suggestMapping(header, rows, 'UTC');
  const stats = summarize(rows, m, NOW);
  assert.equal(stats.readings, 2);
  assert.deepEqual(stats.skipped, { 'tag that clashes with another': 1 });
  assert.deepEqual(stats.examples[0], {
    row: 3,
    message: 'tag that clashes with another: “TT-101” and “TT 101” both become tt-101',
  });
  assert.deepEqual(mappingProblems(header, { ...m, long: { tagColumn: 0, valueColumn: -1 } }), [
    'Choose the tag column and the value column.',
  ]);
  assert.deepEqual(mappingProblems(header, { ...m, long: { tagColumn: 0, valueColumn: 3 } }), [
    'Choose the tag column and the value column.',
  ]);
});

test('rows that cannot be read are skipped and counted, not guessed', () => {
  const header = ['time', 'v'];
  const rows = [
    ['', '1'],
    ['soon', '2'],
    ['2026-10-20T00:00:00Z', '3'],
    ['2026-10-01T00:00:00Z', '9007199254740993'],
    ['2026-10-01T00:00:00Z', '4'],
  ];
  const m = {
    timeColumn: 0,
    timeFormat: 'iso',
    timeZone: 'UTC',
    decimalComma: false,
    keepText: false,
    columns: { 1: 'v' },
    long: null,
  };
  const stats = summarize(rows, m, NOW);
  assert.equal(stats.readings, 1);
  assert.deepEqual(stats.skipped, {
    'no time': 1,
    'unreadable time': 1,
    'time in the future': 1,
    'number too large to store exactly': 1,
  });
  assert.deepEqual([stats.first, stats.last], ['2026-10-01T00:00:00.000000Z', '2026-10-01T00:00:00.000000Z']);
  assert.deepEqual(mappingProblems(header, { ...m, columns: { 1: 'Bad Tag' } }), [
    '“Bad Tag”: signal names use lower-case letters, digits, dot, dash and underscore.',
  ]);
  assert.deepEqual(mappingProblems(header, { ...m, columns: {} }), ['Choose at least one column to import.']);
  assert.match(mappingProblems(header, { ...m, timeZone: 'Mars/Base' })[0], /isn't a time zone/);
});

test('readings go out in batches', () => {
  const batches = [...inBatches([1, 2, 3, 4, 5][Symbol.iterator](), 2)];
  assert.deepEqual(batches, [[1, 2], [3, 4], [5]]);
  assert.deepEqual([...inBatches([][Symbol.iterator](), 2)], []);
});

test('the import page loads a file, describes what it would import, and lists past imports', async () => {
  const { load, describeStats, historyTable } = await import('../js/views/imports.ts');
  assert.match(load('empty.csv', 'time\n'), /needs a header row and at least one data row/);
  const l = load('line.csv', 'time,temp\n2026-10-01T08:00:00Z,21.5\n', 'UTC');
  assert.deepEqual(l.mapping.columns, { 1: 'temp' });
  assert.equal(
    describeStats(summarize(l.rows, l.mapping, NOW)),
    '1 readings for 1 signal(s) in 1 rows from 2026-10-01 08:00:00 to 2026-10-01 08:00:00 UTC.',
  );
  assert.equal(historyTable([]), '<p class="small soft">No imports on this site yet.</p>');
  const html = historyTable([
    {
      id: 'i',
      name: '<b>x</b>.csv',
      created_by: 'eng',
      created_at: '2026-10-08T08:00:00Z',
      received: 1200,
      stored: 1000,
      finished_at: null,
    },
  ]);
  assert.match(html, /&lt;b&gt;x&lt;\/b&gt;\.csv/); // escaped
  assert.match(html, /not finished/);
});
