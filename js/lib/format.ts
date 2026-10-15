// Numbers, dates and times as the person's language writes them (U6.02), all from `Intl`, with no
// dependency: 12,480.5 in English is 12.480,5 in German. Times are shown in the site's time zone
// (the API's `timezone`, set when a site opens; this browser's without one), with the zone named,
// so a shift lead in another country reads the plant's own clock. Units stay SI symbols after the
// number (writing.md): only the number is written the language's way.
//
// Imports nothing: i18n.ts sets the language here (setLocale), and dom.ts's fmt() uses number().
// Nothing else in js/ may write a number or a date with a fixed locale (scripts/check-format.js).

// The catalogue's language → how its numbers and dates are written (English as en-GB, writing.md).
const REGION: Readonly<Record<string, string>> = { en: 'en-GB', 'en-XA': 'en-GB' }; // en-XA: the pseudo-locale

let locale = 'en-GB';
let zone: string | undefined; // undefined: this browser's own

const supported = (code: string): boolean => {
  try {
    return Intl.NumberFormat.supportedLocalesOf([code]).length > 0;
  } catch {
    return false;
  }
};

// The language numbers and dates are written in: a catalogue's code (`en`, `de`) or a full one.
export function setFormatLocale(code: string): void {
  const full = REGION[code] ?? code;
  locale = supported(full) ? full : 'en-GB';
  formats.clear();
}
export const formatLocale = (): string => locale;

// The zone times are shown in: an IANA name (Europe/Berlin), or null for this browser's.
export function setTimeZone(name: string | null | undefined): void {
  let next: string | undefined;
  try {
    next = name ? new Intl.DateTimeFormat('en', { timeZone: name }).resolvedOptions().timeZone : undefined;
  } catch {
    next = undefined; // not a zone this browser knows: its own instead
  }
  if (next !== zone) formats.clear();
  zone = next;
}
export const timeZone = (): string => zone ?? new Intl.DateTimeFormat().resolvedOptions().timeZone;

// One formatter per kind, language, zone and options: making them is the slow part.
const formats = new Map<string, Intl.NumberFormat | Intl.DateTimeFormat | Intl.RelativeTimeFormat>();
function cached<F extends Intl.NumberFormat | Intl.DateTimeFormat | Intl.RelativeTimeFormat>(
  kind: string,
  options: object,
  make: () => F,
): F {
  const key = `${kind}|${locale}|${zone ?? ''}|${JSON.stringify(options)}`;
  let f = formats.get(key) as F | undefined;
  if (!f) formats.set(key, (f = make()));
  return f;
}
const numbers = (o: Intl.NumberFormatOptions) => cached('n', o, () => new Intl.NumberFormat(locale, o));
const dates = (o: Intl.DateTimeFormatOptions) =>
  cached('d', o, () => new Intl.DateTimeFormat(locale, { ...o, ...(zone ? { timeZone: zone } : {}) }));

const NOT_A_NUMBER = '–';

// A number with exactly `digits` decimals: 12,480.5 (en), 12.480,5 (de).
export function number(n: number, digits = 0): string {
  return Number.isFinite(n)
    ? numbers({ minimumFractionDigits: digits, maximumFractionDigits: digits }).format(n)
    : NOT_A_NUMBER;
}

// A number with at most `digits` decimals: 2.5, 3 (no trailing zeros).
export function upTo(n: number, digits: number): string {
  return Number.isFinite(n) ? numbers({ maximumFractionDigits: digits }).format(n) : NOT_A_NUMBER;
}

// A number to `digits` significant figures: 0.00123, 1,230.
export function significant(n: number, digits = 3): string {
  return Number.isFinite(n) ? numbers({ maximumSignificantDigits: digits }).format(n) : NOT_A_NUMBER;
}

// A share (0.242) as a percentage: 24.2% (en), 24,2 % (de).
export function percent(share: number, digits = 0): string {
  return Number.isFinite(share)
    ? numbers({ style: 'percent', minimumFractionDigits: digits, maximumFractionDigits: digits }).format(share)
    : NOT_A_NUMBER;
}

const SECOND = 1000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

// A length of time in the largest unit that keeps it readable (writing.md): 2.5 s, 45 s, 57 min,
// 2 h 10 min, 3 days; SI symbols up to hours, days in the language's word.
export function duration(ms: number): string {
  if (!Number.isFinite(ms)) return NOT_A_NUMBER;
  const sign = ms < 0 ? '−' : '';
  const a = Math.abs(ms);
  // Each unit as it will be rounded, so 59.6 s is "1 min", not "60 s".
  const seconds = a < 10 * SECOND ? Math.round(a / 100) / 10 : Math.round(a / SECOND);
  if (seconds < 60) return `${sign}${upTo(seconds, 1)} s`;
  const minutes = a < 10 * MINUTE ? Math.round(a / (MINUTE / 10)) / 10 : Math.round(a / MINUTE);
  if (minutes < 60) return `${sign}${upTo(minutes, 1)} min`;
  const whole = Math.round(a / MINUTE);
  if (whole < 48 * 60) {
    const [h, m] = [Math.floor(whole / 60), whole % 60];
    return `${sign}${number(h)} h${m ? ` ${number(m)} min` : ''}`;
  }
  return sign + numbers({ style: 'unit', unit: 'day', unitDisplay: 'long' }).format(Math.round(a / DAY));
}

type When = string | number | Date;
const at = (w: When): Date => (w instanceof Date ? w : new Date(w));
const valid = (d: Date): boolean => Number.isFinite(d.getTime());

// A day: 15 Oct 2026 (en), 15. Okt. 2026 (de), in the site's zone.
export function date(w: When): string {
  const d = at(w);
  return valid(d) ? dates({ day: 'numeric', month: 'short', year: 'numeric' }).format(d) : NOT_A_NUMBER;
}

// A day and time with the zone named: 15 Oct 2026, 09:30 CEST. `seconds` for readings.
export function dateTime(w: When, o: { seconds?: boolean; zone?: boolean } = {}): string {
  const d = at(w);
  if (!valid(d)) return NOT_A_NUMBER;
  return dates({
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    ...(o.seconds ? { second: '2-digit' } : {}),
    ...(o.zone === false ? {} : { timeZoneName: 'short' }),
  }).format(d);
}

// A time of day: 09:30 (the zone named only when asked).
export function time(w: When, o: { seconds?: boolean; zone?: boolean } = {}): string {
  const d = at(w);
  if (!valid(d)) return NOT_A_NUMBER;
  return dates({
    hour: '2-digit',
    minute: '2-digit',
    ...(o.seconds ? { second: '2-digit' } : {}),
    ...(o.zone ? { timeZoneName: 'short' } : {}),
  }).format(d);
}

// A month: Oct 2026 (a chart's axis over months).
export function month(w: When): string {
  const d = at(w);
  return valid(d) ? dates({ month: 'short', year: 'numeric' }).format(d) : NOT_A_NUMBER;
}

// A day without the year: 15 Oct (a chart's axis within a year).
export function dayMonth(w: When): string {
  const d = at(w);
  return valid(d) ? dates({ day: 'numeric', month: 'short' }).format(d) : NOT_A_NUMBER;
}

// How long ago (or until): "3 minutes ago", "an hour ago", "yesterday", "in 2 hours"; from a week,
// the date. Each unit takes over where the smaller would round up to it (45 s, 45 min, 22 h).
export function relative(w: When, now: number = Date.now()): string {
  const d = at(w);
  if (!valid(d)) return NOT_A_NUMBER;
  const ms = d.getTime() - now;
  const a = Math.abs(ms);
  const rtf = cached('r', { numeric: 'auto' }, () => new Intl.RelativeTimeFormat(locale, { numeric: 'auto' }));
  if (a < 45 * SECOND) return rtf.format(0, 'second');
  if (a < 45 * MINUTE) return rtf.format(Math.round(ms / MINUTE), 'minute');
  if (a < 22 * HOUR) return rtf.format(Math.round(ms / HOUR), 'hour');
  const days = Math.round(ms / DAY);
  return Math.abs(days) >= 7 ? date(d) : rtf.format(days, 'day');
}

// The hour, minute and second of a time in the site's zone (a chart's ticks fall on midnight).
export function clockOf(w: When): { hour: number; minute: number; second: number } {
  const { hour, minute, second } = zonedParts(w);
  return { hour, minute, second };
}

// A year: 2026 (a chart's axis over years).
export function year(w: When): string {
  const d = at(w);
  return valid(d) ? dates({ year: 'numeric' }).format(d) : NOT_A_NUMBER;
}

// Text sorted as the language sorts it ("Line 2" before "Line 10" with `numeric`).
const collators = new Map<string, Intl.Collator>();
export function textOrder(o: Intl.CollatorOptions = {}): Intl.Collator {
  const key = `${locale}|${JSON.stringify(o)}`;
  let c = collators.get(key);
  if (!c) collators.set(key, (c = new Intl.Collator(locale, o)));
  return c;
}

// The site's wall clock, for working out times (not showing them): read in a fixed locale with
// Latin digits, whatever the language.
const wall = (): Intl.DateTimeFormat =>
  cached(
    'w',
    {},
    () =>
      new Intl.DateTimeFormat('en-US', {
        ...(zone ? { timeZone: zone } : {}),
        hourCycle: 'h23',
        year: 'numeric',
        month: 'numeric',
        day: 'numeric',
        hour: 'numeric',
        minute: 'numeric',
        second: 'numeric',
      }),
  );

// A moment as the site's calendar and clock have it: month from 0, like Date.
export function zonedParts(w: When): {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
} {
  const parts = wall().formatToParts(at(w));
  const part = (type: Intl.DateTimeFormatPartTypes) => Number(parts.find((p) => p.type === type)?.value ?? 0);
  return {
    year: part('year'),
    month: part('month') - 1,
    day: part('day'),
    hour: part('hour') % 24,
    minute: part('minute'),
    second: part('second'),
  };
}

// How far the site's clock is ahead of UTC at a moment, in minutes (120 for CEST).
export function zoneOffset(w: When): number {
  const t = at(w).getTime();
  const p = zonedParts(t);
  const asUtc = Date.UTC(p.year, p.month, p.day, p.hour, p.minute, p.second);
  return Math.round((asUtc - Math.floor(t / 1000) * 1000) / MINUTE);
}

// The moment the site's clock shows a wall time (month from 0; days and months past their end roll
// over, like Date.UTC). A time skipped by a clock change comes out an hour later.
export function zonedTime(year: number, month: number, day = 1, hour = 0, minute = 0): number {
  const guess = Date.UTC(year, month, day, hour, minute);
  const first = guess - zoneOffset(guess) * MINUTE;
  const second = guess - zoneOffset(first) * MINUTE;
  return second;
}

const two = (n: number): string => String(n).padStart(2, '0');

// A moment as a datetime-local input's value on the site's clock: 2026-10-15T09:30.
export function inputValue(w: When): string {
  const p = zonedParts(w);
  return `${p.year}-${two(p.month + 1)}-${two(p.day)}T${two(p.hour)}:${two(p.minute)}`;
}

// A datetime-local input's value, read on the site's clock: the moment, or NaN.
export function fromInput(value: string): number {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/.exec(value.trim());
  if (!m) return Number.NaN;
  const [y, mo, d, h, mi] = m.slice(1, 6).map(Number) as [number, number, number, number, number];
  return zonedTime(y, mo - 1, d, h, mi) + Number(m[6] ?? 0) * SECOND;
}
