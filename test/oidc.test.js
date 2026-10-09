import { test, beforeEach } from 'vitest';
import assert from 'node:assert/strict';
import {
  accessToken,
  beginSignIn,
  cleanCallbackUrl,
  codeChallenge,
  completeSignIn,
  loadSession,
  signOut,
  SignInError,
  takeSignOutReturn,
} from '../js/lib/oidc.ts';

// Vitest runs in Node: give the module a sessionStorage.
const store = new Map();
globalThis.sessionStorage = {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => store.set(k, String(v)),
  removeItem: (k) => store.delete(k),
};
beforeEach(() => store.clear());

const ISSUER = 'https://idp.test/realms/tiles';
const DISCOVERY = {
  authorization_endpoint: `${ISSUER}/auth`,
  token_endpoint: `${ISSUER}/token`,
  end_session_endpoint: `${ISSUER}/logout`,
};
const API = 'http://localhost:8000';
const config = { issuer: ISSUER, clientId: 'tiles-web', redirectUri: 'http://localhost:5173/', apiUrl: API };

// Answers discovery and records token requests.
function provider(
  tokenAnswer = { status: 200, body: { access_token: 'at', expires_in: 300, refresh_token: 'rt', id_token: 'it' } },
) {
  const tokenCalls = [];
  const fn = async (url, init) => {
    if (String(url).endsWith('/.well-known/openid-configuration')) return Response.json(DISCOVERY);
    tokenCalls.push(Object.fromEntries(new URLSearchParams(init.body)));
    return Response.json(tokenAnswer.body, { status: tokenAnswer.status });
  };
  return { fn, tokenCalls };
}

test('PKCE challenge matches RFC 7636 appendix B', async () => {
  assert.equal(
    await codeChallenge('dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk'),
    'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM',
  );
});

test('sign-in sends the browser to the provider with PKCE and returns with a session', async () => {
  const p = provider();
  const url = new URL(await beginSignIn(config, '#/ontology', p.fn));
  assert.equal(url.origin + url.pathname, `${ISSUER}/auth`);
  const q = url.searchParams;
  assert.equal(q.get('response_type'), 'code');
  assert.equal(q.get('client_id'), 'tiles-web');
  assert.equal(q.get('redirect_uri'), 'http://localhost:5173/');
  assert.equal(q.get('code_challenge_method'), 'S256');
  assert.match(q.get('scope'), /openid/);

  const done = await completeSignIn(`?code=abc&state=${q.get('state')}&session_state=x`, p.fn, 1_000);
  assert.equal(done.returnTo, '#/ontology');
  assert.deepEqual(done.session, {
    accessToken: 'at',
    expiresAt: 301_000,
    refreshToken: 'rt',
    idToken: 'it',
    issuer: ISSUER,
    clientId: 'tiles-web',
    apiUrl: API,
  });
  const [call] = p.tokenCalls;
  assert.equal(call.grant_type, 'authorization_code');
  assert.equal(call.code, 'abc');
  assert.equal(await codeChallenge(call.code_verifier), q.get('code_challenge'));
  assert.deepEqual(loadSession(), done.session);
});

test('callbacks that do not match, report an error, or are not callbacks', async () => {
  const p = provider();
  assert.equal(await completeSignIn('?api=local', p.fn), null);
  await beginSignIn(config, '#/', p.fn);
  await assert.rejects(completeSignIn('?code=abc&state=forged', p.fn), /did not match/);
  await assert.rejects(completeSignIn('?error=access_denied&error_description=Nope', p.fn), /Nope/);
  assert.equal(p.tokenCalls.length, 0);
  assert.equal(loadSession(), null);
});

test('a failed code exchange is reported and leaves no session', async () => {
  const p = provider({ status: 400, body: { error: 'invalid_grant', error_description: 'Code expired' } });
  const q = new URL(await beginSignIn(config, '#/', p.fn)).searchParams;
  await assert.rejects(completeSignIn(`?code=abc&state=${q.get('state')}`, p.fn), /Code expired/);
  assert.equal(loadSession(), null);
});

async function signedIn(expiresIn, extra = {}) {
  const p = provider({ status: 200, body: { access_token: 'first', expires_in: expiresIn, ...extra } });
  const q = new URL(await beginSignIn(config, '#/', p.fn)).searchParams;
  await completeSignIn(`?code=abc&state=${q.get('state')}`, p.fn, 0);
}

test('access tokens are reused, then refreshed shortly before they expire', async () => {
  await signedIn(300, { refresh_token: 'rt' });
  assert.equal(await accessToken(API, provider().fn, 100_000), 'first');
  const p = provider({ status: 200, body: { access_token: 'second', expires_in: 300 } });
  assert.equal(await accessToken(API, p.fn, 290_000), 'second');
  assert.deepEqual(p.tokenCalls, [{ grant_type: 'refresh_token', refresh_token: 'rt', client_id: 'tiles-web' }]);
  assert.equal(loadSession().refreshToken, 'rt'); // not rotated: the old one is kept
});

test("an organisation's provider gets its own scope, asked for again on refresh", async () => {
  const scope = 'openid profile email offline_access api://8a2b/access';
  const p = provider({ status: 200, body: { access_token: 'first', expires_in: 300, refresh_token: 'rt' } });
  const q = new URL(await beginSignIn({ ...config, scope }, '#/', p.fn)).searchParams;
  assert.equal(q.get('scope'), scope);
  await completeSignIn(`?code=abc&state=${q.get('state')}`, p.fn, 0);
  assert.equal(loadSession().scope, scope);
  const r = provider({ status: 200, body: { access_token: 'second', expires_in: 300 } });
  assert.equal(await accessToken(API, r.fn, 290_000), 'second');
  assert.equal(r.tokenCalls[0].scope, scope);
  assert.equal(loadSession().scope, scope);
});

test('a session that cannot be renewed is ended', async () => {
  await signedIn(300);
  assert.equal(await accessToken(API, provider().fn, 299_000), null);
  assert.equal(loadSession(), null);
  await signedIn(300, { refresh_token: 'rt' });
  assert.equal(await accessToken(API, provider({ status: 400, body: {} }).fn, 299_000), null);
  assert.equal(loadSession(), null);
});

test('sign-out ends the session and returns the provider logout URL', async () => {
  await signedIn(300, { id_token: 'it' });
  const url = new URL(await signOut('http://localhost:5173/', '#/', provider().fn));
  assert.equal(url.origin + url.pathname, `${ISSUER}/logout`);
  assert.equal(url.searchParams.get('id_token_hint'), 'it');
  assert.equal(url.searchParams.get('post_logout_redirect_uri'), 'http://localhost:5173/');
  assert.equal(loadSession(), null);
  assert.equal(await signOut('http://localhost:5173/', '#/', provider().fn), null);
});

test('after a callback the address returns to the page that started sign-in', () => {
  const callback = 'http://localhost:5173/?code=1&state=2&session_state=3&iss=4';
  assert.equal(
    cleanCallbackUrl(callback, '?api=http%3A%2F%2Fx#/ontology'),
    'http://localhost:5173/?api=http%3A%2F%2Fx#/ontology',
  );
  assert.equal(cleanCallbackUrl(callback, '#/'), 'http://localhost:5173/#/');
  // Unknown origin page (e.g. a failed sign-in): just drop the callback parameters.
  assert.equal(
    cleanCallbackUrl('http://localhost:5173/?api=x&error=access_denied&state=2#/settings'),
    'http://localhost:5173/?api=x#/settings',
  );
});

test('a token is only ever sent to the API it was obtained for', async () => {
  await signedIn(300, { refresh_token: 'rt' });
  assert.equal(await accessToken(API, provider().fn, 1_000), 'first');
  // A link like ?api=https://attacker.example must not get our token.
  assert.equal(await accessToken('https://attacker.example', provider().fn, 1_000), null);
  assert.equal(loadSession().accessToken, 'first'); // and the session survives
});

test('concurrent callers share one refresh (rotating refresh tokens stay valid)', async () => {
  await signedIn(300, { refresh_token: 'rt-1' });
  const p = provider({ status: 200, body: { access_token: 'second', expires_in: 300, refresh_token: 'rt-2' } });
  const tokens = await Promise.all([1, 2, 3].map(() => accessToken(API, p.fn, 290_000)));
  assert.deepEqual(tokens, ['second', 'second', 'second']);
  assert.equal(p.tokenCalls.length, 1);
  assert.equal(loadSession().refreshToken, 'rt-2');
});

test('a failed sign-in still knows the page to return to', async () => {
  const p = provider({ status: 400, body: { error: 'invalid_grant' } });
  const q = new URL(await beginSignIn(config, '?api=x#/settings', p.fn)).searchParams;
  const err = await completeSignIn(`?code=abc&state=${q.get('state')}`, p.fn).catch((e) => e);
  assert.ok(err instanceof SignInError);
  assert.equal(err.returnTo, '?api=x#/settings');
  await beginSignIn(config, '?api=y#/ontology', p.fn);
  const denied = await completeSignIn('?error=access_denied', p.fn).catch((e) => e);
  assert.equal(denied.returnTo, '?api=y#/ontology');
});

test('signing out remembers the page to come back to, once', async () => {
  await signedIn(300);
  await signOut('http://localhost:5173/', '?api=x#/settings', provider().fn);
  assert.equal(takeSignOutReturn(), '?api=x#/settings');
  assert.equal(takeSignOutReturn(), null);
});
