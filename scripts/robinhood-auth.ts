// One-time Robinhood OAuth helper. Run: npm run robinhood:auth
// Registers a client with Robinhood's MCP authorization server, sends you to Robinhood to log in and approve,
// receives the callback on 127.0.0.1, and stores the tokens in data/robinhood-token.json (gitignored).
import crypto from 'node:crypto';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { discoverMetadata, saveToken, TOKEN_FILE, tokenFromResponse } from '../src/data/robinhood-auth.js';

const PORT = Number(process.env.RH_AUTH_PORT ?? 53682);
const REDIRECT = `http://127.0.0.1:${PORT}/callback`;
const SCOPE = 'internal';

const b64url = (b: Buffer) => b.toString('base64url');

const meta = await discoverMetadata();
console.log('Robinhood OAuth endpoints discovered.');

// 1. Dynamic client registration (RFC 7591)
const reg = await fetch(meta.registration_endpoint, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
  body: JSON.stringify({
    client_name: 'APEX',
    redirect_uris: [REDIRECT],
    grant_types: ['authorization_code', 'refresh_token'],
    response_types: ['code'],
    token_endpoint_auth_method: 'none',
    scope: SCOPE,
  }),
});
const regText = await reg.text();
if (!reg.ok) {
  console.error(`\nRegistration was rejected (HTTP ${reg.status}):\n${regText}\n`);
  console.error(
    `Robinhood may only allow redirect URIs for clients it has approved (a Cursor user hit "Mismatching Redirect URI").\n` +
    `Options:\n` +
    `  1. Try another loopback port:  RH_AUTH_PORT=8787 npm run robinhood:auth\n` +
    `  2. Get a token with the MCP Inspector (https://platform.claude.com/docs/en/agents-and-tools/mcp-connector#obtaining-an-access-token-for-testing)\n` +
    `     and put it in ROBINHOOD_MCP_AUTH_TOKEN (it cannot auto-refresh).\n` +
    `  3. Ask Robinhood support to enable a custom MCP client: https://robinhood.com/us/en/support/articles/agentic-trading-overview/`,
  );
  process.exit(1);
}
const clientId = (JSON.parse(regText) as { client_id?: string }).client_id;
if (!clientId) throw new Error(`Registration response had no client_id: ${regText.slice(0, 200)}`);

// 2. Authorization request with PKCE (S256) and a state value
const verifier = b64url(crypto.randomBytes(48));
const challenge = b64url(crypto.createHash('sha256').update(verifier).digest());
const state = b64url(crypto.randomBytes(16));
const authUrl = new URL(meta.authorization_endpoint);
authUrl.search = new URLSearchParams({
  response_type: 'code', client_id: clientId, redirect_uri: REDIRECT, scope: SCOPE,
  code_challenge: challenge, code_challenge_method: 'S256', state,
}).toString();

const code = await new Promise<string>((resolve, reject) => {
  const timer = setTimeout(() => { server.close(); reject(new Error('Timed out after 5 minutes waiting for the browser login')); }, 300_000);
  const server = http.createServer((req, res) => {
    const u = new URL(req.url ?? '/', REDIRECT);
    if (u.pathname !== '/callback') { res.writeHead(404).end(); return; }
    const fail = (msg: string) => { res.writeHead(400, { 'Content-Type': 'text/plain' }).end(msg); clearTimeout(timer); server.close(); reject(new Error(msg)); };
    if (u.searchParams.get('error')) return fail(`Authorization failed: ${u.searchParams.get('error')} ${u.searchParams.get('error_description') ?? ''}`);
    if (u.searchParams.get('state') !== state) return fail('State mismatch — possible CSRF, aborting');
    const iss = u.searchParams.get('iss'); // server advertises authorization_response_iss_parameter_supported
    if (iss && iss !== meta.issuer) return fail(`Unexpected issuer ${iss}`);
    const c = u.searchParams.get('code');
    if (!c) return fail('No code in callback');
    res.writeHead(200, { 'Content-Type': 'text/plain' }).end('APEX is authorised. You can close this tab.');
    clearTimeout(timer);
    server.close();
    resolve(c);
  });
  server.on('error', reject);
  server.listen(PORT, '127.0.0.1', () => {
    console.log(`\nOpen this URL and approve access (log in to Robinhood if asked):\n\n${authUrl.toString()}\n`);
    // Best effort; the URL is also printed above. PowerShell avoids cmd.exe mangling the '&' characters.
    const cmd = process.platform === 'win32'
      ? spawn('powershell', ['-NoProfile', '-Command', `Start-Process '${authUrl.toString()}'`], { stdio: 'ignore' })
      : spawn(process.platform === 'darwin' ? 'open' : 'xdg-open', [authUrl.toString()], { stdio: 'ignore' });
    cmd.on('error', () => {});
  });
});

// 3. Exchange the code
const tokenRes = await fetch(meta.token_endpoint, {
  method: 'POST',
  headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
  body: new URLSearchParams({ grant_type: 'authorization_code', code, redirect_uri: REDIRECT, client_id: clientId, code_verifier: verifier }),
});
const body = (await tokenRes.json().catch(() => ({}))) as Record<string, unknown>;
if (!tokenRes.ok) throw new Error(`Token exchange failed (HTTP ${tokenRes.status}): ${String(body.error ?? '')} ${String(body.error_description ?? '')}`);

saveToken(tokenFromResponse(body, { clientId, redirectUri: REDIRECT, tokenEndpoint: meta.token_endpoint, refreshToken: null, scope: SCOPE }));
console.log(`Done. Tokens saved to ${TOKEN_FILE}`);
console.log(typeof body.refresh_token === 'string' ? 'A refresh token was issued, so APEX can renew access automatically.' : 'WARNING: no refresh token was issued; you will need to re-run this when the access token expires.');
process.exit(0);
