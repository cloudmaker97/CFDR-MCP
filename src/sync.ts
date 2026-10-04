import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, readFile, writeFile, rename, rm, access } from 'node:fs/promises';
import { join, basename } from 'node:path';
import { Worker } from 'node:worker_threads';
import { randomUUID } from 'node:crypto';
import type { Logger } from 'pino';
import type { Config } from './config.js';
import { ContentStore } from './store.js';
import { INDEX_VERSION, TEXT_PATTERNS } from './indexer.js';

const exec = promisify(execFile);

export class RepositorySync {
  private running?: Promise<void>;
  private timer?: NodeJS.Timeout;
  private worker?: Worker;
  private stopped = false;
  private abort = new AbortController();
  lastSuccess: string | null = null;
  lastError: string | null = null;
  get updating() { return !!this.running; }

  constructor(private config: Config, private store: ContentStore, private log: Logger) {}

  private async git(args: string[]) {
    return (await exec('git', ['-c', `safe.directory=${this.config.repoDir.replaceAll('\\', '/')}`, ...args], { signal: this.abort.signal, timeout: this.config.gitTimeout, maxBuffer: 32 * 1024 * 1024,
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_CONFIG_NOSYSTEM: '1' } })).stdout.trim();
  }

  async loadExisting() {
    await mkdir(this.config.dataDir, { recursive: true });
    try {
      const name = (await readFile(join(this.config.dataDir, 'CURRENT'), 'utf8')).trim();
      if (basename(name) !== name || !/^index-[\w-]+\.sqlite$/.test(name)) throw new Error('Invalid index manifest');
      this.store.open(join(this.config.dataDir, name));
      this.log.info({ ...this.store.stats }, 'Loaded persistent index');
    } catch (error: any) {
      if (error.code !== 'ENOENT') this.log.warn({ err: error }, 'Cannot load previous index; rebuilding');
    }
  }

  refresh(): Promise<void> {
    if (this.stopped) return Promise.resolve();
    if (this.running) return this.running;
    this.running = this.run().catch(error => {
      this.lastError = error instanceof Error ? error.message : String(error);
      this.log.error({ err: error }, 'Repository update failed; previous index retained');
      if (!this.store.ready) throw error;
    }).finally(() => { this.running = undefined; });
    return this.running;
  }

  private async run() {
    const { config } = this;
    await mkdir(config.repoDir, { recursive: true });
    let hasGit = true;
    try { await access(join(config.repoDir, '.git')); } catch { hasGit = false; }
    if (!hasGit) {
      if (config.offline) throw new Error('SYNC_ENABLED=false requires an existing repository');
      this.log.info('Cloning source repository');
      await this.git(['clone', '--depth', '1', ...(config.sparse ? ['--filter=blob:none', '--no-checkout'] : []),
        ...(config.branch ? ['--branch', config.branch] : []), '--', config.repoUrl, config.repoDir]);
      if (config.sparse) {
        await this.git(['-C', config.repoDir, 'sparse-checkout', 'set', '--no-cone', '--', ...TEXT_PATTERNS]);
        await this.git(['-C', config.repoDir, 'checkout', '--detach', '--force', 'HEAD']);
      }
    } else if (!config.offline) {
      // This directory is a managed mirror, never a contributor working tree.
      const remote = await this.git(['-C', config.repoDir, 'remote', 'get-url', 'origin']);
      if (remote !== config.repoUrl) throw new Error('Existing origin does not match REPO_URL; use a separate REPO_DIR');
      if (config.sparse) await this.git(['-C', config.repoDir, 'sparse-checkout', 'set', '--no-cone', '--', ...TEXT_PATTERNS]);
      else await this.git(['-C', config.repoDir, 'sparse-checkout', 'disable']);
      await this.git(['-C', config.repoDir, 'fetch', '--depth', '1', 'origin', config.branch || 'HEAD']);
      await this.git(['-C', config.repoDir, 'checkout', '--detach', '--force', 'FETCH_HEAD']);
    }
    const commit = await this.git(['-C', config.repoDir, 'rev-parse', 'HEAD']);
    if (this.store.stats?.commit === commit && this.store.stats?.indexVersion === INDEX_VERSION
      && this.store.stats?.maxFileBytes === config.maxFileBytes && this.store.stats?.sourceBaseUrl === config.sourceBaseUrl) {
      this.lastSuccess = new Date().toISOString(); this.lastError = null;
      this.log.debug({ commit }, 'Source unchanged'); return;
    }
    const name = `index-${randomUUID()}.sqlite`;
    const output = join(config.dataDir, name);
    let oldName: string | undefined;
    try { oldName = (await readFile(join(config.dataDir, 'CURRENT'), 'utf8')).trim(); } catch { /* First generation. */ }
    try {
      const stats = await new Promise<unknown>((resolve, reject) => {
        const development = import.meta.url.endsWith('.ts');
        this.worker = new Worker(new URL(development ? './index-worker.ts' : './index-worker.js', import.meta.url), {
          ...(development ? { execArgv: ['--import', 'tsx'] } : {}), workerData: {
          repoDir: config.repoDir, output, commit, maxFileBytes: config.maxFileBytes, sourceBaseUrl: config.sourceBaseUrl,
        } });
        let received = false;
        this.worker.once('message', message => { received = true; message.error ? reject(new Error(message.error)) : resolve(message.stats); });
        this.worker.once('error', reject);
        this.worker.once('exit', code => { if (!received) reject(new Error(`Index worker exited (${code})`)); });
      });
      if (this.stopped) { await rm(output, { force: true }); return; }
      // Validate the new database before committing the persistent pointer.
      const probe = new ContentStore(); probe.open(output); probe.close();
      await writeFile(join(config.dataDir, 'CURRENT.tmp'), name, 'utf8');
      await rename(join(config.dataDir, 'CURRENT.tmp'), join(config.dataDir, 'CURRENT'));
      this.store.open(output);
      this.lastSuccess = new Date().toISOString(); this.lastError = null;
      this.log.info({ stats }, 'Published new content index');
      if (oldName && oldName !== name && /^index-[\w-]+\.sqlite$/.test(oldName)) {
        await rm(join(config.dataDir, oldName), { force: true }).catch(error => this.log.warn({ err: error }, 'Old index cleanup failed'));
      }
    } catch (error) { await rm(output, { force: true }).catch(() => {}); throw error; }
    finally { this.worker = undefined; }
  }

  schedule() {
    if (!this.config.offline) {
      this.timer = setInterval(() => { void this.refresh().catch(() => {}); }, this.config.syncInterval);
      this.timer.unref();
    }
  }

  async stop() {
    this.stopped = true;
    this.abort.abort();
    clearInterval(this.timer);
    await this.worker?.terminate();
    await this.running?.catch(() => {});
  }
}
