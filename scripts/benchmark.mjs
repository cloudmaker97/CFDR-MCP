import { readFile, stat } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { ContentStore } from '../dist/store.js';

const dir = resolve(process.env.DATA_DIR ?? 'data');
const path = join(dir, (await readFile(join(dir, 'CURRENT'), 'utf8')).trim());
const store = new ContentStore(); store.open(path);
const queries = ['AVV DSGVO', 'Kündigung Arbeitsrecht', 'Datenpanne', 'Urheberrecht', 'Art 28 DSGVO', 'Vertrag', 'Datenschutz'];
const percentile = (values, p) => values.toSorted((a,b) => a-b)[Math.min(values.length - 1, Math.floor(values.length * p))];
const uncached = [], cached = [];
for (let i = 0; i < 30; i++) {
  // Trailing spaces produce a fresh cache key while preserving query semantics.
  for (const query of queries) {
    const q = query + ' '.repeat(i);
    const start = performance.now(); store.search(q);
    uncached.push(performance.now() - start);
    const again = performance.now(); store.search(q);
    cached.push(performance.now() - again);
  }
}
console.log(JSON.stringify({ node: process.version, platform: process.platform, arch: process.arch,
  corpus: store.stats, indexBytes: (await stat(path)).size, rssBytes: process.memoryUsage().rss,
  queries, samples: uncached.length,
  uncachedMs: { p50: percentile(uncached,.5), p95: percentile(uncached,.95), max: Math.max(...uncached) },
  cachedMs: { p50: percentile(cached,.5), p95: percentile(cached,.95), max: Math.max(...cached) },
  scope: 'In-process store latency; excludes HTTP, network, model, and concurrent indexing.' }, null, 2));
store.close();
