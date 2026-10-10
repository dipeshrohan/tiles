// Types shared by the app shell and the page views.

import type { IconName } from '../lib/icons.ts';
import type { ToastOptions } from '../lib/toaster.ts';
import type { ApiClient, AuthConfig, DataSource, Membership, Site } from '../lib/api.ts';
import type { OntologyStore } from '../lib/ontology-store.ts';
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
  // Where in the page the URL points, after the page itself (U1.06): a record (#12) or a place
  // (Line 2 › DC-01), each with its link. Shown in the top bar's breadcrumbs.
  crumbs?(ctx: Context): Crumb[];
}

export interface Crumb {
  label: string;
  href?: string;
}
