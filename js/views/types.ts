// Types shared by the app shell and the page views.

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
  toast(message: string): void;
  reset(): void;
}

export interface View {
  id: string;
  title: string;
  icon: string;
  render(ctx: Context): string;
  bind?(root: HTMLElement, ctx: Context): void;
}
