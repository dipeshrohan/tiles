// First run (U4.06): the first time someone opens Tiles (per person in API mode, per browser profile
// otherwise), a welcome asks what they mostly do. Their role sets the page Tiles opens at and the
// pages pinned at the top of the menu (and folds what they rarely need); then it offers the next step:
// the site wizard (an admin of a site still being set up), the help, or just looking around. It can
// be shown again from Help or the command palette.
import { esc } from './dom.ts';
import { helpHref } from './help.ts';
import { MAX_PINNED, type NavPrefs } from './nav.ts';

export type WorkRole = 'engineer' | 'maintenance' | 'shift-lead' | 'admin';

export interface RoleSetup {
  id: WorkRole;
  label: string;
  says: string; // what they mostly do, in their words
  start: string; // the page Tiles opens at
  localStart?: string; // the one in local mode, when `start` needs the Tiles API
  pins: string[]; // pinned at the top of the menu
  fold: string[]; // menu groups folded away
}

export const WORK_ROLES: readonly RoleSetup[] = [
  {
    id: 'engineer',
    label: 'Engineer',
    says: 'I look for causes in the data and keep the plant model up to date.',
    start: 'explorer',
    localStart: 'quality',
    pins: ['signals', 'explorer', 'correlate', 'ontology'],
    fold: [],
  },
  {
    id: 'maintenance',
    label: 'Maintenance',
    says: 'I work warnings and keep the machines running.',
    start: 'warnings',
    localStart: 'physics',
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

export interface RoleChoice {
  local: boolean; // local mode: the demo plant, no Tiles API
  previous?: RoleSetup; // the role chosen before, whose pins and folds this one replaces
}

// The page a role opens at: its local one in local mode, where its own needs the Tiles API.
export const startOf = (role: RoleSetup, local: boolean): string => (local && role.localStart) || role.start;

// The menu as a role sets it: its pages pinned first (other pins kept after them, but not those the
// previous role pinned), its groups folded (the previous role's unfolded), and its page to open at.
// Pages that aren't in this build are left out.
export function applyRole(prefs: NavPrefs, role: RoleSetup, pages: readonly string[], o: RoleChoice): NavPrefs {
  const before = o.previous;
  const kept = before ? prefs.pinned.filter((p) => !before.pins.includes(p)) : prefs.pinned;
  const unfolded = before ? prefs.folded.filter((g) => !before.fold.includes(g)) : prefs.folded;
  const pins = role.pins.filter((p) => pages.includes(p));
  const pinned = [...new Set([...pins, ...kept])].slice(0, MAX_PINNED);
  const folded = [...new Set([...unfolded, ...role.fold])];
  const start = startOf(role, o.local);
  const next: NavPrefs = { ...prefs, pinned, folded };
  if (pages.includes(start)) next.start = start;
  else delete next.start;
  return next;
}

// Where the welcome is remembered: beside the person's menu choices (their nav key).
export const welcomeKey = (navOwner: string): string => `welcome:${navOwner}`;

// Whether to greet now: not yet greeted, and not an automated browser (tests, Lighthouse), which
// open it from Help instead.
export function shouldWelcome(seen: boolean, automated: boolean): boolean {
  return !seen && !automated;
}

export interface WelcomeContext {
  site: string | null; // the API site's name; null in local mode (the demo plant)
  title(page: string): string; // a page's name in the menu
}

// What Tiles is showing: the demo plant in local mode, or the site.
export function welcomeIntro(c: WelcomeContext): string {
  return c.site === null
    ? 'This is Tiles with its demo plant: a battery plant with a die-caster, a notching cutter and a tab welder. Its readings are made up, and what you change stays in this browser.'
    : `You’re on ${c.site}: its plant model, signals, warnings and insights, shared with everyone on the site.`;
}

// The first step: what Tiles shows, and the roles to choose from.
export function rolesHtml(c: WelcomeContext): string {
  const roles = WORK_ROLES.map(
    (r) =>
      `<button class="welcome-role" type="button" data-role="${esc(r.id)}"><span class="welcome-role-name">${esc(r.label)}</span><span class="small soft">${esc(r.says)}</span></button>`,
  ).join('');
  return `<p class="soft">${esc(welcomeIntro(c))}</p>
    <fieldset class="welcome-roles"><legend>What do you mostly do?</legend>${roles}</fieldset>
    <p class="small soft">Your choice sets the page Tiles opens at and the pages pinned at the top of the menu. You can change both later.</p>
    <div class="dialog-foot"><button class="btn ghost" type="button" data-welcome-skip>Just look around</button></div>`;
}

// The second step: what the role set (the menu as it now is: `prefs`), and where to go next. An admin
// of a site still being set up is offered the site wizard first.
export function nextHtml(
  c: WelcomeContext,
  role: RoleSetup,
  prefs: NavPrefs,
  o: { setUp: boolean; helpFor: string | null },
): string {
  const pins = role.pins.filter((p) => prefs.pinned.includes(p)).map((p) => `<b>${esc(c.title(p))}</b>`);
  const listed = pins.length > 1 ? `${pins.slice(0, -1).join(', ')} and ${pins.at(-1)}` : (pins[0] ?? '');
  const page = prefs.start ?? 'home';
  const start = c.title(page);
  const actions = [
    o.setUp ? `<a class="btn primary" href="#/onboarding">Set up the site</a>` : '',
    `<a class="btn${o.setUp ? '' : ' primary'}" href="#/${page === 'home' ? '' : esc(page)}">Go to ${esc(start)}</a>`,
    o.helpFor ? `<a class="btn ghost" href="${esc(helpHref(o.helpFor))}">Read how ${esc(start)} works</a>` : '',
  ].filter(Boolean);
  const opens = `Tiles will open at <b>${esc(start)}</b>`;
  return `<p>${pins.length ? `${opens}, with ${listed} pinned in the menu.` : `${opens}.`}</p>
    <p class="small soft">To see this again, open Help and choose Show the welcome.</p>
    <div class="dialog-foot">${actions.join('')}</div>`;
}
