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
export function createFakeApi({
  oidc = false,
  requireSignIn = false,
  signedInAs = 'ana@example.com',
  slowWritesMs = 0,
  roles = {},
  slowAuthConfigMs = 0,
} = {}) {
  let origin = '';
  const codes = new Map(); // code -> { challenge, redirectUri }
  const tokens = new Set();
  const site = { id: '11111111-1111-1111-1111-111111111111', slug: 'plant-1', name: 'Plant 1', org: 'demo' };
  let head = createRepo().head;
  let history = [];
  const staged = new Map(); // email -> Op[]
  const requests = [];
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
    res.setHeader('access-control-allow-methods', 'GET, POST, DELETE');
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
      if (!url.pathname.startsWith(base) && url.pathname !== `/sites/${site.id}/me` && !url.pathname.endsWith('/audit'))
        return send(404, { detail: 'Site not found' });
      const role = roles[user] ?? 'engineer';
      if (url.pathname === `/sites/${site.id}/audit`)
        return role === 'admin'
          ? send(200, audit)
          : send(403, { detail: 'Your role on this site is engineer; this needs admin or above' });
      if (url.pathname === `/sites/${site.id}/me`)
        return send(200, { user_id: user, email: user, name: user, role, site_role: role, org_admin: false });
      const path = url.pathname.slice(base.length);
      if (role === 'viewer' && req.method !== 'GET')
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
