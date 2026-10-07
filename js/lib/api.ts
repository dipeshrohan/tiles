// Typed client for the Tiles API (api/). Every call goes through `request`,
// which adds the identity header, sends and parses JSON, and turns any
// failure into an ApiError that is also passed to `onError` (the app shows
// it as a toast). Pure apart from `fetch`, which tests replace.

import type { Commit, Graph, HealthReport, Op } from './types.ts';

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

type Method = 'GET' | 'POST' | 'DELETE';

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
  async function request<T>(method: Method, path: string, body?: unknown, { anonymous = false } = {}): Promise<T> {
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
