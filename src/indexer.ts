import { DatabaseSync } from 'node:sqlite';
import { lstat, readFile } from 'node:fs/promises';
import { resolve, sep, extname, basename } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { parse } from 'yaml';

const exec = promisify(execFile);
const extensions = new Set(['.md', '.txt', '.rst', '.json', '.yaml', '.yml', '.toml', '.csv']);
export const INDEX_VERSION = 1;
export const TEXT_PATTERNS = [...extensions].flatMap(extension => [`*${extension}`, `*${extension.toUpperCase()}`]).concat(['LICENSE*', 'NOTICE']);

export function chunkText(text: string, size = 4000): Array<{ start: number; end: number; text: string }> {
  if (!Number.isSafeInteger(size) || size < 2) throw new Error('Chunk size must be at least 2');
  const chunks = [];
  for (let start = 0; start < text.length;) {
    let end = Math.min(start + size, text.length);
    if (end < text.length) {
      const newline = text.lastIndexOf('\n', end);
      if (newline > start + size / 2) end = newline + 1;
      if (end < text.length && /[\uD800-\uDBFF]/.test(text[end - 1])) end--;
    }
    chunks.push({ start, end, text: text.slice(start, end) });
    start = end;
  }
  return chunks;
}

export function metadata(path: string, text: string) {
  let front: Record<string, unknown> = {};
  const match = text.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
  if (match) {
    try {
      const parsed = parse(match[1], { maxAliasCount: 0 });
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) front = parsed;
    } catch { /* Malformed front matter remains searchable as plain text. */ }
  }
  const heading = text.match(/^#\s+(.+)$/m)?.[1];
  const title = String(front.name ?? heading ?? basename(path)).slice(0, 240);
  const description = String(front.description ?? heading ?? '').slice(0, 1000);
  const collection = path.includes('/') ? path.split('/')[0] : '_repository';
  const kind = basename(path) === 'SKILL.md' ? 'skill'
    : path.includes('/agents/') ? 'agent'
    : path.includes('/commands/') ? 'command'
    : path.includes('/references/') ? 'reference'
    : path.includes('/templates/') ? 'template' : 'document';
  return { title, description, collection, kind };
}

export async function buildIndex(options: {
  repoDir: string; output: string; commit: string; maxFileBytes: number; sourceBaseUrl: string;
}) {
  const started = performance.now();
  const { stdout } = await exec('git', ['-c', `safe.directory=${options.repoDir.replaceAll('\\', '/')}`, '-C', options.repoDir, 'ls-files', '-z'], { maxBuffer: 32 * 1024 * 1024 });
  const db = new DatabaseSync(options.output);
  let documents = 0, chunks = 0, skipped = 0, bytes = 0;
  try {
    db.exec(`PRAGMA journal_mode=OFF; PRAGMA synchronous=OFF; PRAGMA temp_store=MEMORY;
      CREATE TABLE meta(key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE documents(id TEXT PRIMARY KEY, title TEXT NOT NULL, description TEXT NOT NULL,
        collection TEXT NOT NULL, kind TEXT NOT NULL, content TEXT NOT NULL, url TEXT NOT NULL);
      CREATE INDEX documents_collection ON documents(collection, kind, id);
      CREATE TABLE chunks(id INTEGER PRIMARY KEY, document_id TEXT NOT NULL, title TEXT NOT NULL,
        keywords TEXT NOT NULL, text TEXT NOT NULL, start INTEGER NOT NULL, end INTEGER NOT NULL);
      CREATE INDEX chunks_document ON chunks(document_id);
      CREATE VIRTUAL TABLE search_index USING fts5(title, keywords, text, content='chunks', content_rowid='id',
        tokenize='unicode61 remove_diacritics 2', prefix='3 4');
      BEGIN;`);
    const docInsert = db.prepare('INSERT INTO documents VALUES (?, ?, ?, ?, ?, ?, ?)');
    const chunkInsert = db.prepare('INSERT INTO chunks(document_id, title, keywords, text, start, end) VALUES (?, ?, ?, ?, ?, ?)');
    const root = resolve(options.repoDir);
    const verifiedDirectories = new Set<string>();
    for (const path of stdout.split('\0').filter(Boolean).sort()) {
      if (!extensions.has(extname(path).toLowerCase()) && !/^LICENSE(?:-|$)|^NOTICE$/.test(basename(path))) {
        skipped++; continue;
      }
      // Only tracked regular files; reject symlinks in any path component.
      const absolute = resolve(root, path);
      if (!absolute.startsWith(root + sep)) { skipped++; continue; }
      let safe = true;
      let current = root;
      for (const part of path.split('/')) {
        current = resolve(current, part);
        if (verifiedDirectories.has(current)) continue;
        const component = await lstat(current).catch((error: any) => {
          if (error.code === 'ENOENT') return null;
          throw error;
        });
        if (!component) { safe = false; break; }
        if (component.isSymbolicLink()) { safe = false; break; }
        if (component.isDirectory()) verifiedDirectories.add(current);
      }
      if (!safe) { skipped++; continue; }
      const stat = await lstat(absolute);
      if (!stat.isFile() || stat.size > options.maxFileBytes) { skipped++; continue; }
      const buffer = await readFile(absolute);
      if (buffer.includes(0)) { skipped++; continue; }
      let text: string;
      try { text = new TextDecoder('utf-8', { fatal: true }).decode(buffer); }
      catch { skipped++; continue; }
      const meta = metadata(path, text);
      const url = `${options.sourceBaseUrl.replace(/\/$/, '')}/blob/${options.commit}/${path.split('/').map(encodeURIComponent).join('/')}`;
      docInsert.run(path, meta.title, meta.description, meta.collection, meta.kind, text, url);
      for (const chunk of chunkText(text)) {
        chunkInsert.run(path, meta.title, `${meta.collection} ${path} ${meta.description}`, chunk.text, chunk.start, chunk.end);
        chunks++;
      }
      documents++; bytes += buffer.length;
    }
    db.exec("INSERT INTO search_index(search_index) VALUES('rebuild'); INSERT INTO search_index(search_index) VALUES('optimize');");
    const stats = { commit: options.commit, indexVersion: INDEX_VERSION, maxFileBytes: options.maxFileBytes,
      sourceBaseUrl: options.sourceBaseUrl, documents, chunks, skipped, bytes,
      builtAt: new Date().toISOString(), buildMs: Math.round(performance.now() - started) };
    db.prepare('INSERT INTO meta VALUES (?, ?)').run('stats', JSON.stringify(stats));
    db.exec('COMMIT; PRAGMA optimize;');
    return stats;
  } finally { db.close(); }
}
