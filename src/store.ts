import { DatabaseSync } from 'node:sqlite';

type Row = Record<string, any>;
const stopwords = new Set(['der', 'die', 'das', 'und', 'oder', 'ein', 'eine', 'einer', 'den', 'dem', 'des', 'im', 'in', 'für', 'fur', 'von', 'zu', 'mit', 'auf', 'ist', 'the', 'and', 'for']);

export function searchExpression(query: string): string {
  const tokens = [...new Set((query.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []).filter(t => !stopwords.has(t)))].slice(0, 16);
  return tokens.map(t => `"${t}"${t.length >= 3 ? '*' : ''}`).join(' AND ');
}

export class ContentStore {
  private db?: DatabaseSync;
  private cache = new Map<string, unknown>();
  private statements = new Map<string, ReturnType<DatabaseSync['prepare']>>();
  stats: Row | null = null;
  get ready() { return !!this.db; }

  open(path: string) {
    // Prepare replacement before retiring the current snapshot.
    const next = new DatabaseSync(path, { readOnly: true });
    next.exec('PRAGMA query_only=ON; PRAGMA cache_size=-32768; PRAGMA mmap_size=268435456;');
    let stats: Row;
    try { stats = JSON.parse(String(next.prepare("SELECT value FROM meta WHERE key='stats'").get()!.value)); }
    catch (error) { next.close(); throw error; }
    this.db?.close(); this.db = next; this.stats = stats;
    this.cache.clear(); this.statements.clear();
  }

  close() { this.db?.close(); this.db = undefined; this.statements.clear(); this.cache.clear(); }

  private statement(sql: string) {
    if (!this.db) throw new Error('Content index is not ready; retry shortly.');
    let statement = this.statements.get(sql);
    if (!statement) { statement = this.db.prepare(sql); this.statements.set(sql, statement); }
    return statement;
  }

  search(query: string, limit = 8, collection?: string, kind?: string) {
    if (!this.db) throw new Error('Content index is not ready; retry shortly.');
    const key = JSON.stringify([query, limit, collection, kind]);
    const cached = this.cache.get(key);
    if (cached) { this.cache.delete(key); this.cache.set(key, cached); return cached; }
    const expression = searchExpression(query);
    if (!expression) return { results: [], commit: this.stats?.commit };
    // ORDER BY the FTS rank column uses SQLite's optimized top-k path. Avoid
    // computing snippets/window ranks for every match on common legal terms.
    const filtered = collection !== undefined || kind !== undefined;
    const sql = `SELECT c.id AS chunk_id, c.document_id, c.start, c.end, search_index.rank AS score
      FROM search_index JOIN chunks c ON c.id=search_index.rowid
      ${filtered ? 'JOIN documents d ON d.id=c.document_id' : ''}
      WHERE search_index MATCH ? AND search_index.rank MATCH 'bm25(8.0, 3.0, 1.0)'
      ${filtered ? 'AND (? IS NULL OR d.collection=?) AND (? IS NULL OR d.kind=?)' : ''}
      ORDER BY search_index.rank LIMIT ?`;
    let candidates = 128;
    let selected: Row[] = [];
    for (;;) {
      const parameters = filtered
        ? [expression, collection ?? null, collection ?? null, kind ?? null, kind ?? null, candidates]
        : [expression, candidates];
      const rows = this.statement(sql).all(...parameters) as Row[];
      const seen = new Set<string>();
      selected = rows.filter(row => {
        if (seen.has(row.document_id)) return false;
        seen.add(row.document_id); return true;
      }).slice(0, limit);
      if (selected.length >= limit || rows.length < candidates || candidates >= 4096) break;
      candidates *= 2;
    }
    const results = selected.map(row => {
      const document = this.statement('SELECT id,title,description,collection,kind,url FROM documents WHERE id=?').get(row.document_id);
      const snippet = this.statement(`SELECT snippet(search_index, 2, '', '', ' … ', 36) AS text
        FROM search_index WHERE search_index MATCH ? AND rowid=?`).get(expression, row.chunk_id)!;
      return { ...document, snippet: String(snippet.text).slice(0, 600), start: row.start, end: row.end, score: row.score };
    });
    const result = { results, commit: this.stats?.commit };
    this.cache.set(key, result);
    if (this.cache.size > 128) this.cache.delete(this.cache.keys().next().value!);
    return result;
  }

  getContent(id: string, offset = 0, maxChars = 10000) {
    const row = this.statement('SELECT id,title,description,collection,kind,url,content FROM documents WHERE id=?').get(id) as Row | undefined;
    if (!row) throw new Error('Unknown document ID. Use search or list_documents to discover IDs.');
    const { content, ...meta } = row;
    const text = String(content);
    if (offset > text.length) throw new Error('Offset exceeds document length.');
    const start = offset > 0 && /[\uDC00-\uDFFF]/.test(text[offset]) ? offset - 1 : offset;
    let end = Math.min(text.length, start + maxChars);
    if (end < text.length && /[\uD800-\uDBFF]/.test(text[end - 1])) end--;
    return { ...meta, text: text.slice(start, end), offset: start, totalChars: text.length,
      nextOffset: end < text.length ? end : null, commit: this.stats?.commit };
  }

  collections(offset = 0, limit = 50) {
    return { collections: this.statement(`SELECT collection AS name, COUNT(*) AS documents,
      SUM(kind='skill') AS skills FROM documents GROUP BY collection ORDER BY collection LIMIT ? OFFSET ?`).all(limit + 1, offset)
      .slice(0, limit), offset,
      total: Number(this.statement('SELECT COUNT(DISTINCT collection) AS n FROM documents').get()!.n) };
  }

  listDocuments(collection: string, offset = 0, limit = 30, kind?: string) {
    return { documents: this.statement(`SELECT id,title,description,kind,url FROM documents
      WHERE collection=? AND (? IS NULL OR kind=?) ORDER BY id LIMIT ? OFFSET ?`).all(collection, kind ?? null, kind ?? null, limit, offset),
      total: Number(this.statement('SELECT COUNT(*) AS n FROM documents WHERE collection=? AND (? IS NULL OR kind=?)').get(collection, kind ?? null, kind ?? null)!.n), offset };
  }
}
