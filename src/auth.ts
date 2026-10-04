import { randomBytes, randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile, link, unlink, lstat, chmod } from 'node:fs/promises';
import { join } from 'node:path';
import type { Config } from './config.js';

export async function initializeAuth(config: Config) {
  if (config.transport === 'stdio') return { source: 'stdio' };
  if (config.publicRead) { config.token = ''; return { source: 'public' }; }
  if (config.token) return { source: 'environment' };
  if (!config.autoToken) throw new Error('HTTP authentication is not configured');
  await mkdir(config.dataDir, { recursive: true });
  const path = join(config.dataDir, 'auth-token');
  const temporary = join(config.dataDir, `.auth-token-${randomUUID()}`);
  let created = false;
  try {
    await writeFile(temporary, randomBytes(32).toString('hex') + '\n', { flag: 'wx', mode: 0o600 });
    // Atomic create-if-absent: concurrent starts never observe a partial token.
    await link(temporary, path);
    created = true;
  } catch (error: any) { if (error.code !== 'EEXIST') throw error; }
  finally { await unlink(temporary).catch((error: any) => { if (error.code !== 'ENOENT') throw error; }); }
  const stat = await lstat(path);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('Stored auth token must be a regular file');
  const token = (await readFile(path, 'utf8')).trim();
  if (!/^[a-f0-9]{64}$/.test(token)) throw new Error('Stored auth token is invalid; restore it or explicitly supply MCP_AUTH_TOKEN');
  if (process.platform !== 'win32') await chmod(path, 0o600);
  config.token = token;
  return { source: created ? 'generated' : 'persisted', tokenFile: path };
}
