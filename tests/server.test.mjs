import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { request, createServer } from 'node:http';
import pino from 'pino';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { buildIndex, chunkText } from '../dist/indexer.js';
import { ContentStore } from '../dist/store.js';
import { RepositorySync } from '../dist/sync.js';
import { createHttpApp } from '../dist/http.js';
import { loadConfig } from '../dist/config.js';

let root, repo, store, config, server, app, base;
const log = pino({ level: 'silent' });
const skillId = 'datenschutzrecht/skills/avv-pruefung/SKILL.md';
const skill = '---\nname: avv-pruefung\ndescription: AVV-Review Art. 28 DSGVO\n---\n# AVV Prüfung\nAuftragsverarbeitung DSGVO Datenschutz.\n';
const longText = '# Reference\n' + 'Referenz 😀 Unicode Vertrag\n'.repeat(1000);
function git(...args) { return execFileSync('git', ['-c', `safe.directory=${repo.replaceAll('\\','/')}`, '-C', repo, ...args], { encoding: 'utf8' }).trim(); }
function commit() { git('add', '.'); git('-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-qm', 'Update fixture'); return git('rev-parse', 'HEAD'); }
async function rpc(method, params, overrides = {}) {
  return fetch(`${base}/mcp`, { method: 'POST', headers: {
    'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', Authorization: 'Bearer test-secret', ...overrides.headers,
  }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }), ...Object.fromEntries(Object.entries(overrides).filter(([k]) => k !== 'headers')) });
}
before(async () => {
  root = await mkdtemp(join(tmpdir(), 'legal-mcp-test-'));
  repo = join(root, 'source'); await mkdir(join(repo, 'datenschutzrecht/skills/avv-pruefung'), { recursive: true });
  await mkdir(join(repo, 'datenschutzrecht/references'), { recursive: true });
  await writeFile(join(repo, skillId), skill);
  await writeFile(join(repo, 'datenschutzrecht/references/long.md'), longText);
  await writeFile(join(repo, 'binary.md'), Buffer.from([0, 1, 2]));
  await writeFile(join(repo, 'oversized.md'), 'x'.repeat(100000));
  git('init', '-b', 'main'); const sha = commit();
  await writeFile(join(repo, 'untracked-secret.md'), 'Must not be served');
  const output = join(root, 'fixture.sqlite');
  await buildIndex({ repoDir: repo, output, commit: sha, maxFileBytes: 50000, sourceBaseUrl: 'https://github.com/example/legal' });
  store = new ContentStore(); store.open(output);
  config = { ...loadConfig(), repoDir: repo, dataDir: join(root, 'sync-data'), token: 'test-secret', rateLimit: 1000, offline: true };
  const sync = new RepositorySync(config, store, log);
  app = createHttpApp(config, store, sync, log);
  server = app.listen(0, '127.0.0.1'); await new Promise(r => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(async () => {
  app?.locals.stopRateLimiter();
  if (server) await new Promise(r => server.close(r));
  store?.close();
  if (root) await rm(root, { recursive: true, force: true });
});

test('FTS ranks skill metadata and filters collection/kind safely', () => {
  const result = store.search('AVV DSGVO', 8, 'datenschutzrecht', 'skill');
  assert.equal(result.results[0].id, skillId);
  assert.match(result.results[0].url, /blob\/[a-f0-9]{40}\//);
  assert.ok(result.results[0].snippet.length <= 600);
  assert.equal(store.search('AVV', 8, 'missing').results.length, 0);
  assert.doesNotThrow(() => store.search('" OR *; DROP TABLE documents; --'));
  assert.equal(store.stats.documents, 2);
  assert.throws(() => store.getContent('untracked-secret.md'), /Unknown document/);
  assert.throws(() => store.getContent('../../.env'), /Unknown document/);
});

test('official MCP client completes OAuth discovery, registration, PKCE and authenticated retrieval', async () => {
  const listener = createServer(); listener.listen(0, '127.0.0.1');
  await new Promise(r => listener.once('listening', r));
  const url = `http://127.0.0.1:${listener.address().port}`;
  const oauthApp = createHttpApp({ ...config, oauthEnabled: true, publicUrl: url, dataDir: join(root, 'oauth-client-data') }, store, { updating: false, lastError: null }, log);
  listener.on('request', oauthApp);
  let clientInfo, tokens, verifier, authorization;
  const provider = {
    redirectUrl: 'http://127.0.0.1:54321/callback',
    clientMetadata: { redirect_uris: ['http://127.0.0.1:54321/callback'], token_endpoint_auth_method: 'none', client_name: 'SDK integration', grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'] },
    clientInformation: () => clientInfo, saveClientInformation: value => { clientInfo = value; },
    tokens: () => tokens, saveTokens: value => { tokens = value; },
    saveCodeVerifier: value => { verifier = value; }, codeVerifier: () => verifier,
    redirectToAuthorization: value => { authorization = value; }, state: () => 'sdk-state',
  };
  const client = new Client({ name: 'oauth-test', version: '1' });
  const transport = new StreamableHTTPClientTransport(new URL(`${url}/mcp`), { authProvider: provider });
  try {
    await assert.rejects(client.connect(transport)); assert.ok(authorization); assert.ok(clientInfo);
    const page = await fetch(authorization); const html = await page.text();
    const approval = await fetch(`${url}/oauth/approve`, { method: 'POST', redirect: 'manual', headers: {
      'Content-Type': 'application/x-www-form-urlencoded', Cookie: page.headers.get('set-cookie').split(';')[0], Origin: url,
    }, body: new URLSearchParams({ request: /name="request" value="([^"]+)"/.exec(html)[1], csrf: /name="csrf" value="([^"]+)"/.exec(html)[1], api_key: config.token, action: 'allow' }) });
    assert.equal(approval.status, 303);
    const callback = new URL(approval.headers.get('location')); assert.equal(callback.searchParams.get('state'), 'sdk-state');
    await transport.finishAuth(callback.searchParams.get('code'));
    await client.close();
    await client.connect(new StreamableHTTPClientTransport(new URL(`${url}/mcp`), { authProvider: provider }));
    assert.equal((await client.listTools()).tools.length, 6);
    const result = await client.callTool({ name: 'search', arguments: { query: 'AVV DSGVO' } });
    assert.equal(result.structuredContent.results[0].id, skillId);
    assert.ok(tokens.access_token); assert.ok(tokens.refresh_token);
  } finally { await client.close(); oauthApp.locals.stopRateLimiter(); await new Promise(r => listener.close(r)); oauthApp.locals.stopOAuth(); }
});
test('paging reconstructs Unicode content without loss or oversized pages', () => {
  let offset = 0, result = '';
  do {
    const page = store.getContent('datenschutzrecht/references/long.md', offset, 101);
    assert.ok(page.text.length <= 101);
    result += page.text; offset = page.nextOffset;
  } while (offset !== null);
  assert.equal(result, longText);
  assert.equal(chunkText(longText, 101).map(c => c.text).join(''), longText);
  assert.throws(() => store.getContent(skillId, 999999), /Offset exceeds/);
});
test('collection and document browsing is paginated', () => {
  assert.equal(store.collections().collections[0].name, 'datenschutzrecht');
  const result = store.listDocuments('datenschutzrecht', 0, 1);
  assert.equal(result.documents.length, 1); assert.equal(result.total, 2);
  assert.equal(store.listDocuments('datenschutzrecht', 0, 30, 'skill').documents[0].id, skillId);
});
test('HTTP rejects unauthenticated requests, forbidden origins and hosts, malformed and oversized bodies', async () => {
  assert.equal((await rpc('tools/list', {}, { headers: { Authorization: '' } })).status, 401);
  assert.equal((await rpc('tools/list', {}, { headers: { Origin: 'https://evil.invalid' } })).status, 403);
  const forbiddenHostStatus = await new Promise((resolve, reject) => {
    const req = request(`${base}/healthz`, { headers: { Host: 'evil.invalid' } }, res => { res.resume(); resolve(res.statusCode); });
    req.on('error', reject); req.end();
  });
  assert.equal(forbiddenHostStatus, 403);
  assert.equal((await rpc('tools/list', {}, { body: '{' })).status, 400);
  assert.equal((await rpc('tools/list', {}, { body: JSON.stringify({ padding: 'x'.repeat(70000) }) })).status, 413);
  assert.equal((await fetch(`${base}/healthz`)).status, 200);
  assert.equal((await fetch(`${base}/readyz`)).status, 200);
  assert.equal((await fetch(`${base}/mcp`, { headers: { Authorization: 'Bearer test-secret' } })).status, 405);
  assert.equal((await fetch(`${base}/metrics`)).status, 401);
  const metrics = await fetch(`${base}/metrics`, { headers: { Authorization: 'Bearer test-secret' } });
  assert.match(await metrics.text(), /legal_mcp_documents 2/);
});
test('readiness, authenticated metrics during startup, and rate limiting work', async () => {
  const emptyStore = new ContentStore();
  const localApp = createHttpApp({ ...config, rateLimit: 2 }, emptyStore, { lastError: null, updating: true }, log);
  const listener = localApp.listen(0, '127.0.0.1'); await new Promise(r => listener.once('listening', r));
  const url = `http://127.0.0.1:${listener.address().port}`;
  try {
    assert.equal((await fetch(`${url}/readyz`)).status, 503);
    const headers = { Authorization: 'Bearer test-secret' };
    assert.equal((await fetch(`${url}/metrics`, { headers })).status, 200);
    assert.equal((await fetch(`${url}/mcp`, { headers })).status, 503);
    assert.equal((await fetch(`${url}/mcp`, { headers })).status, 429);
  } finally { localApp.locals.stopRateLimiter(); await new Promise(r => listener.close(r)); emptyStore.close(); }
});
test('official MCP HTTP client initializes, discovers tools, searches, fetches, and reads resources', async () => {
  const client = new Client({ name: 'test', version: '1' });
  await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`), { requestInit: { headers: { Authorization: 'Bearer test-secret' } } }));
  try {
    assert.equal((await client.listTools()).tools.length, 6);
    const search = await client.callTool({ name: 'search', arguments: { query: 'AVV DSGVO' } });
    assert.equal(search.structuredContent.results[0].id, skillId);
    const fetched = await client.callTool({ name: 'fetch', arguments: { id: skillId } });
    assert.equal(fetched.structuredContent.text, skill);
    const invalid = await client.callTool({ name: 'get_content', arguments: { id: skillId, maxChars: 20001 } });
    assert.equal(invalid.isError, true);
    const missing = await client.callTool({ name: 'fetch', arguments: { id: '../secret' } });
    assert.equal(missing.isError, true);
    const resource = await client.readResource({ uri: `legal://document/${encodeURIComponent(skillId)}?offset=0` });
    assert.equal(JSON.parse(resource.contents[0].text).text, skill);
    const disclaimer = await client.readResource({ uri: 'legal://disclaimer' });
    assert.match(disclaimer.contents[0].text, /ersetzt keine Rechtsanwältin/);
    assert.match((await client.callTool({ name: 'server_status', arguments: {} })).structuredContent.disclaimer, /Keine Rechtsberatung/);
  } finally { await client.close(); }
});
test('sync updates content, invalidates cache, handles deletions, and retains last snapshot on failure', async () => {
  const mirror = join(root, 'mirror');
  const targetStore = new ContentStore();
  const syncConfig = { ...config, repoDir: mirror, repoUrl: repo, offline: false, dataDir: join(root, 'mirror-data') };
  const sync = new RepositorySync(syncConfig, targetStore, log);
  try {
    await sync.loadExisting(); await sync.refresh();
    assert.equal(targetStore.search('AVV').results[0].id, skillId);
    const previous = targetStore.stats.commit;
    await writeFile(join(repo, 'datenschutzrecht/skills/avv-pruefung/SKILL.md'), '# New Workflow\nNeue Arbeitsrecht Kündigung Recherche');
    await unlink(join(repo, 'datenschutzrecht/references/long.md')); commit();
    await sync.refresh();
    assert.notEqual(targetStore.stats.commit, previous);
    assert.equal(targetStore.search('AVV DSGVO').results.length, 0);
    assert.equal(targetStore.search('Arbeitsrecht Kündigung').results.length, 1);
    assert.throws(() => targetStore.getContent('datenschutzrecht/references/long.md'), /Unknown document/);
    const current = targetStore.stats.commit;
    syncConfig.repoUrl = 'https://invalid.example/repo.git';
    await sync.refresh();
    assert.ok(sync.lastError); assert.equal(targetStore.stats.commit, current);
    const reopened = new ContentStore();
    const name = (await readFile(join(syncConfig.dataDir, 'CURRENT'), 'utf8')).trim();
    reopened.open(join(syncConfig.dataDir, name)); assert.equal(reopened.stats.commit, current); reopened.close();
  } finally { await sync.stop(); targetStore.close(); }
});
test('official MCP stdio client works without logging to protocol stdout', async () => {
  const client = new Client({ name: 'stdio-test', version: '1' });
  const transport = new StdioClientTransport({ command: process.execPath, args: [resolve('dist/main.js')],
    env: { ...Object.fromEntries(Object.entries(process.env).filter(([,v]) => typeof v === 'string')),
      TRANSPORT: 'stdio', SYNC_ENABLED: 'false', REPO_DIR: repo, DATA_DIR: join(root, 'stdio-data'), LOG_LEVEL: 'silent' }, stderr: 'pipe' });
  try {
    await client.connect(transport);
    assert.equal((await client.listTools()).tools.length, 6);
    assert.equal((await client.callTool({ name: 'server_status', arguments: {} })).structuredContent.ready, true);
  } finally { await client.close(); }
});
