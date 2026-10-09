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

test('edge agent calls hit the documented paths', async () => {
  const f = fakeFetch({ body: [] }, { status: 201, body: { agent: {}, token: 'tla_x' } }, { status: 204 });
  const api = createApiClient({ baseUrl: 'http://api.test', fetch: f.fn });
  assert.deepEqual(await api.agents.list('s'), []);
  assert.equal((await api.agents.register('s', 'edge-01')).token, 'tla_x');
  await api.agents.revoke('s', 'a/1');
  assert.deepEqual(
    f.calls.map((c) => `${c.method} ${c.url.replace('http://api.test', '')}`),
    ['GET /sites/s/agents', 'POST /sites/s/agents', 'DELETE /sites/s/agents/a%2F1'],
  );
  assert.deepEqual(JSON.parse(f.calls[1].body), { name: 'edge-01' });
});

test('a revealed agent token is shown only to the admin, API and site it was made for', async () => {
  const { tokenStillShown } = await import('../js/views/settings.ts');
  const r = { name: 'e', token: 'tla_x', apiUrl: 'http://a', siteId: 's', user: 'dev:ana@example.com' };
  assert.equal(tokenStillShown(r, 'http://a', 's', true, 'dev:ana@example.com'), true);
  assert.equal(tokenStillShown(r, 'http://b', 's', true, 'dev:ana@example.com'), false);
  assert.equal(tokenStillShown(r, 'http://a', 't', true, 'dev:ana@example.com'), false);
  assert.equal(tokenStillShown(r, 'http://a', 's', false, 'dev:ana@example.com'), false);
  assert.equal(tokenStillShown(r, 'http://a', 's', true, 'signed-in:ana@example.com'), false);
  assert.equal(tokenStillShown(r, undefined, undefined, true, 'dev:ana@example.com'), false);
  assert.equal(tokenStillShown(null, 'http://a', 's', true, 'dev:ana@example.com'), false);
});

test('agent connectors show as badges with their detail as a tooltip', async () => {
  const { connectorList } = await import('../js/views/settings.ts');
  assert.equal(connectorList({ connectors: [] }), '—');
  const html = connectorList({
    connectors: [
      { name: 'press-line', kind: 'opcua', status: 'ok', detail: 'subscribed to 2 nodes' },
      { name: 'oven', kind: 'opcua', status: 'down', detail: "the server's certificate <x> is not the pinned one" },
    ],
  });
  assert.match(html, /<span class="badge good" title="opcua: subscribed to 2 nodes">press-line ok<\/span>/);
  assert.match(
    html,
    /<span class="badge bad" title="opcua: the server&#39;s certificate &lt;x&gt; is not the pinned one">oven down<\/span>/,
  );
});

test("an agent's buffer shows what waits and why", async () => {
  const { bufferSummary } = await import('../js/views/settings.ts');
  assert.equal(bufferSummary({ buffer: null }), '—');
  const buffer = { queued: 0, oldest_at: null, sent: 10, dropped: 0, rejected: 0, problem: '' };
  assert.match(bufferSummary({ buffer }), /^<span class="badge good" title="0 waiting\. 10 sent, 0 dropped/);
  const stuck = bufferSummary({ buffer: { ...buffer, queued: 12000, problem: "can't reach <Tiles>" } });
  assert.match(stuck, /class="badge warn"/);
  assert.match(stuck, /can&#39;t reach &lt;Tiles&gt;" *>12,000 queued<\/span>$/);
  assert.match(bufferSummary({ buffer: { ...buffer, dropped: 3 } }), /class="badge bad"/);
});

test('audit summaries read as sentences', async () => {
  const { describeAudit } = await import('../js/views/settings.ts');
  const e = (action, before, after) => ({ action, before, after, entity_type: 'x', entity_id: 'y' });
  assert.equal(describeAudit(e('ontology.stage', null, { ops: [1, 2] })), 'Staged 2 change(s)');
  assert.equal(describeAudit(e('ontology.discard', { ops: [1] }, null)), 'Discarded 1 staged change(s)');
  assert.equal(describeAudit(e('ontology.commit', null, { message: 'add press' })), 'Committed “add press”');
  assert.equal(describeAudit(e('ontology.revert', { reverted: 'c1' }, {})), 'Reverted commit c1');
  assert.equal(
    describeAudit(e('member.role', { role: 'engineer' }, { role: 'viewer' })),
    "Changed a member's role from engineer to viewer",
  );
  assert.equal(describeAudit(e('agent.register', null, { name: 'edge-01' })), 'Registered edge agent edge-01');
  assert.equal(describeAudit(e('agent.revoke', { name: 'edge-01' }, null)), 'Revoked edge agent edge-01');
  assert.equal(describeAudit(e('import.start', null, { name: 'line-2.csv' })), 'Started importing line-2.csv');
  assert.equal(
    describeAudit(e('import.finish', null, { received: 10, stored: 7 })),
    'Finished an import: 7 new readings of 10 sent',
  );
  assert.equal(describeAudit(e('site.rename', null, null)), 'site.rename x y');
});

test('the public sign-in settings are fetched without credentials', async () => {
  const f = fakeFetch({ body: { enabled: true } });
  const api = createApiClient({
    baseUrl: 'http://a',
    userEmail: 'ana@example.com',
    getToken: async () => 'secret',
    fetch: f.fn,
  });
  await api.authConfig();
  assert.equal(f.calls[0].headers.Authorization, undefined);
  assert.equal(f.calls[0].headers['X-Tiles-User'], undefined);
});

test('every change-review call hits the documented path with its body', async () => {
  const f = fakeFetch(...Array.from({ length: 10 }, () => ({ body: {} })));
  const api = createApiClient({ baseUrl: 'http://api.test', fetch: f.fn });
  await api.members('s');
  await api.ontology.reviewPolicy('s');
  await api.ontology.setReviewPolicy('s', true);
  await api.reviews.list('s', 'closed', { limit: 5 });
  await api.reviews.get('s', 3);
  await api.reviews.request('s', { message: 'm', reviewer_id: 'u1' });
  await api.reviews.comment('s', 3, 'hi');
  await api.reviews.approve('s', 3);
  await api.reviews.reject('s', 3, 'no');
  await api.reviews.rework('s', 3);
  assert.deepEqual(
    f.calls.map((c) => `${c.method} ${c.url.replace('http://api.test', '')}`),
    [
      'GET /sites/s/members',
      'GET /sites/s/ontology/review-policy',
      'PUT /sites/s/ontology/review-policy',
      'GET /sites/s/ontology/reviews?state=closed&limit=5&offset=0',
      'GET /sites/s/ontology/reviews/3',
      'POST /sites/s/ontology/reviews',
      'POST /sites/s/ontology/reviews/3/comments',
      'POST /sites/s/ontology/reviews/3/approve',
      'POST /sites/s/ontology/reviews/3/reject',
      'POST /sites/s/ontology/reviews/3/rework',
    ],
  );
  const bodies = f.calls.map((c) => (c.body === undefined ? undefined : JSON.parse(c.body)));
  assert.deepEqual(bodies, [
    undefined,
    undefined,
    { required: true },
    undefined,
    undefined,
    { message: 'm', reviewer_id: 'u1' },
    { body: 'hi' },
    { comment: '' },
    { comment: 'no' },
    undefined,
  ]);
});

test('an ontology export comes back as the file text; an import sends the file and the mode', async () => {
  const f = fakeFetch({ raw: 'kind,id\n', headers: { 'content-type': 'text/csv' } }, { body: { total: 0 } });
  const api = createApiClient({ baseUrl: 'http://api.test', fetch: f.fn });
  assert.equal(await api.ontology.exportFile('s', 'csv'), 'kind,id\n');
  await api.ontology.importFile('s', { format: 'json', content: '{}', name: 'a.json', mode: 'replace', dryRun: true });
  assert.deepEqual(
    f.calls.map((c) => `${c.method} ${c.url.replace('http://api.test', '')}`),
    ['GET /sites/s/ontology/export?format=csv', 'POST /sites/s/ontology/import'],
  );
  assert.deepEqual(JSON.parse(f.calls[1].body), {
    format: 'json',
    content: '{}',
    name: 'a.json',
    mode: 'replace',
    dry_run: true,
  });
});

test('every warning call hits the documented path with its body', async () => {
  const f = fakeFetch(...Array.from({ length: 8 }, () => ({ body: {} })));
  const api = createApiClient({ baseUrl: 'http://api.test', fetch: f.fn });
  await api.warnings.list('s');
  await api.warnings.list('s', { status: 'unresolved', assignee: 'me', state: 'open', outcome: undefined, limit: 50 });
  await api.warnings.get('s', 'w 1');
  await api.warnings.acknowledge('s', 'w1');
  await api.warnings.assign('s', 'w1', 'u2', 'yours');
  await api.warnings.assign('s', 'w1', null);
  await api.warnings.resolve('s', 'w1', 'false_alarm', 'noise');
  await api.warnings.reopen('s', 'w1');
  assert.deepEqual(
    f.calls.map((c) => `${c.method} ${c.url.replace('http://api.test', '')}`),
    [
      'GET /sites/s/warnings',
      'GET /sites/s/warnings?status=unresolved&assignee=me&state=open&limit=50',
      'GET /sites/s/warnings/w%201',
      'POST /sites/s/warnings/w1/acknowledge',
      'PUT /sites/s/warnings/w1/assignee',
      'PUT /sites/s/warnings/w1/assignee',
      'POST /sites/s/warnings/w1/resolve',
      'POST /sites/s/warnings/w1/reopen',
    ],
  );
  assert.deepEqual(
    f.calls.map((c) => (c.body === undefined ? undefined : JSON.parse(c.body))),
    [
      undefined,
      undefined,
      undefined,
      { note: '' },
      { user_id: 'u2', note: 'yours' },
      { user_id: null, note: '' },
      { outcome: 'false_alarm', note: 'noise' },
      { note: '' },
    ],
  );
  const g = fakeFetch({ status: 201, body: {} });
  await createApiClient({ baseUrl: 'http://api.test', fetch: g.fn }).warnings.comment('s', 'w1', 'seen');
  assert.deepEqual(
    [g.calls[0].method, g.calls[0].url, JSON.parse(g.calls[0].body)],
    ['POST', 'http://api.test/sites/s/warnings/w1/comments', { note: 'seen' }],
  );
});

test('every notification call hits the documented path with its body', async () => {
  const f = fakeFetch(...Array.from({ length: 7 }, () => ({ body: {} })));
  const api = createApiClient({ baseUrl: 'http://api.test', fetch: f.fn });
  await api.notifications.preferences('s');
  await api.notifications.setPreferences('s', { on_raised: true, on_assigned: false });
  await api.notifications.teams('s');
  await api.notifications.setTeams('s', 'https://x.webhook.office.com/a', false);
  await api.notifications.setTeams('s', null);
  await api.notifications.setTeams('s', undefined, false);
  await api.notifications.deliveries('s', { state: 'failed', limit: 20 });
  assert.deepEqual(
    f.calls.map((c) => `${c.method} ${c.url.replace('http://api.test', '')}`),
    [
      'GET /sites/s/notifications/preferences',
      'PUT /sites/s/notifications/preferences',
      'GET /sites/s/notifications/teams',
      'PUT /sites/s/notifications/teams',
      'PUT /sites/s/notifications/teams',
      'PUT /sites/s/notifications/teams',
      'GET /sites/s/notifications?state=failed&limit=20',
    ],
  );
  assert.deepEqual(
    f.calls.map((c) => (c.body === undefined ? undefined : JSON.parse(c.body))),
    [
      undefined,
      { on_raised: true, on_assigned: false },
      undefined,
      { webhook_url: 'https://x.webhook.office.com/a', on_raised: false },
      { webhook_url: null, on_raised: true },
      { on_raised: false },
      undefined,
    ],
  );
});

test('the performance report and a detector asset are asked for as documented', async () => {
  const f = fakeFetch({ body: {} }, { body: {} }, { body: {} });
  const api = createApiClient({ baseUrl: 'http://api.test', fetch: f.fn });
  await api.performance('s');
  await api.performance('s', { days: 7, horizonHours: 2, codes: ['DT-1', 'DT 2'] });
  await api.setDetectorAsset('s', 'd 1', null);
  assert.deepEqual(
    f.calls.map((c) => `${c.method} ${c.url.replace('http://api.test', '')}`),
    [
      'GET /sites/s/performance',
      'GET /sites/s/performance?days=7&horizon_hours=2&codes=DT-1&codes=DT+2',
      'PATCH /sites/s/detectors/d%201',
    ],
  );
  assert.deepEqual(JSON.parse(f.calls[2].body), { asset: null });
});

test('every dataset call hits the documented path with its body', async () => {
  const f = fakeFetch(...Array.from({ length: 6 }, () => ({ body: {} })));
  const api = createApiClient({ baseUrl: 'http://api.test', fetch: f.fn });
  await api.datasets.list('s');
  await api.datasets.get('s', 'd 1');
  await api.datasets.create('s', 'Lots', [{ name: 'x', kind: 'number' }]);
  await api.datasets.addRows('s', 'd1', [{ x: 1 }]);
  await api.datasets.correlate('s', 'd1', { outcome: 'ng', ng_values: [true], variables: ['x'], split: null });
  await api.datasets.remove('s', 'd1');
  assert.deepEqual(
    f.calls.map((c) => `${c.method} ${c.url.replace('http://api.test', '')}`),
    [
      'GET /sites/s/datasets',
      'GET /sites/s/datasets/d%201',
      'POST /sites/s/datasets',
      'POST /sites/s/datasets/d1/rows',
      'POST /sites/s/datasets/d1/correlate',
      'DELETE /sites/s/datasets/d1',
    ],
  );
  assert.deepEqual(
    f.calls.map((c) => (c.body === undefined ? undefined : JSON.parse(c.body))),
    [
      undefined,
      undefined,
      { name: 'Lots', columns: [{ name: 'x', kind: 'number' }] },
      { rows: [{ x: 1 }] },
      { outcome: 'ng', ng_values: [true], variables: ['x'], split: null },
      undefined,
    ],
  );
});

test('every insight call hits the documented path with its body', async () => {
  const f = fakeFetch(...Array.from({ length: 7 }, () => ({ body: {} })));
  const api = createApiClient({ baseUrl: 'http://api.test', fetch: f.fn });
  const draft = { title: 'T', summary: '', actions: ['a'] };
  const source = { kind: 'series', signals: ['x'], start: '2026-09-01T00:00:00Z', end: '2026-09-02T00:00:00Z' };
  await api.insights.list('s');
  await api.insights.list('s', { status: 'accepted', limit: 5 });
  await api.insights.get('s', 3);
  await api.insights.create('s', draft, source);
  await api.insights.edit('s', 3, { title: 'U' });
  await api.insights.review('s', 3, 'rejected', 'why');
  await api.insights.reopen('s', 3);
  assert.deepEqual(
    f.calls.map((c) => `${c.method} ${c.url.replace('http://api.test', '')}`),
    [
      'GET /sites/s/insights',
      'GET /sites/s/insights?status=accepted&limit=5',
      'GET /sites/s/insights/3',
      'POST /sites/s/insights',
      'PATCH /sites/s/insights/3',
      'POST /sites/s/insights/3/review',
      'POST /sites/s/insights/3/reopen',
    ],
  );
  assert.deepEqual(JSON.parse(f.calls[3].body), { ...draft, source });
  assert.deepEqual(JSON.parse(f.calls[4].body), { title: 'U' });
  assert.deepEqual(JSON.parse(f.calls[5].body), { decision: 'rejected', note: 'why' });
});

test('the copilot calls hit their paths, and an answer streams in as events', async () => {
  const sse =
    'event: text\ndata: {"text":"Hel"}\n\nevent: text\ndata: {"text":"lo [1]."}\n\nevent: done\ndata: {"grounded":true}\n\n';
  const f = fakeFetch(
    { body: { configured: true } },
    { status: 201, body: { id: 'c 1' } },
    { raw: sse, headers: { 'content-type': 'text/event-stream' } },
    { body: { rating: 'down', comment: 'x' } },
    { status: 204 },
    { status: 409, body: { detail: 'The copilot is still answering in this conversation' } },
  );
  const errors = [];
  const api = createApiClient({ baseUrl: 'http://api.test', fetch: f.fn, token: 't', onError: (e) => errors.push(e) });
  assert.deepEqual(await api.copilot.status('s'), { configured: true });
  await api.copilot.create('s');
  const events = [];
  await api.copilot.ask('s', 'c 1', 'Hi?', (e) => events.push(e));
  assert.deepEqual(events, [
    { event: 'text', data: { text: 'Hel' } },
    { event: 'text', data: { text: 'lo [1].' } },
    { event: 'done', data: { grounded: true } },
  ]);
  await api.copilot.rate('s', 'c 1', 3, 'down', 'x');
  await api.copilot.unrate('s', 'c 1', 3);
  await assert.rejects(
    api.copilot.ask('s', 'c 1', 'Again?', () => {}),
    /still answering/,
  );
  assert.equal(errors.length, 1);
  assert.deepEqual(
    f.calls.map((c) => `${c.method} ${c.url.replace('http://api.test', '')}`),
    [
      'GET /sites/s/copilot',
      'POST /sites/s/copilot/conversations',
      'POST /sites/s/copilot/conversations/c%201/messages',
      'PUT /sites/s/copilot/conversations/c%201/messages/3/feedback',
      'DELETE /sites/s/copilot/conversations/c%201/messages/3/feedback',
      'POST /sites/s/copilot/conversations/c%201/messages',
    ],
  );
  assert.equal(f.calls[2].headers.Accept, 'text/event-stream');
  assert.equal(f.calls[2].headers.Authorization, 'Bearer t');
  assert.deepEqual(JSON.parse(f.calls[2].body), { text: 'Hi?' });
  assert.deepEqual(JSON.parse(f.calls[3].body), { rating: 'down', comment: 'x' });
});
