// Preferences (U6.06): a person's own settings for the app, on the "Your preferences" page. Each
// applies at once (app.ts's applyPreferences); they are kept in this browser and, with the Tiles
// API, with the person (GET/PUT /sites/{id}/me/preferences), so they follow them to every site and
// browser and come back after signing out and in. Pure: what they are, their defaults, and
// checking what was kept or sent.

import type { Density } from './data-table.ts';

export type ThemeChoice = 'system' | 'light' | 'dark';
export type ZoneChoice = 'site' | 'device';
export type MotionChoice = 'system' | 'reduce';

export interface Preferences {
  theme: ThemeChoice;
  density: Density; // table rows
  language: string; // a catalogue's code, or 'auto': the browser's
  numbers: string; // how numbers and dates are written (en-US), or 'auto': as the language does
  timeZone: ZoneChoice; // times in the site's clock or this device's
  motion: MotionChoice; // less motion always, or as the system asks
  shortcuts: boolean; // single-key shortcuts
  start: string | null; // the page the app opens at; null: Home
}

export const DEFAULTS: Readonly<Preferences> = {
  theme: 'system',
  density: 'comfortable',
  language: 'auto',
  numbers: 'auto',
  timeZone: 'site',
  motion: 'system',
  shortcuts: true,
  start: null,
};

// The ways of writing numbers and dates offered, besides the language's own.
export const NUMBER_FORMATS: readonly string[] = ['en-GB', 'en-US', 'de-DE', 'de-CH', 'fr-FR'];

const oneOf = <T extends string>(v: unknown, allowed: readonly T[], fallback: T): T =>
  typeof v === 'string' && (allowed as readonly string[]).includes(v) ? (v as T) : fallback;

// Preferences as kept or sent (an older app's, or edited): only known values; the rest default.
export function cleanPreferences(
  value: unknown,
  o: { languages: readonly string[]; pages: readonly string[] },
): Preferences {
  const v = (typeof value === 'object' && value !== null ? value : {}) as Record<string, unknown>;
  return {
    theme: oneOf(v.theme, ['system', 'light', 'dark'], DEFAULTS.theme),
    density: oneOf(v.density, ['comfortable', 'compact'], DEFAULTS.density),
    language: oneOf(v.language, ['auto', ...o.languages], DEFAULTS.language),
    numbers: oneOf(v.numbers, ['auto', ...NUMBER_FORMATS], DEFAULTS.numbers),
    timeZone: oneOf(v.timeZone ?? v.time_zone, ['site', 'device'], DEFAULTS.timeZone),
    motion: oneOf(v.motion, ['system', 'reduce'], DEFAULTS.motion),
    shortcuts: typeof v.shortcuts === 'boolean' ? v.shortcuts : DEFAULTS.shortcuts,
    start: typeof v.start === 'string' && o.pages.includes(v.start) && v.start !== 'home' ? v.start : null,
  };
}

// As the API takes them.
export interface ApiPreferences {
  theme: ThemeChoice;
  density: Density;
  language: string;
  numbers: string;
  time_zone: ZoneChoice;
  motion: MotionChoice;
  shortcuts: boolean;
  start: string | null;
}
export const toApi = ({ timeZone, ...p }: Preferences): ApiPreferences => ({ ...p, time_zone: timeZone });

export const samePreferences = (a: Preferences, b: Preferences): boolean =>
  (Object.keys(DEFAULTS) as (keyof Preferences)[]).every((k) => a[k] === b[k]);
