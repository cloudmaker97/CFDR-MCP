import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const env = await readFile('.env', 'utf8').catch(() => '');
const token = process.env.MCP_AUTH_TOKEN?.trim() || env.match(/^MCP_AUTH_TOKEN=(.*)$/m)?.[1].trim()
  || (await readFile(join(resolve(process.env.DATA_DIR ?? 'data'), 'auth-token'), 'utf8').catch(() => '')).trim();
const url = process.env.MCP_URL ?? 'http://127.0.0.1:3000/mcp';
const client = new Client({ name: 'deployment-smoke', version: '1.0.0' });
try {
  await client.connect(new StreamableHTTPClientTransport(new URL(url), {
    requestInit: { headers: token ? { Authorization: `Bearer ${token}` } : {} },
  }));
  const tools = await client.listTools();
  const status = await client.callTool({ name: 'server_status', arguments: {} });
  const search = await client.callTool({ name: 'search', arguments: { query: 'AVV DSGVO', collection: 'datenschutzrecht', kind: 'skill' } });
  const result = search.structuredContent?.results?.[0];
  if (!result || !status.structuredContent?.ready) throw new Error('Server not ready or real-corpus search failed');
  const fetched = await client.callTool({ name: 'fetch', arguments: { id: result.id } });
  if (!fetched.structuredContent?.text) throw new Error('Fetch returned no content');
  console.log(JSON.stringify({ endpoint: url, tools: tools.tools.map(t => t.name), status: status.structuredContent,
    sample: { id: result.id, title: result.title, fetchedChars: fetched.structuredContent.text.length } }, null, 2));
} finally { await client.close(); }
