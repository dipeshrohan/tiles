// An in-memory stand-in for the Tiles API's ontology endpoints, for browser
// tests. It runs the same ontology logic as the app (js/lib/ontology.ts,
// loaded through Node's TypeScript type stripping), with one shared head and
// history and staged changes per user, like the real API.
import { createHash, randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { applyOp, commit, createRepo, revert, stage, workingGraph, healthCheck } from '../js/lib/ontology.ts';

// With `oidc`, it is also a tiny sign-in provider at /idp that approves every
// request, checks PKCE, and issues opaque tokens the API accepts. With
// `requireSignIn`, requests without a token get 401, as in production.
// `slowWritesMs` delays batch staging, to test answers that arrive late.
// `roles` maps a user's email to their site role (engineer by default).
// `slowAuthConfigMs` delays /auth/config, to test background re-renders.
// `failImportFinish` makes finishing an import fail, as a dropped connection would.
export function createFakeApi({
  oidc = false,
  requireSignIn = false,
  signedInAs = 'ana@example.com',
  slowWritesMs = 0,
  roles = {},
  slowAuthConfigMs = 0,
  failImportFinish = false,
} = {}) {
  let origin = '';
  const codes = new Map(); // code -> { challenge, redirectUri }
  const tokens = new Set();
  const site = { id: '11111111-1111-1111-1111-111111111111', slug: 'plant-1', name: 'Plant 1', org: 'demo' };
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

  const server = createServer(async (req, res) => {
    const send = (status, data) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(data === undefined ? '' : JSON.stringify(data));
    };
    res.setHeader('access-control-allow-origin', '*');
    res.setHeader('access-control-allow-headers', 'content-type, x-tiles-user, authorization');
    res.setHeader('access-control-allow-methods', 'GET, POST, PATCH, DELETE');
    if (req.method === 'OPTIONS') return send(204);
    const url = new URL(req.url, 'http://fake');
    requests.push(`${req.method} ${url.pathname}`);

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
      if (url.pathname === '/sites') return send(200, [site]);
      const agentsPath = `/sites/${site.id}/agents`;
      if (
        !url.pathname.startsWith(base) &&
        url.pathname !== `/sites/${site.id}/me` &&
        !url.pathname.endsWith('/audit') &&
        !url.pathname.startsWith(agentsPath) &&
        !url.pathname.startsWith(`/sites/${site.id}/imports`) &&
        !url.pathname.startsWith(`/sites/${site.id}/signals`)
      )
        return send(404, { detail: 'Site not found' });
      const role = roles[user] ?? 'engineer';
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
        const suggestions = unmapped.map((x) => {
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
        return send(200, { unmapped: unmapped.length, suggestions });
      }
      const plotted = signals.find((x) => url.pathname === `${signalsPath}/${x.id}/series`);
      if (plotted && req.method === 'GET') {
        // Like the API: readings in [from, to), as they are or in at most `points` buckets.
        const from = Date.parse(url.searchParams.get('from') ?? '');
        const to = Date.parse(url.searchParams.get('to') ?? '');
        const points = Number(url.searchParams.get('points') ?? 1000);
        if (!(to > from)) return send(422, { detail: '`to` must be after `from`' });
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
        return send(200, {
          signal_id: plotted.id,
          tag: plotted.tag,
          unit: plotted.unit,
          start: new Date(from).toISOString(),
          end: new Date(to).toISOString(),
          bucket_s: bucket,
          points: out,
        });
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
      if (url.pathname === `/sites/${site.id}/me`)
        return send(200, { user_id: user, email: user, name: user, role, site_role: role, org_admin: false });
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
  });

  return {
    server,
    requests,
    bearersSeen,
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
      let repo = { head, history, staged: [] };
      for (const op of ops) {
        applyOp(workingGraph(repo), op);
        repo = stage(repo, op);
      }
      ({ head, history } = commit(repo, { message, author: user }));
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
