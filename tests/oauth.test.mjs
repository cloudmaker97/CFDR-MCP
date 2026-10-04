import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { mkdtemp, rm, readFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import pino from 'pino';
import { createHttpApp } from '../dist/http.js';
import { loadConfig } from '../dist/config.js';
import { ContentStore } from '../dist/store.js';
import { ApiKeyOAuthProvider } from '../dist/oauth.js';

const issuer = 'http://127.0.0.1:3000';
const resource = `${issuer}/mcp`;
const apiKey = 'test-api-key-with-high-entropy';
const redirect = 'https://client.example/callback';
const verifier = randomBytes(32).toString('base64url');
const challenge = createHash('sha256').update(verifier).digest('base64url');
const digest = value => createHash('sha256').update(value).digest('hex');

async function fixture(fn) {
  const root = await mkdtemp(join(tmpdir(), 'legal-oauth-'));
  const config = { ...loadConfig(), dataDir: root, token: apiKey, oauthEnabled: true, publicUrl: issuer, publicRead: false };
  const store = new ContentStore();
  const logs = [];
  const app = createHttpApp(config, store, { lastError: null, updating: false }, pino({ level: 'info' }, { write: line => logs.push(JSON.parse(line)) }));
  const server = app.listen(0, '127.0.0.1'); await new Promise(r => server.once('listening', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const post = (path, body, headers = {}) => fetch(`${base}${path}`, { method: 'POST', redirect: 'manual', headers: { 'Content-Type': 'application/x-www-form-urlencoded', ...headers }, body: new URLSearchParams(body) });
  const register = async (metadata = {}) => {
    const response = await fetch(`${base}/register`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ redirect_uris: [redirect], client_name: 'Test <script>alert(1)</script>', token_endpoint_auth_method: 'none', ...metadata }) });
    return { response, client: await response.json() };
  };
  const authorize = async (client, overrides = {}) => {
    const query = new URLSearchParams({ client_id: client.client_id, response_type: 'code', redirect_uri: redirect, code_challenge: challenge, code_challenge_method: 'S256', resource, scope: 'legal:read', state: 'client-state', ...overrides });
    const response = await fetch(`${base}/authorize?${query}`, { redirect: 'manual' });
    const html = await response.text();
    return { response, html, id: /name="request" value="([^"]+)"/.exec(html)?.[1], csrf: /name="csrf" value="([^"]+)"/.exec(html)?.[1], cookie: response.headers.get('set-cookie')?.split(';')[0] };
  };
  const approve = (flow, overrides = {}, headers = {}) => post('/oauth/approve', { request: flow.id, csrf: flow.csrf, api_key: apiKey, action: 'allow', ...overrides }, { Cookie: flow.cookie, Origin: issuer, ...headers });
  const consent = async client => {
    const flow = await authorize(client);
    assert.equal(flow.response.status, 200);
    const approved = await approve(flow); assert.equal(approved.status, 303);
    const location = new URL(approved.headers.get('location'));
    assert.equal(location.searchParams.get('state'), 'client-state');
    return { code: location.searchParams.get('code'), flow };
  };
  const exchange = (client, code, overrides = {}) => post('/token', { grant_type: 'authorization_code', client_id: client.client_id, ...(client.client_secret ? { client_secret: client.client_secret } : {}), code, code_verifier: verifier, redirect_uri: redirect, resource, ...overrides });
  const login = async (metadata = {}) => {
    const { client, response } = await register(metadata); assert.equal(response.status, 201);
    const { code } = await consent(client);
    const tokenResponse = await exchange(client, code); assert.equal(tokenResponse.status, 200);
    return { client, tokens: await tokenResponse.json(), code };
  };
  const metrics = token => fetch(`${base}/metrics`, { headers: token ? { Authorization: `Bearer ${token}` } : {} });
  try { await fn({ root, config, base, post, register, authorize, approve, consent, exchange, login, metrics, logs }); }
  finally { app.locals.stopRateLimiter(); await new Promise(r => server.close(r)); app.locals.stopOAuth(); store.close(); await rm(root, { recursive: true, force: true }); }
}

test('OAuth discovery, escaped consent, PKCE login and API-key compatibility', () => fixture(async f => {
  const unauthenticated = await f.metrics(); assert.equal(unauthenticated.status, 401);
  assert.match(unauthenticated.headers.get('www-authenticate'), /resource_metadata="http:\/\/127.0.0.1:3000\/\.well-known\/oauth-protected-resource\/mcp"/);
  const prm = await (await fetch(`${f.base}/.well-known/oauth-protected-resource/mcp`)).json();
  assert.equal(prm.resource, resource); assert.deepEqual(prm.authorization_servers, [`${issuer}/`]);
  const metadata = await (await fetch(`${f.base}/.well-known/oauth-authorization-server`)).json();
  assert.deepEqual(metadata.code_challenge_methods_supported, ['S256']); assert.equal(metadata.registration_endpoint, `${issuer}/register`);
  const { client } = await f.register();
  const flow = await f.authorize(client);
  assert.match(flow.html, /&lt;script&gt;/); assert.ok(!flow.html.includes(apiKey)); assert.match(flow.html, /Keine Rechtsberatung/);
  assert.match(flow.response.headers.get('content-security-policy'), /frame-ancestors 'none'/);
  assert.equal(flow.response.headers.get('referrer-policy'), 'same-origin');
  assert.match(flow.response.headers.get('set-cookie'), /HttpOnly/);
  const approved = await f.approve(flow); assert.equal(approved.status, 303);
  const code = new URL(approved.headers.get('location')).searchParams.get('code');
  const response = await f.exchange(client, code); assert.equal(response.status, 200);
  const tokens = await response.json(); assert.equal(tokens.expires_in, 3600); assert.equal(tokens.scope, 'legal:read');
  assert.equal((await f.metrics(tokens.access_token)).status, 200);
  assert.equal((await f.metrics(apiKey)).status, 200);
  assert.equal((await f.approve(flow)).status, 403);
  const dbText = (await readFile(join(f.root, 'oauth.sqlite'))).toString('latin1');
  assert.ok(!dbText.includes(tokens.access_token)); assert.ok(!dbText.includes(tokens.refresh_token)); assert.ok(!dbText.includes(apiKey));
  if (process.platform !== 'win32') assert.equal((await stat(join(f.root, 'oauth.sqlite'))).mode & 0o777, 0o600);
}));

test('consent rejects incorrect keys, CSRF and foreign origins; cancellation returns state', () => fixture(async f => {
  const { client } = await f.register(); const flow = await f.authorize(client);
  assert.equal((await f.approve(flow, { csrf: 'bad' })).status, 403);
  assert.equal((await f.approve(flow, {}, { Origin: 'https://evil.example' })).status, 403);
  assert.equal((await f.approve(flow, {}, { Origin: 'null' })).status, 403);
  assert.equal((await f.approve(flow, {}, { Cookie: '' })).status, 403);
  const wrong = await f.approve(flow, { api_key: 'wrong-key' }); assert.equal(wrong.status, 403); assert.match(await wrong.text(), /API-Schlüssel ungültig/);
  for (const failure of ['csrf_mismatch', 'origin_mismatch', 'cookie_missing', 'invalid_api_key']) assert.ok(f.logs.some(entry => entry.failure === failure));
  const logs = JSON.stringify(f.logs);
  assert.ok(!logs.includes(apiKey)); assert.ok(!logs.includes('wrong-key')); assert.ok(!logs.includes(flow.csrf)); assert.ok(!logs.includes(flow.id));
  const cancelled = await f.approve(flow, { action: 'deny', api_key: '' });
  assert.equal(cancelled.status, 303); const location = new URL(cancelled.headers.get('location'));
  assert.equal(location.searchParams.get('error'), 'access_denied'); assert.equal(location.searchParams.get('state'), 'client-state');
  assert.equal((await f.approve(flow)).status, 403);
}));

test('parallel browser login tabs keep independent CSRF cookies', () => fixture(async f => {
  const { client } = await f.register();
  const first = await f.authorize(client), second = await f.authorize(client);
  assert.notEqual(first.cookie.split('=')[0], second.cookie.split('=')[0]);
  const jar = `${first.cookie}; ${second.cookie}`;
  assert.equal((await f.approve(first, {}, { Cookie: jar })).status, 303);
  assert.equal((await f.approve(second, {}, { Cookie: jar })).status, 303);
}));

test('SDK OAuth rate limits stay enabled behind untrusted forwarded headers without proxy warnings', () => fixture(async f => {
  const messages = [], previous = console.error;
  console.error = (...args) => messages.push(args.join(' '));
  const headers = { 'X-Forwarded-For': '203.0.113.1', Forwarded: 'for=203.0.113.1;proto=https' };
  try {
    const { client } = await f.register();
    await fetch(`${f.base}/authorize?client_id=${client.client_id}`, { headers, redirect: 'manual' });
    const token = await f.post('/token', { client_id: client.client_id, grant_type: 'unsupported' }, headers);
    assert.ok(token.headers.get('ratelimit-limit'));
    await f.post('/revoke', { client_id: client.client_id, token: 'unknown' }, headers);
    const response = await fetch(`${f.base}/register`, { method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' }, body: JSON.stringify({ redirect_uris: [redirect], token_endpoint_auth_method: 'none' }) });
    assert.equal(response.status, 201);
    assert.equal(messages.length, 0, messages.join('\n'));
  } finally { console.error = previous; }
}));

test('authorization restricts redirect, PKCE method, scopes and audience', () => fixture(async f => {
  const { client } = await f.register();
  assert.equal((await f.authorize(client, { redirect_uri: 'https://evil.example/' })).response.status, 400);
  for (const changes of [{ code_challenge_method: 'plain' }, { code_challenge: 'bad' }, { scope: 'admin' }, { resource: 'https://evil.example/mcp' }]) {
    const flow = await f.authorize(client, changes); assert.ok(flow.response.status >= 300); assert.ok(!flow.id);
  }
  for (const uri of ['http://remote.example/callback', 'javascript:alert(1)', 'https://user:password@client.example/callback', 'https://client.example/callback#fragment']) {
    assert.equal((await f.register({ redirect_uris: [uri] })).response.status, 400);
  }
  assert.equal((await f.register({ redirect_uris: ['http://127.0.0.1:12345/callback'] })).response.status, 201);
}));

test('codes bind PKCE, client, exact redirect and audience, and are single-use', () => fixture(async f => {
  const { client } = await f.register(); const { client: other } = await f.register();
  const { code } = await f.consent(client);
  for (const [who, changes] of [[client, { code_verifier: 'wrong' }], [other, {}], [client, { redirect_uri: 'https://client.example/other' }], [client, { resource: 'https://other.example/mcp' }]]) {
    assert.equal((await f.exchange(who, code, changes)).status, 400);
  }
  const success = await f.exchange(client, code); assert.equal(success.status, 200);
  const tokens = await success.json();
  assert.equal((await f.exchange(client, code)).status, 400);
  assert.equal((await f.metrics(tokens.access_token)).status, 401);
}));

test('confidential clients must authenticate with their generated client secret', () => fixture(async f => {
  const { client } = await f.register({ token_endpoint_auth_method: 'client_secret_post' });
  assert.ok(client.client_secret);
  const { code } = await f.consent(client);
  const invalid = await f.exchange(client, code, { client_secret: 'wrong' });
  assert.equal(invalid.status, 400); assert.equal((await invalid.json()).error, 'invalid_client');
  assert.equal((await f.exchange(client, code)).status, 200);
}));

test('refresh tokens rotate, restrict scopes and audience, and replay revokes the entire grant', () => fixture(async f => {
  const { client, tokens } = await f.login();
  const refresh = changes => f.post('/token', { grant_type: 'refresh_token', client_id: client.client_id, refresh_token: tokens.refresh_token, resource, ...changes });
  assert.equal((await refresh({ scope: 'admin' })).status, 400);
  assert.equal((await refresh({ resource: 'https://evil.example/mcp' })).status, 400);
  const rotated = await refresh({}); assert.equal(rotated.status, 200); const newer = await rotated.json();
  assert.notEqual(newer.refresh_token, tokens.refresh_token); assert.equal((await f.metrics(newer.access_token)).status, 200);
  assert.equal((await refresh({})).status, 400);
  assert.equal((await f.metrics(newer.access_token)).status, 401); assert.equal((await f.metrics(tokens.access_token)).status, 401);
  assert.equal((await refresh({ refresh_token: newer.refresh_token })).status, 400);
}));

test('revocation respects client ownership and invalidates all credentials of the grant', () => fixture(async f => {
  const { client, tokens } = await f.login(); const { client: other } = await f.register();
  assert.equal((await f.post('/revoke', { client_id: other.client_id, token: tokens.access_token })).status, 200);
  assert.equal((await f.metrics(tokens.access_token)).status, 200);
  assert.equal((await f.post('/revoke', { client_id: client.client_id, token: tokens.refresh_token })).status, 200);
  assert.equal((await f.metrics(tokens.access_token)).status, 401);
  assert.equal((await f.post('/token', { grant_type: 'refresh_token', client_id: client.client_id, refresh_token: tokens.refresh_token })).status, 400);
}));

test('tokens persist across provider restart; API-key rotation invalidates grants', () => fixture(async f => {
  const { client, tokens } = await f.login();
  let reopened = new ApiKeyOAuthProvider(f.config);
  assert.equal((await reopened.verifyAccessToken(tokens.access_token)).clientId, client.client_id);
  reopened.close();
  reopened = new ApiKeyOAuthProvider({ ...f.config, token: 'rotated-api-key' });
  await assert.rejects(reopened.verifyAccessToken(tokens.access_token), /Invalid or expired/);
  await assert.rejects(reopened.exchangeRefreshToken(client, tokens.refresh_token), /Invalid refresh/);
  reopened.close();
}));

test('expired access tokens and codes fail closed', () => fixture(async f => {
  const { tokens } = await f.login(); const { client } = await f.register(); const { code } = await f.consent(client);
  const db = new DatabaseSync(join(f.root, 'oauth.sqlite'));
  db.prepare('UPDATE credentials SET expires=0 WHERE key IN (?,?)').run(digest(tokens.access_token), digest(code)); db.close();
  assert.equal((await f.metrics(tokens.access_token)).status, 401);
  assert.equal((await f.exchange(client, code)).status, 400);
}));

test('OAuth configuration requires a fixed secure origin and can be explicitly disabled', () => {
  const previous = Object.fromEntries(['PUBLIC_URL', 'OAUTH_ENABLED', 'ALLOW_PUBLIC_READ', 'SERVICE_URL_LEGAL_MCP_3000', 'SERVICE_URL_LEGAL_MCP', 'COOLIFY_URL'].map(key => [key, process.env[key]]));
  try {
    delete process.env.SERVICE_URL_LEGAL_MCP_3000; delete process.env.SERVICE_URL_LEGAL_MCP; delete process.env.COOLIFY_URL;
    process.env.OAUTH_ENABLED = 'true'; process.env.ALLOW_PUBLIC_READ = 'false';
    for (const url of ['', 'http://remote.example', 'https://recht.example/path', 'https://recht.example/?x=1', 'https://recht.example/#fragment']) {
      process.env.PUBLIC_URL = url; assert.throws(loadConfig, /OAuth/);
    }
    process.env.PUBLIC_URL = 'https://recht.example'; assert.equal(loadConfig().oauthEnabled, true);
    process.env.OAUTH_ENABLED = 'false'; assert.equal(loadConfig().oauthEnabled, false);
  } finally { for (const [key, value] of Object.entries(previous)) value === undefined ? delete process.env[key] : process.env[key] = value; }
});

test('Coolify URL fallback tolerates empty PUBLIC_URL and explicit origins take precedence', () => {
  const names = ['PUBLIC_URL', 'SERVICE_URL_LEGAL_MCP_3000', 'SERVICE_URL_LEGAL_MCP', 'COOLIFY_URL', 'OAUTH_ENABLED', 'ALLOW_PUBLIC_READ', 'TRANSPORT'];
  const previous = Object.fromEntries(names.map(key => [key, process.env[key]]));
  try {
    for (const key of names) delete process.env[key];
    process.env.TRANSPORT = 'http'; process.env.OAUTH_ENABLED = 'true'; process.env.PUBLIC_URL = '  ';
    process.env.COOLIFY_URL = 'https://application.example';
    assert.equal(loadConfig().publicUrl, 'https://application.example');
    process.env.SERVICE_URL_LEGAL_MCP_3000 = 'https://service.example';
    assert.equal(loadConfig().publicUrl, 'https://service.example');
    process.env.PUBLIC_URL = ' https://canonical.example ';
    assert.equal(loadConfig().publicUrl, 'https://canonical.example');
    assert.ok(loadConfig().allowedHosts.includes('canonical.example'));
    process.env.PUBLIC_URL = ''; process.env.SERVICE_URL_LEGAL_MCP_3000 = '';
    process.env.COOLIFY_URL = 'http://application.example';
    assert.throws(loadConfig, /HTTPS origin/);
  } finally { for (const [key, value] of Object.entries(previous)) value === undefined ? delete process.env[key] : process.env[key] = value; }
});
