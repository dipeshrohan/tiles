import { seedOntology, generateCutterBatches, generateWeldPower } from './lib/data.ts';
import { generateShotHistory, detectFrictionAlerts, scoreAlerts } from './lib/physics.ts';
import { workingGraph, healthCheck } from './lib/ontology.ts';
import { load, save, clearAll } from './lib/store.ts';
import { esc, need } from './lib/dom.ts';
import home from './views/home.ts';
import chat from './views/chat.ts';
import ontology from './views/ontology.ts';
import quality from './views/quality.ts';
import physics from './views/physics.ts';
import design from './views/design.ts';
import settings from './views/settings.ts';
import type { AppState, Context, PersistedState, View } from './views/types.ts';

const VIEWS: View[] = [home, chat, ontology, quality, physics, design, settings];

const NAV: { group?: string; items: View[] }[] = [
  { items: [home, chat] },
  { group: 'Operations', items: [ontology, quality, physics] },
  { group: 'Design', items: [design] },
  { group: '', items: [settings] },
];

// ---- state ------------------------------------------------------------

function freshState(): PersistedState {
  return {
    repo: seedOntology(),
    runs: [],
    chat: [],
    user: { name: 'Demo User', email: 'demo@example.com' },
  };
}

// Bump the key when seed data changes so saved copies of the old seed are dropped.
const STATE_KEY = 'state-v2';
const persisted = load<Partial<PersistedState> | null>(STATE_KEY, null);
const shots = generateShotHistory();
const detection = detectFrictionAlerts(shots.history);

const state: AppState = {
  ...freshState(),
  ...(persisted ?? {}),
  // Synthetic plant data is regenerated from fixed seeds on every load.
  batches: generateCutterBatches(),
  weld: generateWeldPower(),
  shots,
  detection,
  scored: scoreAlerts(detection.alerts, shots.downtime, shots.cycleSeconds),
  ui: {},
};

function persist(): void {
  const saved: PersistedState = { repo: state.repo, runs: state.runs, chat: state.chat.slice(-60), user: state.user };
  save(STATE_KEY, saved);
}

// ---- context passed to views -------------------------------------------

const ctx: Context = {
  state,
  get graph() {
    return workingGraph(state.repo);
  },
  update(mutate, { rerender = true } = {}) {
    mutate(state);
    persist();
    if (rerender) render();
  },
  ui<T extends object>(viewId: string, defaults: T): T {
    state.ui[viewId] ??= { ...defaults };
    return state.ui[viewId] as T;
  },
  rerender: () => render(),
  toast,
  reset() {
    clearAll();
    Object.assign(state, freshState(), { ui: {} });
    persist();
    render();
    toast('Demo data reset');
  },
};

// ---- rendering ----------------------------------------------------------

function currentView(): View {
  const id = (location.hash.replace(/^#\/?/, '').split(/[/?]/)[0] || 'home').toLowerCase();
  return VIEWS.find((v) => v.id === id) ?? home;
}

function badgeFor(view: View): string {
  if (view.id === 'physics') {
    const open = state.detection.alerts.length;
    return open ? `<span class="badge bad">${open}</span>` : '';
  }
  if (view.id === 'ontology') {
    const staged = state.repo.staged.length;
    if (staged) return `<span class="badge warn">${staged}</span>`;
    const issues = healthCheck(ctx.graph).issues.filter((i) => i.level !== 'info').length;
    return issues ? `<span class="badge">${issues}</span>` : '';
  }
  return '';
}

function renderNav(active: View): void {
  need(document, '#nav').innerHTML = NAV.map(
    (g) =>
      (g.group
        ? `<div class="nav-group">${esc(g.group)}</div>`
        : g.group === ''
          ? '<div class="nav-group">&nbsp;</div>'
          : '') +
      g.items
        .map(
          (v) =>
            `<a class="nav-link ${v === active ? 'active' : ''}" href="#/${v.id === 'home' ? '' : v.id}"><span class="ico" aria-hidden="true">${v.icon}</span>${esc(v.title)}${badgeFor(v)}</a>`,
        )
        .join(''),
  ).join('');
  const initials = state.user.name
    .split(/\s+/)
    .map((p) => p[0] ?? '')
    .join('')
    .slice(0, 2)
    .toUpperCase();
  need(document, '#user').innerHTML =
    `<span class="avatar">${esc(initials)}</span><div><div>${esc(state.user.name)}</div><div class="muted small">${esc(state.user.email)}</div></div>`;
}

function render(): void {
  const view = currentView();
  renderNav(view);
  need(document, '#crumbs').innerHTML =
    `<span>Home</span>${view === home ? '' : `<span>›</span><b>${esc(view.title)}</b>`}`;
  document.title = view === home ? 'Tiles' : `${view.title} · Tiles`;
  const root = need(document, '#view');
  root.innerHTML = view.render(ctx);
  view.bind?.(root, ctx);
}

let toastTimer: ReturnType<typeof setTimeout> | undefined;
function toast(message: string): void {
  const el = need(document, '#toast');
  el.textContent = message;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 2400);
}

// ---- theme & mobile nav ---------------------------------------------------

type Theme = 'light' | 'dark';

function applyTheme(theme: Theme | null): void {
  if (theme) document.documentElement.dataset.theme = theme;
  else delete document.documentElement.dataset.theme;
}
applyTheme(load<Theme | null>('theme', null));
need(document, '#theme').addEventListener('click', () => {
  const dark = document.documentElement.dataset.theme
    ? document.documentElement.dataset.theme === 'dark'
    : matchMedia('(prefers-color-scheme: dark)').matches;
  const next: Theme = dark ? 'light' : 'dark';
  applyTheme(next);
  save('theme', next);
});
need(document, '#menu').addEventListener('click', () => need(document, '#sidebar').classList.toggle('open'));
need(document, '#nav').addEventListener('click', () => need(document, '#sidebar').classList.remove('open'));

window.addEventListener('hashchange', () => {
  render();
  need(document, '#view').focus({ preventScroll: true });
  window.scrollTo(0, 0);
});
render();
