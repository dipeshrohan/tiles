import { seedOntology, generateCutterBatches, generateWeldPower } from './lib/data.js';
import { generateShotHistory, detectFrictionAlerts, scoreAlerts } from './lib/physics.js';
import { workingGraph, healthCheck } from './lib/ontology.js';
import { load, save, clearAll } from './lib/store.js';
import { esc, $ } from './lib/dom.js';
import home from './views/home.js';
import chat from './views/chat.js';
import ontology from './views/ontology.js';
import quality from './views/quality.js';
import physics from './views/physics.js';
import design from './views/design.js';
import settings from './views/settings.js';

const VIEWS = [home, chat, ontology, quality, physics, design, settings];

const NAV = [
  { items: [home, chat] },
  { group: 'Operations', items: [ontology, quality, physics] },
  { group: 'Design', items: [design] },
  { group: '', items: [settings] },
];

// ---- state ------------------------------------------------------------

function freshState() {
  return {
    repo: seedOntology(),
    runs: [],
    chat: [],
    user: { name: 'Demo User', email: 'demo@example.com' },
  };
}

// Bump the key when seed data changes so saved copies of the old seed are dropped.
const STATE_KEY = 'state-v2';
const persisted = load(STATE_KEY, null);
const shots = generateShotHistory();
const detection = detectFrictionAlerts(shots.history);

const state = {
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

function persist() {
  save(STATE_KEY, { repo: state.repo, runs: state.runs, chat: state.chat.slice(-60), user: state.user });
}

// ---- context passed to views -------------------------------------------

const ctx = {
  state,
  get graph() {
    return workingGraph(state.repo);
  },
  update(mutate, { rerender = true } = {}) {
    mutate(state);
    persist();
    if (rerender) render();
  },
  ui(viewId, defaults = {}) {
    state.ui[viewId] ??= { ...defaults };
    return state.ui[viewId];
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

function currentView() {
  const id = (location.hash.replace(/^#\/?/, '').split(/[/?]/)[0] || 'home').toLowerCase();
  return VIEWS.find((v) => v.id === id) ?? home;
}

function badgeFor(view) {
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

function renderNav(active) {
  $('#nav').innerHTML = NAV.map(
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
    .map((p) => p[0])
    .join('')
    .slice(0, 2)
    .toUpperCase();
  $('#user').innerHTML =
    `<span class="avatar">${esc(initials)}</span><div><div>${esc(state.user.name)}</div><div class="muted small">${esc(state.user.email)}</div></div>`;
}

function render() {
  const view = currentView();
  renderNav(view);
  $('#crumbs').innerHTML = `<span>Home</span>${view === home ? '' : `<span>›</span><b>${esc(view.title)}</b>`}`;
  document.title = view === home ? 'Tiles' : `${view.title} · Tiles`;
  const root = $('#view');
  root.innerHTML = view.render(ctx);
  view.bind?.(root, ctx);
}

let toastTimer;
function toast(message) {
  const el = $('#toast');
  el.textContent = message;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 2400);
}

// ---- theme & mobile nav ---------------------------------------------------

function applyTheme(theme) {
  if (theme) document.documentElement.dataset.theme = theme;
  else delete document.documentElement.dataset.theme;
}
applyTheme(load('theme', null));
$('#theme').addEventListener('click', () => {
  const dark = document.documentElement.dataset.theme
    ? document.documentElement.dataset.theme === 'dark'
    : matchMedia('(prefers-color-scheme: dark)').matches;
  const next = dark ? 'light' : 'dark';
  applyTheme(next);
  save('theme', next);
});
$('#menu').addEventListener('click', () => $('#sidebar').classList.toggle('open'));
$('#nav').addEventListener('click', () => $('#sidebar').classList.remove('open'));

window.addEventListener('hashchange', () => {
  render();
  $('#view').focus({ preventScroll: true });
  window.scrollTo(0, 0);
});
render();
