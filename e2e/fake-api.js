// An in-memory stand-in for the Tiles API's ontology endpoints, for browser
// tests. It runs the same ontology logic as the app (js/lib/ontology.ts,
// loaded through Node's TypeScript type stripping), with one shared head and
// history and staged changes per user, like the real API.
import { createServer } from 'node:http';
import { applyOp, commit, createRepo, revert, stage, workingGraph, healthCheck } from '../js/lib/ontology.ts';

// `slowWritesMs` delays batch staging, to test answers that arrive late.
export function createFakeApi({ slowWritesMs = 0 } = {}) {
  const site = { id: '11111111-1111-1111-1111-111111111111', slug: 'plant-1', name: 'Plant 1', org: 'demo' };
  let head = createRepo().head;
  let history = [];
  const staged = new Map(); // email -> Op[]
  const requests = [];

  const repoFor = (user) => ({ head, history, staged: staged.get(user) ?? [] });

  async function body(req) {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    return raw ? JSON.parse(raw) : undefined;
  }

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
    const user = req.headers['x-tiles-user'] ?? 'demo@example.com';
    requests.push(`${req.method} ${url.pathname}`);
    const base = `/sites/${site.id}/ontology`;
    try {
      if (url.pathname === '/health') return send(200, { status: 'ok', version: 'fake', env: 'test' });
      if (url.pathname === '/sites') return send(200, [site]);
      if (!url.pathname.startsWith(base)) return send(404, { detail: 'Site not found' });
      const path = url.pathname.slice(base.length);
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
        server.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${server.address().port}`)),
      ),
    close: () =>
      new Promise((resolve) => {
        server.close(resolve);
        server.closeAllConnections(); // browsers keep connections alive
      }),
  };
}
