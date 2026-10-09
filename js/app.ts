import { seedOntology, generateCutterBatches, generateWeldPower } from './lib/data.ts';
import { generateShotHistory, detectFrictionAlerts, scoreAlerts } from './lib/physics.ts';
import { healthCheck } from './lib/ontology.ts';
import { load, save, clearAll } from './lib/store.ts';
import {
  ApiError,
  createApiClient,
  normalizeBaseUrl,
  resolveDataSource,
  type ApiClient,
  type AuthConfig,
  type DataSource,
  type Membership,
} from './lib/api.ts';
import { createRepo } from './lib/ontology.ts';
import {
  accessToken,
  beginSignIn,
  cleanCallbackUrl,
  completeSignIn,
  loadSession,
  SignInError,
  signOut,
  takeSignOutReturn,
} from './lib/oidc.ts';
import {
  localStore,
  pickSite,
  safeWorkingGraph,
  remoteStore,
  type OntologyStore,
  type RemoteStore,
} from './lib/ontology-store.ts';
import { esc, need, routeOf } from './lib/dom.ts';
import home from './views/home.ts';
import chat from './views/chat.ts';
import ontology from './views/ontology.ts';
import quality from './views/quality.ts';
import physics from './views/physics.ts';
import design from './views/design.ts';
import settings from './views/settings.ts';
import explorer from './views/explorer.ts';
import reviews from './views/reviews.ts';
import warnings from './views/warnings.ts';
import performance from './views/performance.ts';
import correlate from './views/correlate.ts';
import insights from './views/insights.ts';
import imports from './views/imports.ts';
import signals from './views/signals.ts';
import type { AppState, AuthContext, Context, OntologyContext, PersistedState, View } from './views/types.ts';

const VIEWS: View[] = [
  home,
  chat,
  ontology,
  reviews,
  warnings,
  performance,
  quality,
  physics,
  design,
  signals,
  explorer,
  correlate,
  insights,
  imports,
  settings,
];

const NAV: { group?: string; items: View[] }[] = [
  { items: [home, chat] },
  { group: 'Operations', items: [ontology, reviews, warnings, performance, quality, physics] },
  { group: 'Data', items: [signals, explorer, correlate, insights, imports] },
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
  const repo = ontologyStatus === 'local' ? state.repo : localRepo;
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
let ontologyRole: OntologyContext['role'] = null;
let ontologyUserId: string | null = null;
let siteMembers: Membership[] = [];
let reviewRequired = false;
let connectSeq = 0;

// Switches the ontology between this browser and the API. A slow earlier
// connection attempt can't overwrite a newer one (connectSeq).
async function connectOntology(): Promise<void> {
  const seq = ++connectSeq;
  // state.repo holds this browser's own repo only while the status is "local".
  ontologyRole = null;
  ontologyUserId = null;
  siteMembers = [];
  reviewRequired = false;
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
  renderSoon();
  try {
    const site = await pickSite(api, dataSource.siteId);
    const store = remoteStore(api, site);
    const [repo, people] = await Promise.all([store.load(), loadPeople(api, site.id)]);
    if (seq !== connectSeq) return;
    remote = store;
    state.repo = repo;
    setPeople(people);
    ontologyStatus = 'ready';
  } catch (e) {
    if (seq !== connectSeq) return;
    ontologyStatus = 'error';
    ontologyError = e instanceof Error ? e.message : String(e);
  }
  renderSoon();
}

// Your membership, the site's members and its review policy: fetched with the ontology. Only the
// membership is needed to show it; without the other two, reviews just can't name a reviewer or
// show the policy (the client already said why).
async function loadPeople(client: ApiClient, siteId: string) {
  const [membership, members, policy] = await Promise.all([
    client.membership(siteId),
    client.members(siteId).catch((): Membership[] => []),
    client.ontology.reviewPolicy(siteId).catch(() => ({ required: false })),
  ]);
  return { membership, members, policy };
}

function setPeople({ membership, members, policy }: Awaited<ReturnType<typeof loadPeople>>): void {
  ontologyRole = membership.role;
  ontologyUserId = membership.user_id;
  siteMembers = members;
  reviewRequired = policy.required;
}

const ontologyCtx: OntologyContext = {
  get status() {
    return ontologyStatus;
  },
  get site() {
    return remote?.site ?? null;
  },
  get role() {
    return ontologyRole;
  },
  get userId() {
    return ontologyUserId;
  },
  get members() {
    return siteMembers;
  },
  get reviewRequired() {
    return reviewRequired;
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
    const seq = connectSeq; // a data-source switch while we wait makes the result stale
    try {
      const next = await change(store, state.repo);
      if (seq !== connectSeq) return false;
      state.repo = next;
      persist();
      render();
      if (ok) toast(ok);
      return true;
    } catch (e) {
      // ApiErrors were already shown by the client's onError.
      if (seq !== connectSeq) return false;
      if (!(e instanceof ApiError)) toast(e instanceof Error ? e.message : String(e));
      if (remote) await ontologyCtx.reload(); // show what the server has now
      return false;
    }
  },
  async reload() {
    if (!remote || !api) return;
    const seq = connectSeq;
    try {
      // The role and review policy are fetched again too, so an admin's change to them shows here.
      const [repo, people] = await Promise.all([remote.load(), loadPeople(api, remote.site.id)]);
      if (seq !== connectSeq) return;
      state.repo = repo;
      setPeople(people);
    } catch {
      // the client already showed why
    }
    renderSoon();
  },
};

function makeApi(): ApiClient | null {
  if (dataSource.mode !== 'api') return null;
  const baseUrl = normalizeBaseUrl(dataSource.apiUrl);
  return createApiClient({
    baseUrl,
    userEmail: state.user.email,
    // Only a session obtained for this very API is ever sent to it.
    getToken: () => accessToken(baseUrl),
    onError: (e) => toast(e.status ? `${e.message} (${e.status})` : e.message),
  });
}

// ---- sign-in (API mode) ------------------------------------------------------

let authConfig: AuthConfig | null = null;

// Signed in to the API we are talking to (a session for another API doesn't count).
const sessionForApi = (): boolean => api !== null && loadSession()?.apiUrl === api.baseUrl;

const canRedirect = (): boolean => location.protocol === 'http:' || location.protocol === 'https:';
const redirectUri = (): string => location.origin + location.pathname;

// Finishes a sign-in redirect (?code&state) before any API call is made.
async function finishSignIn(): Promise<void> {
  if (!canRedirect()) return;
  try {
    const done = await completeSignIn(location.search);
    if (done) {
      history.replaceState(null, '', cleanCallbackUrl(location.href, done.returnTo));
      toast('Signed in');
    } else {
      // Back from the provider's sign-out: return to the page we left.
      const back = takeSignOutReturn();
      if (back !== null) history.replaceState(null, '', cleanCallbackUrl(location.href, back));
    }
  } catch (e) {
    history.replaceState(null, '', cleanCallbackUrl(location.href, e instanceof SignInError ? e.returnTo : undefined));
    toast(e instanceof Error ? e.message : String(e));
  }
  // The address now carries the page's own query again (e.g. ?api=…).
  dataSource = resolveDataSource(load<Partial<DataSource> | null>('datasource', null), location.search);
  api = makeApi();
  render();
}

// Learns how the API signs people in, and who we are to it.
let authSeq = 0;
async function refreshAuth(): Promise<void> {
  const seq = ++authSeq; // a newer refresh (e.g. after switching API) wins
  authConfig = null;
  const client = api;
  if (!client) return;
  try {
    const config = await client.authConfig();
    if (seq !== authSeq) return;
    authConfig = config;
    if (sessionForApi()) {
      const me = await client.me();
      if (seq !== authSeq) return;
      if (me.via === 'oidc' && (me.email !== state.user.email || me.name !== state.user.name)) {
        state.user = { name: me.name, email: me.email };
        persist();
      }
    }
  } catch {
    // the client already showed why
  }
  renderSoon();
}

const authCtx: AuthContext = {
  get config() {
    return authConfig;
  },
  get signedIn() {
    return sessionForApi();
  },
  async signIn() {
    if (!authConfig?.enabled || !authConfig.issuer) return toast('This Tiles API has no sign-in configured');
    if (!canRedirect()) return toast('Open Tiles over http(s) to sign in');
    try {
      location.assign(
        await beginSignIn(
          {
            issuer: authConfig.issuer,
            clientId: authConfig.client_id,
            redirectUri: redirectUri(),
            apiUrl: api?.baseUrl ?? '',
          },
          location.search + (location.hash || '#/'),
        ),
      );
    } catch (e) {
      toast(`Can't start sign-in: ${e instanceof Error ? e.message : String(e)}`);
    }
  },
  async signOut() {
    const url = await signOut(redirectUri(), location.search + location.hash);
    if (url) location.assign(url);
    else {
      toast('Signed out');
      await refreshAuth();
      void connectOntology();
    }
  },
};

// ---- context passed to views -------------------------------------------

const ctx: Context = {
  state,
  get graph() {
    return safeWorkingGraph(state.repo).graph;
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
    void refreshAuth();
    void connectOntology();
    render();
  },
  ontology: ontologyCtx,
  auth: authCtx,
};

// ---- rendering ----------------------------------------------------------

function currentView(): View {
  const id = routeOf(location.hash);
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

// Re-render after something finished in the background (a fetch, a sign-in
// check). Form fields the user has changed but not submitted keep their values
// (and focus), so a background update never wipes what they are entering.
function renderSoon(): void {
  const view = need(document, '#view');
  const key = (el: Element) => {
    const form = el.closest('form');
    const name = el.getAttribute('name');
    return form?.id && name ? `${form.id}:${name}:${el instanceof HTMLInputElement ? el.type : ''}` : null;
  };
  const edited = new Map<string, string | boolean>();
  view.querySelectorAll('input, select, textarea').forEach((el) => {
    const k = key(el);
    if (!k) return;
    if (el instanceof HTMLInputElement && (el.type === 'radio' || el.type === 'checkbox')) {
      if (el.checked !== el.defaultChecked) edited.set(`${k}:${el.value}`, el.checked);
    } else if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
      if (el.value !== el.defaultValue) edited.set(k, el.value);
    } else if (el instanceof HTMLSelectElement && [...el.options].some((o) => o.selected !== o.defaultSelected)) {
      edited.set(k, el.value);
    }
  });
  const active = document.activeElement;
  const focused = active && view.contains(active) ? key(active) : null;
  render();
  if (!edited.size && !focused) return;
  view.querySelectorAll('input, select, textarea').forEach((el) => {
    const k = key(el);
    if (!k) return;
    if (el instanceof HTMLInputElement && (el.type === 'radio' || el.type === 'checkbox')) {
      const v = edited.get(`${k}:${el.value}`);
      if (typeof v === 'boolean') el.checked = v;
    } else if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement || el instanceof HTMLSelectElement) {
      const v = edited.get(k);
      if (typeof v === 'string') el.value = v;
    }
    if (k === focused && el instanceof HTMLElement) el.focus({ preventScroll: true });
  });
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

// Charts are drawn to the page's width (fitWidth in svg.ts): draw them again when it changes.
let drawnWidth = 0;
let resizeTimer: ReturnType<typeof setTimeout> | undefined;
window.addEventListener('resize', () => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => {
    const width = need(document, 'main').clientWidth;
    if (Math.abs(width - drawnWidth) < 40 || !document.querySelector('#view svg.chart')) return;
    drawnWidth = width;
    renderSoon();
  }, 200);
});

window.addEventListener('hashchange', () => {
  render();
  need(document, '#view').focus({ preventScroll: true });
  window.scrollTo(0, 0);
});
// In API mode, show the loading state from the first paint (never local data).
if (api) {
  localRepo = state.repo;
  state.repo = createRepo();
  ontologyStatus = 'loading';
}
render();
void (async () => {
  await finishSignIn(); // so the first API calls carry the new token
  await refreshAuth();
  await connectOntology();
})();
