import { seedOntology, generateCutterBatches, generateWeldPower } from './lib/data.ts';
import { shotHistorySteps, detectFrictionAlerts, scoreAlerts } from './lib/physics.ts';
import { graphHealth } from './lib/ontology.ts';
import { load, save, clearAll, storedKeys } from './lib/store.ts';

// What this browser kept before this load (U4.08: someone who used Tiles before isn't new).
const keptBefore = storedKeys().filter((k) => k !== 'whats-new-seen');
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
  type Inbox,
  type InboxItem,
  type Membership,
  type Site,
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
import { announce, esc, lessMotion, need, rebind, routeOf, setBusy } from './lib/dom.ts';
import { morph, noteSent, replace } from './lib/morph.ts';
import {
  cleanPrefs,
  DEFAULT_PREFS,
  MAX_PINNED,
  navHtml,
  toggleFold,
  togglePin,
  visited,
  type NavBadge,
  type NavGroup,
  type NavPrefs,
} from './lib/nav.ts';
import { after, before, rowMotion, watchSections } from './lib/micro.ts';
import {
  forgetUi,
  loadUi,
  mergeKept,
  queryOf,
  restoreScroll,
  saveUi,
  scrollToSaved,
  session,
  leaving,
  showHash,
  watchScroll,
  withQuery,
} from './lib/url-state.ts';
import home from './views/home.ts';
import chat, { prefill } from './views/chat.ts';
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
import help, { guideHtml } from './views/help.ts';
import glossary, { ENTRIES as GLOSSARY_ENTRIES } from './views/glossary.ts';
import type { AppState, AuthContext, Context, OntologyContext, PersistedState, View } from './views/types.ts';
import type { Graph, Repo, ShotHistory } from './lib/types.ts';
import { rowTarget, shown } from './lib/split.ts';
import { icon } from './lib/icons.ts';
import { describeApiError } from './lib/errors.ts';
import { afterRender, clearErrors, setFieldError, showApiErrors, showErrors } from './lib/forms.ts';
import { keepWaiting, saveWaiting, takeSaved } from './lib/undo.ts';
import { createTracker, keepLeft, newSession, takeLeft, ux, type UxEvent } from './lib/analytics.ts';
import { breadcrumbs, button, clockTime, loadingState, resetIds } from './lib/ui.ts';
import { createToaster } from './lib/toaster.ts';
import { installTooltips } from './lib/tooltip.ts';
import { installCharts } from './lib/charts.ts';
import { openView, viewsFor } from './lib/filter-bar.ts';
import { menuViews, viewHref } from './lib/saved-views.ts';
import { INBOX_POLL_MS, announcement, arrivals, bellCount, bellLabel, inboxHtml } from './lib/inbox.ts';
import { installPalette, type PaletteItem } from './lib/palette.ts';
import { installShortcuts, shortcutsOn } from './lib/shortcuts.ts';
import { helpHref, helpItems, helpLoaded, loadHelp, pageSection } from './lib/help.ts';
import { panelDialog, sheet } from './lib/overlay.ts';
import {
  applyRole,
  nextHtml,
  roleSetup,
  rolesHtml,
  shouldWelcome,
  welcomeKey,
  type WelcomeContext,
} from './lib/welcome.ts';
import { runTour } from './lib/tour.ts';
import { feedbackBody, formHtml, previewHtml } from './lib/feedback.ts';
import { canCapture, capturePage } from './lib/screenshot.ts';
import { hasNews, helpLabel, SEEN_KEY, seenOnFirstLoad, whatsNewHtml, whatsNewTitle } from './lib/whats-new.ts';
import { VERSION } from './lib/version.ts';
import { canRun, ROLE_TOURS, tourOf, TOURS } from './lib/tours.ts';
import { searchItems } from './lib/site-search.ts';
import { t, type MessageKey } from './lib/i18n.ts';
import { translateStatic } from './lib/static-text.ts';
import { setTimeZone } from './lib/format.ts';
import { chosenLanguage, keepLanguage, useLanguage } from './lib/language.ts';

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
  help,
  glossary, // not in the menu: Help links to it
];

// A group's id keeps each person's folded groups; its name is shown (`app.nav.<id>`).
const NAV: { group?: 'operations' | 'data' | 'design' | ''; items: View[] }[] = [
  { items: [home, chat] },
  { group: 'operations', items: [shopfloor, plant, ontology, reviews, warnings, performance, quality, physics] },
  { group: 'data', items: [signals, explorer, correlate, insights, apps, documents, imports] },
  { group: 'design', items: [design] },
  { group: '', items: [onboarding, settings, help] },
];
const groupName = (group: string | undefined): string => (group ? t(`app.nav.${group}` as MessageKey) : '');

// index.html's own words (the skip link, the top bar's labels) in the catalogue's language, before
// anything is drawn (U6.01).
translateStatic(document);

// Toasts and tooltips are the page's, from the start (a live region must exist before it speaks).
const toast = createToaster(need(document, '#toast'));
installTooltips();
// Charts read point by point, and saved (U5.03): their values are read out by the page's announcer.
installCharts(need(document, '#announcer'), (what) =>
  toast(what, { type: 'error', description: t('app.chartSaveFailed') }),
);

// ---- state ------------------------------------------------------------

function freshState(): PersistedState {
  return {
    repo: seedOntology(),
    runs: [],
    chat: [],
    user: { name: t('app.demoUser'), email: 'demo@example.com' },
  };
}

// Bump the key when seed data changes so saved copies of the old seed are dropped.
const STATE_KEY = 'state-v2';
const persisted = load<Partial<PersistedState> | null>(STATE_KEY, null);
const state = {
  ...freshState(),
  ...(persisted ?? {}),
  ui: loadUi(session()),
} as AppState;

// Synthetic plant data is regenerated from fixed seeds on every load, when a page first reads it:
// made before the first page, it held Home back by a quarter of a second (U3.07).
const made = new Set<keyof AppState>();
function demo<K extends 'batches' | 'weld' | 'shots' | 'detection' | 'scored'>(key: K, make: () => AppState[K]): void {
  let value: AppState[K] | undefined;
  Object.defineProperty(state, key, {
    enumerable: true,
    get: () => {
      if (!made.has(key)) {
        value = make();
        made.add(key);
      }
      return value;
    },
  });
}
// The shot history is the slow part: made a few shots at a time once the first page is drawn
// (makeDemoSoon), or the rest at once by a page that reads it first.
const shotSteps = shotHistorySteps();
let shotHistory: ShotHistory | null = null;
function stepShots(toTheEnd: boolean): ShotHistory | null {
  while (!shotHistory) {
    const step = shotSteps.next();
    if (step.done) shotHistory = step.value;
    else if (!toTheEnd) break;
  }
  return shotHistory;
}
demo('batches', generateCutterBatches);
demo('weld', generateWeldPower);
demo('shots', () => stepShots(true)!);
demo('detection', () => detectFrictionAlerts(state.shots.history));
demo('scored', () => scoreAlerts(state.detection.alerts, state.shots.downtime, state.shots.cycleSeconds));
// Whether the demo plant's warnings are worked out: pages that can wait (Home, the menu's count)
// show them once they are.
const demoReady = (): boolean => made.has('scored');
function makeDemoSoon(): void {
  if (demoReady()) return;
  if (!stepShots(false)) {
    setTimeout(makeDemoSoon, 0);
    return;
  }
  void state.scored;
  // What waited for it: the menu's count, and Home's card if Home is shown (no other page is drawn
  // again: it would cut short what someone is doing there, a drag on the ontology say).
  if (currentView() === home) renderSoon();
  else renderNav(currentView());
}

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
let knownSites: Site[] = []; // the API's sites, as last listed

// Switches the ontology between this browser and the API. A slow earlier
// connection attempt can't overwrite a newer one (connectSeq).
async function connectOntology(): Promise<void> {
  const seq = ++connectSeq;
  // state.repo holds this browser's own repo only while the status is "local".
  ontologyRole = null;
  ontologyUserId = null;
  siteMembers = [];
  reviewRequired = false;
  knownSites = []; // the last API's sites aren't this one's
  if (!api) {
    if (ontologyStatus !== 'local') state.repo = localRepo;
    remote = null;
    setTimeZone(null); // this browser's own zone (U6.02)
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
    const sites = await api.sites();
    if (seq !== connectSeq) return; // a newer connection's sites are the ones to offer
    knownSites = sites; // for switching sites from the command palette
    const site = await pickSite(api, dataSource.siteId, sites);
    setTimeZone(site.timezone); // its times in its own zone, named, from the start (U6.02)
    const store = remoteStore(api, site);
    const [repo, people] = await Promise.all([store.load(), loadPeople(api, site.id)]);
    if (seq !== connectSeq) return;
    remote = store;
    state.repo = repo;
    setPeople(people);
    ontologyStatus = 'ready';
    void startUx(api, site.id);
    setTimeout(firstRun, 0); // once the person is known: their start page, and the welcome
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
      toast(t('app.ontologyLoading'));
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
      if (e.status === 0 && e.code !== OFFLINE_WRITE && e.code !== STREAM_CUT) showOffline('unreachable');
      ux(
        'error',
        e.code === OFFLINE_WRITE
          ? 'offline'
          : e.code === STREAM_CUT
            ? 'api.stream-cut'
            : `api.${e.status || 'unreachable'}`,
      );
      // Fields the API refused, shown on the form that sent them (which takes the focus): no toast.
      if (e.status === 422 && showApiErrors(e.fields)) return;
      const d = describeApiError(e);
      const action =
        // Only where there is somewhere to go back to.
        d.action === 'back' && history.length > 1
          ? { label: t('app.goBack'), run: () => history.back() }
          : d.action === 'refresh'
            ? { label: t('app.refresh'), run: () => location.reload() }
            : d.action === 'sign-in' && authConfig?.enabled
              ? { label: t('app.signIn'), run: () => void ctx.auth.signIn() }
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
      toast(t('app.signedIn'));
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
    if (!canRedirect()) return toast(t('app.signInNeedsHttp'));
    // An organisation's own provider (T5.05), or the API's.
    let config = authConfig;
    const slug = org?.trim().toLowerCase();
    if (slug && api) {
      try {
        config = await api.authConfig(slug);
      } catch (e) {
        const status = (e as { status?: number }).status;
        return toast(
          status === 404 ? t('app.noOwnSignIn', { org: slug }) : t('app.cantStartSignIn', { error: String(e) }),
        );
      }
    }
    if (!config?.enabled || !config.issuer) return toast(t('app.noSignIn'));
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
      toast(t('app.cantStartSignIn', { error: e instanceof Error ? e.message : String(e) }));
    }
  },
  async signOut() {
    // What the pages showed was this person's: not kept for whoever signs in next in this tab.
    forgetUi(session());
    state.ui = {};
    const url = await signOut(redirectUri(), location.search + location.hash);
    if (url) location.assign(url);
    else {
      toast(t('app.signedOut'));
      await refreshAuth();
      void connectOntology();
    }
  },
};

// ---- context passed to views -------------------------------------------

let working: { head: Repo['head']; staged: Repo['staged']; graph: Graph } | null = null;

const ctx: Context = {
  state,
  get graph() {
    // Made again only when the repository changes, which it does by being replaced, never in place
    // (U3.07: copying 2,000 nodes at every read slowed each redraw).
    const { head, staged } = state.repo;
    if (working?.head !== head || working.staged !== staged)
      working = { head, staged, graph: safeWorkingGraph(state.repo).graph };
    return working.graph;
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
      if (state.ui[viewId]) state.ui[viewId] = mergeKept(defaults, state.ui[viewId]);
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
    toast(t('app.demoReset'));
    void connectOntology();
  },
  get workRole() {
    const owner = navOwner();
    return (owner && load<{ role?: string } | null>(welcomeKey(owner), null)?.role) || null;
  },
  get demoReady() {
    return demoReady();
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

// ---- the menu (U3.06) --------------------------------------------------------------------
// Groups that fold, pins and recent pages, counts, and the icon rail; each person's choices kept in
// this browser (js/lib/nav.ts).
// Made when the menu is drawn, so its names are in the language of the moment.
const navGroups = (): NavGroup[] =>
  NAV.map((g, i) => ({
    id: g.group || `g${i}`,
    title: groupName(g.group),
    pages: g.items.map((v) => ({ id: v.id, title: v.title, icon: v.icon })),
  }));
const NAV_PAGES = NAV.flatMap((g) => g.items.map((v) => v.id));
let navFor = '';
let navPrefs: NavPrefs = DEFAULT_PREFS;
// Whose choices: in API mode the signed-in person (once known), otherwise this browser's profile.
function navOwner(): string | null {
  if (!api) return `nav:local:${state.user.email}`;
  return ctx.ontology.userId ? `nav:${ctx.ontology.userId}` : null;
}
// Until the API says who is signed in, the menu is laid out as for whoever used it here last (the
// rail, the folded groups: no flash on a reload), never with their pages (pins, recent: a tablet on
// the line is shared); pages visited meanwhile join the person's recent pages once known.
const lastOwner = (): string => `nav:last:${api?.baseUrl ?? ''}`;
let waitingVisits: string[] = [];
let borrowed = false;
function prefs(): NavPrefs {
  const who = navOwner();
  if (who && who !== navFor) {
    const first = !navFor;
    navFor = who;
    navPrefs = cleanPrefs(load<unknown>(who, null), NAV_PAGES);
    if (first && waitingVisits.length) {
      for (const id of waitingVisits) navPrefs = visited(navPrefs, id);
      save(who, navPrefs);
    }
    waitingVisits = [];
    if (api) save(lastOwner(), who);
  } else if (!who && !navFor && !borrowed) {
    borrowed = true;
    const last = load<string | null>(lastOwner(), null);
    if (last?.startsWith('nav:')) {
      const theirs = cleanPrefs(load<unknown>(last, null), NAV_PAGES);
      navPrefs = { ...DEFAULT_PREFS, rail: theirs.rail, folded: theirs.folded };
    }
  }
  return navPrefs;
}
function setPrefs(next: NavPrefs): void {
  navPrefs = next;
  if (navFor) save(navFor, next);
  document.body.classList.toggle('nav-rail', next.rail);
}

// Open warnings and reviews waiting for me (API mode): read at most once a minute, and again after
// anyone here acts on a warning or a review.
let counts: { site: string; warnings: number; reviews: number; at: number } | null = null;
let counting = false;
function refreshCounts(): void {
  refreshInbox();
  const site = ctx.ontology.site;
  if (!api || !site || ctx.ontology.status !== 'ready' || counting) return;
  if (counts?.site === site.id && Date.now() - counts.at < 60_000) return;
  counting = true;
  api.menu.counts(site.id).then(
    (c) => {
      counting = false;
      counts = { site: site.id, warnings: c.open_warnings, reviews: c.reviews_waiting, at: Date.now() };
      renderNav(currentView());
    },
    () => {
      counting = false; // kept as they were; tried again with the next page
    },
  );
}
// Saved views read (or changed): the menu lists them.
document.addEventListener('tiles:views', () => renderNav(currentView()));
document.addEventListener('tiles:ux', (e) => {
  const { kind, name } = (e as CustomEvent<{ kind: string; name: string }>).detail;
  if (kind === 'task' && /^(warning|review|ontology)\./.test(name) && counts) counts.at = 0;
});

function badges(): Record<string, NavBadge> {
  const out: Record<string, NavBadge> = {};
  const open = demoReady() ? state.detection.alerts.length : 0;
  if (open) out.physics = { count: open, tone: 'bad', says: t('app.badge.demoWarnings', { count: open }) };
  const staged = state.repo.staged.length;
  const issues = staged ? 0 : graphHealth(ctx.graph).issues.filter((i) => i.level !== 'info').length;
  if (staged) out.ontology = { count: staged, tone: 'warn', says: t('app.badge.staged', { count: staged }) };
  else if (issues) out.ontology = { count: issues, tone: '', says: t('app.badge.health', { count: issues }) };
  const site = ctx.ontology.site;
  if (counts && site && counts.site === site.id) {
    if (counts.warnings)
      out.warnings = {
        count: counts.warnings,
        tone: 'bad',
        says: t('app.badge.openWarnings', { count: counts.warnings }),
      };
    if (counts.reviews)
      out.reviews = { count: counts.reviews, tone: 'warn', says: t('app.badge.reviews', { count: counts.reviews }) };
  }
  return out;
}

function renderNav(active: View): void {
  const p = prefs();
  document.body.classList.toggle('nav-rail', p.rail);
  const views = menuViews(viewsFor(ctx) ?? []).map((v) => ({
    id: v.id,
    name: v.name,
    href: viewHref(v),
    shared: v.shared,
    mine: v.mine,
  }));
  const html = navHtml({
    groups: navGroups(),
    active: active.id,
    under: active.under,
    prefs: p,
    badges: badges(),
    views,
  });
  // Drawn as before (most redraws of a page): nothing to patch (U3.07).
  if (html !== navDrawn) morph(need(document, '#nav'), html);
  navDrawn = html;
  refreshCounts();
  const initials = state.user.name
    .split(/\s+/)
    .map((p) => p[0] ?? '')
    .join('')
    .slice(0, 2)
    .toUpperCase();
  const user = `<span class="avatar">${esc(initials)}</span><div><div>${esc(state.user.name)}</div><div class="muted small">${esc(state.user.email)}</div></div>`;
  if (user !== userDrawn) need(document, '#user').innerHTML = user;
  userDrawn = user;
}
let navDrawn = '';
let userDrawn = '';

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
    if (NAV_PAGES.includes(view.id)) {
      setPrefs(visited(prefs(), view.id)); // the last pages, in the menu
      if (!navFor) waitingVisits.push(view.id);
    }
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
    { label: t('home.title'), href: '#/' },
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
        () => toast(t('app.detailsCopied'), { type: 'success' }),
        () => toast(t('app.cantCopy'), { description: copy.dataset.copyDetails, duration: 15000 }),
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
    kind === 'offline' ? esc(t('app.offline', { time: since })) : esc(t('app.unreachable', { time: since }))
  }</span>${api ? button(t('app.tryAgain'), { size: 'sm', attrs: { 'data-offline-retry': true } }) : ''}`;
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
window.addEventListener('pagehide', () => saveUi(session(), state.ui));
window.addEventListener('pageshow', (e) => {
  if (e.persisted) keepWaiting(localStorage);
});

// Sends the removals a page left behind with their Undo toasts still showing (to this API only).
async function sendSaved(): Promise<void> {
  const client = api;
  if (!client) return;
  for (const r of takeSaved(localStorage, client.baseUrl)) {
    const sent =
      r.kind === 'conversation'
        ? client.copilot.remove(r.site, r.id)
        : r.kind === 'feedback'
          ? client.feedback.remove(r.site, Number(r.id))
          : r.kind === 'view'
            ? client.views.remove(r.site, r.id)
            : client.datasets.remove(r.site, r.id);
    await sent.catch(() => undefined); // the client showed why
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

// Words a site is found by in the palette, besides its slug.
const SITE_WORDS = 'site plant'; // i18n-ok
const go = (hash: string) => () => {
  location.hash = hash;
};
// The glossary's terms (U4.05), after the rest like the guide's headings.
const glossaryItems = (): PaletteItem[] =>
  GLOSSARY_ENTRIES.map((e) => ({
    id: `term:${e.key}`,
    label: e.term,
    group: t('glossary.title'),
    icon: 'book-a',
    hint: e.group,
    late: true,
    run: go(`#/glossary/${encodeURIComponent(e.key)}`),
  }));
// The guide's headings join the palette once loaded (U4.04): asked for once, as the palette first opens.
let helpAsked = false;

// ---- first run (U4.06) ------------------------------------------------------
// Once the person is known (at once in local mode, when the API says in API mode): the app opens at
// the page their role set (only while nobody has gone anywhere since it loaded), and the first time,
// a welcome asks what they mostly do (js/lib/welcome.ts). Automated browsers aren't greeted.
let navigated = false;
let started = false; // the start page is for the app's load, not a site switched to later
let welcoming = false;
function firstRun(): void {
  const owner = navOwner();
  if (!owner) return;
  const start = prefs().start;
  if (!started && start && start !== 'home' && !navigated && /^#?\/?$/.test(location.hash))
    location.replace(`#/${start}`);
  started = true;
  const seen = load<unknown>(welcomeKey(owner), null) !== null;
  if (shouldWelcome(seen, navigator.webdriver === true) && !document.querySelector('dialog[open]')) void showWelcome();
}
document.addEventListener('tiles:welcome', () => void showWelcome());

// ---- guided tours (U4.07) ----------------------------------------------------
// Started from Help, the command palette or the welcome (the `tiles:tour` event names the tour).
function startTour(id: string): void {
  const tour = tourOf(id);
  if (!tour) return;
  // Chosen in the command palette: once it has gone (it fades out), so the focus it gives back
  // doesn't leave the tour's first step.
  if (document.querySelector('dialog.palette')) return void requestAnimationFrame(() => startTour(id));
  if (!canRun(tour, Boolean(api))) {
    toast(t('app.tourNeedsApi'), {
      type: 'info',
      description: t('app.tourNeedsApiHow'),
    });
    return;
  }
  ux('help', `tour.${tour.id}`);
  runTour(tour, {
    go: (hash) => {
      location.hash = hash;
    },
    ended: (finished) => {
      if (finished) ux('task', 'tour.finished');
    },
  });
}
document.addEventListener('tiles:tour', (e) => startTour((e as CustomEvent<string>).detail));
const welcomeContext = (): WelcomeContext => ({
  site: api ? (ctx.ontology.site?.name ?? null) : null,
  title: (page) => VIEWS.find((v) => v.id === page)?.title ?? page,
});
async function showWelcome(): Promise<void> {
  const owner = navOwner();
  if (!owner || welcoming) return;
  welcoming = true;
  const kept = load<{ role?: string } | null>(welcomeKey(owner), null);
  save(welcomeKey(owner), { ...kept, seen: true }); // shown once: closing it is "just look around"
  ux('help', 'welcome');
  const c = welcomeContext();
  await panelDialog(
    {
      title: t('app.welcomeTitle'),
      contentHtml: `<div class="stack gap-3" data-welcome>${rolesHtml(c)}</div>`,
      wide: true,
    },
    (dialog, close) => {
      const box = dialog.querySelector<HTMLElement>('[data-welcome]');
      let chosen = false; // one role: the second step is on its way
      dialog.addEventListener('click', (e) => {
        const el = e.target instanceof Element ? e.target : null;
        if (el?.closest('[data-welcome-skip]')) return close();
        const tourButton = el?.closest<HTMLElement>('[data-start-tour]');
        if (tourButton) {
          close();
          return startTour(tourButton.dataset.startTour ?? '');
        }
        const role = roleSetup(el?.closest<HTMLElement>('[data-role]')?.dataset.role ?? '');
        if (!role || !box || chosen) return;
        chosen = true;
        const before = load<{ role?: string } | null>(welcomeKey(owner), null);
        const next = applyRole(prefs(), role, NAV_PAGES, { local: !api, previous: roleSetup(before?.role ?? '') });
        setPrefs(next);
        save(welcomeKey(owner), { seen: true, role: role.id });
        renderNav(currentView());
        // An admin of a site whose plant has no machine yet (onboarding's first step) is offered the
        // site wizard first.
        const setUp = Boolean(
          api && ctx.ontology.role === 'admin' && !Object.values(ctx.graph.nodes).some((n) => n.type === 'Machine'),
        );
        void loadHelp()
          .catch(() => null)
          .then((help) => {
            const tour = tourOf(ROLE_TOURS[role.id] ?? '');
            box.innerHTML = nextHtml(c, role, next, {
              setUp,
              helpFor: help?.pages[next.start ?? 'home'] ?? null,
              tour: tour && canRun(tour, Boolean(api)) ? tour : null,
            });
            box.querySelector<HTMLElement>('a')?.focus();
          });
      });
    },
  );
  welcoming = false;
}

// ---- help (U4.04) ------------------------------------------------------------

// The page's help in a side sheet: its section of the user guide, with a link to the whole guide.
let helpOpen = false;
async function openHelp(): Promise<void> {
  if (helpOpen) return;
  helpOpen = true;
  let then: 'whats-new' | 'feedback' | null = null;
  try {
    const data = await loadHelp();
    const [first, ...rest] = pageSection(data, currentView().id);
    if (!first) return;
    await sheet(
      {
        label: t('common.help'),
        title: first.title,
        contentHtml: `<div class="prose">${first.html}${guideHtml(rest, { ids: false })}</div>`,
        footHtml: `<button class="btn sm ghost" type="button" data-whats-new>${esc(t('app.help.whatsNewIn', { version: VERSION }))}</button>${
          api
            ? `<button class="btn sm ghost" type="button" data-feedback-open>${esc(t('app.help.sendFeedback'))}</button>`
            : ''
        }<a class="btn sm" href="${esc(helpHref(first.slug))}">${esc(t('app.help.fullGuide'))}</a>`,
      },
      (dialog, close) => {
        dialog.querySelector('[data-whats-new]')?.addEventListener('click', () => {
          then = 'whats-new';
          close();
        });
        dialog.querySelector('[data-feedback-open]')?.addEventListener('click', () => {
          then = 'feedback';
          close();
        });
      },
    );
    // Opened once the help sheet has gone, so the focus it gives back (the help button) is what
    // What's new gives it back to.
    if (then === 'whats-new') void openWhatsNew();
    if (then === 'feedback') void openFeedback();
  } catch (e) {
    toast(t('app.help.failed'), { type: 'error', description: e instanceof Error ? e.message : String(e) });
  } finally {
    helpOpen = false;
  }
}
// ---- the notification centre (U5.07) ------------------------------------------------
// With the Tiles API, a bell in the top bar: what waits for you on the site (warnings assigned to
// you, reviews asked of you, insights to review, imports that didn't finish), asked for at most once
// a minute; new items are announced politely; the sheet lists them, each linked, to mark read.
const bell = need(document, '#inbox-open');
bell.insertAdjacentHTML('afterbegin', icon('bell'));
let inbox: { key: string; data: Inbox } | null = null;
let inboxAsked: { key: string; at: number } | null = null; // when it was last asked (answered or not)
let inboxSeen: Set<string> | null = null; // the unread keys last time: what is new since
let inboxAsking = false;
let inboxWrites = 0; // a mark read since a question was asked makes its answer stale
const inboxKey = (): string =>
  api && ctx.ontology.site ? `${api.baseUrl}|${ctx.ontology.site.id}|${ctx.ontology.userId}` : '';
function drawBell(): void {
  const key = inboxKey();
  bell.hidden = !key || ctx.ontology.status !== 'ready';
  const unread = inbox?.key === key ? inbox.data.unread : 0;
  bell.querySelector('.bell-count')?.remove();
  if (unread)
    bell.insertAdjacentHTML('beforeend', `<span class="bell-count" aria-hidden="true">${bellCount(unread)}</span>`);
  bell.setAttribute('aria-label', bellLabel(unread));
  bell.dataset.tooltip = bellLabel(unread);
}
function keepInbox(key: string, data: Inbox): void {
  if (inbox?.key !== key) inboxSeen = null; // another site or person: what waits is not news
  const said = announcement(arrivals(inboxSeen, data.items));
  if (said) need(document, '#announcer').textContent = said;
  inbox = { key, data };
  inboxSeen = new Set(data.items.filter((i) => !i.read).map((i) => i.key));
  drawBell();
  document.dispatchEvent(new CustomEvent('tiles:inbox'));
}
// Asks what waits, at most once a minute (counted from when it was asked, so the minute's timer
// finds it due), failed or not; `force` asks now.
function refreshInbox(force = false): void {
  const key = inboxKey();
  const site = ctx.ontology.site;
  drawBell();
  if (!api || !site || !key || ctx.ontology.status !== 'ready' || inboxAsking) return;
  if (!force && inboxAsked?.key === key && Date.now() - inboxAsked.at < INBOX_POLL_MS - 1000) return;
  inboxAsking = true;
  inboxAsked = { key, at: Date.now() };
  const writes = inboxWrites;
  api.inbox.get(site.id).then(
    (data) => {
      inboxAsking = false;
      if (inboxKey() === key && writes === inboxWrites) keepInbox(key, data);
    },
    () => {
      inboxAsking = false; // kept as it was; asked again in a minute
    },
  );
}
setInterval(() => {
  if (document.visibilityState === 'visible') refreshInbox();
}, INBOX_POLL_MS);
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') refreshInbox();
});
async function openInbox(): Promise<void> {
  const site = ctx.ontology.site;
  const key = inboxKey();
  if (!api || !site || !key) return;
  const client = api;
  const items = (): InboxItem[] => (inbox?.key === key ? inbox.data.items : []);
  // Marks read; the list drawn again keeps the focus near where it was (the item's link).
  const markRead = async (keys: string[], body: HTMLElement): Promise<void> => {
    inboxWrites++;
    try {
      keepInbox(key, await client.inbox.read(site.id, keys));
    } catch {
      // the client showed why
    }
    const focused = keys.length === 1 ? keys[0] : null;
    morph(body, inboxHtml(items()));
    if (focused) body.querySelector<HTMLElement>(`[data-inbox-open="${CSS.escape(focused)}"]`)?.focus();
  };
  ux('help', 'inbox');
  await sheet(
    {
      title: t('app.inbox.title'),
      label: site.name,
      contentHtml: `<div data-inbox>${inbox?.key === key ? inboxHtml(items()) : loadingState(t('app.inbox.loading'))}</div>`,
      footHtml: button(t('app.inbox.markAll'), { attrs: { 'data-inbox-all': true } }),
    },
    (dialog) => {
      const body = dialog.querySelector<HTMLElement>('[data-inbox]');
      if (!body) return;
      // The latest, as it opens; the list follows what the bell learns while it is open.
      refreshInbox(true);
      const redraw = () => {
        if (body.isConnected) morph(body, inboxHtml(items()));
      };
      document.addEventListener('tiles:inbox', redraw);
      dialog.addEventListener('close', () => document.removeEventListener('tiles:inbox', redraw), { once: true });
      dialog.addEventListener('click', (e) => {
        const t = e.target instanceof Element ? e.target : null;
        const one = t?.closest<HTMLElement>('[data-inbox-read]')?.dataset.inboxRead;
        if (one) void markRead([one], body);
        // Mark all read: those shown (one that arrives meanwhile stays new).
        else if (t?.closest('[data-inbox-all]')) {
          const shown = [...body.querySelectorAll<HTMLElement>('[data-inbox-read]')].flatMap((b) =>
            b.dataset.inboxRead ? [b.dataset.inboxRead] : [],
          );
          if (shown.length) void markRead(shown, body);
        }
        // Opening an item marks it read (its link closes the sheet).
        const opened = t?.closest<HTMLElement>('[data-inbox-open]')?.dataset.inboxOpen;
        if (opened && items().some((i) => i.key === opened && !i.read)) {
          inboxWrites++;
          void client.inbox.read(site.id, [opened]).then(
            (data) => keepInbox(key, data),
            () => undefined,
          );
        }
      });
    },
  );
}
bell.addEventListener('click', () => void openInbox());

const helpButton = need(document, '#help-open');
helpButton.insertAdjacentHTML('afterbegin', icon('circle-help'));
helpButton.addEventListener('click', () => void openHelp());

// ---- what's new (U4.08) ------------------------------------------------------
// A dot on the help button for someone who used an earlier version and hasn't read what changed; a
// first visit only notes the version.
if (load<string | null>(SEEN_KEY, null) === null) save(SEEN_KEY, seenOnFirstLoad(keptBefore, VERSION));
function markNews(): void {
  const news = hasNews(load<string | null>(SEEN_KEY, null), VERSION);
  helpButton.classList.toggle('has-news', news);
  helpButton.setAttribute('aria-label', helpLabel(news, VERSION));
  helpButton.dataset.tooltip = helpLabel(news, VERSION);
}
markNews();
let newsOpen = false;
async function openWhatsNew(): Promise<void> {
  if (newsOpen) return;
  newsOpen = true;
  try {
    const w = (await loadHelp()).whatsNew;
    if (!w) {
      toast(t('app.news.missing'), {
        type: 'error',
        description: t('app.news.missingHow'),
      });
      return;
    }
    save(SEEN_KEY, VERSION);
    markNews();
    ux('help', 'whatsnew');
    await sheet({ label: t('app.whatsNew'), title: whatsNewTitle(w), contentHtml: whatsNewHtml(w) });
  } catch (e) {
    toast(t('app.news.failed'), {
      type: 'error',
      description: t('app.news.failedHow', { error: e instanceof Error ? e.message : String(e) }),
    });
  } finally {
    newsOpen = false;
  }
}
document.addEventListener('tiles:whats-new', () => void openWhatsNew());

// ---- feedback (U4.09) --------------------------------------------------------
// "Send feedback": a mood, a few words, and if they choose, their name and a screenshot of the page
// (made when ticked, shown before it is sent, and removable). It goes to the site's admins.
let feedbackOpen = false;
async function openFeedback(): Promise<void> {
  const client = api;
  const site = ctx.ontology.site;
  if (!client || !site) {
    toast(t('app.feedback.needsApi'), {
      type: 'info',
      description: t('app.feedback.needsApiHow'),
    });
    return;
  }
  if (feedbackOpen) return;
  feedbackOpen = true;
  const view = currentView();
  ux('help', 'feedback');
  try {
    await panelDialog(
      {
        title: t('app.help.sendFeedback'),
        body: t('app.feedback.lead'),
        contentHtml: formHtml({
          page: view.title,
          version: VERSION,
          name: state.user.name,
          canShoot: canCapture(),
        }),
      },
      (dialog, close) => {
        const form = need<HTMLFormElement>(dialog, '[data-feedback-form]');
        form.noValidate = true;
        let shot: string | null = null;
        let taking = 0;
        const box = dialog.querySelector<HTMLInputElement>('[data-feedback-shot]');
        const preview = dialog.querySelector<HTMLElement>('[data-feedback-preview]');
        const unshot = (): void => {
          taking++;
          shot = null;
          if (box) box.checked = false;
          if (preview) {
            preview.hidden = true;
            preview.replaceChildren();
          }
        };
        box?.addEventListener('change', () => {
          if (!box.checked || !preview) return unshot();
          const mine = ++taking;
          preview.hidden = false;
          preview.innerHTML = `<p class="small soft" role="status">${esc(t('app.feedback.taking'))}</p>`;
          void capturePage().then((url) => {
            if (mine !== taking || !box.checked) return;
            if (!url) {
              unshot();
              toast(t('app.feedback.shotFailed'), {
                type: 'error',
                description: t('app.feedback.shotFailedHow'),
              });
              return;
            }
            shot = url;
            preview.innerHTML = previewHtml(url);
            preview.querySelector('[data-feedback-unshot]')?.addEventListener('click', () => {
              unshot();
              box.focus();
            });
          });
        });
        dialog.querySelector('[data-feedback-cancel]')?.addEventListener('click', close);
        // A mood chosen puts its error right.
        form.addEventListener('change', (e) => {
          const first = form.querySelector<HTMLInputElement>('input[name="mood"]');
          if (first && e.target instanceof HTMLInputElement && e.target.name === 'mood') setFieldError(first, null);
        });
        let sending = false;
        form.addEventListener('submit', (e) => {
          e.preventDefault();
          if (sending) return;
          const mood = form.querySelector<HTMLInputElement>('input[name="mood"]:checked')?.value ?? '';
          const text = form.querySelector<HTMLTextAreaElement>('textarea[name="text"]')?.value ?? '';
          const errors = [
            ...(mood ? [] : [{ name: 'mood', message: t('app.feedback.needMood') }]),
            ...(text.trim() ? [] : [{ name: 'text', message: t('app.feedback.needText') }]),
          ];
          if (errors.length) {
            showErrors(form, errors);
            // The mood's error under the three choices, not inside the first.
            const note = form.querySelector('.moods .field-error');
            if (note) form.querySelector('.moods > div')?.after(note);
            return;
          }
          clearErrors(form);
          const named = form.querySelector<HTMLInputElement>('input[name="named"]')?.checked ?? false;
          const button = need<HTMLButtonElement>(form, 'button[type="submit"]');
          sending = true;
          setBusy(button, true);
          client.feedback
            .send(
              site.id,
              feedbackBody({
                mood,
                text,
                named,
                screenshot: shot,
                page: view.id,
                version: VERSION,
                userAgent: navigator.userAgent,
              }),
            )
            .then(
              () => {
                ux('task', 'feedback.sent');
                close();
                toast(t('app.feedback.sent'), { type: 'success', description: t('app.feedback.thanks') });
              },
              () => undefined, // the client said why; what was typed stays
            )
            .finally(() => {
              sending = false;
              setBusy(button, false);
            });
        });
      },
    );
  } finally {
    feedbackOpen = false;
  }
}
document.addEventListener('tiles:feedback', () => void openFeedback());
const palette = installPalette({
  items(): PaletteItem[] {
    const pages = NAV.flatMap((g) =>
      g.items.map((v) => ({
        id: `page:${v.id}`,
        label: v.title,
        group: t('app.palette.group.pages'),
        icon: v.icon,
        hint: groupName(g.group) || undefined,
        run: go(`#/${v.id === 'home' ? '' : v.id}`),
      })),
    );
    const actions: PaletteItem[] = [
      {
        id: 'do:ask',
        label: t('app.palette.do.ask'),
        group: t('app.palette.group.actions'),
        icon: 'sparkles',
        keywords: 'question chat ai',
        run: go('#/chat'),
      },
      {
        id: 'do:triage',
        label: t('app.palette.do.triage'),
        group: t('app.palette.group.actions'),
        icon: 'triangle-alert',
        keywords: 'alarm acknowledge assign resolve inbox',
        run: go('#/warnings'),
      },
      {
        id: 'do:ontology',
        label: t('app.palette.do.ontology'),
        group: t('app.palette.group.actions'),
        icon: 'network',
        keywords: 'node machine line add edit commit model plant',
        run: go('#/ontology'),
      },
      {
        id: 'do:review',
        label: t('app.palette.do.review'),
        group: t('app.palette.group.actions'),
        icon: 'git-pull-request',
        keywords: 'approve reject ontology commit',
        run: go('#/reviews'),
      },
      {
        id: 'do:correlate',
        label: t('app.palette.do.correlate'),
        group: t('app.palette.group.actions'),
        icon: 'chart-scatter',
        keywords: 'root cause csv upload effect scrap ng',
        run: go('#/correlate'),
      },
      {
        id: 'do:site',
        label: t('app.palette.do.site'),
        group: t('app.palette.group.actions'),
        icon: 'factory',
        keywords: 'onboarding wizard plant agent',
        run: go('#/onboarding'),
      },
      {
        id: 'do:plot',
        label: t('app.palette.do.plot'),
        group: t('app.palette.group.actions'),
        icon: 'chart-line',
        keywords: 'explorer chart readings',
        run: go('#/explorer'),
      },
      {
        id: 'do:import',
        label: t('app.palette.do.import'),
        group: t('app.palette.group.actions'),
        icon: 'upload',
        keywords: 'csv historian upload',
        run: go('#/import'),
      },
      {
        id: 'do:docs',
        label: t('app.palette.do.docs'),
        group: t('app.palette.group.actions'),
        icon: 'book-open',
        keywords: 'manual procedure pdf',
        run: go('#/documents'),
      },
      {
        id: 'do:help',
        label: t('app.palette.do.help'),
        group: t('app.palette.group.actions'),
        icon: 'circle-help',
        keywords: 'guide how manual explain',
        run: () => void openHelp(),
      },
      ...TOURS.filter((tour) => canRun(tour, Boolean(api))).map((tour): PaletteItem => ({
        id: `do:tour:${tour.id}`,
        label: t('app.palette.tour', { tour: tour.title }),
        group: t('app.palette.group.actions'),
        icon: 'circle-help',
        keywords: 'tour guide show me how help',
        run: () => startTour(tour.id),
      })),
      {
        id: 'do:whats-new',
        label: t('app.whatsNew'),
        group: t('app.palette.group.actions'),
        icon: 'circle-help',
        keywords: 'changelog release version changes new features',
        run: () => void openWhatsNew(),
      },
      ...(api
        ? [
            {
              id: 'do:feedback',
              label: t('app.help.sendFeedback'),
              group: t('app.palette.group.actions'),
              icon: 'message-square',
              keywords: 'feedback comment suggest problem idea complain report',
              run: () => void openFeedback(),
            } satisfies PaletteItem,
          ]
        : []),
      {
        id: 'do:welcome',
        label: t('app.palette.do.welcome'),
        group: t('app.palette.group.actions'),
        icon: 'circle-help',
        keywords: 'first run role start page getting started demo',
        run: () => void showWelcome(),
      },
      {
        id: 'do:glossary',
        label: t('glossary.title'),
        group: t('app.palette.group.actions'),
        icon: 'book-a',
        keywords: 'terms words meaning definitions',
        run: go('#/glossary'),
      },
      {
        id: 'do:shortcuts',
        label: t('app.palette.do.shortcuts'),
        group: t('app.palette.group.actions'),
        icon: 'keyboard',
        keywords: 'keys hotkeys help turn off single',
        run: () => shortcuts.show(),
      },
      {
        id: 'do:theme',
        label: isDark() ? t('app.palette.do.lightTheme') : t('app.palette.do.darkTheme'),
        group: t('app.palette.group.actions'),
        icon: isDark() ? 'sun' : 'moon',
        keywords: 'theme dark light mode appearance',
        run: () => need(document, '#theme').click(),
      },
    ];
    // Another of the API's sites to work on (the one shown is left out).
    const here = ctx.ontology.site?.id;
    const sites: PaletteItem[] =
      api && ctx.ontology.status === 'ready'
        ? knownSites
            .filter((s) => s.id !== here)
            .map((s) => ({
              id: `site:${s.id}`,
              label: t('app.palette.switchSite', { site: s.name }),
              group: t('app.palette.group.sites'),
              icon: 'factory',
              keywords: `${SITE_WORDS} ${s.slug}`,
              run: () => ctx.setDataSource({ ...dataSource, siteId: s.id }),
            }))
        : [];
    const guide = helpLoaded();
    if (!guide && !helpAsked) {
      helpAsked = true;
      loadHelp().catch(() => {}); // the Help page and the help button say when it can't be loaded
    }
    const helpFound = guide
      ? helpItems(guide, (href) => {
          location.hash = href;
        })
      : [];
    return [...pages, ...actions, ...sites, ...helpFound, ...glossaryItems()];
  },
  canSearch: () => Boolean(api && ctx.ontology.site),
  // Where records picked come from: they come back among the recent picks there only.
  scope: () => (api && ctx.ontology.site ? `${api.baseUrl}|${ctx.ontology.site.id}` : 'local'),
  // The site's records (U4.01): signals, ontology nodes, warnings, insights, documents and apps.
  async search(q) {
    const site = ctx.ontology.site;
    if (!api || !site) return [];
    return searchItems(await api.search(site.id, q, { limit: 5 }), (href) => {
      location.hash = href;
    });
  },
  // What is typed, as a question for the copilot (put in its box: Enter sends it).
  typed: (q) => [
    {
      id: 'do:ask-this',
      label: t('app.palette.askThis', { question: q }),
      group: t('app.palette.group.ask'),
      icon: 'sparkles',
      run: () => {
        prefill(q);
        if (routeOf(location.hash) === 'chat')
          ctx.rerender(); // already there: the box shows it now
        else location.hash = '#/chat';
      },
    },
  ],
});
const searchButton = need(document, '#palette-open');
searchButton.insertAdjacentHTML('afterbegin', icon('search'));
if (/Mac|iPhone|iPad/.test(navigator.platform)) need(searchButton, 'kbd').textContent = '⌘K';
searchButton.addEventListener('click', () => palette.open());

// Keyboard shortcuts (U4.03): g then a letter, ?, and the keys the page's buttons and fields name.
const shortcuts = installShortcuts({
  root: need(document, '#view'),
  go: (page) => go(`#/${page === 'home' ? '' : page}`)(),
  title: (page) => NAV.flatMap((g) => g.items).find((v) => v.id === page)?.title ?? null,
  palette: () => palette.open(),
  changed: () => {
    keyHint();
    ctx.rerender();
  },
});
// The search button names / only while single keys are on.
function keyHint(): void {
  searchButton.setAttribute('aria-keyshortcuts', `Control+K Meta+K${shortcutsOn() ? ' /' : ''}`);
}
keyHint();
need(document, '#menu').addEventListener('click', () => {
  if (need(document, '#sidebar').classList.contains('open')) closeMenu();
  else openMenu();
});
// The phone menu (U3.06): a scrim behind it closes it; the focus stays in it while it is open (Tab
// goes round); a swipe to the left closes it.
need(document, '#scrim').addEventListener('click', () => closeMenu());
// The phone layout's menu, open when the window widens past it: closed (the menu is beside the page).
const phoneLayout = matchMedia('(max-width: 820px)');
phoneLayout.addEventListener('change', () => {
  if (!phoneLayout.matches) closeMenu();
});
document.addEventListener('keydown', (e) => {
  const sidebar = need(document, '#sidebar');
  if (e.key !== 'Tab' || !sidebar.classList.contains('open') || !phoneLayout.matches) return;
  const stops = [...sidebar.querySelectorAll<HTMLElement>('a[href], button:not([disabled])')].filter(
    (el) => el.offsetParent !== null,
  );
  const first = stops[0];
  const last = stops.at(-1);
  if (!first || !last) return;
  const at = document.activeElement;
  if (e.shiftKey && (at === first || !sidebar.contains(at))) {
    e.preventDefault();
    last.focus();
  } else if (!e.shiftKey && (at === last || !sidebar.contains(at))) {
    e.preventDefault();
    first.focus();
  }
});
let swipe: { x: number; y: number } | null = null;
need(document, '#sidebar').addEventListener(
  'touchstart',
  (e) => {
    const t = e.touches[0];
    swipe = t ? { x: t.clientX, y: t.clientY } : null;
  },
  { passive: true },
);
need(document, '#sidebar').addEventListener(
  'touchmove',
  (e) => {
    const t = e.touches[0];
    if (!swipe || !t) return;
    const dx = t.clientX - swipe.x;
    if (dx < -60 && Math.abs(t.clientY - swipe.y) < Math.abs(dx)) {
      swipe = null;
      closeMenu();
    }
  },
  { passive: true },
);
// "Skip to content" moves the focus past the navigation (a #view link would be read as a route).
need(document, '[data-skip]').addEventListener('click', (e) => {
  e.preventDefault();
  need(document, '#view').focus();
});
// The menu's own buttons: fold a group, pin a page, the icon rail. A link closes the phone menu.
need(document, '#nav').addEventListener('click', (e) => {
  const el = e.target instanceof Element ? e.target : null;
  const fold = el?.closest<HTMLElement>('[data-nav-fold]');
  const pin = el?.closest<HTMLElement>('[data-nav-pin]');
  const saved = el?.closest<HTMLElement>('[data-nav-view]')?.dataset.navView;
  const view = saved ? viewsFor(ctx)?.find((v) => v.id === saved) : undefined;
  if (view) {
    e.preventDefault();
    openView(ctx, view); // its table settings, then its address
    return closeMenu();
  }
  if (fold) setPrefs(toggleFold(prefs(), fold.dataset.navFold ?? ''));
  else if (pin) {
    const next = togglePin(prefs(), pin.dataset.navPin ?? '');
    if (next === prefs()) toast(t('app.maxPinned', { max: MAX_PINNED }));
    else setPrefs(next);
  } else if (el?.closest('[data-nav-rail]')) setPrefs({ ...prefs(), rail: !prefs().rail });
  else return closeMenu();
  renderNav(currentView());
});
// Escape closes the phone menu, and gives the focus back to its button.
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape' || !need(document, '#sidebar').classList.contains('open')) return;
  closeMenu(); // the focus goes back to the menu button
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

function openMenu(): void {
  need(document, '#sidebar').classList.add('open');
  need(document, '#menu').setAttribute('aria-expanded', 'true');
  need(document, '#scrim').hidden = false;
  // Into the menu, at the page shown (or its first link).
  // (The page shown may be in a folded group: then the first link shown.)
  const shown = (el: HTMLElement | null) => (el && el.offsetParent !== null ? el : null);
  const here =
    shown(document.querySelector<HTMLElement>('#nav [aria-current="page"]')) ??
    [...document.querySelectorAll<HTMLElement>('#sidebar a[href]')].find((el) => el.offsetParent !== null);
  here?.focus({ preventScroll: true });
}
function closeMenu(): void {
  const sidebar = need(document, '#sidebar');
  const wasOpen = sidebar.classList.contains('open');
  sidebar.classList.remove('open');
  need(document, '#menu').setAttribute('aria-expanded', 'false');
  need(document, '#scrim').hidden = true;
  // Closed by the scrim or a swipe with the focus in it: the focus goes back to the menu button.
  // (Pressing the scrim has already moved the focus to the page's body.)
  const at = document.activeElement;
  if (wasOpen && (!at || at === document.body || sidebar.contains(at)))
    need(document, '#menu').focus({ preventScroll: true });
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
  navigated = true;
  closeMenu(); // whatever link was followed: the menu's, the brand, or one in the page
  leaving(); // the page left keeps the place it was scrolled to (U3.05)
  const root = need(document, '#view');
  const newPage = currentView().id !== shownView;
  // The link followed to this record, when it was a click on a link to exactly this place.
  // A record opened from its list in a split view (U3.08): the list stays, and so does the focus.
  const fromList =
    !newPage && clicked?.closest('.split-list') ? clicked.closest('[data-key]')?.getAttribute('data-key') : null;
  // Opened beside its list, a record doesn't grow from the link: the page head stays as it was.
  const from = !newPage && !fromList && clicked?.isConnected && clicked.hash === location.hash ? clicked : null;
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
    // A record opened beside its list leaves the focus on the list's row (on a narrow screen the
    // record takes the list's place, so the heading takes it).
    const row = fromList ? root.querySelector(`.split-list [data-key="${CSS.escape(fromList)}"]`) : null;
    const stay = row && shown(row) ? rowTarget(row) : null;
    if (stay) return stay.focus({ preventScroll: true });
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
function start(): void {
  render();
  if (!api) firstRun(); // in local mode the person is this browser's profile, known at once
  setTimeout(makeDemoSoon, 0);
  void (async () => {
    await finishSignIn(); // so the first API calls carry the new token
    await refreshAuth();
    await sendSaved();
    await connectOntology();
  })();
}
// In the language chosen (U6.03): another than English first loads its messages, then draws.
const language = chosenLanguage();
if (language === 'en') start();
else
  void useLanguage(language).then(() => {
    translateStatic(document);
    start();
  });
// Chosen in Settings: kept, loaded, and every word on the page said again in it.
window.addEventListener('tiles:language', (e) => {
  const code = (e as CustomEvent<string>).detail;
  keepLanguage(code);
  void useLanguage(code).then(() => {
    translateStatic(document);
    render();
  });
});
