import { resolve } from 'node:path';

function integer(name: string, fallback: number, min: number, max: number): number {
  const value = Number(process.env[name] ?? fallback);
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    throw new Error(`${name} must be an integer between ${min} and ${max}`);
  }
  return value;
}

export function loadConfig() {
  const transport = process.env.TRANSPORT ?? 'http';
  if (!['http', 'stdio'].includes(transport)) throw new Error('TRANSPORT must be http or stdio');
  const repoUrl = process.env.REPO_URL ?? 'https://github.com/cloudmaker97/claude-fuer-deutsches-recht.git';
  if (!/^(https:\/\/|git@|ssh:\/\/)/.test(repoUrl)) throw new Error('REPO_URL must use HTTPS or SSH');
  const branch = process.env.REPO_BRANCH ?? '';
  if (branch && !/^[\w][\w./-]*$/.test(branch)) throw new Error('Invalid REPO_BRANCH');
  const host = process.env.HOST ?? '127.0.0.1';
  const publicRead = process.env.ALLOW_PUBLIC_READ === 'true';
  const token = publicRead ? '' : (process.env.MCP_AUTH_TOKEN ?? '').trim();
  const autoToken = process.env.AUTO_AUTH_TOKEN !== 'false';
  if (transport === 'http' && !token && !publicRead && !autoToken) {
    throw new Error('HTTP requires MCP_AUTH_TOKEN, AUTO_AUTH_TOKEN=true, or explicit ALLOW_PUBLIC_READ=true');
  }
  const publicUrl = process.env.PUBLIC_URL ?? '';
  let publicHost: string | undefined;
  if (publicUrl) {
    const url = new URL(publicUrl);
    if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) throw new Error('PUBLIC_URL must be an HTTP(S) URL without credentials');
    publicHost = url.hostname;
  }
  return {
    transport, host, token, publicRead, autoToken, publicUrl, repoUrl, branch,
    port: integer('PORT', 3000, 1, 65535),
    dataDir: resolve(process.env.DATA_DIR ?? 'data'),
    repoDir: resolve(process.env.REPO_DIR ?? 'content/repository'),
    sourceBaseUrl: process.env.SOURCE_BASE_URL ?? 'https://github.com/cloudmaker97/claude-fuer-deutsches-recht',
    syncInterval: integer('SYNC_INTERVAL_SECONDS', 900, 30, 604800) * 1000,
    gitTimeout: integer('GIT_TIMEOUT_SECONDS', 300, 1, 3600) * 1000,
    maxFileBytes: integer('MAX_FILE_BYTES', 2_000_000, 1000, 10_000_000),
    rateLimit: integer('RATE_LIMIT_PER_MINUTE', 120, 1, 100000),
    allowedHosts: [...new Set([...(process.env.ALLOWED_HOSTS ?? 'localhost,127.0.0.1,[::1]').split(',').map(s => s.trim()).filter(Boolean), ...(publicHost ? [publicHost] : [])])],
    allowedOrigins: (process.env.ALLOWED_ORIGINS ?? '').split(',').map(s => s.trim()).filter(Boolean),
    offline: process.env.SYNC_ENABLED === 'false',
    sparse: process.env.SPARSE_CHECKOUT !== 'false',
  };
}
export type Config = ReturnType<typeof loadConfig>;
