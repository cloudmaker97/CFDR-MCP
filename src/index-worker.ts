import { parentPort, workerData } from 'node:worker_threads';
import { buildIndex } from './indexer.js';

try {
  parentPort!.postMessage({ stats: await buildIndex(workerData) });
} catch (error) {
  parentPort!.postMessage({ error: error instanceof Error ? error.message : String(error) });
}
