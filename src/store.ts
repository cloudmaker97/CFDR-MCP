import { DatabaseSync } from 'node:sqlite';

type Row = Record<string, any>;
const stopwords = new Set(['der', 'die', 'das', 'und', 'oder', 'ein', 'eine', 'einer', 'den', 'dem', 'des', 'im', 'in', 'für', 'fur', 'von', 'zu', 'mit', 'auf', 'ist', 'the', 'and', 'for']);

function queryTerms(query: string) {
  return [...new Set((query.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []).filter(t => !stopwords.has(t)))].slice(0, 16);
}
function termExpression(term: string) { return `"${term}"${term.length >= 3 ? '*' : ''}`; }
function excerpt(content: string, terms: string[]) {
  const normalize = (value: string) => value.toLowerCase().normalize('NFD').replace(/\p{M}/gu, '');
  const normalized = terms.map(normalize);
  const bodyStart = content.match(/^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/)?.[0].length ?? 0;
  const positions: Array<{ position: number; term: number }> = [];
  for (const word of content.matchAll(/[\p{L}\p{N}]+/gu)) {
    if (word.index < bodyStart) continue;
    const token = normalize(word[0]);
    normalized.forEach((term, index) => {
      if (term.length >= 3 ? token.startsWith(term) : token === term) positions.push({ position: word.index, term: index });
    });
  }
  let start = bodyStart, best = 0, right = 0;
  const counts = new Map<number, number>();
  for (let left = 0; left < positions.length; left++) {
    const candidate = Math.max(bodyStart, positions[left].position - 100);
    while (right < positions.length && positions[right].position < candidate + 600) {
      const term = positions[right++].term; counts.set(term, (counts.get(term) ?? 0) + 1);
    }
    if (counts.size > best) { best = counts.size; start = candidate; }
    const term = positions[left].term, count = counts.get(term)! - 1;
    if (count) counts.set(term, count); else counts.delete(term);
  }
  if (start > 0 && /[\uDC00-\uDFFF]/.test(content[start])) start--;
  let end = Math.min(content.length, start + 600);
  if (end < content.length && /[\uD800-\uDBFF]/.test(content[end - 1])) end--;
  return { snippet: content.slice(start, end), start, end };
}
export function searchExpression(query: string): string {
  return queryTerms(query).map(termExpression).join(' AND ');
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
    const terms = queryTerms(query);
    let expression = searchExpression(query);
    if (!expression) return { results: [], commit: this.stats?.commit };
    // ORDER BY the FTS rank column uses SQLite's optimized top-k path. Avoid
    // computing snippets/window ranks for every match on common legal terms.
    const sql = `SELECT c.id AS chunk_id, c.document_id, c.start, c.end, search_index.rank AS score
      FROM search_index JOIN chunks c ON c.id=search_index.rowid
      JOIN documents d ON d.id=c.document_id
      WHERE search_index MATCH ? AND search_index.rank MATCH 'bm25(8.0, 3.0, 1.0)'
      AND (? IS NULL OR d.collection=?) AND (? IS NULL OR d.kind=?)
      ${kind === undefined ? "AND d.kind NOT IN ('fixture', 'meta')" : ''}
      ORDER BY search_index.rank LIMIT ?`;
    let candidates = 128;
    let selected: Row[] = [];
    let fallback = false;
    const minimumMatch = Math.max(1, Math.ceil(terms.length / 2));
    for (;;) {
      const parameters = [expression, collection ?? null, collection ?? null, kind ?? null, kind ?? null, candidates];
      const rows = this.statement(sql).all(...parameters) as Row[];
      if (!rows.length && !fallback && terms.length > 1) {
        fallback = true; expression = terms.map(termExpression).join(' OR '); continue;
      }
      if (fallback) {
        // Ask FTS itself which terms match each candidate, using the same tokenizer.
        const matches = new Map<number, string[]>();
        const ids = rows.map(row => Number(row.chunk_id));
        if (ids.length) for (const term of terms) {
          const hits = this.statement(`SELECT rowid FROM search_index WHERE search_index MATCH ? AND rowid IN (${ids.map(() => '?').join(',')})`)
            .all(termExpression(term), ...ids) as Row[];
          for (const hit of hits) {
            const id = Number(hit.rowid); const list = matches.get(id) ?? [];
            list.push(term); matches.set(id, list);
          }
        }
        for (const row of rows) row.matchedTerms = matches.get(Number(row.chunk_id)) ?? [];
        rows.sort((a, b) => b.matchedTerms.length - a.matchedTerms.length || a.score - b.score);
      }
      const seen = new Set<string>();
      selected = rows.filter(row => {
        if (fallback && row.matchedTerms.length < minimumMatch) return false;
        if (seen.has(row.document_id)) return false;
        seen.add(row.document_id); return true;
      }).slice(0, limit);
      if (selected.length >= limit || rows.length < candidates || candidates >= 4096) break;
      candidates *= 2;
    }
    const results = selected.map(row => {
      const document = this.statement('SELECT id,title,description,collection,kind,url,content FROM documents WHERE id=?').get(row.document_id) as Row;
      const { content, ...meta } = document;
      const matchedTerms: string[] = row.matchedTerms ?? terms;
      return { ...meta, ...excerpt(String(content), matchedTerms), score: row.score,
        matchedTerms, droppedTerms: terms.filter(term => !matchedTerms.includes(term)) };
    });
    const result = { results, fallback, minimumMatch: fallback ? minimumMatch : terms.length, commit: this.stats?.commit };
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
