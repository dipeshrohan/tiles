// Where the ontology page reads and writes its repository. The local store
// keeps it in this browser (the pure functions in ontology.ts); the remote
// store keeps it in the Tiles API, so everyone on a site shares one history.
// Both take the repo the page is showing and resolve to the repo to show next.

import { applyOps, commit, createRepo, discard, revert, stage, workingGraph } from './ontology.ts';
import type { ApiClient, Site } from './api.ts';
import type { Op, Repo } from './types.ts';

export interface OntologyStore {
  readonly kind: 'local' | 'api';
  // Stages ops in order. All are checked against the working graph first,
  // so a batch is never half-applied by a bad op.
  stage(repo: Repo, ops: Op[]): Promise<Repo>;
  discard(repo: Repo): Promise<Repo>;
  commit(repo: Repo, message: string, author: string): Promise<Repo>;
  revert(repo: Repo, commitId: string, author: string): Promise<Repo>;
}

export const localStore: OntologyStore = {
  kind: 'local',
  stage: async (repo, ops) => ops.reduce((r, op) => stage(r, op), repo),
  discard: async (repo) => discard(repo),
  commit: async (repo, message, author) => commit(repo, { message, author }),
  revert: async (repo, id, author) => revert(repo, id, { author }),
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
      for (const op of ops) await o.stage(site.id, op);
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
  };
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
