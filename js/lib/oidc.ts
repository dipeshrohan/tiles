// OpenID Connect sign-in for the browser: Authorization Code flow with PKCE
// (RFC 7636), no client secret, no dependencies. The session (tokens) lives
// in sessionStorage, so it ends with the tab and is not shared across sites.

export interface Endpoints {
  authorization_endpoint: string;
  token_endpoint: string;
  end_session_endpoint?: string;
}

export interface SignInConfig {
  issuer: string;
  clientId: string;
  redirectUri: string;
  // The Tiles API this sign-in is for. Its token is only ever sent there.
  apiUrl: string;
  // What to ask for; an organisation's provider may need its API's scope (Entra ID: api://…/access).
  scope?: string;
}

export interface Session {
  accessToken: string;
  expiresAt: number; // epoch ms
  refreshToken?: string;
  idToken?: string;
  issuer: string;
  clientId: string;
  apiUrl: string;
  // Asked for again on refresh (Entra ID wants it); unset for the default.
  scope?: string;
}

// A failed sign-in, with the page to go back to (so ?api=… survives).
export class SignInError extends Error {
  readonly returnTo: string | undefined;
  constructor(message: string, returnTo?: string) {
    super(message);
    this.name = 'SignInError';
    this.returnTo = returnTo;
  }
}

interface Pending extends SignInConfig {
  state: string;
  verifier: string;
  returnTo: string; // query and hash route to come back to, e.g. ?api=…#/ontology
}

type Fetch = typeof fetch;
const PENDING_KEY = 'tiles:oidc-pending';
const SESSION_KEY = 'tiles:oidc-session';
const AFTER_SIGN_OUT_KEY = 'tiles:oidc-after-sign-out';

// ---- PKCE ------------------------------------------------------------------

export function base64url(bytes: Uint8Array): string {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function randomString(bytes = 32): string {
  return base64url(crypto.getRandomValues(new Uint8Array(bytes)));
}

export async function codeChallenge(verifier: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
  return base64url(new Uint8Array(digest));
}

// ---- storage (guarded: storage can be blocked) -------------------------------

function read<T>(key: string): T | null {
  try {
    const raw = sessionStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : null;
  } catch {
    return null;
  }
}

function write(key: string, value: unknown): void {
  try {
    if (value === null) sessionStorage.removeItem(key);
    else sessionStorage.setItem(key, JSON.stringify(value));
  } catch {
    // signed in for this page only
  }
}

// ---- flow ---------------------------------------------------------------------

export async function discover(issuer: string, doFetch: Fetch = fetch): Promise<Endpoints> {
  const res = await doFetch(`${issuer.replace(/\/+$/, '')}/.well-known/openid-configuration`);
  if (!res.ok) throw new Error(`Sign-in provider answered ${res.status}`);
  const body = (await res.json()) as Partial<Endpoints>;
  if (!body.authorization_endpoint || !body.token_endpoint) throw new Error('Sign-in provider is misconfigured');
  return body as Endpoints;
}

// Returns the provider URL to send the browser to.
export async function beginSignIn(config: SignInConfig, returnTo: string, doFetch: Fetch = fetch): Promise<string> {
  const endpoints = await discover(config.issuer, doFetch);
  const pending: Pending = { ...config, state: randomString(16), verifier: randomString(32), returnTo };
  write(PENDING_KEY, pending);
  const url = new URL(endpoints.authorization_endpoint);
  url.search = new URLSearchParams({
    response_type: 'code',
    client_id: config.clientId,
    redirect_uri: config.redirectUri,
    scope: config.scope || 'openid email profile',
    state: pending.state,
    code_challenge: await codeChallenge(pending.verifier),
    code_challenge_method: 'S256',
  }).toString();
  return url.toString();
}

interface TokenResponse {
  access_token: string;
  expires_in?: number;
  refresh_token?: string;
  id_token?: string;
}

async function tokenRequest(
  endpoint: string,
  form: Record<string, string>,
  config: Pick<Session, 'issuer' | 'clientId' | 'apiUrl' | 'scope'>,
  doFetch: Fetch,
  now: number,
): Promise<Session> {
  const res = await doFetch(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(form).toString(),
  });
  const body = (await res.json().catch(() => ({}))) as Partial<TokenResponse> & { error_description?: string };
  if (!res.ok || !body.access_token) throw new Error(body.error_description ?? `Sign-in failed (${res.status})`);
  return {
    accessToken: body.access_token,
    expiresAt: now + (body.expires_in ?? 300) * 1000,
    refreshToken: body.refresh_token,
    idToken: body.id_token,
    issuer: config.issuer,
    clientId: config.clientId,
    apiUrl: config.apiUrl,
    ...(config.scope ? { scope: config.scope } : {}),
  };
}

// Finishes a sign-in when the provider has redirected back with ?code&state.
// Returns null when the URL is not a sign-in callback.
export async function completeSignIn(
  search: string,
  doFetch: Fetch = fetch,
  now = Date.now(),
): Promise<{ session: Session; returnTo: string } | null> {
  const params = new URLSearchParams(search);
  const code = params.get('code');
  const state = params.get('state');
  const error = params.get('error');
  if (!code && !error) return null;
  const pending = read<Pending>(PENDING_KEY);
  write(PENDING_KEY, null);
  const returnTo = pending?.returnTo;
  if (error) throw new SignInError(params.get('error_description') ?? `Sign-in was cancelled (${error})`, returnTo);
  if (!pending || !state || pending.state !== state)
    throw new SignInError('Sign-in response did not match; try again', returnTo);
  let session: Session;
  try {
    const endpoints = await discover(pending.issuer, doFetch);
    session = await tokenRequest(
      endpoints.token_endpoint,
      {
        grant_type: 'authorization_code',
        code: code ?? '',
        redirect_uri: pending.redirectUri,
        client_id: pending.clientId,
        code_verifier: pending.verifier,
      },
      pending,
      doFetch,
      now,
    );
  } catch (e) {
    throw new SignInError(e instanceof Error ? e.message : String(e), returnTo);
  }
  write(SESSION_KEY, session);
  return { session, returnTo: pending.returnTo };
}

export function loadSession(): Session | null {
  return read<Session>(SESSION_KEY);
}

export function clearSession(): void {
  write(SESSION_KEY, null);
}

// The access token to send to `apiUrl`, refreshed when it is about to expire.
// Null when signed out, when the session belongs to another API (a token is
// never sent anywhere but the API it was obtained for), or when it can't be
// renewed (then the session is cleared). Concurrent callers share one refresh,
// so a provider that rotates refresh tokens sees a single exchange.
let refreshing: Promise<string | null> | null = null;

export async function accessToken(apiUrl: string, doFetch: Fetch = fetch, now = Date.now()): Promise<string | null> {
  const session = loadSession();
  if (!session || session.apiUrl !== apiUrl) return null;
  if (session.expiresAt - now > 30_000) return session.accessToken;
  refreshing ??= refresh(session, doFetch, now).finally(() => {
    refreshing = null;
  });
  return refreshing;
}

async function refresh(session: Session, doFetch: Fetch, now: number): Promise<string | null> {
  if (!session.refreshToken) {
    clearSession();
    return null;
  }
  try {
    const endpoints = await discover(session.issuer, doFetch);
    const next = await tokenRequest(
      endpoints.token_endpoint,
      {
        grant_type: 'refresh_token',
        refresh_token: session.refreshToken,
        client_id: session.clientId,
        ...(session.scope ? { scope: session.scope } : {}),
      },
      session,
      doFetch,
      now,
    );
    // Providers may keep the refresh token (no rotation) or the ID token.
    write(SESSION_KEY, {
      ...next,
      refreshToken: next.refreshToken ?? session.refreshToken,
      idToken: next.idToken ?? session.idToken,
    });
    return next.accessToken;
  } catch {
    clearSession();
    return null;
  }
}

// Ends the session here and returns the provider's sign-out URL, if it has one.
// `returnTo` (query and hash) is restored after the provider sends us back.
export async function signOut(
  postLogoutRedirect: string,
  returnTo: string,
  doFetch: Fetch = fetch,
): Promise<string | null> {
  const session = loadSession();
  clearSession();
  write(AFTER_SIGN_OUT_KEY, returnTo);
  if (!session) return null;
  try {
    const { end_session_endpoint } = await discover(session.issuer, doFetch);
    if (!end_session_endpoint) return null;
    const url = new URL(end_session_endpoint);
    url.search = new URLSearchParams({
      client_id: session.clientId,
      post_logout_redirect_uri: postLogoutRedirect,
      ...(session.idToken ? { id_token_hint: session.idToken } : {}),
    }).toString();
    return url.toString();
  } catch {
    return null;
  }
}

// The page to show after returning from the provider's sign-out, once.
export function takeSignOutReturn(): string | null {
  const returnTo = read<string>(AFTER_SIGN_OUT_KEY);
  write(AFTER_SIGN_OUT_KEY, null);
  return returnTo;
}

// The address to show after a callback: the page we left for sign-in
// (`returnTo`: its query and hash), or, when unknown, the current address
// without the callback parameters.
export function cleanCallbackUrl(href: string, returnTo?: string): string {
  const url = new URL(href);
  if (returnTo !== undefined) return new URL(returnTo, url.origin + url.pathname).toString();
  for (const p of ['code', 'state', 'session_state', 'iss', 'error', 'error_description']) url.searchParams.delete(p);
  return url.toString();
}
