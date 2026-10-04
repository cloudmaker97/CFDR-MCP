import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, mkdir, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import pino from 'pino';
import { initializeAuth } from '../dist/auth.js';
import { loadConfig } from '../dist/config.js';
import { createHttpApp } from '../dist/http.js';
import { ContentStore } from '../dist/store.js';

const log = pino({ level: 'silent' });
function config(dir, overrides = {}) {
  return { ...loadConfig(), transport: 'http', dataDir: dir, autoToken: true, publicRead: false, token: '', ...overrides };
}
async function temporary(fn) {
  const root = await mkdtemp(join(tmpdir(), 'legal-auth-test-'));
  try { await fn(root); } finally { await rm(root, { recursive: true, force: true }); }
}

test('generated token persists across restarts and authenticates HTTP without appearing in browser hints', async () => {
  await temporary(async root => {
    const first = config(root);
    assert.equal((await initializeAuth(first)).source, 'generated');
    assert.match(first.token, /^[a-f0-9]{64}$/);
    const second = config(root);
    assert.equal((await initializeAuth(second)).source, 'persisted');
    assert.equal(second.token, first.token);
    if (process.platform !== 'win32') assert.equal((await stat(join(root, 'auth-token'))).mode & 0o777, 0o600);
    const store = new ContentStore();
    const app = createHttpApp(second, store, { updating: false, lastError: null }, log);
    const listener = app.listen(0, '127.0.0.1'); await new Promise(r => listener.once('listening', r));
    const url = `http://127.0.0.1:${listener.address().port}`;
    try {
      const unauthorized = await fetch(`${url}/metrics`);
      assert.equal(unauthorized.status, 401);
      assert.match(unauthorized.headers.get('www-authenticate'), /^Bearer/);
      assert.equal((await fetch(`${url}/metrics`, { headers: { Authorization: `Bearer ${second.token}` } })).status, 200);
      const hints = await (await fetch(url)).text();
      assert.ok(!hints.includes(second.token)); assert.match(hints, /Keine Rechtsberatung/);
      const guide = await (await fetch(`${url}/guide`)).text();
      assert.match(guide, /keine Rechtsberatung/);
      assert.match(await (await fetch(`${url}/disclaimer`)).text(), /keine Rechtsanwältin/);
    } finally { app.locals.stopRateLimiter(); await new Promise(r => listener.close(r)); store.close(); }
  });
});

test('concurrent token initialization publishes one complete credential', async () => {
  await temporary(async root => {
    const configs = Array.from({ length: 8 }, () => config(root));
    await Promise.all(configs.map(initializeAuth));
    assert.equal(new Set(configs.map(c => c.token)).size, 1);
    assert.match(configs[0].token, /^[a-f0-9]{64}$/);
  });
});

test('explicit credential takes precedence without overwriting persisted automatic token', async () => {
  await temporary(async root => {
    const original = config(root); await initializeAuth(original);
    const override = config(root, { token: 'operator-provided-token' });
    assert.equal((await initializeAuth(override)).source, 'environment');
    assert.equal(override.token, 'operator-provided-token');
    assert.equal((await readFile(join(root, 'auth-token'), 'utf8')).trim(), original.token);
  });
});

test('public mode is explicit, bypasses a retained Coolify credential, and does not delete it', async () => {
  await temporary(async root => {
    const original = config(root); await initializeAuth(original);
    const publicConfig = config(root, { publicRead: true, token: 'coolify-retained-token' });
    assert.equal((await initializeAuth(publicConfig)).source, 'public');
    assert.equal(publicConfig.token, '');
    assert.equal((await readFile(join(root, 'auth-token'), 'utf8')).trim(), original.token);
    const protectedAgain = config(root); await initializeAuth(protectedAgain);
    assert.equal(protectedAgain.token, original.token);
  });
});

test('corrupt persisted token and uninitialized HTTP authentication fail closed', async () => {
  await temporary(async root => {
    await writeFile(join(root, 'auth-token'), 'invalid');
    await assert.rejects(initializeAuth(config(root)), /Stored auth token is invalid/);
    const store = new ContentStore();
    assert.throws(() => createHttpApp(config(root), store, {}, log), /Initialize authentication/);
    await assert.rejects(initializeAuth(config(root, { autoToken: false })), /not configured/);
    const dir = join(root, 'directory-token'); await mkdir(join(dir, 'auth-token'), { recursive: true });
    await assert.rejects(initializeAuth(config(dir)), /regular file/);
    store.close();
  });
});

test('stdio does not require or create an HTTP credential', async () => {
  await temporary(async root => {
    assert.equal((await initializeAuth(config(root, { transport: 'stdio' }))).source, 'stdio');
    await assert.rejects(readFile(join(root, 'auth-token')), { code: 'ENOENT' });
  });
});

test('public URL adds its actual hostname while missing credentials never silently expose HTTP', () => {
  const names = ['PUBLIC_URL', 'MCP_AUTH_TOKEN', 'ALLOW_PUBLIC_READ', 'AUTO_AUTH_TOKEN', 'TRANSPORT'];
  const previous = Object.fromEntries(names.map(name => [name, process.env[name]]));
  try {
    process.env.PUBLIC_URL = 'https://recht.example.com';
    process.env.MCP_AUTH_TOKEN = '';
    process.env.ALLOW_PUBLIC_READ = 'false';
    process.env.AUTO_AUTH_TOKEN = 'true';
    process.env.TRANSPORT = 'http';
    assert.ok(loadConfig().allowedHosts.includes('recht.example.com'));
    process.env.AUTO_AUTH_TOKEN = 'false';
    assert.throws(loadConfig, /HTTP requires/);
    process.env.MCP_AUTH_TOKEN = 'coolify-token';
    process.env.ALLOW_PUBLIC_READ = 'true';
    assert.equal(loadConfig().token, '');
    process.env.PUBLIC_URL = 'https://user:password@recht.example.com';
    assert.throws(loadConfig, /without credentials/);
  } finally {
    for (const name of names) previous[name] === undefined ? delete process.env[name] : process.env[name] = previous[name];
  }
});
