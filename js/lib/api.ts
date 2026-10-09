// Typed client for the Tiles API (api/). Every call goes through `request`,
// which adds the identity header, sends and parses JSON, and turns any
// failure into an ApiError that is also passed to `onError` (the app shows
// it as a toast). Pure apart from `fetch`, which tests replace.

import { sseParser, type SseEvent } from './sse.ts';
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
  // What to ask the provider for (an organisation's own may need its API's scope, T5.05).
  scope?: string;
  // The organisation whose own provider this is, or null for the deployment's.
  org?: string | null;
  // Outside production, requests without a token act as the development user.
  dev_identity: boolean;
}

// An organisation's own identity provider (T5.05), e.g. its Entra ID tenant.
export type OrgRole = 'viewer' | 'engineer' | 'admin';
export interface IdentityProviderIn {
  issuer: string;
  client_id: string;
  audience: string;
  scope: string;
  jwks_url: string | null;
  group_roles: Record<string, OrgRole>;
  enforced: boolean;
}
export interface IdentityProvider extends IdentityProviderIn {
  updated_at: string;
  // Confirmed: the admin who saved it signed in through it. Until then it takes no one else.
  verified: boolean;
}

// App Studio (T6.10): templates, and apps configured from them on a site.
export type AppParamKind = 'signal' | 'number' | 'integer' | 'choice' | 'choices';
export interface AppParam {
  name: string;
  label: string;
  kind: AppParamKind;
  default: unknown;
  minimum: number | null;
  maximum: number | null;
  choices: [string, string][]; // [value, label]
  optional: boolean;
  help: string;
}
export interface AppTemplate {
  id: string;
  version: number;
  title: string;
  summary: string;
  params: AppParam[];
}
export type AppConfig = Record<string, unknown>;
export interface StudioApp {
  number: number;
  name: string;
  template: string;
  template_version: number;
  template_title: string;
  config: AppConfig;
  signal_tag: string | null;
  created_by: string;
  created_at: string;
  updated_at: string;
}
export interface AppResult {
  app: StudioApp;
  status: 'ok' | 'alert' | 'no_data';
  headline: string;
  text: string;
  signal_id: string;
  tag: string;
  unit: string | null;
  start: string;
  end: string;
  gap_seconds: number;
  points: { at: string; value: number }[];
  levels: { label: string; value: number }[];
  spans: { from: string; to: string; label: string }[];
  facts: { label: string; value: number; format: 'number' | 'percent' }[];
}

// A token an identity provider's SCIM client provisions users with (never shown again).
export interface ScimToken {
  id: string;
  name: string;
  created_at: string;
  last_used_at: string | null;
  revoked_at: string | null;
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
  source: 'person' | 'copilot'; // who wrote the ops: its author, or the copilot for them (T4.09)
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

export interface NewSite {
  name: string;
  slug: string; // lower case, digits and dashes; new in the organisation
  timezone: string; // IANA, e.g. Europe/Berlin
}

// How far a site is set up (T6.06), worked out by the API from the site's data.
export interface Onboarding {
  steps: { key: 'site' | 'outline' | 'agent' | 'mapping' | 'dashboard'; done: boolean; detail: string }[];
  next: 'site' | 'outline' | 'agent' | 'mapping' | 'dashboard' | null; // null: set up
  machines: number;
  agents: number;
  agents_seen: number;
  tags: number;
  mapped: number;
  dashboard: { id: string; label: string } | null; // the machine to open first
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
  event_kind: 'downtime' | 'scrap' | 'other' | null; // an event stream (T3.10): each reading is an event
  asset: string | null; // the machine it belongs to, as the MES names it
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
  Pick<
    SignalInfo,
    | 'unit'
    | 'sample_rate_hz'
    | 'description'
    | 'node_id'
    | 'range_min'
    | 'range_max'
    | 'stuck_after_s'
    | 'event_kind'
    | 'asset'
  >
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

// The wear check (T3.13): has a signal's level moved from its baseline, how fast, and when does it
// reach a limit.
export interface WearCheckQuery {
  end?: string; // excluded; default: just after the latest reading
  recent_hours?: number;
  baseline_hours?: number;
  bucket_minutes?: number;
  direction?: 'up' | 'down' | 'either';
  threshold?: number; // a fraction of the baseline
  limit?: number | null;
  last?: number;
}

export interface WearCheckResult {
  signal_id: string;
  tag: string;
  unit: string | null;
  start: string;
  recent_from: string;
  end: string;
  verdict: 'wearing' | 'stable' | 'not_enough_data';
  baseline: number | null;
  last: number | null;
  change: number | null;
  slope_per_day: number | null;
  hours_to_limit: number | null;
  baseline_buckets: number;
  recent_buckets: number;
  text: string;
  buckets: { at: string; value: number; n: number }[];
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

// Warnings a detector raised, and people's work on them (T3.07).
export type WarningStatus = 'raised' | 'acknowledged' | 'resolved';
export type WarningOutcome = 'true_alarm' | 'false_alarm' | 'unknown';

export interface WarningInfo {
  id: string;
  detector_id: string;
  detector: string;
  signal_id: string;
  signal_tag: string;
  started_at: string;
  last_at: string;
  ended_at: string | null; // when the signal came back; null while it is still out
  side: 'above' | 'below';
  peak: number;
  baseline: number;
  threshold: number;
  readings: number;
  status: WarningStatus;
  acknowledged_at: string | null;
  acknowledged_by: string | null;
  assignee_id: string | null;
  assignee: string | null;
  resolved_at: string | null;
  resolved_by: string | null;
  outcome: WarningOutcome | null;
  resolution_note: string;
}

export interface WarningActivity {
  at: string;
  action: 'raised' | 'acknowledged' | 'assigned' | 'unassigned' | 'resolved' | 'reopened' | 'commented';
  actor: string | null;
  assignee: string | null;
  outcome: WarningOutcome | null;
  note: string;
}

export interface WarningDetail extends WarningInfo {
  detector_config: Record<string, unknown>;
  activity: WarningActivity[];
}

export interface WarningQuery {
  state?: 'open' | 'ended' | 'all'; // the signal still out, or back
  status?: WarningStatus | 'unresolved' | 'all';
  assignee?: string; // me, none, or a user's id
  outcome?: WarningOutcome;
  signal_id?: string;
  limit?: number;
  offset?: number;
}

// Notifications (T3.09): your email preferences, the site's Teams channel, and what was sent.
export interface NotificationPrefs {
  on_raised: boolean; // every new warning on the site
  on_assigned: boolean; // a warning someone assigns you
  email: string;
}

export interface TeamsChannel {
  configured: boolean;
  host: string | null; // the webhook's host; the URL itself is never sent back
  on_raised: boolean;
}

export interface Delivery {
  id: number;
  kind: 'warning_raised' | 'warning_assigned';
  channel: 'email' | 'teams';
  recipient: string;
  signal_tag: string;
  warning_id: string;
  created_at: string;
  sent_at: string | null;
  failed_at: string | null; // given up
  attempts: number;
  last_error: string | null;
}

// How the warnings did (T3.10): real warnings against the MES's events, per detector and in total.
export interface Distribution {
  count: number;
  min: number;
  p10: number;
  median: number;
  p90: number;
  max: number;
}

export interface Scores {
  warnings: number;
  true_warnings: number; // an event followed within the horizon
  false_warnings: number;
  pending_warnings: number; // the horizon runs past now
  events: number;
  caught: number;
  recall: number | null;
  precision: number | null;
  false_per_day: number | null;
  warning_seconds: Distribution | null;
  confirmed: { true_alarm: number; false_alarm: number; unknown: number; unresolved: number };
}

export interface DetectorScores extends Scores {
  id: string;
  name: string;
  signal_tag: string;
  asset: string | null;
  matched: boolean; // false: no asset, so its warnings can't be matched to events
}

export interface PerformanceReport {
  start: string;
  end: string;
  horizon_seconds: number;
  totals: Scores;
  detectors: DetectorScores[];
  unwatched: { asset: string; events: number }[]; // events of assets no detector watches
  events: {
    at: string;
    asset: string;
    kind: 'downtime' | 'scrap' | 'other';
    signal_tag: string;
    code: string;
    warned_at: string | null;
    warning_seconds: number | null;
    detector: string | null;
  }[];
}

// Batch tables and the correlation finder (T3.11).
export interface DatasetColumn {
  name: string;
  kind: 'number' | 'text' | 'bool';
}
export type DatasetValue = number | string | boolean | null;

export interface Dataset {
  id: string;
  name: string;
  description: string;
  columns: DatasetColumn[];
  row_count: number;
  created_by: string | null;
  created_at: string;
}

export interface CorrelationFinding {
  segment: string;
  variable: string;
  ng_mean: number | null;
  ok_mean: number | null;
  ng_count: number;
  ok_count: number;
  effect: number; // Cohen's d, failed minus good
  ci_low: number | null; // its 95% confidence interval
  ci_high: number | null;
  clear: boolean; // the interval leaves out 0
  r: number;
}

export interface CorrelationResult {
  rows: number;
  ng: number;
  ok: number;
  findings: CorrelationFinding[];
  explanations: { segment: string; variable: string; text: string }[];
}

// The copilot (T4.01–T4.04): a user's conversations, their stored messages (Messages API content
// blocks) and an answer's grounding report.
export interface CopilotConversation {
  id: string;
  title: string;
  created_at: string;
  updated_at: string;
  messages: number;
  input_tokens: number;
  output_tokens: number;
}

export interface CopilotGrounding {
  grounded: boolean;
  declined: boolean;
  cited: number[];
  unknown_citations: number[];
  unsupported_numbers: string[];
  unsupported_names: string[];
  uncited: boolean;
}

export interface CopilotMessage {
  seq: number;
  role: 'user' | 'assistant';
  content: Record<string, unknown>[];
  meta: { grounding?: CopilotGrounding; withdrawn?: string[] }; // why drafts were withdrawn
  created_at: string;
  feedback?: { rating: 'up' | 'down'; comment: string } | null;
}

// The copilot's usage on a site (T4.07): per UTC day (latest first) and per user, with the limits
// and how much of today's organisation budget is used. Tokens are billed tokens (weighted by price,
// in input tokens) unless named otherwise; times are milliseconds from the question.
export interface CopilotUsageDay {
  day: string;
  questions: number;
  answered: number;
  failed: number;
  over_budget: number;
  ungrounded: number; // answered, but the grounding check found what no result supports
  model_calls: number;
  input_tokens: number;
  output_tokens: number;
  cache_write_tokens: number;
  cache_read_tokens: number;
  billed_tokens: number;
  first_text_p50_ms: number | null;
  first_text_p95_ms: number | null;
  total_p50_ms: number | null;
  total_p95_ms: number | null;
}

export interface CopilotUsage {
  days: CopilotUsageDay[];
  users: { user: string; email: string; questions: number; billed_tokens: number }[];
  today: { org_billed_tokens: number; site_billed_tokens: number };
  limits: {
    question_tokens: number;
    org_daily_tokens: number;
    org_questions_per_minute: number;
    user_questions_per_minute: number;
    max_tokens_per_call: number;
    max_rounds: number;
  };
}

// A stored design run (T4.11): a design model version, its parameters and the output the API
// computed, its parent and the run it restored (by number on the site), and what changed from its parent.
export interface RunChange {
  key: string; // a parameter, or 'version'
  before: number | string | null;
  after: number | string | null;
}

export interface DesignRun {
  number: number;
  model: string; // the registry's key, e.g. 'cell-swelling'
  version: string; // e.g. '2.0.0'
  model_name: string;
  params: Record<string, number>;
  output: Record<string, number | null>;
  units: Record<string, string>;
  parent: number | null;
  restored_from: number | null;
  project: string | null; // its design project (T4.14)
  note: string;
  author: { name: string; email: string };
  created_at: string;
  changes: RunChange[];
  lineage?: number[]; // one run's: its parent, that run's parent, … back to the first
  lineage_complete?: boolean; // false when the lineage was cut (it is long)
}

// A parameter sweep run in the background on the API (T4.12): its progress (`done` of `total`
// points) and, once done, its grid (rows by y, nulls where the model couldn't run).
export interface SweepAxis {
  param: string;
  from: number;
  to: number;
  steps: number;
}

export interface SweepResult {
  output: string;
  unit: string;
  x: { param: string; values: number[] };
  y: { param: string; values: number[] } | null;
  grid: (number | null)[][];
  min: number | null;
  max: number | null;
}

export interface ApiSweep {
  id: string;
  model: string;
  version: string;
  params: Record<string, number>;
  x: SweepAxis;
  y: SweepAxis | null;
  project: string | null;
  status: 'queued' | 'running' | 'done' | 'cancelled' | 'failed';
  total: number;
  done: number;
  error: string | null;
  cancel_requested: boolean;
  created_by: string;
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
  cached: boolean;
  result: SweepResult | null;
}

// A site's shared design project (T4.14): runs belong to one.
export interface DesignProject {
  id: string;
  name: string;
  description: string;
  created_by: string;
  created_at: string;
  runs: number;
  last_run_at: string | null;
}

export interface RunComparison {
  a: DesignRun;
  b: DesignRun;
  changes: RunChange[];
  outputs: {
    name: string;
    unit: string;
    a: number | null;
    b: number | null;
    delta: number | null;
    percent: number | null;
  }[];
}

// A saved insight (T3.12): a finding with what produced it and the evidence it gave when saved.
export type InsightStatus = 'proposed' | 'accepted' | 'rejected';

export type InsightSource =
  | {
      kind: 'correlation';
      dataset_id: string;
      outcome: string;
      ng_values?: DatasetValue[] | null;
      variables?: string[] | null;
      split?: string | null;
      min_effect?: number;
    }
  | { kind: 'series'; signals: string[]; start: string; end: string; points?: number };

export interface InsightSummary {
  number: number;
  title: string;
  summary: string;
  actions: string[];
  kind: InsightSource['kind'];
  status: InsightStatus;
  author: string;
  author_id: string | null;
  created_at: string;
  updated_at: string;
  reviewer: string | null;
  reviewed_at: string | null;
  review_note: string;
}

export interface InsightEvidence {
  dataset?: { id: string; name: string; row_count: number }; // correlation
  result?: CorrelationResult; // its largest findings
  findings_total?: number;
  series?: SignalSeries[]; // series
}

export interface Insight extends InsightSummary {
  query: InsightSource;
  evidence: InsightEvidence;
}

export interface InsightDraft {
  title: string;
  summary: string;
  actions: string[];
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
  async function headersFor(body: unknown, anonymous: boolean, accept = 'application/json') {
    const headers: Record<string, string> = { Accept: accept };
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    if (!anonymous && options.userEmail) headers['X-Tiles-User'] = options.userEmail;
    const token = anonymous ? null : (options.token ?? (await options.getToken?.()));
    if (token) headers.Authorization = `Bearer ${token}`;
    return headers;
  }

  async function request<T>(
    method: Method,
    path: string,
    body?: unknown,
    { anonymous = false, text = false, blob = false, quiet = false } = {},
  ): Promise<T> {
    const headers = await headersFor(body, anonymous);
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
    if (blob && res.ok) return (await res.blob()) as T;
    let parsed: unknown = null;
    try {
      parsed = await res.json();
    } catch {
      if (res.ok) return fail(new ApiError('The Tiles API sent a response that is not JSON', res.status, requestId));
    }
    if (!res.ok) {
      const error = new ApiError(errorMessage(parsed, res.status), res.status, requestId);
      if (quiet) throw error; // the caller shows it (e.g. a 403 that only means "not for you")
      return fail(error);
    }
    return parsed as T;
  }

  function fail(error: ApiError): never {
    options.onError?.(error);
    throw error;
  }

  // A POST whose answer streams back as server-sent events (the copilot's, T4.04): each event
  // reaches `onEvent` as it arrives; resolves when the stream ends.
  async function streamEvents(path: string, body: unknown, onEvent: (e: SseEvent) => void): Promise<void> {
    const headers = await headersFor(body, false, 'text/event-stream');
    let res: Response;
    try {
      res = await doFetch(base + path, { method: 'POST', headers, body: JSON.stringify(body) });
    } catch {
      return fail(new ApiError(`Can't reach the Tiles API at ${base}`, 0));
    }
    if (!res.ok || !res.body) {
      let parsed: unknown = null;
      try {
        parsed = await res.json();
      } catch {
        // no details
      }
      return fail(new ApiError(errorMessage(parsed, res.status), res.status, res.headers.get('x-request-id')));
    }
    const parser = sseParser(onEvent);
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    for (;;) {
      let chunk: ReadableStreamReadResult<Uint8Array>;
      try {
        chunk = await reader.read();
      } catch {
        return fail(new ApiError('The answer was cut off: the connection to the Tiles API dropped', 0));
      }
      if (chunk.done) break;
      parser.feed(decoder.decode(chunk.value, { stream: true }));
    }
    parser.feed(decoder.decode());
    parser.end();
  }

  const site = (id: string) => `/sites/${encodeURIComponent(id)}/ontology`;
  const warning = (siteId: string, id = '') =>
    `/sites/${encodeURIComponent(siteId)}/warnings${id ? `/${encodeURIComponent(id)}` : ''}`;
  // A query string from the set fields, or nothing.
  const query = (fields: object): string => {
    const params = new URLSearchParams();
    for (const [k, v] of Object.entries(fields)) if (v !== undefined && v !== '') params.set(k, String(v));
    const qs = params.toString();
    return qs ? `?${qs}` : '';
  };

  return {
    baseUrl: base,
    request,
    health: () => request<ApiHealth>('GET', '/health'),
    // With `org`, that organisation's own sign-in (404 when it has none: the caller says so).
    authConfig: (org?: string) =>
      request<AuthConfig>('GET', org ? `/auth/config?org=${encodeURIComponent(org)}` : '/auth/config', undefined, {
        anonymous: true,
        quiet: !!org,
      }),
    me: () => request<Me>('GET', '/me'),
    sites: () => request<Site[]>('GET', '/sites'),
    // Setting up a site (T6.06): organisation admins create one; its progress, step by step.
    createSite: (site: NewSite) => request<Site>('POST', '/sites', site),
    onboarding: (siteId: string) => request<Onboarding>('GET', `/sites/${encodeURIComponent(siteId)}/onboarding`),
    // App Studio (T6.10): templates, and the site's apps made from them.
    appTemplates: () => request<AppTemplate[]>('GET', '/app-templates'),
    apps: {
      list: (siteId: string) => request<StudioApp[]>('GET', `/sites/${encodeURIComponent(siteId)}/apps`),
      create: (siteId: string, app: { name: string; template: string; config: AppConfig }) =>
        request<StudioApp>('POST', `/sites/${encodeURIComponent(siteId)}/apps`, app),
      update: (siteId: string, n: number, app: { name: string; config: AppConfig }) =>
        request<StudioApp>('PUT', `/sites/${encodeURIComponent(siteId)}/apps/${n}`, app),
      archive: (siteId: string, n: number) => request<void>('DELETE', `/sites/${encodeURIComponent(siteId)}/apps/${n}`),
      result: (siteId: string, n: number) =>
        request<AppResult>('GET', `/sites/${encodeURIComponent(siteId)}/apps/${n}/result`),
    },
    // Your organisation's own sign-in and SCIM provisioning (T5.05; organisation admins).
    org: {
      // Your organisation, and whether you manage it.
      me: () => request<{ slug: string | null; name: string | null; admin: boolean }>('GET', '/org'),
      identityProvider: () => request<IdentityProvider | null>('GET', '/org/identity-provider'),
      setIdentityProvider: (p: IdentityProviderIn) => request<IdentityProvider>('PUT', '/org/identity-provider', p),
      removeIdentityProvider: () => request<void>('DELETE', '/org/identity-provider'),
      scimTokens: () => request<ScimToken[]>('GET', '/org/scim-tokens'),
      createScimToken: (name: string) => request<ScimToken & { token: string }>('POST', '/org/scim-tokens', { name }),
      revokeScimToken: (id: string) => request<void>('DELETE', `/org/scim-tokens/${encodeURIComponent(id)}`),
    },
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
      list: (siteId: string, q: SignalQuery = {}) =>
        request<{ total: number; signals: SignalInfo[] }>(
          'GET',
          `/sites/${encodeURIComponent(siteId)}/signals${query(q)}`,
        ),
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
      wearCheck: (siteId: string, signalId: string, q: WearCheckQuery) =>
        request<WearCheckResult>(
          'POST',
          `/sites/${encodeURIComponent(siteId)}/signals/${encodeURIComponent(signalId)}/wear-check`,
          q,
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
    // Warnings and their workflow (T3.07): acknowledge, assign, resolve with an outcome, reopen, comment.
    warnings: {
      list: (siteId: string, q: WarningQuery = {}) => request<WarningInfo[]>('GET', `${warning(siteId)}${query(q)}`),
      get: (siteId: string, id: string) => request<WarningDetail>('GET', warning(siteId, id)),
      acknowledge: (siteId: string, id: string, note = '') =>
        request<WarningDetail>('POST', `${warning(siteId, id)}/acknowledge`, { note }),
      // null unassigns.
      assign: (siteId: string, id: string, userId: string | null, note = '') =>
        request<WarningDetail>('PUT', `${warning(siteId, id)}/assignee`, { user_id: userId, note }),
      resolve: (siteId: string, id: string, outcome: WarningOutcome, note = '') =>
        request<WarningDetail>('POST', `${warning(siteId, id)}/resolve`, { outcome, note }),
      reopen: (siteId: string, id: string, note = '') =>
        request<WarningDetail>('POST', `${warning(siteId, id)}/reopen`, { note }),
      comment: (siteId: string, id: string, note: string) =>
        request<WarningDetail>('POST', `${warning(siteId, id)}/comments`, { note }),
    },
    // The last `days`: each detector's warnings scored against its asset's events (T3.10).
    performance: (siteId: string, q: { days?: number; horizonHours?: number; codes?: string[] } = {}) => {
      const params = new URLSearchParams();
      if (q.days !== undefined) params.set('days', String(q.days));
      if (q.horizonHours !== undefined) params.set('horizon_hours', String(q.horizonHours));
      for (const c of q.codes ?? []) params.append('codes', c);
      const qs = params.toString();
      return request<PerformanceReport>('GET', `/sites/${encodeURIComponent(siteId)}/performance${qs ? `?${qs}` : ''}`);
    },
    // Sets (or clears) the asset a detector watches, which matches its warnings to that asset's events.
    setDetectorAsset: (siteId: string, detectorId: string, asset: string | null) =>
      request<{ id: string; asset: string | null }>(
        'PATCH',
        `/sites/${encodeURIComponent(siteId)}/detectors/${encodeURIComponent(detectorId)}`,
        { asset },
      ),
    datasets: {
      list: (siteId: string) => request<Dataset[]>('GET', `/sites/${encodeURIComponent(siteId)}/datasets`),
      get: (siteId: string, id: string) =>
        request<Dataset & { preview: Record<string, DatasetValue>[] }>(
          'GET',
          `/sites/${encodeURIComponent(siteId)}/datasets/${encodeURIComponent(id)}`,
        ),
      create: (siteId: string, name: string, columns: DatasetColumn[]) =>
        request<Dataset>('POST', `/sites/${encodeURIComponent(siteId)}/datasets`, { name, columns }),
      // At most 5,000 rows a call, appended in order.
      addRows: (siteId: string, id: string, rows: Record<string, DatasetValue>[]) =>
        request<{ received: number; row_count: number }>(
          'POST',
          `/sites/${encodeURIComponent(siteId)}/datasets/${encodeURIComponent(id)}/rows`,
          { rows },
        ),
      remove: (siteId: string, id: string) =>
        request<void>('DELETE', `/sites/${encodeURIComponent(siteId)}/datasets/${encodeURIComponent(id)}`),
      correlate: (
        siteId: string,
        id: string,
        q: { outcome: string; ng_values?: DatasetValue[]; variables?: string[]; split?: string | null },
      ) =>
        request<CorrelationResult>(
          'POST',
          `/sites/${encodeURIComponent(siteId)}/datasets/${encodeURIComponent(id)}/correlate`,
          q,
        ),
    },
    copilot: (() => {
      const base = (siteId: string) => `/sites/${encodeURIComponent(siteId)}/copilot`;
      const conv = (siteId: string, id: string) => `${base(siteId)}/conversations/${encodeURIComponent(id)}`;
      return {
        status: (siteId: string) => request<{ configured: boolean }>('GET', base(siteId)),
        conversations: (siteId: string) => request<CopilotConversation[]>('GET', `${base(siteId)}/conversations`),
        create: (siteId: string, title = '') =>
          request<CopilotConversation>('POST', `${base(siteId)}/conversations`, { title }),
        get: (siteId: string, id: string) =>
          request<CopilotConversation & { history: CopilotMessage[] }>('GET', conv(siteId, id)),
        remove: (siteId: string, id: string) => request<void>('DELETE', conv(siteId, id)),
        ask: (siteId: string, id: string, text: string, onEvent: (e: SseEvent) => void) =>
          streamEvents(`${conv(siteId, id)}/messages`, { text }, onEvent),
        rate: (siteId: string, id: string, seq: number, rating: 'up' | 'down', comment = '') =>
          request<{ rating: 'up' | 'down'; comment: string }>('PUT', `${conv(siteId, id)}/messages/${seq}/feedback`, {
            rating,
            comment,
          }),
        unrate: (siteId: string, id: string, seq: number) =>
          request<void>('DELETE', `${conv(siteId, id)}/messages/${seq}/feedback`),
        usage: (siteId: string, days = 30) => request<CopilotUsage>('GET', `${base(siteId)}/usage${query({ days })}`),
      };
    })(),
    runs: (() => {
      const base = (siteId: string) => `/sites/${encodeURIComponent(siteId)}/runs`;
      return {
        list: (siteId: string, q: { model?: string; project?: string; limit?: number; offset?: number } = {}) =>
          request<{ runs: DesignRun[]; total: number }>('GET', `${base(siteId)}${query(q)}`),
        get: (siteId: string, n: number) => request<DesignRun>('GET', `${base(siteId)}/${n}`),
        create: (
          siteId: string,
          run: {
            model: string;
            version?: string;
            params?: Record<string, number>;
            note?: string;
            parent?: number | null;
            project?: string | null;
          },
        ) => request<DesignRun>('POST', base(siteId), run),
        restore: (siteId: string, n: number, note = '') =>
          request<DesignRun>('POST', `${base(siteId)}/${n}/restore`, { note }),
        compare: (siteId: string, a: number, b: number) =>
          request<RunComparison>('GET', `${base(siteId)}/compare${query({ a, b })}`),
        // A run's audit record with its whole lineage (T4.13): the JSON file as it is, or a PDF report.
        audit: (siteId: string, n: number) =>
          request<string>('GET', `${base(siteId)}/${n}/audit`, undefined, { text: true }),
        auditPdf: (siteId: string, n: number) =>
          request<Blob>('GET', `${base(siteId)}/${n}/audit.pdf`, undefined, { blob: true }),
      };
    })(),
    sweeps: (() => {
      const base = (siteId: string) => `/sites/${encodeURIComponent(siteId)}/sweeps`;
      return {
        start: (
          siteId: string,
          sweep: {
            model: string;
            version?: string;
            params?: Record<string, number>;
            x: SweepAxis;
            y?: SweepAxis | null;
            project?: string | null;
          },
        ) => request<ApiSweep>('POST', base(siteId), sweep),
        get: (siteId: string, id: string) => request<ApiSweep>('GET', `${base(siteId)}/${encodeURIComponent(id)}`),
        list: (siteId: string) => request<ApiSweep[]>('GET', base(siteId)),
        cancel: (siteId: string, id: string) =>
          request<ApiSweep>('POST', `${base(siteId)}/${encodeURIComponent(id)}/cancel`),
      };
    })(),
    designProjects: {
      list: (siteId: string) => request<DesignProject[]>('GET', `/sites/${encodeURIComponent(siteId)}/design-projects`),
      create: (siteId: string, name: string, description = '') =>
        request<DesignProject>('POST', `/sites/${encodeURIComponent(siteId)}/design-projects`, { name, description }),
    },
    insights: (() => {
      const base = (siteId: string) => `/sites/${encodeURIComponent(siteId)}/insights`;
      const one = (siteId: string, n: number) => `${base(siteId)}/${n}`;
      return {
        list: (siteId: string, q: { status?: InsightStatus; limit?: number; offset?: number } = {}) =>
          request<{ insights: InsightSummary[]; total: number }>('GET', `${base(siteId)}${query(q)}`),
        get: (siteId: string, n: number) => request<Insight>('GET', one(siteId, n)),
        create: (siteId: string, draft: InsightDraft, source: InsightSource) =>
          request<Insight>('POST', base(siteId), { ...draft, source }),
        edit: (siteId: string, n: number, changes: Partial<InsightDraft>) =>
          request<Insight>('PATCH', one(siteId, n), changes),
        review: (siteId: string, n: number, decision: 'accepted' | 'rejected', note: string) =>
          request<Insight>('POST', `${one(siteId, n)}/review`, { decision, note }),
        reopen: (siteId: string, n: number) => request<Insight>('POST', `${one(siteId, n)}/reopen`),
        remove: (siteId: string, n: number) => request<void>('DELETE', one(siteId, n)),
      };
    })(),
    notifications: {
      preferences: (siteId: string) =>
        request<NotificationPrefs>('GET', `/sites/${encodeURIComponent(siteId)}/notifications/preferences`),
      setPreferences: (siteId: string, prefs: Pick<NotificationPrefs, 'on_raised' | 'on_assigned'>) =>
        request<NotificationPrefs>('PUT', `/sites/${encodeURIComponent(siteId)}/notifications/preferences`, prefs),
      // Admins: the site's Teams channel; a null URL removes it.
      teams: (siteId: string) =>
        request<TeamsChannel>('GET', `/sites/${encodeURIComponent(siteId)}/notifications/teams`),
      // `undefined` keeps the channel and changes only whether it hears of new warnings.
      setTeams: (siteId: string, webhookUrl: string | null | undefined, onRaised = true) =>
        request<TeamsChannel>('PUT', `/sites/${encodeURIComponent(siteId)}/notifications/teams`, {
          ...(webhookUrl === undefined ? {} : { webhook_url: webhookUrl }),
          on_raised: onRaised,
        }),
      deliveries: (siteId: string, q: { state?: 'all' | 'pending' | 'sent' | 'failed'; limit?: number } = {}) =>
        request<Delivery[]>('GET', `/sites/${encodeURIComponent(siteId)}/notifications${query(q)}`),
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
// is handy for demos and tests; `?api=local` forces local mode. `deployed` is
// the API a deployment serves the app with (the `tiles-api` meta tag, T5.09):
// the default until this browser chooses otherwise in Settings.
export function resolveDataSource(saved: Partial<DataSource> | null, search: string, deployed = ''): DataSource {
  const fallback: DataSource = isHttpUrl(deployed)
    ? { mode: 'api', apiUrl: normalizeBaseUrl(deployed) }
    : DEFAULT_DATA_SOURCE;
  const source: DataSource = { ...fallback, ...(saved ?? {}) };
  if (source.mode !== 'local' && source.mode !== 'api') source.mode = 'local';
  const param = new URLSearchParams(search).get('api');
  if (param === 'local') return { ...source, mode: 'local' };
  if (param && isHttpUrl(param)) return { mode: 'api', apiUrl: normalizeBaseUrl(param) };
  return source;
}
