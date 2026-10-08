// Typed client for the Tiles API (api/). Every call goes through `request`,
// which adds the identity header, sends and parses JSON, and turns any
// failure into an ApiError that is also passed to `onError` (the app shows
// it as a toast). Pure apart from `fetch`, which tests replace.

import type { Commit, DiffStats, Graph, HealthReport, Op } from './types.ts';

export interface Site {
  id: string;
  slug: string;
  name: string;
  org: string;
}

export interface ApiHealth {
  status: 'ok';
  version: string;
  env: string;
}

export type GraphView = 'head' | 'working';

export interface AuthConfig {
  enabled: boolean;
  issuer: string | null;
  client_id: string;
  // Outside production, requests without a token act as the development user.
  dev_identity: boolean;
}

export interface Membership {
  user_id: string;
  email: string;
  name: string;
  role: 'viewer' | 'engineer' | 'admin';
  site_role: 'viewer' | 'engineer' | 'admin';
  org_admin: boolean;
}

export type ReviewStatus = 'open' | 'approved' | 'rejected' | 'withdrawn';

// A change request (T2.12): staged ontology changes waiting for another engineer's review.
export interface ReviewSummary {
  number: number;
  message: string;
  author: string;
  author_id: string | null;
  reviewer: string | null; // the engineer asked to review it; null: anyone
  reviewer_id: string | null;
  status: ReviewStatus;
  stats: DiffStats;
  reverts: string | null; // the commit it reverts
  created_at: string;
  decided_by: string | null;
  decided_at: string | null;
  commit_id: string | null; // the commit its approval made
  comments: number;
}

export interface ReviewComment {
  id: number;
  author: string;
  body: string;
  verdict: 'approved' | 'rejected' | 'withdrawn' | null; // the decision this entry records
  created_at: string;
}

export interface Review extends ReviewSummary {
  ops: Op[];
  thread: ReviewComment[];
  conflict: string | null; // why an open request no longer applies to the committed ontology
}

// A file turned into the ops that bring the committed ontology to it (T2.13).
export interface OntologyImport {
  counts: {
    add_nodes: number;
    remove_nodes: number;
    set_props: number;
    remove_props: number;
    add_edges: number;
    remove_edges: number;
  };
  total: number; // ops planned
  ops: Op[]; // the first 500
  duplicates: string[]; // relationships already there under another id: skipped
  staged: boolean;
  commit: string | null; // the latest commit it was planned against
}

export interface AuditEntry {
  id: number;
  at: string;
  actor_id: string | null;
  actor_name: string;
  action: string;
  entity_type: string;
  entity_id: string;
  before: unknown;
  after: unknown;
  request_id: string | null;
}

export interface EdgeAgent {
  id: string;
  name: string;
  created_at: string;
  last_seen_at: string | null;
  status: 'online' | 'offline' | 'never seen';
  version: string | null;
  hostname: string | null;
  connectors: { name: string; kind: string; status: 'ok' | 'degraded' | 'down'; detail: string }[];
  // The agent's store-and-forward buffer; null when it hasn't reported one.
  buffer: {
    queued: number;
    oldest_at: string | null;
    sent: number;
    dropped: number;
    rejected: number;
    problem: string;
  } | null;
}

export type QualityBadge = 'good' | 'warn' | 'bad' | 'unknown';

// A signal's latest data-quality check (T2.09), over the hours up to its latest reading.
export interface QualityReport {
  badge: QualityBadge;
  checked_at: string;
  window_hours: number;
  first_at: string | null;
  last_at: string | null;
  readings: number;
  period_s: number | null;
  coverage: number | null;
  gaps: number;
  longest_gap_s: number | null;
  stuck_runs: number;
  longest_stuck_s: number | null;
  out_of_range: number;
  source_flagged: number;
  issues: {
    check: 'gaps' | 'stuck' | 'range' | 'source' | 'unit' | 'silent';
    severity: 'warn' | 'bad';
    message: string;
  }[];
}

// A signal in the catalogue (T2.08): a tag, what is known about it, and its latest reading.
export interface SignalInfo {
  id: string;
  tag: string;
  unit: string | null;
  sample_rate_hz: number | null;
  source: string; // edge:<agent>, import:<file> or manual
  description: string;
  node_id: string | null;
  node_label: string | null; // null when unlinked, or when the ontology no longer has it as a Signal node
  range_min: number | null; // the values expected
  range_max: number | null;
  stuck_after_s: number | null; // how long one value may repeat (null: an hour)
  created_at: string;
  last_at: string | null;
  last_value: number | string | boolean | null;
  quality: QualityReport | null; // null until checked
}

export interface SignalQuery {
  q?: string;
  source?: '' | 'edge' | 'import' | 'manual';
  linked?: '' | 'yes' | 'no';
  quality?: '' | QualityBadge | 'unchecked';
  limit?: number;
  offset?: number;
}

export type SignalChange = Partial<
  Pick<SignalInfo, 'unit' | 'sample_rate_hz' | 'description' | 'node_id' | 'range_min' | 'range_max' | 'stuck_after_s'>
>;

// A signal's readings over a range (T2.10): as they are (bucket_s null), or bucketed.
export interface SignalSeries {
  signal_id: string;
  tag: string;
  unit: string | null;
  start: string;
  end: string;
  bucket_s: number | null;
  points: {
    at: string; // the reading's time, or the bucket's start
    value: number | null; // null for text
    min: number | null;
    max: number | null;
    n: number;
    text: string | null;
  }[];
}

// A suggested ontology node for an unmapped tag (T2.11): link an existing node, or create one by
// staging `ops`.
export interface MappingSuggestion {
  signal_id: string;
  tag: string;
  kind: 'link' | 'create';
  score: number;
  node_id: string;
  node_label: string;
  reasons: string[];
  ops: Op[];
}

// One bulk import of readings from a file (T2.07).
export interface ImportRun {
  id: string;
  name: string;
  created_by: string | null;
  created_at: string;
  received: number;
  stored: number; // the rest were already stored
  finished_at: string | null;
}

export interface Me {
  email: string;
  name: string;
  org: string | null;
  via: 'oidc' | 'dev';
}

export class ApiError extends Error {
  readonly status: number;
  readonly requestId: string | null;
  constructor(message: string, status: number, requestId: string | null = null) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.requestId = requestId;
  }
}

export interface ApiOptions {
  baseUrl: string;
  // Until single sign-on (T1.16) the API identifies users by this header.
  userEmail?: string;
  // Bearer token, fixed or fetched per request (refreshed when near expiry).
  token?: string;
  getToken?: () => Promise<string | null>;
  onError?: (error: ApiError) => void;
  fetch?: typeof fetch;
}

type Method = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

// FastAPI errors are {"detail": "..."} or, for validation, {"detail": [{loc, msg}, ...]}.
function errorMessage(body: unknown, status: number): string {
  const detail = (body as { detail?: unknown } | null)?.detail;
  if (typeof detail === 'string' && detail) return detail;
  if (Array.isArray(detail) && detail.length) {
    return detail
      .map((d: { loc?: unknown[]; msg?: string }) => {
        const where = (d.loc ?? []).filter((p) => p !== 'body').join('.');
        return where ? `${where}: ${d.msg ?? 'invalid'}` : (d.msg ?? 'invalid');
      })
      .join('; ');
  }
  return `The Tiles API answered ${status}`;
}

export const isHttpUrl = (url: string): boolean => /^https?:\/\/[^\s/]+/i.test(url);

// A /health answer really from the Tiles API (another service may answer too).
export function isTilesHealth(body: unknown): body is ApiHealth {
  const h = body as Partial<ApiHealth> | null;
  return h?.status === 'ok' && typeof h.version === 'string' && typeof h.env === 'string';
}

export function normalizeBaseUrl(url: string): string {
  return url.trim().replace(/\/+$/, '');
}

export function createApiClient(options: ApiOptions) {
  const base = normalizeBaseUrl(options.baseUrl);
  const doFetch = options.fetch ?? ((...args: Parameters<typeof fetch>) => fetch(...args));

  // `anonymous` requests carry no credentials (e.g. the public /auth/config).
  // `text` answers with the body as it is (a file to download), not parsed as JSON.
  async function request<T>(
    method: Method,
    path: string,
    body?: unknown,
    { anonymous = false, text = false } = {},
  ): Promise<T> {
    const headers: Record<string, string> = { Accept: 'application/json' };
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    if (!anonymous && options.userEmail) headers['X-Tiles-User'] = options.userEmail;
    const token = anonymous ? null : (options.token ?? (await options.getToken?.()));
    if (token) headers.Authorization = `Bearer ${token}`;
    let res: Response;
    try {
      res = await doFetch(base + path, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    } catch {
      return fail(new ApiError(`Can't reach the Tiles API at ${base}`, 0));
    }
    const requestId = res.headers.get('x-request-id');
    if (res.status === 204) return undefined as T;
    if (text && res.ok) return (await res.text()) as T;
    let parsed: unknown = null;
    try {
      parsed = await res.json();
    } catch {
      if (res.ok) return fail(new ApiError('The Tiles API sent a response that is not JSON', res.status, requestId));
    }
    if (!res.ok) return fail(new ApiError(errorMessage(parsed, res.status), res.status, requestId));
    return parsed as T;
  }

  function fail(error: ApiError): never {
    options.onError?.(error);
    throw error;
  }

  const site = (id: string) => `/sites/${encodeURIComponent(id)}/ontology`;

  return {
    baseUrl: base,
    request,
    health: () => request<ApiHealth>('GET', '/health'),
    authConfig: () => request<AuthConfig>('GET', '/auth/config', undefined, { anonymous: true }),
    me: () => request<Me>('GET', '/me'),
    sites: () => request<Site[]>('GET', '/sites'),
    // Your membership (and role) on a site; joins it on first visit.
    membership: (siteId: string) => request<Membership>('GET', `/sites/${encodeURIComponent(siteId)}/me`),
    members: (siteId: string) => request<Membership[]>('GET', `/sites/${encodeURIComponent(siteId)}/members`),
    // Every change on a site, newest first (site admins only).
    audit: (siteId: string, { limit = 100, offset = 0 } = {}) =>
      request<AuditEntry[]>('GET', `/sites/${encodeURIComponent(siteId)}/audit?limit=${limit}&offset=${offset}`),
    // The site's edge agents (T2.01); admins register and revoke them.
    agents: {
      list: (siteId: string) => request<EdgeAgent[]>('GET', `/sites/${encodeURIComponent(siteId)}/agents`),
      // The token is in this answer only: Tiles keeps just its hash.
      register: (siteId: string, name: string) =>
        request<{ agent: EdgeAgent; token: string }>('POST', `/sites/${encodeURIComponent(siteId)}/agents`, { name }),
      revoke: (siteId: string, agentId: string) =>
        request<void>('DELETE', `/sites/${encodeURIComponent(siteId)}/agents/${encodeURIComponent(agentId)}`),
    },
    // The signal catalogue (T2.08): search it, describe or link a signal, check its quality (engineers).
    signals: {
      list: (siteId: string, query: SignalQuery = {}) => {
        const params = new URLSearchParams();
        for (const [k, v] of Object.entries(query)) if (v !== undefined && v !== '') params.set(k, String(v));
        const qs = params.toString();
        return request<{ total: number; signals: SignalInfo[] }>(
          'GET',
          `/sites/${encodeURIComponent(siteId)}/signals${qs ? `?${qs}` : ''}`,
        );
      },
      update: (siteId: string, signalId: string, change: SignalChange) =>
        request<SignalInfo>(
          'PATCH',
          `/sites/${encodeURIComponent(siteId)}/signals/${encodeURIComponent(signalId)}`,
          change,
        ),
      // Checks the quality of the listed signals (or all) and stores each report (T2.09).
      checkQuality: (siteId: string, signalIds?: string[], hours?: number) =>
        request<{ checked: number; badges: Record<QualityBadge, number> }>(
          'POST',
          `/sites/${encodeURIComponent(siteId)}/signals/quality`,
          { ...(signalIds ? { signal_ids: signalIds } : {}), ...(hours ? { hours } : {}) },
        ),
      // For each tag no node is linked to: the node to link, or the Signal node to create (T2.11).
      suggestions: (siteId: string, limit = 100) =>
        request<{ unmapped: number; staged: string[]; suggestions: MappingSuggestion[] }>(
          'GET',
          `/sites/${encodeURIComponent(siteId)}/signals/suggestions?limit=${limit}`,
        ),
      get: (siteId: string, signalId: string) =>
        request<SignalInfo>('GET', `/sites/${encodeURIComponent(siteId)}/signals/${encodeURIComponent(signalId)}`),
      // Readings from `from` (included) to `to` (excluded), in at most `points` buckets (T2.10).
      series: (siteId: string, signalId: string, from: string, to: string, points: number) =>
        request<SignalSeries>(
          'GET',
          `/sites/${encodeURIComponent(siteId)}/signals/${encodeURIComponent(signalId)}/series?${new URLSearchParams({ from, to, points: String(points) }).toString()}`,
        ),
    },
    // Bulk imports of readings (T2.07): start one, send its readings in batches, finish it.
    imports: {
      list: (siteId: string) => request<ImportRun[]>('GET', `/sites/${encodeURIComponent(siteId)}/imports`),
      start: (siteId: string, name: string) =>
        request<ImportRun>('POST', `/sites/${encodeURIComponent(siteId)}/imports`, { name }),
      send: (siteId: string, importId: string, samples: { signal: string; at: string; value: number | string }[]) =>
        request<{ received: number; stored: number }>(
          'POST',
          `/sites/${encodeURIComponent(siteId)}/imports/${encodeURIComponent(importId)}/samples`,
          { samples },
        ),
      finish: (siteId: string, importId: string) =>
        request<ImportRun>(
          'POST',
          `/sites/${encodeURIComponent(siteId)}/imports/${encodeURIComponent(importId)}/finish`,
        ),
    },
    ontology: {
      graph: (siteId: string, view: GraphView = 'working') =>
        request<Graph>('GET', `${site(siteId)}/graph?view=${view}`),
      staged: (siteId: string) => request<Op[]>('GET', `${site(siteId)}/staged`),
      stage: (siteId: string, op: Op) => request<Op[]>('POST', `${site(siteId)}/staged`, op),
      // All or none: the API stages every op or, if one doesn't fit, none.
      stageMany: (siteId: string, ops: Op[]) => request<Op[]>('POST', `${site(siteId)}/staged/batch`, ops),
      discard: (siteId: string) => request<void>('DELETE', `${site(siteId)}/staged`),
      commit: (siteId: string, message: string) => request<Commit>('POST', `${site(siteId)}/commits`, { message }),
      history: (siteId: string, { limit = 50, offset = 0 } = {}) =>
        request<Commit[]>('GET', `${site(siteId)}/commits?limit=${limit}&offset=${offset}`),
      revert: (siteId: string, commitId: string) =>
        request<Commit>('POST', `${site(siteId)}/commits/${encodeURIComponent(commitId)}/revert`),
      health: (siteId: string, view: GraphView = 'head') =>
        request<HealthReport>('GET', `${site(siteId)}/health?view=${view}`),
      // The committed ontology as a JSON or CSV file (T2.13).
      exportFile: (siteId: string, format: 'json' | 'csv') =>
        request<string>('GET', `${site(siteId)}/export?format=${format}`, undefined, { text: true }),
      // Plans the ops that bring the committed ontology to the file's and stages them, or only plans (dryRun).
      importFile: (
        siteId: string,
        file: {
          format: 'json' | 'csv';
          content: string;
          name: string;
          mode: 'merge' | 'replace';
          dryRun: boolean;
          // Stage only if the latest commit is still this one (a preview's `commit`).
          expectCommit?: string | null;
        },
      ) =>
        request<OntologyImport>('POST', `${site(siteId)}/import`, {
          format: file.format,
          content: file.content,
          name: file.name,
          mode: file.mode,
          dry_run: file.dryRun,
          ...(file.expectCommit !== undefined ? { expect_commit: file.expectCommit } : {}),
        }),
      // Whether every change needs a review (T2.12); admins set it.
      reviewPolicy: (siteId: string) => request<{ required: boolean }>('GET', `${site(siteId)}/review-policy`),
      setReviewPolicy: (siteId: string, required: boolean) =>
        request<{ required: boolean }>('PUT', `${site(siteId)}/review-policy`, { required }),
    },
    // Change requests (T2.12): your staged changes (or a revert) for another engineer to approve or reject.
    reviews: {
      list: (siteId: string, state: 'open' | 'closed' | 'all' = 'open', { limit = 50, offset = 0 } = {}) =>
        request<ReviewSummary[]>('GET', `${site(siteId)}/reviews?state=${state}&limit=${limit}&offset=${offset}`),
      get: (siteId: string, n: number) => request<Review>('GET', `${site(siteId)}/reviews/${n}`),
      request: (siteId: string, body: { message?: string; reviewer_id?: string; reverts?: string }) =>
        request<Review>('POST', `${site(siteId)}/reviews`, body),
      comment: (siteId: string, n: number, body: string) =>
        request<Review>('POST', `${site(siteId)}/reviews/${n}/comments`, { body }),
      approve: (siteId: string, n: number, comment = '') =>
        request<Review>('POST', `${site(siteId)}/reviews/${n}/approve`, { comment }),
      reject: (siteId: string, n: number, comment: string) =>
        request<Review>('POST', `${site(siteId)}/reviews/${n}/reject`, { comment }),
      // Back into your staged changes; an open request is withdrawn.
      rework: (siteId: string, n: number) => request<Review>('POST', `${site(siteId)}/reviews/${n}/rework`),
    },
  };
}

export type ApiClient = ReturnType<typeof createApiClient>;

// ---- data source flag ------------------------------------------------------
// Where the app reads and writes shared data. "local" keeps everything in this
// browser (the default, and what works from file://); "api" uses the Tiles
// API. Pages switch over one at a time (the ontology first, T1.15).

export interface DataSource {
  mode: 'local' | 'api';
  apiUrl: string;
  // Site to open in API mode; the first one the API lists if unset or gone.
  siteId?: string;
}

export const DEFAULT_DATA_SOURCE: DataSource = { mode: 'local', apiUrl: 'http://localhost:8000' };

// A `?api=<url>` query parameter switches to API mode for this visit, which
// is handy for demos and tests; `?api=local` forces local mode.
export function resolveDataSource(saved: Partial<DataSource> | null, search: string): DataSource {
  const source: DataSource = { ...DEFAULT_DATA_SOURCE, ...(saved ?? {}) };
  if (source.mode !== 'local' && source.mode !== 'api') source.mode = 'local';
  const param = new URLSearchParams(search).get('api');
  if (param === 'local') return { ...source, mode: 'local' };
  if (param && isHttpUrl(param)) return { mode: 'api', apiUrl: normalizeBaseUrl(param) };
  return source;
}
