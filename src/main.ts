import pino from 'pino';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import type { Server } from 'node:http';
import { loadConfig } from './config.js';
import { ContentStore } from './store.js';
import { RepositorySync } from './sync.js';
import { createMcpServer } from './mcp.js';
import { createHttpApp } from './http.js';
import { initializeAuth } from './auth.js';

const log = pino({ level: process.env.LOG_LEVEL ?? 'info', base: { service: 'deutsches-recht-mcp' } }, pino.destination(2));
const config = loadConfig();
const store = new ContentStore();
const sync = new RepositorySync(config, store, log);
let http: Server | undefined;
let mcp: ReturnType<typeof createMcpServer> | undefined;
let stopLimiter: (() => void) | undefined;
let stopOAuth: (() => void) | undefined;
let exiting = false;
async function shutdown() {
  if (exiting) return;
  exiting = true;
  log.info('Shutting down');
  const timeout = setTimeout(() => process.exit(1), 15000); timeout.unref();
  if (http) await new Promise<void>(resolve => { http!.close(() => resolve()); http!.closeIdleConnections(); });
  stopLimiter?.();
  stopOAuth?.();
  await mcp?.close();
  await sync.stop(); store.close();
  clearTimeout(timeout);
}
process.once('SIGINT', () => { void shutdown(); });
process.once('SIGTERM', () => { void shutdown(); });
try {
  log.info(await initializeAuth(config), 'Authentication configured; token value is never logged');
  await sync.loadExisting();
  if (config.transport === 'stdio') {
    await sync.refresh();
    mcp = createMcpServer(store, sync, log);
    await mcp.connect(new StdioServerTransport());
    process.stdin.once('end', () => { void shutdown(); });
  } else {
    const app = createHttpApp(config, store, sync, log);
    stopLimiter = app.locals.stopRateLimiter;
    stopOAuth = app.locals.stopOAuth;
    http = app.listen(config.port, config.host, () => log.info({ host: config.host, port: config.port }, 'MCP listening at /mcp'));
    http.on('error', error => { log.fatal({ err: error }, 'HTTP listener failed'); void shutdown().then(() => { process.exitCode = 1; }); });
    void sync.refresh().catch(error => { log.fatal({ err: error }, 'Initial index failed; periodic retry remains enabled'); });
  }
  sync.schedule();
} catch (error) {
  log.fatal({ err: error }, 'Startup failed'); await shutdown(); process.exitCode = 1;
}
