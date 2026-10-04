import express from 'express';
import { timingSafeEqual } from 'node:crypto';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { hostHeaderValidation } from '@modelcontextprotocol/sdk/server/middleware/hostHeaderValidation.js';
import type { Logger } from 'pino';
import type { Config } from './config.js';
import type { ContentStore } from './store.js';
import type { RepositorySync } from './sync.js';
import { createMcpServer } from './mcp.js';
import { fileURLToPath } from 'node:url';
import { LEGAL_DISCLAIMER } from './disclaimer.js';
import { installOAuth } from './oauth.js';

export function createHttpApp(config: Config, store: ContentStore, sync: RepositorySync, log: Logger) {
  const app = express();
  if (config.transport === 'http' && !config.token && !config.publicRead) throw new Error('Initialize authentication before creating the HTTP app');
  app.disable('x-powered-by');
  app.use(hostHeaderValidation(config.allowedHosts));
  app.use(['/authorize', '/token', '/register', '/revoke', '/oauth/approve'], (req, res, next) => {
    const start = performance.now();
    res.on('finish', () => log.info({ method: req.method, status: res.statusCode, durationMs: Math.round((performance.now() - start) * 100) / 100, failure: res.locals.oauthFailure }, 'OAuth request'));
    next();
  });
  const oauthAuth = config.oauthEnabled ? installOAuth(app, config) : undefined;
  app.get('/', (_req, res) => res.json({ name: 'Deutsches Recht MCP', disclaimer: LEGAL_DISCLAIMER,
    endpoint: '/mcp', guide: '/guide', readiness: '/readyz',
    oauth: config.oauthEnabled ? { enabled: true, discovery: '/.well-known/oauth-authorization-server', login: 'Verbindung im MCP-Client per OAuth starten; auf dieser Serverdomain mit dem API-Schlüssel freigeben.' } : { enabled: false },
    authentication: config.token ? 'Authorization: Bearer <Token>. /mcp ist ein MCP-Endpunkt, keine Browserseite.' : 'Öffentlicher Lesezugriff wurde ausdrücklich aktiviert.' }));
  app.get('/guide', (_req, res) => res.type('text/plain; charset=utf-8').sendFile(fileURLToPath(new URL('../docs/NUTZUNG.md', import.meta.url))));
  app.get('/disclaimer', (_req, res) => res.type('text/plain; charset=utf-8').send(LEGAL_DISCLAIMER));
  app.get('/healthz', (_req, res) => res.json({ live: true }));
  app.get('/readyz', (_req, res) => res.status(store.ready ? 200 : 503).json({ ready: store.ready }));
  const clients = new Map<string, { count: number; expires: number }>();
  const requests = new Map<number, number>();
  let durationSeconds = 0;
  const cleanup = setInterval(() => {
    const now = Date.now();
    for (const [key, value] of clients) if (value.expires < now) clients.delete(key);
  }, 60000);
  cleanup.unref();
  app.locals.stopRateLimiter = () => clearInterval(cleanup);
  app.use(['/mcp', '/metrics'], (req, res, next) => {
    const start = performance.now();
    res.on('finish', () => {
      const durationMs = performance.now() - start;
      durationSeconds += durationMs / 1000;
      requests.set(res.statusCode, (requests.get(res.statusCode) ?? 0) + 1);
      log.info({ method: req.method, status: res.statusCode, durationMs: Math.round(durationMs * 100) / 100 }, 'HTTP request');
    });
    if (req.headers.origin && !config.allowedOrigins.includes(req.headers.origin)) {
      res.status(403).json({ error: 'Origin not allowed' }); return;
    }
    if (config.token) {
      const actual = Buffer.from(req.headers.authorization ?? '');
      const expected = Buffer.from(`Bearer ${config.token}`);
      if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
        if (oauthAuth) { oauthAuth(req, res, next); return; }
        res.setHeader('WWW-Authenticate', 'Bearer realm="deutsches-recht-mcp"');
        res.status(401).json({ error: 'Unauthorized' }); return;
      }
    }
    next();
  });
  app.use(['/mcp', '/metrics'], (req, res, next) => {
    const key = req.ip ?? 'unknown';
    let bucket = clients.get(key);
    if (!bucket || bucket.expires <= Date.now()) {
      if (clients.size >= 10000) { res.status(429).json({ error: 'Too many clients' }); return; }
      bucket = { count: 0, expires: Date.now() + 60000 }; clients.set(key, bucket);
    }
    if (++bucket.count > config.rateLimit) { res.setHeader('Retry-After', '60'); res.status(429).json({ error: 'Rate limit exceeded' }); return; }
    if (!store.ready && req.originalUrl.split('?')[0] !== '/metrics') { res.setHeader('Retry-After', '10'); res.status(503).json({ error: 'Index is building' }); return; }
    next();
  });
  app.get('/metrics', (_req, res) => {
    const lines = [
      '# TYPE legal_mcp_ready gauge', `legal_mcp_ready ${store.ready ? 1 : 0}`,
      '# TYPE legal_mcp_documents gauge', `legal_mcp_documents ${store.stats?.documents ?? 0}`,
      '# TYPE legal_mcp_chunks gauge', `legal_mcp_chunks ${store.stats?.chunks ?? 0}`,
      '# TYPE legal_mcp_sync_degraded gauge', `legal_mcp_sync_degraded ${sync.lastError ? 1 : 0}`,
      '# TYPE legal_mcp_sync_updating gauge', `legal_mcp_sync_updating ${sync.updating ? 1 : 0}`,
      '# TYPE legal_mcp_http_requests_total counter',
      ...[...requests].map(([status, count]) => `legal_mcp_http_requests_total{status="${status}"} ${count}`),
      '# TYPE legal_mcp_http_duration_seconds_total counter', `legal_mcp_http_duration_seconds_total ${durationSeconds}`,
      '# TYPE process_resident_memory_bytes gauge', `process_resident_memory_bytes ${process.memoryUsage().rss}`,
      '# TYPE process_uptime_seconds gauge', `process_uptime_seconds ${process.uptime()}`,
    ];
    res.type('text/plain; version=0.0.4').send(lines.join('\n') + '\n');
  });
  app.post('/mcp', express.json({ limit: '64kb' }), async (req, res) => {
    const server = createMcpServer(store, sync, log);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    res.once('close', () => { void transport.close(); void server.close(); });
    try {
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (error) {
      log.error({ err: error }, 'MCP transport failed');
      if (!res.headersSent) res.status(500).json({ error: 'Internal server error' });
    }
  });
  app.all('/mcp', (_req, res) => res.setHeader('Allow', 'POST').status(405).json({ error: 'Stateless MCP supports POST only' }));
  app.use((error: any, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    res.status(error.status === 413 ? 413 : 400).json({ error: 'Invalid request body' });
  });
  return app;
}
