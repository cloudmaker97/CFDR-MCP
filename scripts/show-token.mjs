import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

// Explicit operator command: never invoked at server startup or logged automatically.
const token = process.env.MCP_AUTH_TOKEN?.trim() || (await readFile(join(resolve(process.env.DATA_DIR ?? 'data'), 'auth-token'), 'utf8')).trim();
if (!token) throw new Error('No token found. Start the server first, or check Coolify environment variables.');
process.stdout.write(token + '\n');
