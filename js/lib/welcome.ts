// First run (U4.06): the first time someone opens Tiles (per person in API mode, per browser profile
// otherwise), a welcome asks what they mostly do. Their role sets the page Tiles opens at and the
// pages pinned at the top of the menu (and folds what they rarely need); then it offers the next step:
// the site wizard (an admin of a site still being set up), the help, or just looking around. It can
// be shown again from Help or the command palette.
import { MAX_PINNED, type NavPrefs } from './nav.ts';

export type WorkRole = 'engineer' | 'maintenance' | 'shift-lead' | 'admin';

export interface RoleSetup {
  id: WorkRole;
  label: string;
  says: string; // what they mostly do, in their words
  start: string; // the page Tiles opens at
  pins: string[]; // pinned at the top of the menu
  fold: string[]; // menu groups folded away
}

export const WORK_ROLES: readonly RoleSetup[] = [
  {
    id: 'engineer',
    label: 'Engineer',
    says: 'I look for causes in the data and keep the plant model up to date.',
    start: 'explorer',
    pins: ['signals', 'explorer', 'correlate', 'ontology'],
    fold: [],
  },
  {
    id: 'maintenance',
    label: 'Maintenance',
    says: 'I work warnings and keep the machines running.',
    start: 'warnings',
    pins: ['warnings', 'plant', 'documents'],
    fold: ['design'],
  },
  {
    id: 'shift-lead',
    label: 'Shift lead',
    says: 'I watch my line during the shift and act on what goes wrong.',
    start: 'shopfloor',
    pins: ['shopfloor', 'warnings', 'plant'],
    fold: ['data', 'design'],
  },
  {
    id: 'admin',
    label: 'Admin',
    says: 'I set up sites, people and the connections to the plant.',
    start: 'settings',
    pins: ['settings', 'onboarding', 'reviews'],
    fold: ['design'],
  },
];

export const roleSetup = (id: string): RoleSetup | undefined => WORK_ROLES.find((r) => r.id === id);

// The menu as a role sets it: its pages pinned first (pins already there kept after them), its groups
// folded, and its page to open at. Pages that aren't in this build are left out.
export function applyRole(prefs: NavPrefs, role: RoleSetup, pages: readonly string[]): NavPrefs {
  const pins = role.pins.filter((p) => pages.includes(p));
  const pinned = [...new Set([...pins, ...prefs.pinned])].slice(0, MAX_PINNED);
  const folded = [...new Set([...prefs.folded, ...role.fold])];
  return { ...prefs, pinned, folded, ...(pages.includes(role.start) ? { start: role.start } : {}) };
}

// Where the welcome is remembered: beside the person's menu choices (their nav key).
export const welcomeKey = (navOwner: string): string => `welcome:${navOwner}`;

// Whether to greet now: not yet greeted, and not an automated browser (tests, Lighthouse), which
// open it from Help instead.
export function shouldWelcome(seen: boolean, automated: boolean): boolean {
  return !seen && !automated;
}
