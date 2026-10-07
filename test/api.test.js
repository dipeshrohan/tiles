import { test } from 'vitest';
import assert from 'node:assert/strict';
import {
  ApiError,
  createApiClient,
  isHttpUrl,
  isTilesHealth,
  normalizeBaseUrl,
  resolveDataSource,
  DEFAULT_DATA_SOURCE,
} from '../js/lib/api.ts';

// A fetch stand-in that records calls and answers from a queue.
function fakeFetch(...answers) {
  const calls = [];
  const fn = async (url, init) => {
    calls.push({ url, ...init });
    const next = answers.shift();
    if (next instanceof Error) throw next;
    const { status = 200, body, raw, headers = {} } = next ?? {};
    return new Response(status === 204 ? null : (raw ?? JSON.stringify(body ?? null)), {
      status,
      headers: { 'content-type': 'application/json', ...headers },
    });
  };
  return { fn, calls };
}

const op = { kind: 'addNode', node: { id: 'a', type: 'Line', label: 'A', props: {} } };

test('requests carry JSON, the identity header and a bearer token when given', async () => {
  const f = fakeFetch({ status: 201, body: [op] });
  const api = createApiClient({
    baseUrl: 'http://api.test/',
    userEmail: 'alice@example.com',
    token: 't0k',
    fetch: f.fn,
  });
  assert.deepEqual(await api.ontology.stage('site 1', op), [op]);
  const [call] = f.calls;
  assert.equal(call.url, 'http://api.test/sites/site%201/ontology/staged');
  assert.equal(call.method, 'POST');
  assert.equal(call.headers['Content-Type'], 'application/json');
  assert.equal(call.headers['X-Tiles-User'], 'alice@example.com');
  assert.equal(call.headers.Authorization, 'Bearer t0k');
  assert.deepEqual(JSON.parse(call.body), op);
});

test('every ontology call hits the documented path', async () => {
  const f = fakeFetch(...Array.from({ length: 11 }, () => ({ body: {} })));
  const api = createApiClient({ baseUrl: 'http://api.test', fetch: f.fn });
  await api.sites();
  await api.membership('s');
  await api.ontology.graph('s');
  await api.ontology.graph('s', 'head');
  await api.ontology.staged('s');
  await api.ontology.stageMany('s', [op]);
  await api.ontology.commit('s', 'msg');
  await api.ontology.history('s', { limit: 10, offset: 20 });
  await api.ontology.revert('s', 'c/1');
  await api.ontology.health('s');
  await api.health();
  assert.deepEqual(
    f.calls.map((c) => `${c.method} ${c.url.replace('http://api.test', '')}`),
    [
      'GET /sites',
      'GET /sites/s/me',
      'GET /sites/s/ontology/graph?view=working',
      'GET /sites/s/ontology/graph?view=head',
      'GET /sites/s/ontology/staged',
      'POST /sites/s/ontology/staged/batch',
      'POST /sites/s/ontology/commits',
      'GET /sites/s/ontology/commits?limit=10&offset=20',
      'POST /sites/s/ontology/commits/c%2F1/revert',
      'GET /sites/s/ontology/health?view=head',
      'GET /health',
    ],
  );
  assert.equal(f.calls[0].headers['X-Tiles-User'], undefined);
  assert.deepEqual(JSON.parse(f.calls[5].body), [op]);
  assert.deepEqual(JSON.parse(f.calls[6].body), { message: 'msg' });
});

test('204 responses resolve to undefined', async () => {
  const f = fakeFetch({ status: 204 });
  assert.equal(await createApiClient({ baseUrl: 'http://a', fetch: f.fn }).ontology.discard('s'), undefined);
  assert.equal(f.calls[0].method, 'DELETE');
});

test('API errors carry the server message, status and request id, and reach onError', async () => {
  const seen = [];
  const f = fakeFetch({ status: 409, body: { detail: 'Node a not found' }, headers: { 'x-request-id': 'req-1' } });
  const api = createApiClient({ baseUrl: 'http://a', fetch: f.fn, onError: (e) => seen.push(e) });
  const err = await api.ontology.commit('s', 'x').catch((e) => e);
  assert.ok(err instanceof ApiError);
  assert.equal(err.message, 'Node a not found');
  assert.equal(err.status, 409);
  assert.equal(err.requestId, 'req-1');
  assert.deepEqual(seen, [err]);
});

test('validation errors are summarised field by field', async () => {
  const detail = [
    { loc: ['body', 'node', 'id'], msg: 'String should have at least 1 character' },
    { loc: ['body'], msg: 'Field required' },
  ];
  const f = fakeFetch({ status: 422, body: { detail } });
  const err = await createApiClient({ baseUrl: 'http://a', fetch: f.fn })
    .ontology.stage('s', op)
    .catch((e) => e);
  assert.equal(err.message, 'node.id: String should have at least 1 character; Field required');
});

test('non-JSON errors and network failures still give a readable ApiError', async () => {
  const f = fakeFetch({ status: 502, raw: '<html>Bad gateway</html>' }, new TypeError('Failed to fetch'), {
    status: 200,
    raw: 'not json',
  });
  const seen = [];
  const api = createApiClient({ baseUrl: 'http://a', fetch: f.fn, onError: (e) => seen.push(e.message) });
  assert.equal((await api.sites().catch((e) => e)).message, 'The Tiles API answered 502');
  const offline = await api.sites().catch((e) => e);
  assert.equal(offline.status, 0);
  assert.equal(offline.message, "Can't reach the Tiles API at http://a");
  assert.equal((await api.sites().catch((e) => e)).message, 'The Tiles API sent a response that is not JSON');
  assert.equal(seen.length, 3);
});

test('base URLs lose trailing slashes and spaces', () => {
  assert.equal(normalizeBaseUrl(' http://localhost:8000/// '), 'http://localhost:8000');
});

test('data source: saved choice, defaults and the ?api= override', () => {
  assert.deepEqual(resolveDataSource(null, ''), DEFAULT_DATA_SOURCE);
  const saved = { mode: 'api', apiUrl: 'http://tiles.example.com' };
  assert.deepEqual(resolveDataSource(saved, ''), saved);
  assert.deepEqual(resolveDataSource(saved, '?api=local'), { ...saved, mode: 'local' });
  assert.deepEqual(resolveDataSource(null, '?api=http://127.0.0.1:9000/'), {
    mode: 'api',
    apiUrl: 'http://127.0.0.1:9000',
  });
  // Anything that isn't an http(s) URL is ignored, and a corrupt saved mode falls back to local.
  assert.deepEqual(resolveDataSource(null, '?api=javascript:alert(1)'), DEFAULT_DATA_SOURCE);
  assert.equal(resolveDataSource({ mode: 'cloud' }, '').mode, 'local');
});

test('only a real Tiles /health answer counts as connected', () => {
  assert.equal(isTilesHealth({ status: 'ok', version: '0.1.0', env: 'development' }), true);
  for (const other of [{ ok: true }, { status: 'ok' }, { status: 'up', version: '1', env: 'x' }, null, 'ok']) {
    assert.equal(isTilesHealth(other), false);
  }
});

test('http(s) URL check', () => {
  assert.equal(isHttpUrl('http://localhost:8000'), true);
  assert.equal(isHttpUrl('https://tiles.example.com'), true);
  for (const bad of ['', 'localhost:8000', 'ftp://x', 'http://', 'javascript:alert(1)'])
    assert.equal(isHttpUrl(bad), false);
});
