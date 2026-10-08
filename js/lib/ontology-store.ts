// Where the ontology page reads and writes its repository. The local store
// keeps it in this browser (the pure functions in ontology.ts); the remote
// store keeps it in the Tiles API, so everyone on a site shares one history.
// Both take the repo the page is showing and resolve to the repo to show next.

import { applyOps, commit, createRepo, discard, revert, stage, workingGraph } from './ontology.ts';
import type { ApiClient, Site } from './api.ts';
import type { Graph, Op, Repo } from './types.ts';

export interface OntologyStore {
  readonly kind: 'local' | 'api';
  // Stages ops in order. All are checked against the working graph first,
  // so a batch is never half-applied by a bad op.
  stage(repo: Repo, ops: Op[]): Promise<Repo>;
  discard(repo: Repo): Promise<Repo>;
  commit(repo: Repo, message: string, author: string): Promise<Repo>;
  revert(repo: Repo, commitId: string, author: string): Promise<Repo>;
  // Sends the staged changes (or the revert of a commit) for review instead of
  // committing them (T2.12). Reviews are shared, so only the API store has them.
  requestReview(repo: Repo, request: { message?: string; reviewerId?: string; reverts?: string }): Promise<Repo>;
}

const NO_REVIEWS = 'Reviews need a shared ontology: connect to the Tiles API in Settings';

export const localStore: OntologyStore = {
  kind: 'local',
  stage: async (repo, ops) => ops.reduce((r, op) => stage(r, op), repo),
  discard: async (repo) => discard(repo),
  commit: async (repo, message, author) => commit(repo, { message, author }),
  revert: async (repo, id, author) => revert(repo, id, { author }),
  requestReview: () => Promise.reject(new Error(NO_REVIEWS)),
};

// History is fetched in one page; plenty for the pilot, paged later if needed.
const HISTORY_LIMIT = 500;

export interface RemoteStore extends OntologyStore {
  readonly site: Site;
  load(): Promise<Repo>;
}

export function remoteStore(api: ApiClient, site: Site): RemoteStore {
  const o = api.ontology;
  const load = async (): Promise<Repo> => {
    const [head, staged, history] = await Promise.all([
      o.graph(site.id, 'head'),
      o.staged(site.id),
      o.history(site.id, { limit: HISTORY_LIMIT }),
    ]);
    return { ...createRepo(head), staged, history };
  };
  return {
    kind: 'api',
    site,
    load,
    async stage(repo, ops) {
      applyOps(workingGraph(repo), ops); // throws before anything is sent
      await o.stageMany(site.id, ops); // one request: all staged or none
      return load();
    },
    async discard() {
      await o.discard(site.id);
      return load();
    },
    async commit(_repo, message) {
      await o.commit(site.id, message);
      return load();
    },
    async revert(_repo, commitId) {
      await o.revert(site.id, commitId);
      return load();
    },
    async requestReview(_repo, { message, reviewerId, reverts }) {
      await api.reviews.request(site.id, {
        ...(message ? { message } : {}),
        ...(reviewerId ? { reviewer_id: reviewerId } : {}),
        ...(reverts ? { reverts } : {}),
      });
      return load();
    },
  };
}

// The working graph, or, when the staged ops no longer apply (someone else
// committed a change they conflict with), the head plus the reason. The page
// then shows the head and offers to discard the staged ops.
export function safeWorkingGraph(repo: Repo): { graph: Graph; conflict: string | null } {
  try {
    return { graph: workingGraph(repo), conflict: null };
  } catch (e) {
    return { graph: repo.head, conflict: e instanceof Error ? e.message : String(e) };
  }
}

// The site the app works on: the one saved in settings if it still exists,
// otherwise the first the API lists.
export async function pickSite(api: ApiClient, preferred?: string): Promise<Site> {
  const sites = await api.sites();
  const site = sites.find((s) => s.id === preferred) ?? sites[0];
  if (!site) throw new Error('The Tiles API has no sites yet. Run `tiles-seed` (Docker Compose does this for you).');
  return site;
}

// Every op of a repository's history, oldest first: replaying them rebuilds
// its head. Used to copy the demo ontology into an empty site.
export function historyOps(repo: Repo): Op[] {
  return [...repo.history].reverse().flatMap((c) => c.ops);
}
