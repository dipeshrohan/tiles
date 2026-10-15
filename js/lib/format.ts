// Numbers, dates and times as the person's language writes them (U6.02), all from `Intl`, with no
// dependency: 12,480.5 in English is 12.480,5 in German. Times are shown in the site's time zone
// (the API's `timezone`, set when a site opens; this browser's without one), with the zone named,
// so a shift lead in another country reads the plant's own clock. Units stay SI symbols after the
// number (writing.md): only the number is written the language's way.
//
// Imports nothing: i18n.ts sets the language here (setLocale), and dom.ts's fmt() uses number().
// Nothing else in js/ may write a number or a date with a fixed locale (scripts/check-format.js).

// The catalogue's language → how its numbers and dates are written (English as en-GB, writing.md).
const REGION: Readonly<Record<string, string>> = { en: 'en-GB' };

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
  if (a < MINUTE) return `${sign}${upTo(a / SECOND, a < 10 * SECOND ? 1 : 0)} s`;
  if (a < HOUR) return `${sign}${number(Math.round(a / MINUTE))} min`;
  if (a < 2 * DAY) {
    const minutes = Math.round(a / MINUTE);
    const [h, m] = [Math.floor(minutes / 60), minutes % 60];
    return `${sign}${number(h)} h${m ? ` ${number(m)} min` : ''}`;
  }
  const days = Math.round(a / DAY);
  return sign + numbers({ style: 'unit', unit: 'day', unitDisplay: 'long' }).format(days);
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

const STEPS: [Intl.RelativeTimeFormatUnit, number][] = [
  ['second', SECOND],
  ['minute', MINUTE],
  ['hour', HOUR],
  ['day', DAY],
];

// How long ago (or until): "3 minutes ago", "yesterday", "in 2 hours"; past a week, the date.
export function relative(w: When, now: number = Date.now()): string {
  const d = at(w);
  if (!valid(d)) return NOT_A_NUMBER;
  const ms = d.getTime() - now;
  if (Math.abs(ms) >= 7 * DAY) return date(d);
  if (Math.abs(ms) < 45 * SECOND) {
    return cached('r', { numeric: 'auto' }, () => new Intl.RelativeTimeFormat(locale, { numeric: 'auto' })).format(
      0,
      'second',
    );
  }
  let unit: Intl.RelativeTimeFormatUnit = 'second';
  let size = SECOND;
  for (const [u, s] of STEPS) if (Math.abs(ms) >= s) [unit, size] = [u, s];
  const rtf = cached('r', { numeric: 'auto' }, () => new Intl.RelativeTimeFormat(locale, { numeric: 'auto' }));
  return rtf.format(Math.round(ms / size), unit);
}

// The hour, minute and second of a time in the site's zone (a chart's ticks fall on midnight).
export function clockOf(w: When): { hour: number; minute: number; second: number } {
  const parts = dates({ hour: 'numeric', minute: 'numeric', second: 'numeric', hourCycle: 'h23' }).formatToParts(at(w));
  const part = (type: Intl.DateTimeFormatPartTypes) => Number(parts.find((p) => p.type === type)?.value ?? 0);
  return { hour: part('hour'), minute: part('minute'), second: part('second') };
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
