// Spotify Authorization Code with PKCE, entirely in the browser.
// Docs: https://developer.spotify.com/documentation/web-api/tutorials/code-pkce-flow
//       https://developer.spotify.com/documentation/web-api/tutorials/refreshing-tokens

import { config } from '../config';
import { kvDelete, kvGet, kvSet } from '../store/db';

const AUTHORIZE_URL = 'https://accounts.spotify.com/authorize';
const TOKEN_URL = 'https://accounts.spotify.com/api/token';

export const SCOPES = [
  'user-library-read',
  'user-library-modify',
  'user-top-read',
  'user-read-recently-played',
  'user-read-playback-state',
  'user-modify-playback-state',
];

const TOKENS_KEY = 'auth.tokens';
const PENDING_KEY = 'auth.pending';
/** Refresh this long before the access token actually expires. */
const EXPIRY_MARGIN_MS = 60_000;
const PENDING_TTL_MS = 10 * 60_000;

export interface Tokens {
  accessToken: string;
  refreshToken: string;
  /** Epoch ms. */
  expiresAt: number;
  scope: string;
}

interface PendingLogin {
  verifier: string;
  state: string;
  createdAt: number;
}

interface TokenResponse {
  access_token: string;
  token_type: string;
  scope: string;
  expires_in: number;
  refresh_token?: string;
}

export class AuthError extends Error {
  override name = 'AuthError';
}

// --- PKCE primitives -------------------------------------------------------

const VERIFIER_CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~';

export function randomString(length: number): string {
  const bytes = crypto.getRandomValues(new Uint8Array(length));
  let out = '';
  for (const b of bytes) out += VERIFIER_CHARS[b % VERIFIER_CHARS.length];
  return out;
}

export function base64Url(bytes: ArrayBuffer): string {
  let binary = '';
  for (const b of new Uint8Array(bytes)) binary += String.fromCharCode(b);
  return btoa(binary).replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');
}

export async function codeChallenge(verifier: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
  return base64Url(digest);
}

// --- Flow ------------------------------------------------------------------

function requireConfig(): { clientId: string; redirectUri: string } {
  const { spotifyClientId, redirectUri } = config;
  if (!spotifyClientId || !redirectUri) {
    throw new AuthError('Missing VITE_SPOTIFY_CLIENT_ID or VITE_REDIRECT_URI in .env.local');
  }
  return { clientId: spotifyClientId, redirectUri };
}

/** Redirects the browser to Spotify's consent page. */
export async function login(): Promise<never> {
  const { clientId, redirectUri } = requireConfig();
  const verifier = randomString(64);
  const state = randomString(16);
  await kvSet(PENDING_KEY, { verifier, state, createdAt: Date.now() } satisfies PendingLogin);

  const url = new URL(AUTHORIZE_URL);
  url.search = new URLSearchParams({
    client_id: clientId,
    response_type: 'code',
    redirect_uri: redirectUri,
    state,
    scope: SCOPES.join(' '),
    code_challenge_method: 'S256',
    code_challenge: await codeChallenge(verifier),
  }).toString();
  window.location.assign(url.toString());
  return new Promise<never>(() => {});
}

export function isCallback(location: Location): boolean {
  const { redirectUri } = config;
  if (!redirectUri) return false;
  return location.pathname.replace(/\/$/, '') === new URL(redirectUri).pathname.replace(/\/$/, '');
}

/** Exchanges the `?code=` on the callback URL for tokens. */
export async function handleCallback(params: URLSearchParams): Promise<Tokens> {
  const { clientId, redirectUri } = requireConfig();
  const error = params.get('error');
  if (error) throw new AuthError(`Spotify login failed: ${error}`);

  const pending = await kvGet<PendingLogin>(PENDING_KEY);
  await kvDelete(PENDING_KEY);
  if (!pending || Date.now() - pending.createdAt > PENDING_TTL_MS) {
    throw new AuthError('Login expired or was started in another browser. Try again.');
  }
  if (params.get('state') !== pending.state) throw new AuthError('Login state mismatch. Try again.');
  const code = params.get('code');
  if (!code) throw new AuthError('Callback had no authorization code.');

  const tokens = await tokenRequest(
    {
      grant_type: 'authorization_code',
      code,
      redirect_uri: redirectUri,
      client_id: clientId,
      code_verifier: pending.verifier,
    },
    undefined,
  );
  await kvSet(TOKENS_KEY, tokens);
  return tokens;
}

async function tokenRequest(body: Record<string, string>, previousRefreshToken: string | undefined): Promise<Tokens> {
  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(body),
  });
  if (!res.ok) {
    const detail = await res.json().catch(() => ({}));
    if (detail?.error === 'invalid_grant') {
      // Per Spotify docs: drop the refresh token and restart the login flow.
      await kvDelete(TOKENS_KEY);
      throw new AuthError('Session expired. Log in again.');
    }
    throw new AuthError(`Token request failed (${res.status}): ${detail?.error_description ?? detail?.error ?? ''}`);
  }
  const json = (await res.json()) as TokenResponse;
  const refreshToken = json.refresh_token ?? previousRefreshToken;
  if (!refreshToken) throw new AuthError('Spotify returned no refresh token.');
  return {
    accessToken: json.access_token,
    // Refresh responses may omit refresh_token; keep using the old one then.
    refreshToken,
    expiresAt: Date.now() + json.expires_in * 1000,
    scope: json.scope,
  };
}

let refreshing: Promise<Tokens> | undefined;

async function refresh(tokens: Tokens): Promise<Tokens> {
  // Several requests can hit an expired token at once; share one refresh.
  refreshing ??= (async () => {
    try {
      const { clientId } = requireConfig();
      const next = await tokenRequest(
        { grant_type: 'refresh_token', refresh_token: tokens.refreshToken, client_id: clientId },
        tokens.refreshToken,
      );
      await kvSet(TOKENS_KEY, next);
      return next;
    } finally {
      refreshing = undefined;
    }
  })();
  return refreshing;
}

export async function getTokens(): Promise<Tokens | undefined> {
  return kvGet<Tokens>(TOKENS_KEY);
}

/**
 * Returns a valid access token, refreshing if it is near expiry.
 * `force` refreshes even if the token looks valid, e.g. after a 401.
 */
export async function getAccessToken(force = false): Promise<string> {
  const tokens = await getTokens();
  if (!tokens) throw new AuthError('Not logged in.');
  if (!force && tokens.expiresAt - EXPIRY_MARGIN_MS > Date.now()) return tokens.accessToken;
  return (await refresh(tokens)).accessToken;
}

export async function logout(): Promise<void> {
  await kvDelete(TOKENS_KEY);
}

/** Debug helper: mark the access token expired so the next call must refresh. */
export async function expireAccessToken(): Promise<void> {
  const tokens = await getTokens();
  if (tokens) await kvSet(TOKENS_KEY, { ...tokens, expiresAt: 0 });
}
