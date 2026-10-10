import { seedOntology, generateCutterBatches, generateWeldPower } from './lib/data.ts';
import { generateShotHistory, detectFrictionAlerts, scoreAlerts } from './lib/physics.ts';
import { healthCheck } from './lib/ontology.ts';
import { load, save, clearAll } from './lib/store.ts';
import {
  ApiError,
  createApiClient,
  normalizeBaseUrl,
  OFFLINE_WRITE,
  resolveDataSource,
  STREAM_CUT,
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
import { announce, esc, lessMotion, need, rebind, routeOf } from './lib/dom.ts';
import { morph, noteSent, replace } from './lib/morph.ts';
import { after, before, rowMotion, watchSections } from './lib/micro.ts';
import {
  loadUi,
  queryOf,
  restoreScroll,
  saveUi,
  scrollToSaved,
  showHash,
  watchScroll,
  withQuery,
} from './lib/url-state.ts';
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
import shopfloor from './views/shopfloor.ts';
import plant from './views/plant.ts';
import onboarding from './views/onboarding.ts';
import styleguide from './views/styleguide.ts';
import performance from './views/performance.ts';
import correlate from './views/correlate.ts';
import insights from './views/insights.ts';
import apps from './views/apps.ts';
import documents from './views/documents.ts';
import imports from './views/imports.ts';
import signals from './views/signals.ts';
import type { AppState, AuthContext, Context, OntologyContext, PersistedState, View } from './views/types.ts';
import { icon } from './lib/icons.ts';
import { describeApiError } from './lib/errors.ts';
import { afterRender, showApiErrors } from './lib/forms.ts';
import { keepWaiting, saveWaiting, takeSaved } from './lib/undo.ts';
import { createTracker, keepLeft, newSession, takeLeft, ux, type UxEvent } from './lib/analytics.ts';
import { breadcrumbs, button, clockTime, resetIds } from './lib/ui.ts';
import { createToaster } from './lib/toaster.ts';
import { installTooltips } from './lib/tooltip.ts';
import { installPalette, type PaletteItem } from './lib/palette.ts';

const VIEWS: View[] = [
  home,
  chat,
  ontology,
  reviews,
  warnings,
  shopfloor,
  plant,
  performance,
  quality,
  physics,
  design,
  signals,
  explorer,
  correlate,
  insights,
  apps,
  documents,
  imports,
  onboarding,
  settings,
  styleguide, // not in the menu: Settings → About links to it
];

const NAV: { group?: string; items: View[] }[] = [
  { items: [home, chat] },
  { group: 'Operations', items: [shopfloor, plant, ontology, reviews, warnings, performance, quality, physics] },
  { group: 'Data', items: [signals, explorer, correlate, insights, apps, documents, imports] },
  { group: 'Design', items: [design] },
  { group: '', items: [onboarding, settings] },
];

// Toasts and tooltips are the page's, from the start (a live region must exist before it speaks).
const toast = createToaster(need(document, '#toast'));
installTooltips();

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
  ui: loadUi(sessionStorage),
};

const uiChecked = new Set<string>(); // pages whose kept state has had its defaults filled in

function persist(): void {
  // In API mode state.repo mirrors the server; the browser's own copy stays in localRepo.
  const repo = ontologyStatus === 'local' ? state.repo : localRepo;
  const saved: PersistedState = { repo, runs: state.runs, chat: state.chat.slice(-60), user: state.user };
  save(STATE_KEY, saved);
}

// ---- data source ---------------------------------------------------------

// The API this deployment serves the app with (server.js fills the meta tag from TILES_API_URL).
const DEPLOYED_API = document.querySelector<HTMLMetaElement>('meta[name="tiles-api"]')?.content ?? '';

let dataSource = resolveDataSource(load<Partial<DataSource> | null>('datasource', null), location.search, DEPLOYED_API);
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
    void startUx(api, site.id);
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
    // What happened, why and what to do (U2.06), with the way out when there is one.
    onError: (e) => {
      // Offline says so itself, and a stream cut off mid-answer was reached.
      if (e.status === 0 && e.message !== OFFLINE_WRITE && e.message !== STREAM_CUT) showOffline('unreachable');
      ux(
        'error',
        e.message === OFFLINE_WRITE
          ? 'offline'
          : e.message === STREAM_CUT
            ? 'api.stream-cut'
            : `api.${e.status || 'unreachable'}`,
      );
      // Fields the API refused, shown on the form that sent them (which takes the focus): no toast.
      if (e.status === 422 && showApiErrors(e.fields)) return;
      const d = describeApiError(e);
      const action =
        // Only where there is somewhere to go back to.
        d.action === 'back' && history.length > 1
          ? { label: 'Go back', run: () => history.back() }
          : d.action === 'refresh'
            ? { label: 'Refresh', run: () => location.reload() }
            : d.action === 'sign-in' && authConfig?.enabled
              ? { label: 'Sign in', run: () => void ctx.auth.signIn() }
              : undefined;
      toast(d.message, { type: 'error', description: d.description, requestId: e.requestId, action });
    },
    onAnswer: (status) => {
      if (status < 500) hideOffline('unreachable');
    },
    isOffline: () => !navigator.onLine,
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
  dataSource = resolveDataSource(load<Partial<DataSource> | null>('datasource', null), location.search, DEPLOYED_API);
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
  get signInOrg() {
    return load<string>('signin-org', '');
  },
  async signIn(org?: string) {
    if (!canRedirect()) return toast('Open Tiles over http(s) to sign in');
    // An organisation's own provider (T5.05), or the API's.
    let config = authConfig;
    const slug = org?.trim().toLowerCase();
    if (slug && api) {
      try {
        config = await api.authConfig(slug);
      } catch (e) {
        const status = (e as { status?: number }).status;
        return toast(status === 404 ? `${slug} has no sign-in of its own` : `Can't start sign-in: ${String(e)}`);
      }
    }
    if (!config?.enabled || !config.issuer) return toast('This Tiles API has no sign-in configured');
    save('signin-org', slug ?? '');
    try {
      location.assign(
        await beginSignIn(
          {
            issuer: config.issuer,
            clientId: config.client_id,
            redirectUri: redirectUri(),
            apiUrl: api?.baseUrl ?? '',
            ...(config.scope ? { scope: config.scope } : {}),
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
    // Kept from the tab's last load (U3.05): what it lacks (a field added since) comes from the defaults.
    if (!uiChecked.has(viewId)) {
      uiChecked.add(viewId);
      state.ui[viewId] = { ...defaults, ...(state.ui[viewId] ?? {}) };
    }
    state.ui[viewId] ??= { ...defaults };
    return state.ui[viewId] as T;
  },
  rerender: () => render(),
  address() {
    const view = currentView();
    if (!view.query) return;
    showHash(withQuery(location.hash, view.query.write(ctx)));
    addressed = location.hash;
  },
  toast,
  reset() {
    // The data source is a preference, not workspace data; kept only if this browser chose one, so
    // a deployment's default (the tiles-api meta tag) stays a default.
    const chosen = load<Partial<DataSource> | null>('datasource', null);
    clearAll();
    if (chosen) save('datasource', chosen);
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
            `<a class="nav-link ${v === active || v.id === active.under ? 'active' : ''}" href="#/${v.id === 'home' ? '' : v.id}"${v === active ? ' aria-current="page"' : ''}><span class="ico">${icon(v.icon)}</span>${esc(v.title)}${badgeFor(v)}</a>`,
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

let addressed = ''; // the address the page last wrote itself (its query is the page's own)
let shownView: string | null = null; // the page last shown: drawn again, it is patched in place
let trackedView = ''; // the page last recorded as viewed (U1.09)

// Draws the current page. A new page replaces what was there; the same page drawn again is patched
// in place (U3.03, js/lib/morph.ts), so focus, scroll, open sections and selections stay, and its
// listeners are bound afresh (the last binding's dropped: `rebind`).
function render(): void {
  const view = currentView();
  if (view.id !== trackedView) {
    trackedView = view.id;
    ux('page', view.id);
  }
  renderNav(view);
  document.title = view === home ? 'Tiles' : `${view.title} · Tiles`;
  const root = need(document, '#view');
  // A query that came from outside (a link, a reload, back or forward) sets what the page shows; an
  // address without one keeps what this tab showed last (U3.05).
  const params = queryOf(location.hash);
  if (view.query && location.hash !== addressed && [...params].length) view.query.read(params, ctx);
  resetIds();
  const html = view.render(ctx);
  // Drawn again in place, what changed moves a little (U3.04): rows in and out, highlights, numbers.
  const again = view.id === shownView;
  const was = again ? before(root) : null;
  if (again) morph(root, html, rowMotion);
  else replace(root, html);
  rebind();
  view.bind?.(root, ctx);
  afterRender(); // the API's field errors on the form sent last stay (js/lib/forms.ts)
  after(root, was);
  // Home › the page › the record or place it shows (after render and bind, from what they show; the
  // record comes from the URL, so a reload or a shared link shows the same).
  need(document, '#crumbs').innerHTML = breadcrumbs([
    { label: 'Home', href: '#/' },
    ...VIEWS.filter((v) => v.id === view.under).map((v) => ({ label: v.title, href: `#/${v.id}` })),
    ...(view === home ? [] : [{ label: view.title, href: `#/${view.id}` }]),
    ...(view.crumbs?.(ctx) ?? []),
  ]);
  shownView = view.id;
  // The address says what the page shows, with no history entry of its own.
  ctx.address();
  addressed = location.hash;
  restoreScroll(); // back or forward: the page put back where it was, once it is tall enough
}

// A form sent without onSubmit (which notes its own once it is checked) is sent once the browser's
// checks pass: drawn again, its fields show what the page says, not what was sent (js/lib/morph.ts).
need(document, '#view').addEventListener('submit', (e) => {
  if (e.target instanceof HTMLFormElement && !e.target.noValidate) noteSent(e.target);
});

// Re-render after something finished in the background (a fetch, a sign-in check). The page is
// patched in place (js/lib/morph.ts), so what is being typed, and where, stays. A focused field the
// patch had to draw anew (its place in the page changed) gets the focus back, found by its form and
// name.
function renderSoon(): void {
  const view = need(document, '#view');
  const key = (el: Element) => {
    const form = el.closest('form');
    const name = el.getAttribute('name');
    return form?.id && name ? `${form.id}:${name}` : null;
  };
  const active = document.activeElement;
  const focused = active && view.contains(active) ? key(active) : null;
  render();
  if (!focused || (document.activeElement && view.contains(document.activeElement))) return;
  const again = [...view.querySelectorAll<HTMLElement>('input, select, textarea')].find((el) => key(el) === focused);
  again?.focus({ preventScroll: true });
}

// "Try again" and "Sign in" on a page whose site didn't load (apiUnreachable), not on a sample of it.
need(document, '#view').addEventListener('click', (e) => {
  const el = e.target instanceof Element ? e.target : null;
  if (!el || el.closest('.sg-pair')) return;
  if (el.closest('[data-reconnect]')) void connectOntology();
  else if (el.closest('[data-app-sign-in]')) void ctx.auth.signIn();
  else {
    // "Copy details" on an error: what support needs to find it (request ID, page, time, version).
    const copy = el.closest<HTMLElement>('[data-copy-details]');
    if (copy)
      void (navigator.clipboard?.writeText(copy.dataset.copyDetails ?? '') ?? Promise.reject(new Error())).then(
        () => toast('Details copied', { type: 'success' }),
        () => toast("Can't copy here", { description: copy.dataset.copyDetails, duration: 15000 }),
      );
  }
});

// ---- offline (U2.06) -----------------------------------------------------------
// A banner while the browser is offline, or the API doesn't answer: what is on screen stays, changes
// aren't sent (the client refuses them with a reason), and Try again connects afresh.

let offline: 'offline' | 'unreachable' | null = null;
let offlineSince = 0;
function showOffline(kind: 'offline' | 'unreachable'): void {
  if (offline === 'offline' && kind === 'unreachable') return; // offline says more
  if (!offline) offlineSince = Date.now();
  offline = kind;
  const banner = need(document, '#offline');
  const since = clockTime(offlineSince);
  banner.innerHTML = `${icon(kind === 'offline' ? 'wifi-off' : 'cloud-off')}<span>${
    kind === 'offline'
      ? `You're offline. What you see is as of ${since}; changes can't be sent until the connection is back.`
      : `Can't reach the Tiles API. What you see is as of ${since}.`
  }</span>${api ? button('Try again', { size: 'sm', attrs: { 'data-offline-retry': true } }) : ''}`;
  banner.hidden = false;
}
function hideOffline(kind?: 'offline' | 'unreachable'): void {
  if (!offline || (kind && offline !== kind)) return;
  offline = null;
  need(document, '#offline').hidden = true;
}
// ---- UX analytics (U1.09) ---------------------------------------------------
// On only where the organisation turned it on (the API says so for each site). Events come from
// anywhere as `ux(kind, name)`; a new session id per page load, kept nowhere. What a page leaves
// unsent is kept for the next load to send (a request started as the page goes doesn't arrive).

const uxSession = newSession();
let uxSite: string | null = null;
const tracker = createTracker({
  send: (events) => (api && uxSite ? api.ux.send(uxSite, uxSession, events) : Promise.resolve()),
});
document.addEventListener('tiles:ux', (e) => {
  const { kind, name } = (e as CustomEvent<UxEvent>).detail;
  tracker.track(kind, name);
});
// The organisation's admin turned it on or off on the Settings page: this tab follows at once.
document.addEventListener('tiles:ux-setting', (e) => {
  if (!uxSite) return;
  tracker.setEnabled((e as CustomEvent<{ enabled: boolean }>).detail.enabled);
});
async function startUx(client: ApiClient, site: string): Promise<void> {
  if (uxSite === site) return; // connected again to the same site: carry on as it was
  uxSite = site;
  tracker.setEnabled(false);
  const on = await client.ux.enabled(site).then(
    (r) => r.enabled,
    () => false,
  );
  if (uxSite !== site) return;
  tracker.setEnabled(on);
  if (!on) return;
  tracker.track('page', currentView().id); // the page already open
  const left = takeLeft(localStorage, client.baseUrl, site);
  if (left) await client.ux.send(site, left.session, left.events).catch(() => undefined);
}
window.addEventListener('pagehide', () => {
  if (api && uxSite && tracker.enabled)
    keepLeft(localStorage, { api: api.baseUrl, site: uxSite, session: uxSession, events: tracker.drain() });
});
window.addEventListener('pageshow', (e) => {
  // Back from the back/forward cache: the same page, so its events go back in its own queue.
  if (!e.persisted || !api || !uxSite) return;
  for (const ev of takeLeft(localStorage, api.baseUrl, uxSite)?.events ?? []) tracker.track(ev.kind, ev.name);
});

// Removals waiting on an Undo toast (U2.03) when the page goes are saved for the next load to send;
// a page back from the back/forward cache still has its toasts, so they stay with it.
window.addEventListener('pagehide', () => saveWaiting(localStorage));
// What each page shows (filters, a tab, a record open) stays for this tab's next load (U3.05).
window.addEventListener('pagehide', () => saveUi(sessionStorage, state.ui));
window.addEventListener('pageshow', (e) => {
  if (e.persisted) keepWaiting(localStorage);
});

// Sends the removals a page left behind with their Undo toasts still showing (to this API only).
async function sendSaved(): Promise<void> {
  const client = api;
  if (!client) return;
  for (const r of takeSaved(localStorage, client.baseUrl)) {
    const send = r.kind === 'conversation' ? client.copilot.remove : client.datasets.remove;
    await send(r.site, r.id).catch(() => undefined); // the client showed why
  }
}
window.addEventListener('offline', () => showOffline('offline'));
// Back again: connect afresh only if the site never loaded; otherwise keep what is on screen and
// draw the page again, which fetches its data.
function reconnect(): void {
  if (!api) return;
  if (ontologyStatus === 'error') void connectOntology();
  else renderSoon();
}
window.addEventListener('online', () => {
  hideOffline('offline');
  reconnect();
});
need(document, '#offline').addEventListener('click', (e) => {
  if (!(e.target instanceof Element) || !e.target.closest('[data-offline-retry]')) return;
  hideOffline('unreachable');
  if (navigator.onLine) reconnect();
  else showOffline('offline');
});
if (!navigator.onLine) showOffline('offline');

// ---- theme & mobile nav ---------------------------------------------------

type Theme = 'light' | 'dark';

const isDark = (): boolean =>
  document.documentElement.dataset.theme
    ? document.documentElement.dataset.theme === 'dark'
    : matchMedia('(prefers-color-scheme: dark)').matches;

// The toggle shows where it goes: a moon in the light theme, a sun in the dark one.
function applyTheme(theme: Theme | null): void {
  if (theme) document.documentElement.dataset.theme = theme;
  else delete document.documentElement.dataset.theme;
  need(document, '#theme').innerHTML = icon(isDark() ? 'sun' : 'moon');
}
applyTheme(load<Theme | null>('theme', null));
matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () =>
  applyTheme(load<Theme | null>('theme', null)),
);
need(document, '#theme').addEventListener('click', () => {
  const next: Theme = isDark() ? 'light' : 'dark';
  applyTheme(next);
  save('theme', next);
});
need(document, '#menu').innerHTML = icon('menu', { size: 18 });

// ---- command palette (U4.02) ------------------------------------------------

const go = (hash: string) => () => {
  location.hash = hash;
};
const palette = installPalette({
  items(): PaletteItem[] {
    const pages = NAV.flatMap((g) =>
      g.items.map((v) => ({
        id: `page:${v.id}`,
        label: v.title,
        group: 'Pages',
        icon: v.icon,
        hint: g.group || undefined,
        run: go(`#/${v.id === 'home' ? '' : v.id}`),
      })),
    );
    const actions: PaletteItem[] = [
      {
        id: 'do:ask',
        label: 'Ask the copilot',
        group: 'Actions',
        icon: 'sparkles',
        keywords: 'question chat ai',
        run: go('#/chat'),
      },
      {
        id: 'do:plot',
        label: 'Plot a signal',
        group: 'Actions',
        icon: 'chart-line',
        keywords: 'explorer chart readings',
        run: go('#/explorer'),
      },
      {
        id: 'do:import',
        label: 'Import readings from a file',
        group: 'Actions',
        icon: 'upload',
        keywords: 'csv historian upload',
        run: go('#/import'),
      },
      {
        id: 'do:docs',
        label: 'Search documents and SOPs',
        group: 'Actions',
        icon: 'book-open',
        keywords: 'manual procedure pdf',
        run: go('#/documents'),
      },
      {
        id: 'do:theme',
        label: isDark() ? 'Switch to the light theme' : 'Switch to the dark theme',
        group: 'Actions',
        icon: isDark() ? 'sun' : 'moon',
        keywords: 'theme dark light mode appearance',
        run: () => need(document, '#theme').click(),
      },
    ];
    return [...pages, ...actions];
  },
  canSearch: () => Boolean(api && ctx.ontology.site),
  async search(q) {
    const site = ctx.ontology.site;
    if (!api || !site) return [];
    const found = await api.signals.list(site.id, { q, limit: 8 });
    return found.signals.map((s) => ({
      id: `signal:${s.id}`,
      label: s.tag,
      group: 'Signals',
      icon: 'activity' as const,
      hint: [s.unit, s.node_label].filter(Boolean).join(' · ') || undefined,
      run: go(`#/explorer?signal=${encodeURIComponent(s.id)}`),
    }));
  },
});
const searchButton = need(document, '#palette-open');
searchButton.insertAdjacentHTML('afterbegin', icon('search'));
if (/Mac|iPhone|iPad/.test(navigator.platform)) need(searchButton, 'kbd').textContent = '⌘K';
searchButton.addEventListener('click', () => palette.open());
need(document, '#menu').addEventListener('click', (e) => {
  const open = need(document, '#sidebar').classList.toggle('open');
  (e.currentTarget as HTMLElement).setAttribute('aria-expanded', String(open));
});
// "Skip to content" moves the focus past the navigation (a #view link would be read as a route).
need(document, '[data-skip]').addEventListener('click', (e) => {
  e.preventDefault();
  need(document, '#view').focus();
});
need(document, '#nav').addEventListener('click', () => closeMenu());
// Escape closes the phone menu, and gives the focus back to its button.
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape' || !need(document, '#sidebar').classList.contains('open')) return;
  closeMenu();
  need(document, '#menu').focus();
});

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

function closeMenu(): void {
  need(document, '#sidebar').classList.remove('open');
  need(document, '#menu').setAttribute('aria-expanded', 'false');
}

// ---- page transitions (U3.02) ---------------------------------------------------------
// Another page cross-fades in, with its head kept in place (css/styles.css); a record opened from a
// list on the same page grows from the row that was clicked into its page head. Only where the
// browser has view transitions and less motion isn't asked for: otherwise nothing moves. Either way
// the new page's heading takes the focus, so a screen reader reads where it is, and it is announced.
// The link last clicked in the page or its breadcrumbs: a record opened from it grows from it.
let clicked: HTMLAnchorElement | null = null;
document.addEventListener(
  'click',
  (e) => {
    const el = e.target instanceof Element ? e.target.closest<HTMLAnchorElement>('a[href^="#/"]') : null;
    clicked = el && el.closest('#view, #crumbs') ? el : null;
  },
  true,
);

type ViewTransitionDocument = Document & {
  startViewTransition?: (update: () => void) => { ready: Promise<void>; finished: Promise<void> };
};

function navigate(): void {
  closeMenu(); // whatever link was followed: the menu's, the brand, or one in the page
  const root = need(document, '#view');
  const newPage = currentView().id !== shownView;
  // The link followed to this record, when it was a click on a link to exactly this place.
  const from = !newPage && clicked?.isConnected && clicked.hash === location.hash ? clicked : null;
  clicked = null;
  // Scrolled down, the old page's head is above the window: it isn't held (it would slide down).
  const head = (): HTMLElement | null => root.querySelector<HTMLElement>(':scope > .page-head');
  const hold = window.scrollY < (head()?.offsetHeight ?? 0);
  const name = (el: HTMLElement | null, value: string) => el?.style.setProperty('view-transition-name', value);
  const arrive = () => {
    name(from, ''); // the head is the record now
    render();
    scrollToSaved(); // the top for a new entry; where it was for one reached with back or forward
    name(head(), from ? 'record' : hold ? '' : 'none');
    // The new page's heading takes the focus, which a screen reader reads; a page without one is said.
    const heading = root.querySelector<HTMLElement>('h1[tabindex]');
    (heading ?? root).focus({ preventScroll: true });
    if (!heading) announce(document.title);
  };
  const doc = document as ViewTransitionDocument;
  if (!(newPage || from) || !doc.startViewTransition || lessMotion() || document.hidden) return arrive();
  name(from, 'record');
  if (!hold) name(head(), 'none');
  const transition = doc.startViewTransition(() => {
    try {
      arrive();
    } catch (e) {
      reportError(e); // reported as any page error is, not as a transition that failed
    }
  });
  // Skipped (another navigation came first) or done: the page is drawn either way.
  void transition.ready.catch(() => undefined);
  void transition.finished.then(
    () => head()?.style.removeProperty('view-transition-name'),
    () => undefined,
  );
}
window.addEventListener('hashchange', navigate);
watchSections(document); // a section someone opens fades its content in (U3.04)
watchScroll(); // each history entry keeps its scroll, put back on back and forward (U3.05)
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
  await sendSaved();
  await connectOntology();
})();
