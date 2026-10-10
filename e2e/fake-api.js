// An in-memory stand-in for the Tiles API's ontology endpoints, for browser
// tests. It runs the same ontology logic as the app (js/lib/ontology.ts,
// loaded through Node's TypeScript type stripping), with one shared head and
// history and staged changes per user, like the real API.
import { createHash, randomUUID } from 'node:crypto';
import { correlationFinder } from '../js/lib/analysis.ts';
import { evaluate as evaluateDesign, getModel as getDesignModel } from '../js/lib/design.ts';
import { median } from '../js/lib/stats.ts';
import { machineOf } from '../js/lib/shopfloor.ts';
import { createServer } from 'node:http';
import {
  applyOp,
  commit,
  createRepo,
  diffStats,
  revert,
  stage,
  workingGraph,
  healthCheck,
} from '../js/lib/ontology.ts';

// With `oidc`, it is also a tiny sign-in provider at /idp that approves every
// request, checks PKCE, and issues opaque tokens the API accepts. With
// `requireSignIn`, requests without a token get 401, as in production.
// `slowWritesMs` delays batch staging, to test answers that arrive late.
// `roles` maps a user's email to their site role (engineer by default).
// `slowAuthConfigMs` delays /auth/config, to test background re-renders.
// `failImportFinish` makes finishing an import fail, as a dropped connection would.
// Like the API's ontology_io.plan: the ops that bring `head` to the file's graph (merge: no removals).
function planImport(head, file, mode) {
  const list = (x) => (Array.isArray(x) ? x : Object.values(x ?? {}));
  const nodes = Object.fromEntries(list(file.nodes).map((n) => [n.id, { props: {}, ...n }]));
  const edges = Object.fromEntries(list(file.edges).map((e) => [e.id, e]));
  for (const n of Object.values(nodes)) {
    const have = head.nodes[n.id];
    if (have && have.label !== n.label)
      return { problem: `node ${n.id} is called '${have.label}', not '${n.label}': rename it by hand` };
  }
  const triple = (e) => `${e.from}|${e.rel}|${e.to}`;
  const existing = new Set(Object.values(head.edges).map(triple));
  const kept = new Set(Object.values(edges).map(triple));
  const removeEdges = [];
  const addEdges = [];
  const duplicates = [];
  for (const e of Object.values(edges)) {
    const same = head.edges[e.id];
    if (same && triple(same) === triple(e)) continue;
    if (same) removeEdges.push({ kind: 'removeEdge', id: e.id });
    else if (existing.has(triple(e))) {
      duplicates.push(e.id);
      continue;
    }
    addEdges.push({ kind: 'addEdge', edge: { id: e.id, from: e.from, rel: e.rel, to: e.to } });
  }
  const removeNodes = [];
  if (mode === 'replace') {
    for (const e of Object.values(head.edges))
      if (!edges[e.id] && !kept.has(triple(e))) removeEdges.push({ kind: 'removeEdge', id: e.id });
    for (const id of Object.keys(head.nodes).sort()) if (!nodes[id]) removeNodes.push({ kind: 'removeNode', id });
  }
  const addNodes = [];
  const setProps = [];
  for (const n of Object.values(nodes)) {
    const have = head.nodes[n.id];
    if (!have) {
      addNodes.push({ kind: 'addNode', node: { id: n.id, type: n.type, label: n.label, props: { ...n.props } } });
      continue;
    }
    for (const [key, value] of Object.entries(n.props))
      if (have.props[key] !== value) setProps.push({ kind: 'setProp', id: n.id, key, value });
    if (mode === 'replace')
      for (const key of Object.keys(have.props))
        if (!(key in n.props)) setProps.push({ kind: 'setProp', id: n.id, key });
  }
  return {
    ops: [...removeEdges, ...removeNodes, ...addNodes, ...setProps, ...addEdges],
    duplicates,
    counts: {
      add_nodes: addNodes.length,
      remove_nodes: removeNodes.length,
      set_props: setProps.filter((op) => 'value' in op).length,
      remove_props: setProps.filter((op) => !('value' in op)).length,
      add_edges: addEdges.length,
      remove_edges: removeEdges.length,
    },
  };
}

// App Studio's templates (T6.10), as GET /app-templates describes them (shortened settings).
const param = (name, label, kind, extra = {}) => ({
  name,
  label,
  kind,
  default: null,
  minimum: null,
  maximum: null,
  choices: [],
  optional: false,
  help: '',
  ...extra,
});
const APP_TEMPLATES = [
  {
    id: 'wear-check',
    version: 1,
    title: 'Wear check',
    summary: "Has a signal's level moved from its baseline, as a wearing tool's does?",
    params: [
      param('signal', 'Signal', 'signal'),
      param('recent_hours', 'Recent window (hours)', 'number', { default: 24, minimum: 1, maximum: 720 }),
      param('threshold_percent', 'Change that counts (%)', 'number', { default: 5, minimum: 0.1, maximum: 1000 }),
      param('limit', 'Worn-out level', 'number', { optional: true }),
    ],
  },
  {
    id: 'spc-limits',
    version: 1,
    title: 'SPC limits',
    summary: 'Is the process in control? A control chart with the Western Electric rules.',
    params: [
      param('signal', 'Signal', 'signal'),
      param('sigmas', 'Limits at (sigma)', 'number', { default: 3, minimum: 1, maximum: 6 }),
      param('rules', 'Rules', 'choices', {
        default: ['beyond_limits', 'trend_of_six'],
        choices: [
          ['beyond_limits', 'a point beyond a control limit'],
          ['trend_of_six', 'six points in a row rising or falling'],
        ],
      }),
    ],
  },
];

export function createFakeApi({
  oidc = false,
  requireSignIn = false,
  signedInAs = 'ana@example.com',
  slowWritesMs = 0,
  roles = {},
  slowAuthConfigMs = 0,
  failImportFinish = false,
  copilot = false, // whether the copilot service is on (T4.01)
  copilotEnabled = true, // whether the site's admins turned it on (threat model G-A4)
} = {}) {
  let origin = '';
  const codes = new Map(); // code -> { challenge, redirectUri }
  const scopesAsked = []; // the scope of each sign-in sent to the provider
  // The organisation's own sign-in (T5.05): its provider (served by /idp too) and SCIM tokens.
  let orgProvider = null;
  const scimTokens = [];
  const tokens = new Set();
  const site = { id: '11111111-1111-1111-1111-111111111111', slug: 'plant-1', name: 'Plant 1', org: 'demo' };
  const sites = [site]; // the organisation's; only `site` is served
  let head = createRepo().head;
  let history = [];
  const staged = new Map(); // email -> Op[]
  const requests = [];
  const agents = []; // { id, name, token, created_at, last_seen_at, hostname, version }
  const imports = []; // newest first: { id, name, created_by, created_at, received, stored, finished_at }
  const samples = new Map(); // "signal|at" -> value: readings stored by imports
  const signals = []; // the catalogue: { id, tag, unit, sample_rate_hz, source, description, node_id, created_at }
  const addSignal = (tag, extra = {}) => {
    let sig = signals.find((x) => x.tag === tag);
    if (!sig) {
      sig = {
        id: randomUUID(),
        tag,
        unit: null,
        sample_rate_hz: null,
        source: 'manual',
        description: '',
        node_id: null,
        range_min: null,
        range_max: null,
        stuck_after_s: null,
        quality: null,
      };
      sig.created_at = new Date().toISOString();
      signals.push(sig);
      signals.sort((a, b) => a.tag.localeCompare(b.tag));
    }
    return Object.assign(sig, extra);
  };
  // Like the API: the node's label (if it's in the committed ontology) and the latest reading.
  const qualityFound = new Map(); // tag -> the report the next quality check gives it (default: good)
  const goodReport = (sig) => ({
    badge: 'good',
    checked_at: new Date().toISOString(),
    window_hours: 24,
    first_at: null,
    last_at: null,
    readings: [...samples.keys()].filter((k) => k.startsWith(`${sig.tag}|`)).length,
    period_s: null,
    coverage: null,
    gaps: 0,
    longest_gap_s: null,
    stuck_runs: 0,
    longest_stuck_s: null,
    out_of_range: 0,
    source_flagged: 0,
    issues: [],
  });
  const slowSearches = new Map(); // search text -> ms to wait before answering
  const failingSearches = new Set(); // search texts answered with an error
  let slowSaves = 0; // ms before a signal change is answered
  let slowChecks = 0; // ms before a quality check is answered
  const signalView = (sig) => {
    const mine = [...samples.entries()].filter(([k]) => k.startsWith(`${sig.tag}|`)).sort();
    const last = mine.at(-1);
    return {
      ...sig,
      node_label: (sig.node_id && head.nodes[sig.node_id]?.label) || null,
      last_at: last ? last[0].split('|')[1] : null,
      last_value: last ? last[1] : null,
    };
  };
  // A site's onboarding progress (T6.06), worked out from the fake's state as the API does.
  const onboarding = () => {
    const machines = Object.values(head.nodes).filter((n) => n.type === 'Machine').length;
    const live = agents.filter((a) => !a.revoked);
    const seen = live.filter((a) => a.last_seen_at).length;
    const tags = signals.filter((x) => !x.source.startsWith('model:'));
    const mapped = tags.filter((x) => x.node_id);
    const counts = new Map();
    for (const x of mapped) {
      const m = head.nodes[x.node_id] ? machineOf(head, x.node_id) : null;
      if (m) counts.set(m, (counts.get(m) ?? 0) + 1);
    }
    const best = [...counts].sort(
      (a, b) => b[1] - a[1] || head.nodes[a[0]].label.localeCompare(head.nodes[b[0]].label),
    )[0];
    const n = (k, w) => `${k} ${w}${k === 1 ? '' : 's'}`;
    const steps = [
      { key: 'site', done: true, detail: 'Created' },
      {
        key: 'outline',
        done: machines > 0,
        detail: machines ? `${n(machines, 'machine')} in the ontology` : 'No machines in the ontology yet',
      },
      {
        key: 'agent',
        done: seen > 0,
        detail: seen
          ? `${seen} agent${seen === 1 ? ' has' : 's have'} called in, ${seen} online now`
          : live.length
            ? `${n(live.length, 'agent')} registered, none has called in yet`
            : 'No edge agent yet',
      },
      {
        key: 'mapping',
        done: mapped.length > 0,
        detail: tags.length ? `${mapped.length} of ${n(tags.length, 'tag')} mapped` : 'No tags have arrived yet',
      },
      {
        key: 'dashboard',
        done: Boolean(best),
        detail: best
          ? `${head.nodes[best[0]].label}: ${n(best[1], 'mapped signal')}`
          : 'Needs a machine with a mapped signal',
      },
    ];
    return {
      steps,
      next: steps.find((x) => !x.done)?.key ?? null,
      machines,
      agents: live.length,
      agents_seen: seen,
      tags: tags.length,
      mapped: mapped.length,
      dashboard: best ? { id: best[0], label: head.nodes[best[0]].label } : null,
    };
  };
  // Change reviews (T2.12), like the API: requests with their ops and comment thread.
  let reviewRequired = false;
  const reviews = []; // { number, message, author, author_id, reviewer, reviewer_id, status, ops, reverts, ... }
  const members = new Set(); // users who have visited the site
  // Warnings (T3.07), like the API: raised by a test (as a detector would), then worked by people.
  const warnings = []; // newest first: the API's fields, plus `activity`
  // Notifications (T3.09): each user's preferences, the site's Teams channel, and messages to list.
  const notifyPrefs = new Map(); // email -> { on_raised, on_assigned }
  let teams = { url: null, on_raised: true };
  const deliveries = []; // newest first, as the API lists them
  let failWarningGets = 0; // answer this many reads of one warning with an error
  // Warning performance (T3.10): the report a test sets, and the queries the page asked it with.
  let performanceReport = null;
  const correlations = []; // each correlate request's body
  const insights = []; // saved insights, as the API returns them, with `evidence`
  const studioApps = []; // App Studio's apps (T6.10), archived ones included
  let lastApp = 0;
  const siteDocuments = []; // Document search (T4.08): { number, title, …, pages: [text], content, archived }
  let appsFailures = 0; // the next lists of templates and apps that fail, as a restarting API's would
  let requestIds = 0; // numbers the request IDs
  let sitesFailures = 0; // the next lists of sites that fail, as an API still starting would
  const plannedFailures = []; // { method, path (RegExp), status, detail }, from failNext
  const plannedDelays = []; // { method, path (RegExp), ms }, from slowNext
  let searchFailures = 0; // the next document searches that fail
  // Design projects and runs (T4.11, T4.14), as the API returns them; outputs from js/lib/design.ts.
  const designProjects = [];
  const designRuns = []; // latest last
  let designRunsDelayMs = 0; // before a list of runs answers
  // Sweeps (T4.12): each one moves on a quarter of its points every time it is read, then is done.
  const designSweeps = [];
  let sweepReadFailures = 0; // reads of a sweep that answer 503 first
  // The copilot: conversations by id ({ id, user, title, created_at, updated_at, history }) and
  // the answers to give next, each { tools: [{ name, input, result }], drafts: [{ text, reason }],
  // answer, grounding? }; with none scripted, it asks back.
  const conversations = new Map();
  const copilotScripts = [];
  const copilotQuestions = [];
  const feedback = []; // { conversation, seq, rating, comment }
  let copilotDelayMs = 5; // between streamed events
  // The copilot's usage (T4.07), as GET …/copilot/usage gives it to admins.
  const copilotUsage = {
    days: [],
    users: [],
    today: { org_billed_tokens: 0, site_billed_tokens: 0 },
    limits: {
      question_tokens: 200000,
      org_daily_tokens: 5000000,
      org_questions_per_minute: 30,
      user_questions_per_minute: 6,
      max_tokens_per_call: 2048,
      max_rounds: 8,
    },
  };
  const wearChecks = []; // each wear-check request's body
  let datasetRowsFail = null; // a detail: the next rows batch is refused with it
  // Batch tables (T3.11): like the API, the correlation finder ranks with the browser's own.
  const datasets = []; // { id, name, description, columns, rows, created_by, created_at }
  const performanceQueries = [];
  const audit = []; // newest first, like the API
  let auditId = 0;
  const bearersSeen = []; // every bearer token sent to this API

  const repoFor = (user) => ({ head, history, staged: staged.get(user) ?? [] });

  async function rawBody(req) {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    return raw;
  }
  const body = async (req) => {
    const raw = await rawBody(req);
    return raw ? JSON.parse(raw) : undefined;
  };

  // Like the API: a signal's readings in [from, to), as they are or in at most `points` buckets.
  function seriesOf(plotted, from, to, points) {
    const rows = [...samples.entries()]
      .filter(([k]) => k.startsWith(`${plotted.tag}|`))
      .map(([k, v]) => ({ t: Date.parse(k.split('|')[1]), v }))
      .filter((r) => r.t >= from && r.t < to)
      .sort((a, b) => a.t - b.t);
    const num = (v) => (typeof v === 'boolean' ? Number(v) : typeof v === 'number' ? v : null);
    const text = (v) => (typeof v === 'string' ? v : null);
    let bucket = null;
    let out = rows.map((r) => ({
      at: new Date(r.t).toISOString(),
      value: num(r.v),
      min: num(r.v),
      max: num(r.v),
      n: 1,
      text: text(r.v),
    }));
    if (rows.length > points) {
      bucket = Math.ceil((to - from) / points) / 1000; // whole ms, as the API rounds
      const groups = new Map();
      for (const r of rows) {
        const start = from + Math.floor((r.t - from) / (bucket * 1000)) * bucket * 1000;
        if (!groups.has(start)) groups.set(start, []);
        groups.get(start).push(r);
      }
      out = [...groups.entries()].map(([start, rs]) => {
        const vs = rs.map((r) => num(r.v)).filter((v) => v !== null);
        return {
          at: new Date(start).toISOString(),
          value: vs.length ? vs.reduce((a, b) => a + b, 0) / vs.length : null,
          min: vs.length ? Math.min(...vs) : null,
          max: vs.length ? Math.max(...vs) : null,
          n: rs.length,
          text:
            rs
              .map((r) => text(r.v))
              .filter((v) => v !== null)
              .at(-1) ?? null,
        };
      });
    }
    return {
      signal_id: plotted.id,
      tag: plotted.tag,
      unit: plotted.unit,
      start: new Date(from).toISOString(),
      end: new Date(to).toISOString(),
      bucket_s: bucket,
      points: out,
    };
  }

  // Like the API: which variables separate a dataset's failed rows from its good ones.
  function correlationOf(d, q) {
    const ng = q.ng_values ?? [true];
    const judged = d.rows.filter((r) => r[q.outcome] !== null && r[q.outcome] !== undefined);
    // Segments named as the API names them: a missing value is "(blank)".
    const rows = judged.map((r) => ({
      ...r,
      __ng: ng.includes(r[q.outcome]),
      __segment: q.split ? (r[q.split] === null ? '(blank)' : String(r[q.split])) : null,
    }));
    const variables = q.variables.map((key) => ({ key, label: key, unit: '' }));
    const findings = correlationFinder(rows, variables, {
      outcome: '__ng',
      splitBy: q.split ? '__segment' : null,
    }).map((f) => {
      const n = f.ngCount + f.okCount;
      const se =
        f.ngCount > 1 && f.okCount > 1 ? Math.sqrt(n / (f.ngCount * f.okCount) + f.effect ** 2 / (2 * n)) : null;
      const ci = se === null ? [null, null] : [f.effect - 1.96 * se, f.effect + 1.96 * se];
      return {
        segment: f.segment,
        variable: f.variable,
        ng_mean: Number.isFinite(f.ngMean) ? f.ngMean : null,
        ok_mean: Number.isFinite(f.okMean) ? f.okMean : null,
        ng_count: f.ngCount,
        ok_count: f.okCount,
        effect: f.effect,
        ci_low: ci[0],
        ci_high: ci[1],
        clear: ci[0] !== null && (ci[0] > 0 || ci[1] < 0),
        r: f.r,
      };
    });
    const top = new Map();
    for (const f of findings) if (f.clear && Math.abs(f.effect) >= 0.8 && !top.has(f.segment)) top.set(f.segment, f);
    const explanations = [...top.values()].map((f) => ({
      segment: f.segment,
      variable: f.variable,
      text: `${q.split ? `${f.segment}: ` : ''}failed batches ran ${f.variable} ${f.effect > 0 ? 'higher' : 'lower'}.`,
    }));
    const ngCount = rows.filter((r) => r.__ng).length;
    return { rows: rows.length, ng: ngCount, ok: rows.length - ngCount, findings, explanations };
  }

  const server = createServer(async (req, res) => {
    const send = (status, data) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(data === undefined ? '' : JSON.stringify(data));
    };
    res.setHeader('access-control-allow-origin', '*');
    res.setHeader('access-control-allow-headers', 'content-type, x-tiles-user, authorization');
    res.setHeader('access-control-allow-methods', 'GET, POST, PUT, PATCH, DELETE');
    // Like the API: every answer carries its request ID, which the browser may read.
    res.setHeader('x-request-id', `req-${String(++requestIds).padStart(6, '0')}`);
    res.setHeader('access-control-expose-headers', 'x-request-id');
    if (req.method === 'OPTIONS') return send(204);
    const url = new URL(req.url, 'http://fake');
    requests.push(`${req.method} ${url.pathname}`);
    // A failure a test asked for (failNext): the next matching request gets it, once.
    const planned = plannedFailures.findIndex((f) => f.method === req.method && f.path.test(url.pathname));
    // A slow answer a test asked for (slowNext): the next matching request waits first, once.
    const slow = plannedDelays.findIndex((d) => d.method === req.method && d.path.test(url.pathname));
    if (slow >= 0) {
      const [d] = plannedDelays.splice(slow, 1);
      await new Promise((r) => setTimeout(r, d.ms));
    }
    if (planned >= 0) {
      const [f] = plannedFailures.splice(planned, 1);
      return send(f.status, { detail: f.detail });
    }

    // ---- the sign-in provider -------------------------------------------------
    if (url.pathname === '/idp/.well-known/openid-configuration')
      return send(200, {
        issuer: `${origin}/idp`,
        authorization_endpoint: `${origin}/idp/auth`,
        token_endpoint: `${origin}/idp/token`,
        end_session_endpoint: `${origin}/idp/logout`,
      });
    if (url.pathname === '/idp/auth') {
      const q = url.searchParams;
      scopesAsked.push(q.get('scope'));
      const code = randomUUID();
      codes.set(code, { challenge: q.get('code_challenge'), redirectUri: q.get('redirect_uri') });
      const back = new URL(q.get('redirect_uri'));
      back.searchParams.set('code', code);
      back.searchParams.set('state', q.get('state'));
      res.writeHead(302, { location: back.toString() }).end();
      return;
    }
    if (url.pathname === '/idp/token') {
      const form = new URLSearchParams(await rawBody(req));
      const pending = codes.get(form.get('code'));
      codes.delete(form.get('code'));
      const challenge = createHash('sha256')
        .update(form.get('code_verifier') ?? '')
        .digest('base64url');
      if (!pending || pending.challenge !== challenge || pending.redirectUri !== form.get('redirect_uri'))
        return send(400, { error: 'invalid_grant', error_description: 'Bad code or verifier' });
      const token = `tok-${randomUUID()}`;
      tokens.add(token);
      // A sign-in through the organisation's pending provider confirms it (here: any sign-in).
      if (orgProvider) orgProvider.verified = true;
      return send(200, { access_token: token, expires_in: 300, id_token: 'id-token' });
    }
    if (url.pathname === '/idp/logout') {
      res.writeHead(302, { location: url.searchParams.get('post_logout_redirect_uri') }).end();
      return;
    }

    // ---- who is calling -------------------------------------------------------
    const auth = req.headers.authorization ?? '';
    const bearer = auth.startsWith('Bearer ') ? auth.slice(7) : null;
    if (bearer) bearersSeen.push(bearer);
    if (bearer && !tokens.has(bearer)) return send(401, { detail: 'Invalid token' });
    if (!bearer && requireSignIn && url.pathname !== '/health' && url.pathname !== '/auth/config')
      return send(401, { detail: 'Sign in to use Tiles' });
    const user = bearer ? signedInAs : (req.headers['x-tiles-user'] ?? 'demo@example.com');
    if (url.pathname === '/auth/config' && slowAuthConfigMs) await new Promise((r) => setTimeout(r, slowAuthConfigMs));
    if (url.pathname === '/auth/config' && url.searchParams.has('org')) {
      if (!orgProvider || url.searchParams.get('org').toLowerCase() !== 'demo')
        return send(404, { detail: 'That organisation has no sign-in of its own' });
      return send(200, {
        enabled: true,
        issuer: `${origin}/idp`, // the provider's own issuer stands for its tenant: sign-in goes to /idp
        client_id: orgProvider.client_id,
        scope: orgProvider.scope,
        org: 'demo',
        dev_identity: !requireSignIn,
      });
    }
    if (url.pathname === '/auth/config')
      return send(200, {
        enabled: oidc,
        issuer: oidc ? `${origin}/idp` : null,
        client_id: 'tiles-web',
        dev_identity: !requireSignIn,
      });
    if (url.pathname === '/me')
      return send(200, {
        email: user,
        name: bearer ? 'Ana Lopez' : 'Demo User',
        org: bearer ? 'demo' : null,
        via: bearer ? 'oidc' : 'dev',
      });
    const base = `/sites/${site.id}/ontology`;
    try {
      if (url.pathname === '/health') return send(200, { status: 'ok', version: 'fake', env: 'test' });
      if (url.pathname === '/sites' && req.method === 'GET') {
        if (sitesFailures > 0 && sitesFailures--) return send(503, { detail: 'The API is starting' });
        return send(200, sites);
      }
      // Creating a site (T6.06): admins only here (the API: organisation admins). Listed, not served.
      if (url.pathname === '/sites' && req.method === 'POST') {
        if ((roles[user] ?? 'engineer') !== 'admin')
          return send(403, { detail: 'Creating a site needs an organisation admin' });
        const { name, slug, timezone } = await body(req);
        if (!/^[a-z0-9][a-z0-9-]{0,62}$/.test(slug ?? '') || !String(name ?? '').trim() || !timezone)
          return send(422, { detail: 'Give the site a name, a slug and a time zone' });
        if (sites.some((x) => x.slug === slug))
          return send(409, { detail: `Your organisation already has a site called ${slug}` });
        const made = { id: randomUUID(), slug, name: String(name).trim(), org: 'demo' };
        sites.push(made);
        return send(201, made);
      }
      if (url.pathname === '/org' && req.method === 'GET')
        return send(200, { slug: 'demo', name: 'Demo', admin: (roles[user] ?? 'engineer') === 'admin' });
      // The organisation's sign-in: organisation admins only (here: admins of the site).
      if (url.pathname === '/org/identity-provider' || url.pathname.startsWith('/org/scim-tokens')) {
        if ((roles[user] ?? 'engineer') !== 'admin')
          return send(403, { detail: 'Creating a site needs an organisation admin' });
        if (url.pathname === '/org/identity-provider') {
          if (req.method === 'GET') return send(200, orgProvider);
          if (req.method === 'PUT') {
            const p = await body(req);
            if (!/^https?:\/\//.test(p.issuer ?? '')) return send(422, { detail: 'The issuer is an https URL' });
            const same = orgProvider?.issuer === p.issuer;
            orgProvider = { ...p, verified: same && orgProvider.verified, updated_at: new Date().toISOString() };
            return send(200, orgProvider);
          }
          if (req.method === 'DELETE') {
            if (!orgProvider) return send(404, { detail: 'Your organisation has no identity provider' });
            orgProvider = null;
            return send(204);
          }
        }
        if (url.pathname === '/org/scim-tokens' && req.method === 'GET') return send(200, scimTokens);
        if (url.pathname === '/org/scim-tokens' && req.method === 'POST') {
          const made = {
            id: randomUUID(),
            name: (await body(req)).name,
            created_at: new Date().toISOString(),
            last_used_at: null,
            revoked_at: null,
          };
          scimTokens.unshift(made);
          return send(201, { ...made, token: `tiles_scim_${randomUUID()}` });
        }
        const revoking = scimTokens.find((t) => url.pathname === `/org/scim-tokens/${t.id}` && !t.revoked_at);
        if (revoking && req.method === 'DELETE') {
          revoking.revoked_at = new Date().toISOString();
          return send(204);
        }
        return send(404, { detail: 'No such active SCIM token in your organisation' });
      }
      if (url.pathname === '/app-templates' && req.method === 'GET') {
        if (appsFailures > 0 && appsFailures--) return send(503, { detail: 'The API is restarting' });
        return send(200, APP_TEMPLATES);
      }
      const agentsPath = `/sites/${site.id}/agents`;
      if (
        !url.pathname.startsWith(base) &&
        url.pathname !== `/sites/${site.id}/me` &&
        url.pathname !== `/sites/${site.id}/onboarding` &&
        url.pathname !== `/sites/${site.id}/members` &&
        !url.pathname.endsWith('/audit') &&
        !url.pathname.startsWith(agentsPath) &&
        !url.pathname.startsWith(`/sites/${site.id}/imports`) &&
        !url.pathname.startsWith(`/sites/${site.id}/signals`) &&
        !url.pathname.startsWith(`/sites/${site.id}/warnings`) &&
        !url.pathname.startsWith(`/sites/${site.id}/notifications`) &&
        url.pathname !== `/sites/${site.id}/performance` &&
        !url.pathname.startsWith(`/sites/${site.id}/datasets`) &&
        !url.pathname.startsWith(`/sites/${site.id}/insights`) &&
        !url.pathname.startsWith(`/sites/${site.id}/apps`) &&
        !url.pathname.startsWith(`/sites/${site.id}/documents`) &&
        !url.pathname.startsWith(`/sites/${site.id}/copilot`) &&
        url.pathname !== `/sites/${site.id}/design-projects` &&
        url.pathname !== `/sites/${site.id}/runs` &&
        !url.pathname.startsWith(`/sites/${site.id}/sweeps`) &&
        !url.pathname.startsWith(`/sites/${site.id}/runs/`) &&
        !url.pathname.startsWith(`/sites/${site.id}/detectors/`)
      )
        return send(404, { detail: 'Site not found' });
      const role = roles[user] ?? 'engineer';
      if (url.pathname === `/sites/${site.id}/onboarding`) return send(200, onboarding());
      if (url.pathname.startsWith(agentsPath)) {
        const shown = (a) => ({
          id: a.id,
          name: a.name,
          created_at: a.created_at,
          last_seen_at: a.last_seen_at,
          status: a.last_seen_at ? 'online' : 'never seen',
          version: a.version,
          hostname: a.hostname,
          connectors: a.connectors ?? [],
          buffer: a.buffer ?? null,
        });
        if (req.method === 'GET') return send(200, agents.map(shown));
        if (role !== 'admin')
          return send(403, { detail: `Your role on this site is ${role}; this needs admin or above` });
        if (req.method === 'POST') {
          const { name } = await body(req);
          if (agents.some((a) => a.name === name))
            return send(409, { detail: `An agent named ${name} already exists` });
          const agent = { id: randomUUID(), name, token: `tla_${randomUUID()}`, created_at: new Date().toISOString() };
          Object.assign(agent, { last_seen_at: null, version: null, hostname: null });
          agents.push(agent);
          return send(201, { agent: shown(agent), token: agent.token });
        }
        const i = agents.findIndex((a) => url.pathname === `${agentsPath}/${a.id}`);
        if (req.method === 'DELETE' && i >= 0) {
          agents.splice(i, 1);
          return send(204);
        }
        return send(404, { detail: 'No such agent on this site' });
      }
      const importsPath = `/sites/${site.id}/imports`;
      if (url.pathname.startsWith(importsPath)) {
        if (req.method === 'GET' && url.pathname === importsPath) return send(200, imports);
        if (role === 'viewer')
          return send(403, { detail: 'Your role on this site is viewer; this needs engineer or above' });
        if (req.method === 'POST' && url.pathname === importsPath) {
          const run = {
            id: randomUUID(),
            name: (await body(req)).name,
            created_by: user.split('@')[0],
            created_at: new Date().toISOString(),
            received: 0,
            stored: 0,
            finished_at: null,
          };
          imports.unshift(run);
          return send(201, run);
        }
        const m = url.pathname.slice(importsPath.length).match(/^\/([^/]+)\/(samples|finish)$/);
        const run = m && imports.find((r) => r.id === m[1]);
        if (!run) return send(404, { detail: 'No such import on this site' });
        if (run.finished_at) return send(409, { detail: 'This import is finished; start a new one' });
        if (m[2] === 'finish' && failImportFinish) return send(503, { detail: 'Tiles is restarting' });
        if (m[2] === 'finish') {
          run.finished_at = new Date().toISOString();
          return send(200, run);
        }
        const batch = (await body(req)).samples;
        let stored = 0;
        for (const s of batch) {
          if (!signals.some((x) => x.tag === s.signal)) addSignal(s.signal, { source: `import:${run.name}` });
          const key = `${s.signal}|${s.at}`;
          if (!samples.has(key)) {
            samples.set(key, s.value);
            stored++;
          }
        }
        run.received += batch.length;
        run.stored += stored;
        return send(200, { received: batch.length, stored });
      }
      const signalsPath = `/sites/${site.id}/signals`;
      if (url.pathname === signalsPath && req.method === 'GET') {
        const q = (url.searchParams.get('q') ?? '').trim().toLowerCase();
        const delay = slowSearches.get(q);
        if (delay) await new Promise((r) => setTimeout(r, delay));
        if (failingSearches.has(q)) return send(503, { detail: 'The catalogue is busy' });
        const source = url.searchParams.get('source') ?? '';
        const linked = url.searchParams.get('linked') ?? '';
        const quality = url.searchParams.get('quality') ?? '';
        const found = signals
          .map(signalView)
          .filter(
            (x) =>
              (!q || [x.tag, x.description, x.node_label ?? ''].some((t) => t.toLowerCase().includes(q))) &&
              (!source || (source === 'manual' ? x.source === 'manual' : x.source.startsWith(`${source}:`))) &&
              (!linked || (linked === 'yes') === (x.node_id !== null)) &&
              (!quality || (x.quality?.badge ?? 'unchecked') === quality),
          );
        const offset = Number(url.searchParams.get('offset') ?? 0);
        const limit = Number(url.searchParams.get('limit') ?? 100);
        return send(200, { total: found.length, signals: found.slice(offset, offset + limit) });
      }
      if (url.pathname === `${signalsPath}/quality` && req.method === 'POST') {
        if (role === 'viewer')
          return send(403, { detail: 'Your role on this site is viewer; this needs engineer or above' });
        const { signal_ids: ids } = await body(req);
        if (slowChecks) await new Promise((r) => setTimeout(r, slowChecks));
        const badges = { good: 0, warn: 0, bad: 0, unknown: 0 };
        for (const sig of signals.filter((x) => !ids || ids.includes(x.id))) {
          sig.quality = { ...goodReport(sig), ...qualityFound.get(sig.tag), checked_at: new Date().toISOString() };
          badges[sig.quality.badge]++;
        }
        const checked = Object.values(badges).reduce((a, b) => a + b, 0);
        return send(200, { checked, badges });
      }
      if (url.pathname === `${signalsPath}/suggestions` && req.method === 'GET') {
        // A simple stand-in for the API's suggester: link a Signal node made for the tag, else create one.
        const unmapped = signals.filter((x) => !x.node_id);
        const stagedTags = (staged.get(user) ?? [])
          .filter((op) => op.kind === 'addNode' && op.node.props.tag)
          .map((op) => op.node.props.tag);
        const waiting = unmapped.filter((x) => stagedTags.includes(x.tag)).map((x) => x.tag);
        const suggestions = unmapped
          .filter((x) => !waiting.includes(x.tag))
          .map((x) => {
            const made = Object.values(head.nodes).find((n) => n.type === 'Signal' && n.props.tag === x.tag);
            if (made)
              return {
                signal_id: x.id,
                tag: x.tag,
                kind: 'link',
                score: 1,
                node_id: made.id,
                node_label: made.label,
                reasons: [`${made.label} was created for this tag`],
                ops: [],
              };
            const id = `signal-${x.tag.replace(/[^a-z0-9]+/g, '-')}`;
            const node = { id, type: 'Signal', label: x.tag, props: { tag: x.tag, unit: x.unit ?? 'state' } };
            return {
              signal_id: x.id,
              tag: x.tag,
              kind: 'create',
              score: 0.6,
              node_id: id,
              node_label: x.tag,
              reasons: ['no machine or PLC found in the tag'],
              ops: [{ kind: 'addNode', node }],
            };
          });
        return send(200, { unmapped: unmapped.length, staged: waiting, suggestions });
      }
      const worn = signals.find((x) => url.pathname === `${signalsPath}/${x.id}/wear-check`);
      if (worn && req.method === 'POST') {
        // Like the API, in short: bucket medians, the baseline and recent level, a verdict.
        const q = await body(req);
        wearChecks.push(q);
        const [recentH, baseH, step] = [
          q.recent_hours ?? 24,
          q.baseline_hours ?? 72,
          (q.bucket_minutes ?? 60) * 60_000,
        ];
        const end = Date.parse(q.end);
        const recentFrom = end - recentH * 3_600_000;
        const start = recentFrom - baseH * 3_600_000;
        const groups = new Map();
        for (const [k, v] of samples) {
          const [tag, at] = k.split('|');
          const t = Date.parse(at);
          if (tag !== worn.tag || typeof v !== 'number' || t < start || t >= end) continue;
          const b = start + Math.floor((t - start) / step) * step;
          groups.set(b, [...(groups.get(b) ?? []), v]);
        }
        const buckets = [...groups.entries()]
          .sort((a, b) => a[0] - b[0])
          .map(([b, vs]) => ({ t: b, v: median(vs), n: vs.length }));
        const base = buckets.filter((b) => b.t < recentFrom);
        const recent = buckets.filter((b) => b.t >= recentFrom);
        const enough = base.length >= 6 && recent.length >= 4;
        const baseline = enough ? median(base.map((b) => b.v)) : null;
        const last = enough ? median(recent.slice(-4).map((b) => b.v)) : null;
        const change = enough && baseline ? (last - baseline) / Math.abs(baseline) : null;
        const moved =
          change !== null &&
          (q.direction === 'down' ? change <= -0.05 : q.direction === 'up' ? change >= 0.05 : Math.abs(change) >= 0.05);
        const verdict = change === null ? 'not_enough_data' : moved ? 'wearing' : 'stable';
        return send(200, {
          signal_id: worn.id,
          tag: worn.tag,
          unit: worn.unit,
          start: new Date(start).toISOString(),
          recent_from: new Date(recentFrom).toISOString(),
          end: new Date(end).toISOString(),
          verdict,
          baseline,
          last,
          change,
          slope_per_day: null,
          hours_to_limit: null,
          baseline_buckets: base.length,
          recent_buckets: recent.length,
          text:
            change === null
              ? 'Not enough readings.'
              : `${verdict === 'wearing' ? 'Wearing' : 'Stable'}: ${(change * 100).toFixed(1)}% from the baseline.`,
          buckets: buckets.map((b) => ({ at: new Date(b.t).toISOString(), value: b.v, n: b.n })),
        });
      }
      const plotted = signals.find((x) => url.pathname === `${signalsPath}/${x.id}/series`);
      if (plotted && req.method === 'GET') {
        // Like the API: readings in [from, to), as they are or in at most `points` buckets.
        const from = Date.parse(url.searchParams.get('from') ?? '');
        const to = Date.parse(url.searchParams.get('to') ?? '');
        const points = Number(url.searchParams.get('points') ?? 1000);
        if (!(to > from)) return send(422, { detail: '`to` must be after `from`' });
        return send(200, seriesOf(plotted, from, to, points));
      }
      const sig = signals.find((x) => url.pathname === `${signalsPath}/${x.id}`);
      if (url.pathname.startsWith(`${signalsPath}/`)) {
        if (!sig) return send(404, { detail: 'No such signal on this site' });
        if (req.method === 'GET') return send(200, signalView(sig));
        if (role === 'viewer')
          return send(403, { detail: 'Your role on this site is viewer; this needs engineer or above' });
        const change = await body(req);
        if (slowSaves) await new Promise((r) => setTimeout(r, slowSaves));
        if (change.node_id) {
          if (head.nodes[change.node_id]?.type !== 'Signal')
            return send(422, {
              detail: `${change.node_id} is not a Signal node of the committed ontology; commit it there first`,
            });
          const other = signals.find((x) => x !== sig && x.node_id === change.node_id);
          if (other) return send(409, { detail: `${change.node_id} is already linked to ${other.tag}` });
        }
        if ('description' in change && change.description === null) change.description = '';
        Object.assign(sig, change);
        return send(200, signalView(sig));
      }
      if (url.pathname === `/sites/${site.id}/audit`)
        return role === 'admin'
          ? send(200, audit)
          : send(403, { detail: 'Your role on this site is engineer; this needs admin or above' });
      const memberOf = (who) => {
        const r = roles[who] ?? 'engineer';
        return { user_id: who, email: who, name: who.split('@')[0], role: r, site_role: r, org_admin: false };
      };
      members.add(user);
      const copilotPath = `/sites/${site.id}/copilot`;
      if (url.pathname === copilotPath || url.pathname.startsWith(`${copilotPath}/`)) {
        if (url.pathname === copilotPath) return send(200, { configured: copilot, enabled: copilotEnabled });
        if (url.pathname === `${copilotPath}/policy` && req.method === 'PUT') {
          if (role !== 'admin') return send(403, { detail: `Your role on this site is ${role}; this needs admin` });
          const wanted = await body(req);
          if (typeof wanted.enabled !== 'boolean' || Object.keys(wanted).length !== 1)
            return send(422, { detail: 'Send {"enabled": true} or {"enabled": false}' });
          copilotEnabled = wanted.enabled;
          return send(200, { configured: copilot, enabled: copilotEnabled });
        }
        if (url.pathname === `${copilotPath}/usage`)
          return role === 'admin'
            ? send(200, copilotUsage)
            : send(403, { detail: `Your role on this site is ${role}; this needs admin or above` });
        const now = () => new Date().toISOString();
        const shown = ({ history: h, user: _u, ...c }) => ({
          ...c,
          messages: h.length,
          input_tokens: 0,
          output_tokens: 0,
        });
        const m = url.pathname
          .slice(copilotPath.length)
          .match(/^\/conversations(?:\/([^/]+))?(?:\/messages(?:\/(\d+)\/feedback)?)?$/);
        if (!m) return send(404, { detail: 'Not found' });
        if (!m[1] && req.method === 'GET')
          return send(
            200,
            [...conversations.values()]
              .filter((c) => c.user === user)
              .sort((a, b) => (a.updated_at < b.updated_at ? 1 : -1))
              .map(shown),
          );
        if (!m[1] && req.method === 'POST') {
          const { title = '' } = (await body(req)) ?? {};
          const c = { id: randomUUID(), user, title, created_at: now(), updated_at: now(), history: [] };
          conversations.set(c.id, c);
          return send(201, shown(c));
        }
        const c = conversations.get(m[1]);
        if (!c || c.user !== user) return send(404, { detail: 'No such conversation' });
        const withFeedback = (msg) => {
          const f = feedback.find((x) => x.conversation === c.id && x.seq === msg.seq);
          return { ...msg, feedback: f ? { rating: f.rating, comment: f.comment } : null };
        };
        if (m[2] !== undefined) {
          const seq = Number(m[2]);
          const msg = c.history[seq];
          if (!msg || msg.role !== 'assistant') return send(404, { detail: 'No such answer in this conversation' });
          const at = feedback.findIndex((x) => x.conversation === c.id && x.seq === seq);
          if (at >= 0) feedback.splice(at, 1);
          if (req.method === 'DELETE') return send(204);
          const { rating, comment = '' } = await body(req);
          feedback.push({ conversation: c.id, seq, rating, comment: comment.trim() });
          return send(200, { rating, comment: comment.trim() });
        }
        if (req.method === 'GET') return send(200, { ...shown(c), history: c.history.map(withFeedback) });
        if (req.method === 'DELETE') {
          conversations.delete(c.id);
          return send(204);
        }
        // A question: the scripted answer, streamed as the API streams it, and stored as it stores it.
        if (!copilotEnabled)
          return send(403, { detail: 'The copilot is off on this site: an admin turns it on in Settings' });
        const { text } = await body(req);
        copilotQuestions.push(text);
        const script = copilotScripts.shift() ?? { answer: 'Which press do you mean?' };
        // A rate limit or budget refuses the question before it is stored (T4.07).
        if (script.refuse) {
          res.setHeader('retry-after', '30');
          return send(429, { detail: script.refuse });
        }
        const store = (role, content, meta = {}) =>
          c.history.push({ seq: c.history.length, role, content, meta, created_at: now() });
        store('user', [{ type: 'text', text }]);
        if (!c.title) c.title = text.slice(0, 80);
        c.updated_at = now();
        res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
        const emit = async (event, data) => {
          res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
          await new Promise((r) => setTimeout(r, copilotDelayMs));
        };
        for (const d of script.drafts ?? []) {
          await emit('text', { text: d.text });
          await emit('retract', { reason: d.reason });
        }
        const first = 1 + c.history.flatMap((x) => x.content).filter((b) => b.type === 'tool_result').length;
        const tools = (script.tools ?? []).map((t, i) => ({ ...t, n: first + i, id: `toolu_${first + i}` }));
        if (tools.length) {
          store(
            'assistant',
            tools.map((t) => ({ type: 'tool_use', id: t.id, name: t.name, input: t.input })),
          );
          for (const t of tools) {
            await emit('tool_use', { id: t.id, name: t.name, input: t.input, n: t.n });
            await emit('tool_result', { id: t.id, name: t.name, is_error: Boolean(t.isError), n: t.n });
          }
          store(
            'user',
            tools.map((t) => ({
              type: 'tool_result',
              tool_use_id: t.id,
              content: `[${t.n}] ${t.name} ${JSON.stringify(t.input)}\n${JSON.stringify(t.result)}`,
              is_error: Boolean(t.isError),
            })),
          );
        }
        if (script.error) {
          // As the API ends an answer that failed: the error is sent, not stored.
          await emit('error', { detail: script.error });
          res.end();
          return;
        }
        const words = script.answer.split(/(?<= )/);
        for (const w of words) await emit('text', { text: w });
        const grounding = script.grounding ?? {
          grounded: true,
          declined: false,
          cited: [...script.answer.matchAll(/\[(\d+)\]/g)].map((x) => Number(x[1])),
          unknown_citations: [],
          unsupported_numbers: [],
          unsupported_names: [],
          uncited: false,
        };
        const withdrawn = (script.drafts ?? []).map((d) => d.reason);
        store('assistant', [{ type: 'text', text: script.answer }], {
          grounding,
          ...(withdrawn.length ? { withdrawn } : {}),
        });
        await emit('grounding', grounding);
        await emit('done', { stop_reason: 'end_turn', usage: {}, grounded: grounding.grounded });
        res.end();
        return;
      }
      // Documents (T4.08): text files are split into pages at form feeds; a word matches its forms
      // that start with it, roughly as the API's stemming does.
      const docsPath = `/sites/${site.id}/documents`;
      if (url.pathname === docsPath || url.pathname.startsWith(`${docsPath}/`)) {
        const live = siteDocuments.filter((d) => !d.archived);
        const shown = ({ pages, content: _content, archived: _archived, ...d }) => ({ ...d, pages: pages.length });
        if (url.pathname === docsPath && req.method === 'GET') return send(200, live.map(shown).reverse());
        if (url.pathname === docsPath && req.method === 'POST') {
          if (role === 'viewer') return send(403, { detail: 'Needs the engineer role' });
          const chunks = [];
          for await (const c of req) chunks.push(c);
          const content = Buffer.concat(chunks);
          const type = (req.headers['content-type'] ?? '').split(';')[0];
          if (!['application/pdf', 'text/plain', 'text/markdown'].includes(type))
            return send(422, { detail: 'Send a PDF, a text file or a Markdown file' });
          const pages = type === 'application/pdf' ? ['A PDF'] : content.toString('utf8').split('\f');
          if (!pages.some((p) => p.trim()))
            return send(422, { detail: 'The document has no text to search (a scan needs OCR first)' });
          const q = url.searchParams;
          const made = {
            number: siteDocuments.length + 1,
            title: q.get('title'),
            filename: q.get('filename') || 'document',
            content_type: type,
            language: q.get('language') || 'english',
            pages,
            size: content.length,
            sha256: createHash('sha256').update(content).digest('hex'),
            uploaded_by: user,
            created_at: new Date().toISOString(),
            content,
          };
          siteDocuments.push(made);
          return send(201, shown(made));
        }
        if (url.pathname === `${docsPath}/search`) {
          if (searchFailures > 0 && searchFailures--) return send(503, { detail: 'The API is restarting' });
          const words = (url.searchParams.get('q') ?? '').toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
          const matches = [];
          for (const d of live)
            d.pages.forEach((text, i) => {
              const hit = (w) => new RegExp(`\\b${w.length > 3 ? w.slice(0, -1) : w}`, 'i').test(text);
              if (words.length && words.every(hit)) {
                let snippet = text.slice(0, 200);
                for (const w of words)
                  snippet = snippet.replace(
                    new RegExp(`\\b(${w.length > 3 ? w.slice(0, -1) : w}\\w*)`, 'gi'),
                    '\u0002$1\u0003',
                  );
                matches.push({ document: d.number, title: d.title, page: i + 1, snippet, rank: 1 });
              }
            });
          return send(200, { query: url.searchParams.get('q'), matches });
        }
        const m = url.pathname.slice(docsPath.length).match(/^\/(\d+)(\/file)?$/);
        const doc = m && live.find((d) => d.number === Number(m[1]));
        if (!doc) return send(404, { detail: 'No such document on this site' });
        if (m[2]) {
          res.writeHead(200, { 'content-type': doc.content_type, 'content-security-policy': 'sandbox' });
          return void res.end(doc.content);
        }
        if (req.method === 'DELETE') {
          if (role === 'viewer') return send(403, { detail: 'Needs the engineer role' });
          doc.archived = true;
          return send(204);
        }
        return send(405, { detail: 'Method not allowed' });
      }
      // App Studio (T6.10): apps from the templates above; a result made up from the settings.
      const appsPath = `/sites/${site.id}/apps`;
      if (url.pathname === appsPath || url.pathname.startsWith(`${appsPath}/`)) {
        const m = url.pathname.slice(appsPath.length).match(/^(?:\/(\d+))?(\/result)?$/);
        if (!m) return send(404, { detail: 'Not found' });
        const shown = (a) => ({ ...a, signal_tag: signals.find((x) => x.id === a.config.signal)?.tag ?? null });
        const live = studioApps.filter((a) => !a.archived);
        const app = m[1] ? live.find((a) => a.number === Number(m[1])) : null;
        if (m[1] && !app) return send(404, { detail: 'No such app on this site' });
        const settings = (template, config) => {
          const t = APP_TEMPLATES.find((x) => x.id === template);
          if (!t) return { problem: `No template '${template}'` };
          const clean = {};
          for (const p of t.params) {
            const v = config[p.name] ?? p.default;
            if (v === null && !p.optional) return { problem: `${p.name}: ${p.label} is needed` };
            if (p.kind === 'number' && v !== null && (v < p.minimum || v > p.maximum))
              return { problem: `${p.name}: ${p.label} must be from ${p.minimum} to ${p.maximum}` };
            clean[p.name] = v;
          }
          if (!signals.some((x) => x.id === clean.signal)) return { problem: 'No such signal on this site' };
          return { t, clean };
        };
        const writes = req.method !== 'GET';
        if (writes && role === 'viewer') return send(403, { detail: 'Needs the engineer role' });
        if (!m[1] && req.method === 'GET') {
          if (appsFailures > 0 && appsFailures--) return send(503, { detail: 'The API is restarting' });
          return send(200, live.map(shown));
        }
        if (!m[1] && req.method === 'POST') {
          const b = await body(req);
          const { t, clean, problem } = settings(b.template, b.config ?? {});
          if (problem) return send(422, { detail: problem });
          const now = new Date().toISOString();
          const made = {
            number: ++lastApp,
            name: b.name,
            template: t.id,
            template_version: 1,
            template_title: t.title,
            config: clean,
            created_by: user,
            created_at: now,
            updated_at: now,
          };
          studioApps.push(made);
          return send(201, shown(made));
        }
        if (app && !m[2] && req.method === 'PUT') {
          const b = await body(req);
          const { clean, problem } = settings(app.template, b.config ?? {});
          if (problem) return send(422, { detail: problem });
          Object.assign(app, { name: b.name, config: clean, updated_at: new Date().toISOString() });
          return send(200, shown(app));
        }
        if (app && !m[2] && req.method === 'DELETE') {
          app.archived = true;
          return send(204);
        }
        if (app && m[2] && req.method === 'GET') {
          const tag = shown(app).signal_tag;
          const hour = 3_600_000;
          const end = Date.parse('2026-09-08T00:00:00Z');
          const points = Array.from({ length: 48 }, (_, i) => ({
            at: new Date(end - (48 - i) * hour).toISOString(),
            value: 100 + (i % 2) + (i > 40 ? (i - 40) * 2 : 0),
          }));
          const spc = app.template === 'spc-limits';
          return send(200, {
            app: shown(app),
            status: spc ? 'alert' : 'ok',
            headline: spc ? 'Out of control' : 'Stable',
            text: spc
              ? 'Out of control: 1 signal(s) in the recent 24 buckets (a point beyond a control limit); the centre is 100.5.'
              : 'Stable: the recent level is 101, 0.5% above the baseline of 100.5 (the threshold is 5%).',
            signal_id: app.config.signal,
            tag,
            unit: '°C',
            start: points[0].at,
            end: new Date(end).toISOString(),
            gap_seconds: 5400,
            points,
            levels: spc
              ? [
                  { label: 'centre', value: 100.5 },
                  { label: 'upper limit', value: 103.2 },
                  { label: 'lower limit', value: 97.8 },
                ]
              : [{ label: 'baseline', value: 100.5 }],
            spans: spc ? [{ from: points[46].at, to: points[47].at, label: 'a point beyond a control limit' }] : [],
            facts: spc ? [{ label: 'Signals', value: 1, format: 'number' }] : [],
          });
        }
        return send(405, { detail: 'Method not allowed' });
      }
      const insightsPath = `/sites/${site.id}/insights`;
      if (url.pathname === insightsPath || url.pathname.startsWith(`${insightsPath}/`)) {
        const m = url.pathname.slice(insightsPath.length).match(/^(?:\/(\d+))?(?:\/(review|reopen))?$/);
        const i = m?.[1] ? insights.find((x) => x.number === Number(m[1])) : null;
        if (req.method !== 'GET' && role === 'viewer')
          return send(403, { detail: 'Your role on this site is viewer; this needs engineer or above' });
        const summary = ({ query: _query, evidence: _evidence, ...rest }) => rest;
        const now = () => new Date().toISOString();
        if (!m?.[1] && req.method === 'GET') {
          const status = url.searchParams.get('status');
          const found = insights.filter((x) => !status || x.status === status).sort((a, b) => b.number - a.number);
          return send(200, { insights: found.map(summary), total: found.length });
        }
        if (!m?.[1] && req.method === 'POST') {
          const { title, summary: text = '', actions = [], source } = await body(req);
          let evidence;
          if (source.kind === 'correlation') {
            const d = datasets.find((x) => x.id === source.dataset_id);
            if (!d) return send(404, { detail: 'No such dataset' });
            const result = correlationOf(d, source);
            evidence = {
              dataset: { id: d.id, name: d.name, row_count: d.rows.length },
              result: { ...result, findings: result.findings.slice(0, 60) },
              findings_total: result.findings.length,
            };
          } else {
            const picked = source.signals.map((id) => signals.find((x) => x.id === id));
            if (picked.some((x) => !x)) return send(404, { detail: 'No such signal on this site' });
            const [from, to] = [Date.parse(source.start), Date.parse(source.end)];
            evidence = { series: picked.map((x) => seriesOf(x, from, to, source.points ?? 600)) };
          }
          const created = {
            number: Math.max(0, ...insights.map((x) => x.number)) + 1,
            title,
            summary: text,
            actions,
            kind: source.kind,
            status: 'proposed',
            author: user.split('@')[0],
            author_id: user,
            created_at: now(),
            updated_at: now(),
            reviewer: null,
            reviewed_at: null,
            review_note: '',
            query: source,
            evidence,
          };
          insights.push(created);
          return send(201, created);
        }
        if (!i) return send(404, { detail: `Insight #${m?.[1]} not found` });
        const owner = i.author_id === user || role === 'admin';
        if (!m[2] && req.method === 'GET') return send(200, i);
        if (!m[2] && req.method === 'DELETE') {
          if (!owner) return send(403, { detail: 'Only its author (or an admin) deletes an insight' });
          insights.splice(insights.indexOf(i), 1);
          return send(204);
        }
        if (!m[2] && req.method === 'PATCH') {
          if (!owner) return send(403, { detail: 'Only its author (or an admin) edits an insight' });
          if (i.status !== 'proposed')
            return send(409, { detail: `Insight #${i.number} is ${i.status}: reopen it first` });
          const changes = await body(req);
          for (const k of ['title', 'summary', 'actions']) if (changes[k] !== undefined) i[k] = changes[k];
          i.updated_at = now();
          return send(200, i);
        }
        if (m[2] === 'review') {
          const { decision, note = '' } = await body(req);
          if (i.author_id === user) return send(403, { detail: 'Another engineer reviews your insight' });
          if (i.status !== 'proposed') return send(409, { detail: `Insight #${i.number} is already ${i.status}` });
          if (decision === 'rejected' && !note.trim()) return send(422, { detail: 'Say why the insight is rejected' });
          Object.assign(i, {
            status: decision,
            reviewer: user.split('@')[0],
            reviewed_at: now(),
            review_note: note.trim(),
            updated_at: now(),
          });
          return send(200, i);
        }
        if (!owner) return send(403, { detail: 'Only its author (or an admin) reopens an insight' });
        if (i.status === 'proposed') return send(409, { detail: `Insight #${i.number} already waits for review` });
        Object.assign(i, { status: 'proposed', reviewer: null, reviewed_at: null, review_note: '', updated_at: now() });
        return send(200, i);
      }
      const datasetsPath = `/sites/${site.id}/datasets`;
      if (url.pathname.startsWith(datasetsPath)) {
        const shown = ({ rows, ...d }) => ({ ...d, row_count: rows.length });
        const m = url.pathname.slice(datasetsPath.length).match(/^(?:\/([^/]+))?(?:\/(rows|correlate))?$/);
        const d = m?.[1] ? datasets.find((x) => x.id === m[1]) : null;
        const writes = req.method !== 'GET' && m?.[2] !== 'correlate';
        if (writes && role === 'viewer')
          return send(403, { detail: 'Your role on this site is viewer; this needs engineer or above' });
        if (!m?.[1] && req.method === 'GET') return send(200, datasets.map(shown));
        if (!m?.[1] && req.method === 'POST') {
          const { name, columns } = await body(req);
          if (datasets.some((x) => x.name === name))
            return send(409, { detail: `A dataset is already called ${name}` });
          const created = {
            id: randomUUID(),
            name,
            description: '',
            columns,
            rows: [],
            created_by: user.split('@')[0],
            created_at: new Date().toISOString(),
          };
          datasets.push(created);
          return send(201, shown(created));
        }
        if (!d) return send(404, { detail: 'No such dataset' });
        if (!m[2] && req.method === 'GET') return send(200, { ...shown(d), preview: d.rows.slice(0, 20) });
        if (!m[2] && req.method === 'DELETE') {
          datasets.splice(datasets.indexOf(d), 1);
          return send(204);
        }
        if (m[2] === 'rows') {
          const { rows } = await body(req);
          if (datasetRowsFail) {
            const detail = datasetRowsFail;
            datasetRowsFail = null;
            return send(422, { detail });
          }
          d.rows.push(...rows.map((r) => Object.fromEntries(d.columns.map((c) => [c.name, r[c.name] ?? null]))));
          return send(200, { received: rows.length, row_count: d.rows.length });
        }
        const q = await body(req);
        correlations.push(q);
        return send(200, correlationOf(d, q));
      }
      if (url.pathname === `/sites/${site.id}/performance`) {
        performanceQueries.push(url.searchParams.toString());
        return performanceReport ? send(200, performanceReport) : send(503, { detail: 'No report set' });
      }
      const detector = performanceReport?.detectors.find((d) => url.pathname === `/sites/${site.id}/detectors/${d.id}`);
      if (url.pathname.startsWith(`/sites/${site.id}/detectors/`)) {
        if (!detector) return send(404, { detail: 'No such detector' });
        if (role === 'viewer')
          return send(403, { detail: 'Your role on this site is viewer; this needs engineer or above' });
        const { asset } = await body(req);
        Object.assign(detector, { asset, matched: asset !== null });
        return send(200, { id: detector.id, asset });
      }
      const notifyPath = `/sites/${site.id}/notifications`;
      if (url.pathname.startsWith(notifyPath)) {
        const sub = url.pathname.slice(notifyPath.length);
        const forbid = (needs) =>
          send(403, { detail: `Your role on this site is ${role}; this needs ${needs} or above` });
        if (sub === '/preferences') {
          const mine = () => ({ on_raised: false, on_assigned: true, ...notifyPrefs.get(user), email: user });
          if (req.method === 'GET') return send(200, mine());
          if (role === 'viewer') return forbid('engineer');
          const { on_raised: onRaised, on_assigned: onAssigned } = await body(req);
          notifyPrefs.set(user, { on_raised: onRaised, on_assigned: onAssigned });
          return send(200, mine());
        }
        if (role !== 'admin') return forbid('admin');
        const shownTeams = () => ({
          configured: teams.url !== null,
          host: teams.url ? new URL(teams.url).hostname : null,
          on_raised: teams.on_raised,
        });
        if (sub === '/teams' && req.method === 'GET') return send(200, shownTeams());
        if (sub === '/teams') {
          const { webhook_url: hook, on_raised: onRaised } = await body(req);
          if (
            hook &&
            !/^https:\/\/[^/]+\.(webhook\.office\.com|logic\.azure\.com|api\.powerplatform\.com)(:\d+)?\//.test(hook)
          )
            return send(422, {
              detail:
                'Not a Microsoft Teams webhook: its host must end with .webhook.office.com, .logic.azure.com, .api.powerplatform.com',
            });
          // Like the API: left out, the URL stays.
          teams = { url: hook === undefined ? teams.url : hook || null, on_raised: onRaised ?? true };
          return send(200, shownTeams());
        }
        if (sub === '') return send(200, deliveries.slice(0, Number(url.searchParams.get('limit') ?? 100)));
        return send(404, { detail: 'Not found' });
      }
      const designPath = `/sites/${site.id}/design-projects`;
      if (url.pathname === designPath) {
        if (req.method === 'GET')
          return send(
            200,
            designProjects.map((p) => {
              const runs = designRuns.filter((r) => r.project === p.id);
              return { ...p, runs: runs.length, last_run_at: runs.at(-1)?.created_at ?? null };
            }),
          );
        if (role === 'viewer')
          return send(403, { detail: 'Your role on this site is viewer; this needs engineer or above' });
        const { name: projectName = '', description = '' } = await body(req);
        const trimmed = projectName.trim();
        if (designProjects.some((p) => p.name.toLowerCase() === trimmed.toLowerCase()))
          return send(409, { detail: `There is already a project called '${trimmed}'` });
        const p = {
          id: randomUUID(),
          name: trimmed,
          description,
          created_by: user.split('@')[0],
          created_at: new Date().toISOString(),
        };
        designProjects.unshift(p);
        return send(201, { ...p, runs: 0, last_run_at: null });
      }
      const runsPath = `/sites/${site.id}/runs`;
      if (url.pathname === runsPath) {
        if (req.method === 'GET') {
          if (designRunsDelayMs) await new Promise((r) => setTimeout(r, designRunsDelayMs));
          const model = url.searchParams.get('model');
          const project = url.searchParams.get('project');
          const list = designRuns
            .filter((r) => (!model || r.model === model) && (!project || r.project === project))
            .reverse();
          return send(200, { runs: list, total: list.length });
        }
        if (role === 'viewer')
          return send(403, { detail: 'Your role on this site is viewer; this needs engineer or above' });
        const { model, version, params = {}, note = '', parent = null, project = null } = await body(req);
        const id = Object.entries({ swelling: 'cell-swelling', actuator: 'joint-actuator' }).find(
          ([, k]) => k === model,
        )?.[0];
        if (!id) return send(404, { detail: `No model ${model}` });
        const spec = getDesignModel(id);
        const v = version ?? spec.latest;
        const full = Object.fromEntries(spec.params.map((p) => [p.key, params[p.key] ?? p.default]));
        const before = parent === null ? null : designRuns.find((r) => r.number === parent);
        if (parent !== null && (!before || before.project !== project))
          return send(422, { detail: `Run ${parent} is in another project` });
        const changes = before
          ? [
              ...(before.version !== `${v}.0` ? [{ key: 'version', before: before.version, after: `${v}.0` }] : []),
              ...Object.keys(full)
                .filter((k) => full[k] !== before.params[k])
                .map((k) => ({ key: k, before: before.params[k], after: full[k] })),
            ]
          : [];
        const r = {
          number: designRuns.length + 1,
          model,
          version: `${v}.0`,
          model_name: spec.name,
          params: full,
          output: { [spec.output.key]: evaluateDesign(id, v, full) },
          units: { [spec.output.key]: spec.output.unit },
          parent,
          restored_from: null,
          project,
          note,
          author: { name: user.split('@')[0], email: user },
          created_at: new Date().toISOString(),
          changes,
        };
        designRuns.push(r);
        return send(201, { ...r, lineage: [] });
      }
      const sweepMatch = url.pathname.match(new RegExp(`^/sites/${site.id}/sweeps(?:/([^/]+)(/cancel)?)?$`));
      if (sweepMatch) {
        const values = (a) => Array.from({ length: a.steps }, (_, i) => a.from + ((a.to - a.from) * i) / (a.steps - 1));
        const finish = (sw) => {
          const id = Object.entries({ swelling: 'cell-swelling', actuator: 'joint-actuator' }).find(
            ([, k]) => k === sw.model,
          )[0];
          const xs = values(sw.x);
          const ys = sw.y ? values(sw.y) : [0];
          const grid = ys.map((yv) =>
            xs.map((xv) =>
              evaluateDesign(id, sw.version.replace(/\.0$/, ''), {
                ...sw.params,
                [sw.x.param]: xv,
                ...(sw.y ? { [sw.y.param]: yv } : {}),
              }),
            ),
          );
          const flat = grid.flat();
          Object.assign(sw, {
            status: 'done',
            done: sw.total,
            finished_at: new Date().toISOString(),
            result: {
              output: 'force',
              unit: '',
              x: { param: sw.x.param, values: xs },
              y: sw.y ? { param: sw.y.param, values: ys } : null,
              grid,
              min: Math.min(...flat),
              max: Math.max(...flat),
            },
          });
        };
        if (!sweepMatch[1] && req.method === 'GET')
          return send(
            200,
            designSweeps.map((sw) => ({ ...sw, result: null })),
          );
        if (!sweepMatch[1] && req.method === 'POST') {
          if (role === 'viewer')
            return send(403, { detail: 'Your role on this site is viewer; this needs engineer or above' });
          const b = await body(req);
          const key = JSON.stringify([b.model, b.version, b.params, b.x, b.y]);
          const same = designSweeps.find((sw) => sw.key === key && sw.status === 'done');
          if (same) return send(200, { ...same, cached: true });
          const sw = {
            id: randomUUID(),
            key,
            model: b.model,
            version: b.version.split('.').length === 3 ? b.version : `${b.version}.0`,
            params: b.params ?? {},
            x: b.x,
            y: b.y ?? null,
            project: b.project ?? null,
            status: 'running',
            total: b.x.steps * (b.y ? b.y.steps : 1),
            done: 0,
            error: null,
            cancel_requested: false,
            created_by: user.split('@')[0],
            created_at: new Date().toISOString(),
            started_at: new Date().toISOString(),
            finished_at: null,
            cached: false,
            result: null,
          };
          designSweeps.unshift(sw);
          return send(202, sw);
        }
        const sw = designSweeps.find((x) => x.id === sweepMatch[1]);
        if (!sw) return send(404, { detail: 'No such sweep on this site' });
        if (!sweepMatch[2] && sweepReadFailures > 0) {
          sweepReadFailures -= 1;
          return send(503, { detail: 'Busy' });
        }
        if (sweepMatch[2]) {
          if (sw.status !== 'running') return send(409, { detail: `The sweep is already ${sw.status}` });
          sw.cancel_requested = true;
          return send(200, { ...sw, result: null });
        }
        if (sw.status === 'running') {
          if (sw.cancel_requested) Object.assign(sw, { status: 'cancelled', finished_at: new Date().toISOString() });
          else if (sw.done + Math.ceil(sw.total / 4) >= sw.total) finish(sw);
          else sw.done += Math.ceil(sw.total / 4);
        }
        return send(200, sw);
      }
      // A run's audit record (T4.13): its lineage back to the first run, as JSON or a PDF report.
      const runAudit = url.pathname.match(new RegExp(`^/sites/${site.id}/runs/(\\d+)/audit(\\.pdf)?$`));
      if (runAudit) {
        const lineage = [];
        for (let r = designRuns.find((x) => x.number === Number(runAudit[1])); r;) {
          lineage.push(r.number);
          r = r.parent === null ? undefined : designRuns.find((x) => x.number === r.parent);
        }
        if (!lineage.length) return send(404, { detail: `No run ${runAudit[1]} on this site` });
        if (runAudit[2]) {
          res.writeHead(200, { 'content-type': 'application/pdf' });
          return res.end(`%PDF-1.4\n% run ${runAudit[1]}\n%%EOF\n`);
        }
        const runs = designRuns.filter((r) => lineage.includes(r.number)).reverse();
        return send(200, { format: 'tiles-design-audit/1', run: Number(runAudit[1]), lineage, runs });
      }
      const warningsPath = `/sites/${site.id}/warnings`;
      if (url.pathname.startsWith(warningsPath))
        return await warningRoute(url, url.pathname.slice(warningsPath.length), user, role, memberOf);
      if (url.pathname === `/sites/${site.id}/me`) return send(200, memberOf(user));
      if (url.pathname === `/sites/${site.id}/members`) return send(200, [...members].sort().map(memberOf));
      const path = url.pathname.slice(base.length);
      // Like the real API, anyone may discard their own staged changes.
      if (role === 'viewer' && req.method !== 'GET' && !(path === '/staged' && req.method === 'DELETE'))
        return send(403, { detail: 'Your role on this site is viewer; this needs engineer or above' });
      const repo = repoFor(user);
      if (path === '/graph') return send(200, url.searchParams.get('view') === 'head' ? head : workingGraph(repo));
      if (path === '/health') return send(200, healthCheck(head));
      if (path === '/staged' && req.method === 'GET') return send(200, repo.staged);
      if (path === '/staged/batch' && req.method === 'POST') {
        if (slowWritesMs) await new Promise((r) => setTimeout(r, slowWritesMs));
        let next = repo;
        for (const op of await body(req)) next = stage(next, op); // throws before anything is kept
        staged.set(user, next.staged);
        return send(201, next.staged);
      }
      if (path === '/staged' && req.method === 'POST') {
        const next = stage(repo, await body(req));
        staged.set(user, next.staged);
        return send(201, next.staged);
      }
      if (path === '/staged' && req.method === 'DELETE') {
        staged.delete(user);
        return send(204);
      }
      if (path === '/export' && req.method === 'GET') return sendExport(url.searchParams.get('format') ?? 'json');
      if (path === '/import' && req.method === 'POST') {
        if (repo.staged.length) return send(409, { detail: 'Commit, send or discard your staged changes first' });
        const given = await body(req);
        const { content, format, mode = 'merge', dry_run: dryRun = false } = given;
        const latest = history[0]?.id ?? null;
        if ('expect_commit' in given && given.expect_commit !== latest)
          return send(409, { detail: 'The ontology has changed since the preview: check the changes again' });
        if (format !== 'json') return send(422, { detail: 'The fake API imports JSON only' });
        let file;
        try {
          file = JSON.parse(content);
        } catch (e) {
          return send(422, { detail: `The file can't be imported: Not valid JSON: ${e.message}` });
        }
        const planned = planImport(head, file, mode);
        if (planned.problem) return send(422, { detail: `The file can't be imported: ${planned.problem}` });
        let next = repo;
        for (const op of planned.ops) next = stage(next, op);
        const staging = planned.ops.length > 0 && !dryRun;
        if (staging) staged.set(user, next.staged);
        return send(200, {
          ...planned,
          ops: planned.ops.slice(0, 500),
          total: planned.ops.length,
          staged: staging,
          commit: latest,
        });
      }
      if (path === '/review-policy' && req.method === 'GET') return send(200, { required: reviewRequired });
      if (path === '/review-policy' && req.method === 'PUT') {
        if (role !== 'admin')
          return send(403, { detail: `Your role on this site is ${role}; this needs admin or above` });
        reviewRequired = (await body(req)).required;
        return send(200, { required: reviewRequired });
      }
      if (path.startsWith('/reviews')) return await reviewRoute(path, user, role, repo); // await: its errors are caught below
      const refuse = { detail: 'This site requires a review: request one instead of committing' };
      if (reviewRequired && req.method === 'POST' && /^\/commits(\/[^/]+\/revert)?$/.test(path))
        return send(409, refuse);
      if (path === '/commits' && req.method === 'GET') return send(200, history);
      if (path === '/commits' && req.method === 'POST') {
        const { message } = await body(req);
        const next = commit(repo, { message, author: user.split('@')[0] });
        ({ head, history } = next);
        audit.unshift({
          id: ++auditId,
          at: new Date().toISOString(),
          actor_id: user,
          actor_name: user.split('@')[0],
          action: 'ontology.commit',
          entity_type: 'commit',
          entity_id: history[0].id,
          before: null,
          after: history[0],
          request_id: null,
        });
        staged.delete(user);
        return send(201, history[0]);
      }
      const m = path.match(/^\/commits\/([^/]+)\/revert$/);
      if (m && req.method === 'POST') {
        const id = decodeURIComponent(m[1]);
        if (!history.some((c) => c.id === id)) return send(404, { detail: `Commit ${id} not found` });
        const next = revert(repo, id, { author: user.split('@')[0] });
        ({ head, history } = next);
        return send(201, history[0]);
      }
      return send(404, { detail: 'Not Found' });
    } catch (e) {
      return send(409, { detail: e.message });
    }

    function sendExport(format) {
      const nodes = Object.values(head.nodes).sort((a, b) => a.id.localeCompare(b.id));
      const edges = Object.values(head.edges).sort((a, b) => a.id.localeCompare(b.id));
      if (format === 'json') {
        res.writeHead(200, { 'content-type': 'application/json' });
        return res.end(JSON.stringify({ format: 'tiles-ontology', version: 1, nodes, edges }, null, 2));
      }
      const keys = [...new Set(nodes.flatMap((n) => Object.keys(n.props)))].sort();
      const q = (v) => (/[",\n]/.test(String(v)) ? `"${String(v).replaceAll('"', '""')}"` : String(v));
      const rows = [
        ['kind', 'id', 'type', 'label', 'from', 'rel', 'to', ...keys.map((k) => `prop:${k}`)],
        ...nodes.map((n) => ['node', n.id, n.type, n.label, '', '', '', ...keys.map((k) => n.props[k] ?? '')]),
        ...edges.map((e) => ['edge', e.id, '', '', e.from, e.rel, e.to, ...keys.map(() => '')]),
      ];
      res.writeHead(200, { 'content-type': 'text/csv' });
      return res.end(rows.map((r) => r.map(q).join(',')).join('\n') + '\n');
    }

    async function warningRoute(url, path, user, role, memberOf) {
      const name = (who) => (who ? who.split('@')[0] : null);
      const shown = (w) => ({
        ...Object.fromEntries(Object.entries(w).filter(([k]) => k !== 'activity')),
        status: w.resolved_at ? 'resolved' : w.acknowledged_at ? 'acknowledged' : 'raised',
        acknowledged_by: name(w.acknowledged_by),
        assignee: name(w.assignee_id),
        resolved_by: name(w.resolved_by),
      });
      const detail = (w) => ({
        ...shown(w),
        detector_config: { window: 200, k: 4, persist: 3, direction: 'above', cooldown: 0, flat_spread: 1 },
        activity: [
          { at: w.created_at, action: 'raised', actor: null, assignee: null, outcome: null, note: '' },
          ...w.activity.map((a) => ({ ...a, actor: name(a.actor), assignee: name(a.assignee) })),
        ],
      });
      if (path === '' && req.method === 'GET') {
        const q = url.searchParams;
        const status = q.get('status') ?? 'all';
        const assignee = q.get('assignee');
        const state = q.get('state') ?? 'all';
        const list = warnings
          .map(shown)
          .filter(
            (w) =>
              (status === 'all' || (status === 'unresolved' ? w.status !== 'resolved' : w.status === status)) &&
              (state === 'all' || (state === 'open') === (w.ended_at === null)) &&
              (!assignee ||
                (assignee === 'none' ? !w.assignee_id : w.assignee_id === (assignee === 'me' ? user : assignee))) &&
              (!q.get('outcome') || w.outcome === q.get('outcome')),
          );
        const offset = Number(q.get('offset') ?? 0);
        return send(200, list.slice(offset, offset + Number(q.get('limit') ?? 100)));
      }
      const m = path.match(/^\/([^/]+)(?:\/(acknowledge|assignee|resolve|reopen|comments))?$/);
      const w = m && warnings.find((x) => x.id === m[1]);
      if (!w) return send(404, { detail: 'No such warning' });
      if (!m[2] && failWarningGets > 0) {
        failWarningGets--;
        return send(503, { detail: 'Tiles is restarting' });
      }
      if (!m[2]) return send(200, detail(w));
      if (role === 'viewer')
        return send(403, { detail: 'Your role on this site is viewer; this needs engineer or above' });
      const { note = '', user_id: userId, outcome } = await body(req);
      const step = (action, extra = {}) =>
        w.activity.push({
          at: new Date().toISOString(),
          action,
          actor: user,
          assignee: null,
          outcome: null,
          note,
          ...extra,
        });
      const acknowledge = (n = '') => {
        if (w.acknowledged_at) return false;
        Object.assign(w, { acknowledged_at: new Date().toISOString(), acknowledged_by: user });
        w.activity.push({
          at: w.acknowledged_at,
          action: 'acknowledged',
          actor: user,
          assignee: null,
          outcome: null,
          note: n,
        });
        return true;
      };
      if (m[2] === 'comments') {
        step('commented');
        return send(201, detail(w));
      }
      if (m[2] === 'reopen') {
        if (!w.resolved_at) return send(409, { detail: 'This warning is not resolved' });
        Object.assign(w, { resolved_at: null, resolved_by: null, outcome: null, resolution_note: '' });
        step('reopened');
        return send(200, detail(w));
      }
      if (w.resolved_at) return send(409, { detail: 'This warning is resolved; reopen it first' });
      if (m[2] === 'acknowledge') {
        if (!acknowledge(note)) return send(409, { detail: 'This warning is already acknowledged' });
        return send(200, detail(w));
      }
      if (m[2] === 'assignee') {
        if ((userId ?? null) === w.assignee_id) {
          if (note.trim()) step('commented');
          return send(200, detail(w));
        }
        if (userId && (!members.has(userId) || memberOf(userId).role === 'viewer'))
          return send(422, { detail: 'Not an engineer or admin of this site' });
        if (userId) acknowledge();
        w.assignee_id = userId ?? null;
        step(userId ? 'assigned' : 'unassigned', { assignee: userId ?? null });
        return send(200, detail(w));
      }
      acknowledge();
      Object.assign(w, { resolved_at: new Date().toISOString(), resolved_by: user, outcome, resolution_note: note });
      step('resolved', { outcome });
      return send(200, detail(w));
    }

    async function reviewRoute(path, user, role, repo) {
      const shown = (r) => {
        let conflict = null;
        if (r.status === 'open')
          try {
            let g = head;
            for (const op of r.ops) g = applyOp(g, op).graph;
          } catch (e) {
            conflict = e.message;
          }
        return { ...r, comments: r.thread.filter((c) => c.body).length, conflict };
      };
      const now = () => new Date().toISOString();
      const name = user.split('@')[0];
      if (path === '/reviews' && req.method === 'GET') {
        const state = url.searchParams.get('state') ?? 'open';
        const list = reviews.filter((r) => state === 'all' || (state === 'open') === (r.status === 'open'));
        return send(200, list.map(shown).reverse());
      }
      if (path === '/reviews' && req.method === 'POST') {
        const { message = '', reviewer_id = null, reverts = null } = await body(req);
        let ops = repo.staged;
        let text = message.trim();
        if (reverts) {
          if (ops.length) return send(409, { detail: 'Request a review of your staged changes or discard them first' });
          const target = history.find((c) => c.id === reverts);
          if (!target) return send(404, { detail: `Commit ${reverts} not found` });
          ops = target.inverses;
          text ||= `Revert "${target.message}"`;
        } else if (!ops.length) return send(409, { detail: 'Nothing to review: stage some changes first' });
        else if (!text) return send(422, { detail: 'A change request needs a message' });
        let g = head;
        for (const op of ops) g = applyOp(g, op).graph; // throws: 409
        const r = {
          number: reviews.length + 1,
          message: text,
          author: name,
          author_id: user,
          reviewer: reviewer_id ? reviewer_id.split('@')[0] : null,
          reviewer_id,
          status: 'open',
          stats: diffStats(ops),
          reverts,
          source: 'person',
          created_at: now(),
          decided_by: null,
          decided_at: null,
          commit_id: null,
          ops,
          thread: [],
        };
        reviews.push(r);
        if (!reverts) staged.delete(user);
        return send(201, shown(r));
      }
      const m = path.match(/^\/reviews\/(\d+)(?:\/(comments|approve|reject|rework))?$/);
      const r = m && reviews[Number(m[1]) - 1];
      if (!r) return send(404, { detail: 'Change request not found' });
      if (req.method === 'GET' && !m[2]) return send(200, shown(r));
      if (req.method !== 'POST') return send(404, { detail: 'Not Found' });
      const note = (text, verdict = null) =>
        r.thread.push({ id: r.thread.length + 1, author: name, body: text, verdict, created_at: now() });
      const close = (status) => Object.assign(r, { status, decided_by: name, decided_at: now() });
      const given = m[2] === 'rework' ? {} : await body(req);
      if (m[2] === 'comments') {
        if (!given.body?.trim()) return send(422, { detail: 'Write a comment first' });
        note(given.body.trim());
        return send(200, shown(r));
      }
      if (m[2] === 'rework') {
        if (r.author_id !== user) return send(403, { detail: 'Only the author of a change request can rework it' });
        if (r.status === 'approved') return send(409, { detail: `Change request #${r.number} is already committed` });
        if (r.reverts) {
          if (r.status !== 'open') return send(409, { detail: 'Request the revert again from the history' });
          close('withdrawn');
          note('', 'withdrawn');
          return send(200, shown(r));
        }
        if (repo.staged.length) return send(409, { detail: 'Commit, send or discard your staged changes first' });
        let next = repo;
        for (const op of r.ops) next = stage(next, op);
        staged.set(user, next.staged);
        if (r.status === 'open') {
          close('withdrawn');
          note('', 'withdrawn');
        }
        return send(200, shown(r));
      }
      if (r.status !== 'open') return send(409, { detail: `Change request #${r.number} is already ${r.status}` });
      if (r.author_id === user) return send(403, { detail: "You can't review your own change: ask another engineer" });
      if (r.reviewer_id && r.reviewer_id !== user && role !== 'admin')
        return send(403, { detail: `Change request #${r.number} waits for ${r.reviewer} (or an admin)` });
      const comment = (given.comment ?? '').trim();
      if (m[2] === 'reject') {
        if (!comment) return send(422, { detail: 'Say why the change is rejected' });
        close('rejected');
        note(comment, 'rejected');
        return send(200, shown(r));
      }
      const next = commit({ head, history, staged: r.ops }, { message: r.message, author: r.author });
      next.history[0].reviewer = name;
      ({ head, history } = next);
      close('approved');
      r.commit_id = history[0].id;
      note(comment, 'approved');
      return send(200, shown(r));
    }
  });

  return {
    server,
    requests,
    bearersSeen,
    scopesAsked,
    datasets,
    correlations,
    // The copilot: the next answers to give, the questions asked, the ratings given.
    copilotScripts,
    copilotQuestions,
    copilotFeedback: feedback,
    copilotUsage,
    // Design runs stored on the site (T4.11), latest last.
    designRuns,
    // The next `n` reads of a sweep fail, as a network blip would.
    failSweepReads(n) {
      sweepReadFailures = n;
    },
    // Slows the list of runs, so a test can see the page wait for it.
    slowDesignRuns(ms) {
      designRunsDelayMs = ms;
    },
    // Slows the copilot's streamed events, so a test can see an answer arrive.
    slowCopilot(ms) {
      copilotDelayMs = ms;
    },
    insights,
    studioApps,
    siteDocuments,
    // Makes the next `n` document searches fail.
    failDocumentSearch(n) {
      searchFailures = n;
    },
    // Answers the next `method` request to a path matching `path` with `status` and `detail`.
    failNext(method, path, status, detail) {
      plannedFailures.push({ method, path, status, detail });
    },
    // Makes the next matching request wait `ms` before it is answered (a slow API, U2.08).
    slowNext(method, path, ms) {
      plannedDelays.push({ method, path, ms });
    },
    // Makes the next `n` lists of sites fail: the app can't connect until they pass.
    failSites(n) {
      sitesFailures = n;
    },
    // Makes the next `n` lists of App Studio's templates or apps fail.
    failApps(n) {
      appsFailures = n;
    },
    wearChecks,
    // Refuses the next batch of dataset rows, as the API does a value of the wrong kind.
    failDatasetRows(detail) {
      datasetRowsFail = detail;
    },
    // Lets a test play an edge agent sending a heartbeat with its token.
    heartbeat(token, hostname = 'edge-01', connectors = [], buffer = null) {
      const agent = agents.find((a) => a.token === token);
      if (!agent) throw new Error('unknown agent token');
      Object.assign(agent, { last_seen_at: new Date().toISOString(), version: '0.1.0', hostname, connectors, buffer });
    },
    // The readings imports have stored, as "signal|at" -> value.
    samples,
    // Adds a signal to the catalogue (or changes one), as an agent or an engineer would.
    addSignal,
    // Sets what the next quality check finds for a tag (part of a report; the rest as for a good one).
    qualityWillBe(tag, report) {
      qualityFound.set(tag, report);
    },
    // Makes the catalogue answer a search for `q` only after `ms`.
    slowSearch(q, ms) {
      slowSearches.set(q, ms);
    },
    // Makes quality checks take `ms` to be answered.
    slowCheck(ms) {
      slowChecks = ms;
    },
    // Makes signal changes take `ms` to be answered.
    slowSave(ms) {
      slowSaves = ms;
    },
    // Makes the catalogue answer a search for `q` with an error.
    failSearch(q) {
      failingSearches.add(q);
    },
    // Lets a test raise a warning on `tag`, as a detector would, with the readings around it.
    raiseWarning(tag, readings, warning) {
      addSignal(tag, { source: 'edge:edge-01' });
      for (const r of readings) samples.set(`${tag}|${r.at}`, r.value);
      const w = {
        id: randomUUID(),
        detector_id: randomUUID(),
        detector: `${tag.replace(/[^a-z0-9]+/g, '-')}-detector`,
        signal_id: signals.find((x) => x.tag === tag).id,
        signal_tag: tag,
        side: 'above',
        ended_at: null,
        acknowledged_at: null,
        acknowledged_by: null,
        assignee_id: null,
        resolved_at: null,
        resolved_by: null,
        outcome: null,
        resolution_note: '',
        created_at: new Date().toISOString(),
        activity: [],
        ...warning,
      };
      warnings.unshift(w);
      return w.id;
    },
    // A change request the copilot proposed for `author` (T4.09), as propose_ontology_change opens it.
    addCopilotProposal({ message, ops, author }) {
      const number = Math.max(0, ...reviews.map((r) => r.number)) + 1;
      reviews.push({
        number,
        message,
        author: author.split('@')[0],
        author_id: author,
        reviewer: null,
        reviewer_id: null,
        status: 'open',
        stats: diffStats(ops),
        reverts: null,
        source: 'copilot',
        created_at: new Date().toISOString(),
        decided_by: null,
        decided_at: null,
        commit_id: null,
        ops,
        thread: [],
      });
      return number;
    },
    // Lets a test set what the warning performance page is shown (T3.10).
    setPerformance(report) {
      performanceReport = report;
    },
    performanceQueries: () => [...performanceQueries],
    // Lets a test add a message to the site's outbox listing, as tiles-notify would leave it.
    addDelivery(d) {
      deliveries.unshift({
        id: deliveries.length + 1,
        kind: 'warning_raised',
        channel: 'email',
        warning_id: randomUUID(),
        created_at: new Date().toISOString(),
        sent_at: null,
        failed_at: null,
        attempts: 0,
        last_error: null,
        ...d,
      });
    },
    // The Teams webhook URL the site was given (a test checks it never comes back to the browser).
    teamsUrl: () => teams.url,
    // Makes the next `n` reads of a warning fail, as a restarting API would.
    failWarningGets(n = 1) {
      failWarningGets = n;
    },
    // Lets a test require (or stop requiring) a review for every change, as a site admin would.
    requireReview(required = true) {
      reviewRequired = required;
    },
    // Lets a test send staged changes for review as another user.
    requestReviewAs(user, ops, message, reviewerId = null) {
      let repo = { head, history, staged: [] };
      for (const op of ops) repo = stage(repo, op);
      reviews.push({
        number: reviews.length + 1,
        message,
        author: user.split('@')[0],
        author_id: user,
        reviewer: reviewerId ? reviewerId.split('@')[0] : null,
        reviewer_id: reviewerId,
        status: 'open',
        stats: diffStats(ops),
        reverts: null,
        created_at: new Date().toISOString(),
        decided_by: null,
        decided_at: null,
        commit_id: null,
        ops: repo.staged,
        thread: [],
      });
      members.add(user);
    },
    // Lets a test change a user's role, as a site admin would.
    setRole(user, role) {
      roles[user] = role;
    },
    // Lets a test give a user staged changes, as if made earlier.
    stageAs(user, ops) {
      let repo = repoFor(user);
      for (const op of ops) repo = stage(repo, op);
      staged.set(user, repo.staged);
    },
    // Lets a test act as another user committing directly.
    commitAs(user, ops, message) {
      ({ head, history } = commit({ head, history, staged: ops }, { message, author: user })); // validates them all
    },
    listen: () =>
      new Promise((resolve) =>
        server.listen(0, '127.0.0.1', () => {
          origin = `http://127.0.0.1:${server.address().port}`;
          resolve(origin);
        }),
      ),
    close: () =>
      new Promise((resolve) => {
        server.close(resolve);
        server.closeAllConnections(); // browsers keep connections alive
      }),
  };
}
