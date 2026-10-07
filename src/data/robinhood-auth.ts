import fs from 'node:fs';
import path from 'node:path';
import { PROJECT_ROOT } from '../config/index.js';

/**
 * OAuth for the Robinhood MCP server. Anthropic's MCP connector does not run OAuth: the caller must obtain
 * the access token and refresh it, then pass it as `authorization_token`. This module stores the token
 * produced by `npm run robinhood:auth` and refreshes it when it is about to expire.
 *
 * Discovered from https://agent.robinhood.com/.well-known/oauth-authorization-server:
 * authorization-code + PKCE (S256), dynamic client registration, public client (no secret), refresh tokens.
 */

export const RH_ORIGIN = 'https://agent.robinhood.com';
export const TOKEN_FILE = process.env.ROBINHOOD_TOKEN_FILE?.trim() || path.join(PROJECT_ROOT, 'data', 'robinhood-token.json');

export interface RhMetadata {
  issuer: string;
  authorization_endpoint: string;
  token_endpoint: string;
  registration_endpoint: string;
  scopes_supported?: string[];
}

export interface StoredToken {
  clientId: string;
  redirectUri: string;
  tokenEndpoint: string;
  accessToken: string;
  refreshToken: string | null;
  /** Epoch ms. */
  expiresAt: number;
  scope: string;
}

export async function discoverMetadata(): Promise<RhMetadata> {
  const res = await fetch(`${RH_ORIGIN}/.well-known/oauth-authorization-server`, { headers: { Accept: 'application/json' } });
  if (!res.ok) throw new Error(`OAuth metadata request failed: HTTP ${res.status}`);
  return (await res.json()) as RhMetadata;
}

export function loadToken(): StoredToken | null {
  try {
    return JSON.parse(fs.readFileSync(TOKEN_FILE, 'utf8')) as StoredToken;
  } catch {
    return null;
  }
}

export function saveToken(t: StoredToken): void {
  fs.mkdirSync(path.dirname(TOKEN_FILE), { recursive: true });
  fs.writeFileSync(TOKEN_FILE, JSON.stringify(t, null, 2), { mode: 0o600 });
}

/** Turns a token endpoint response into a StoredToken, keeping the old refresh token if none is rotated in. */
export function tokenFromResponse(body: Record<string, unknown>, prev: Pick<StoredToken, 'clientId' | 'redirectUri' | 'tokenEndpoint' | 'refreshToken' | 'scope'>): StoredToken {
  if (typeof body.access_token !== 'string') throw new Error('Token response had no access_token');
  const lifetimeSec = typeof body.expires_in === 'number' ? body.expires_in : 3600;
  return {
    clientId: prev.clientId,
    redirectUri: prev.redirectUri,
    tokenEndpoint: prev.tokenEndpoint,
    accessToken: body.access_token,
    refreshToken: typeof body.refresh_token === 'string' ? body.refresh_token : prev.refreshToken,
    expiresAt: Date.now() + lifetimeSec * 1000,
    scope: typeof body.scope === 'string' ? body.scope : prev.scope,
  };
}

let refreshing: Promise<StoredToken> | null = null;

async function refresh(t: StoredToken): Promise<StoredToken> {
  if (!t.refreshToken) throw new Error('Robinhood token expired and there is no refresh token. Run: npm run robinhood:auth');
  const res = await fetch(t.tokenEndpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
    body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: t.refreshToken, client_id: t.clientId }),
  });
  const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok) {
    throw new Error(`Robinhood token refresh failed (HTTP ${res.status}: ${String(body.error ?? 'unknown')}). Run: npm run robinhood:auth`);
  }
  const next = tokenFromResponse(body, t);
  saveToken(next); // refresh tokens may rotate, so persist immediately
  return next;
}

/**
 * Returns a valid access token, refreshing it if it expires within a minute. ROBINHOOD_MCP_AUTH_TOKEN
 * (e.g. one obtained from the MCP Inspector) takes precedence but cannot be refreshed.
 */
export async function getAccessToken(opts: { forceRefresh?: boolean } = {}): Promise<string> {
  const manual = process.env.ROBINHOOD_MCP_AUTH_TOKEN?.trim();
  if (manual) return manual;

  const t = loadToken();
  if (!t) throw new Error('No Robinhood token found. Run once: npm run robinhood:auth');
  if (!opts.forceRefresh && t.expiresAt - Date.now() > 60_000) return t.accessToken;

  refreshing ??= refresh(t).finally(() => { refreshing = null; }); // one refresh at a time: rotation would invalidate a racing second one
  return (await refreshing).accessToken;
}
