import { seedOntology, generateCutterBatches, generateWeldPower } from './lib/data.ts';
import { generateShotHistory, detectFrictionAlerts, scoreAlerts } from './lib/physics.ts';
import { workingGraph, healthCheck } from './lib/ontology.ts';
import { load, save, clearAll } from './lib/store.ts';
import { ApiError, createApiClient, resolveDataSource, type ApiClient, type DataSource } from './lib/api.ts';
import { createRepo } from './lib/ontology.ts';
import { localStore, pickSite, remoteStore, type OntologyStore, type RemoteStore } from './lib/ontology-store.ts';
import { esc, need } from './lib/dom.ts';
import home from './views/home.ts';
import chat from './views/chat.ts';
import ontology from './views/ontology.ts';
import quality from './views/quality.ts';
import physics from './views/physics.ts';
import design from './views/design.ts';
import settings from './views/settings.ts';
import type { AppState, Context, OntologyContext, PersistedState, View } from './views/types.ts';

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
  // In API mode state.repo mirrors the server; the browser's own copy stays in localRepo.
  const repo = remote ? localRepo : state.repo;
  const saved: PersistedState = { repo, runs: state.runs, chat: state.chat.slice(-60), user: state.user };
  save(STATE_KEY, saved);
}

// ---- data source ---------------------------------------------------------

let dataSource = resolveDataSource(load<Partial<DataSource> | null>('datasource', null), location.search);
let api = makeApi();

// ---- ontology store (local or API) ------------------------------------------

let localRepo = state.repo;
let remote: RemoteStore | null = null;
let ontologyStatus: OntologyContext['status'] = 'local';
let ontologyError: string | null = null;
let connectSeq = 0;

// Switches the ontology between this browser and the API. A slow earlier
// connection attempt can't overwrite a newer one (connectSeq).
async function connectOntology(): Promise<void> {
  const seq = ++connectSeq;
  // state.repo holds this browser's own repo only while the status is "local".
  if (!api) {
    if (ontologyStatus !== 'local') state.repo = localRepo;
    remote = null;
    ontologyStatus = 'local';
    ontologyError = null;
    return;
  }
  if (ontologyStatus === 'local') localRepo = state.repo;
  remote = null;
  state.repo = createRepo();
  ontologyStatus = 'loading';
  ontologyError = null;
  render();
  try {
    const store = remoteStore(api, await pickSite(api, dataSource.siteId));
    const repo = await store.load();
    if (seq !== connectSeq) return;
    remote = store;
    state.repo = repo;
    ontologyStatus = 'ready';
  } catch (e) {
    if (seq !== connectSeq) return;
    ontologyStatus = 'error';
    ontologyError = e instanceof Error ? e.message : String(e);
  }
  render();
}

const ontologyCtx: OntologyContext = {
  get status() {
    return ontologyStatus;
  },
  get site() {
    return remote?.site ?? null;
  },
  get error() {
    return ontologyError;
  },
  async act(change, ok) {
    const store: OntologyStore | null = api ? remote : localStore;
    if (!store) {
      toast('The ontology is still loading from the Tiles API');
      return false;
    }
    try {
      state.repo = await change(store, state.repo);
      persist();
      render();
      if (ok) toast(ok);
      return true;
    } catch (e) {
      // ApiErrors were already shown by the client's onError.
      if (!(e instanceof ApiError)) toast(e instanceof Error ? e.message : String(e));
      if (remote) await ontologyCtx.reload(); // show what the server has now
      return false;
    }
  },
  async reload() {
    if (!remote) return;
    try {
      state.repo = await remote.load();
    } catch {
      // the client already showed why
    }
    render();
  },
};

function makeApi(): ApiClient | null {
  if (dataSource.mode !== 'api') return null;
  return createApiClient({
    baseUrl: dataSource.apiUrl,
    userEmail: state.user.email,
    onError: (e) => toast(e.status ? `${e.message} (${e.status})` : e.message),
  });
}

// ---- context passed to views -------------------------------------------

const ctx: Context = {
  state,
  get graph() {
    return workingGraph(state.repo);
  },
  update(mutate, { rerender = true } = {}) {
    const email = state.user.email;
    mutate(state);
    if (state.user.email !== email && api) {
      api = makeApi();
      void connectOntology(); // staged changes are per user
    }
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
    save('datasource', dataSource); // a preference, not workspace data
    Object.assign(state, freshState(), { ui: {} });
    localRepo = state.repo;
    persist();
    render();
    toast('Demo data reset');
    void connectOntology();
  },
  get dataSource() {
    return dataSource;
  },
  get api() {
    return api;
  },
  setDataSource(source) {
    dataSource = source;
    save('datasource', source);
    api = makeApi();
    void connectOntology();
    render();
  },
  ontology: ontologyCtx,
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
void connectOntology(); // renders the loading state in API mode, before any local data shows
render();
