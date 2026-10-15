// Types shared by the app shell and the page views.

import type { IconName } from '../lib/icons.ts';
import type { ToastOptions } from '../lib/toaster.ts';
import type { ApiClient, AuthConfig, DataSource, Membership, Site } from '../lib/api.ts';
import type { OntologyStore } from '../lib/ontology-store.ts';
import type { Preferences } from '../lib/preferences.ts';
import type { CutterBatch, Detection, Graph, Repo, Run, ScoredEvent, ShotHistory, WeldData } from '../lib/types.ts';

export interface User {
  name: string;
  email: string;
}

export interface ChatMessage {
  role: 'user' | 'bot';
  text: string;
  steps?: string[];
  link?: string;
  skill?: string;
}

// What is saved in the browser between visits.
export interface PersistedState {
  repo: Repo;
  runs: Run[];
  chat: ChatMessage[];
  user: User;
}

export interface AppState extends PersistedState {
  // Synthetic plant data, regenerated from fixed seeds on every load.
  batches: CutterBatch[];
  weld: WeldData;
  shots: ShotHistory;
  detection: Detection;
  scored: ScoredEvent[];
  // Per-view UI state (selected tab, filters, …), not persisted.
  ui: Record<string, object>;
}

export interface Context {
  readonly state: AppState;
  readonly graph: Graph;
  update(mutate: (state: AppState) => void, options?: { rerender?: boolean }): void;
  ui<T extends object>(viewId: string, defaults: T): T;
  rerender(): void;
  // Puts what the page shows into its address (U3.05), for a change that doesn't draw it again.
  address(): void;
  // Whether the demo plant's shots and warnings are worked out (U3.07): made after the first page is
  // drawn, or at once when a page reads them. A page that can wait shows a placeholder until then.
  readonly demoReady: boolean;
  // The work you said you mostly do in the welcome (U4.06: engineer, maintenance, shift-lead,
  // admin), which sets Home's cards (U5.01); null until chosen.
  readonly workRole: string | null;
  // A toast: `type` (success, error…) picks its icon; `action` adds a button (Undo, Retry).
  toast(message: string, opts?: ToastOptions): void;
  reset(): void;
  // Where shared data lives; see DataSource in js/lib/api.ts.
  readonly dataSource: DataSource;
  // The API client in "api" mode, otherwise null. Failed calls show a toast.
  readonly api: ApiClient | null;
  setDataSource(source: DataSource): void;
  readonly ontology: OntologyContext;
  readonly auth: AuthContext;
  // Your preferences (U6.06).
  readonly preferences: PreferencesContext;
}

// A person's preferences (U6.06): as they are now (the language, shortcuts and start page too),
// where they are kept, and changing them, which applies at once.
export interface PreferencesContext {
  readonly current: Preferences;
  readonly kept: 'account' | 'browser'; // with the person (the Tiles API), or in this browser only
  readonly siteZone: string | null; // the site's clock, when there is a site
  readonly pages: readonly { id: string; title: string }[]; // those it can open at
  set(patch: Partial<Preferences>): void;
}

// Signing in to the Tiles API (API mode only).
export interface AuthContext {
  // The API's sign-in settings; null in local mode or until fetched.
  readonly config: AuthConfig | null;
  readonly signedIn: boolean;
  // The organisation last signed in with through its own provider ('' for the API's).
  readonly signInOrg: string;
  // Sends the browser to the sign-in provider (the organisation's own, given its slug: T5.05);
  // it comes back to this page.
  signIn(org?: string): Promise<void>;
  signOut(): Promise<void>;
}

// The ontology repository shown in state.repo, and how to change it.
export interface OntologyContext {
  // "local": this browser. In API mode: "loading" until the first fetch,
  // then "ready", or "error" (with `error`) if the API can't be used.
  readonly status: 'local' | 'loading' | 'ready' | 'error';
  readonly site: Site | null;
  // Your role on the site in API mode; null in local mode (you can do anything).
  readonly role: 'viewer' | 'engineer' | 'admin' | null;
  // API mode: your user id, the site's members, and whether every change needs a review (T2.12).
  readonly userId: string | null;
  readonly members: Membership[];
  readonly reviewRequired: boolean;
  readonly error: string | null;
  // Runs a change against the current store and shows its result. Failures
  // become a toast; resolves to whether the change worked.
  act(change: (store: OntologyStore, repo: Repo) => Promise<Repo>, ok?: string): Promise<boolean>;
  // Fetches the latest repository from the API (no-op in local mode).
  reload(): Promise<void>;
}

export interface View {
  id: string;
  title: string;
  icon: IconName; // a Lucide icon (js/lib/icons.ts), unique to the page
  render(ctx: Context): string;
  bind?(root: HTMLElement, ctx: Context): void;
  // The record or place the page shows, after the page itself (U1.06): #12, or Line 2 › DC-01, each
  // with its link. Read after render and bind, from what they showed; shown in the top bar.
  crumbs?(ctx: Context): Crumb[];
  // A page outside the menu that belongs to another (the style guide to Settings): that page is
  // marked in the menu and comes before it in the breadcrumbs.
  under?: string;
  // What the page shows, in its address (U3.05, js/lib/url-state.ts): `read` takes a link's query
  // into the page's state before it is drawn; `write` gives the state as query values (a default
  // left out), which the address then shows, so a copied link or a reload shows the same.
  query?: {
    read(params: URLSearchParams, ctx: Context): void;
    write(ctx: Context): Record<string, string | null | undefined>;
  };
}

export interface Crumb {
  label: string;
  href?: string;
}
