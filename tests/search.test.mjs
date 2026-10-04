import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { buildIndex, metadata, removeBoilerplate } from '../dist/indexer.js';
import { ContentStore } from '../dist/store.js';

test('metadata uses substantive H1 without splitting legal abbreviations and preserves real descriptions', () => {
  const heading = 'Erstellt eine Meldung nach Art. 33 Abs. 3 Nr. 1 DSGVO';
  assert.equal(metadata('recht/skills/dsv-meldung/SKILL.md', `---\nname: dsv-meldung\ndescription: 'Für Dsv Meldung: ordnet Norm, Beweislast und Gegenargument; Prüfprodukt mit Risiko und nächstem Schritt.'\n---\n# ${heading}`).description, heading);
  assert.equal(metadata('recht/skills/dsv-meldung/SKILL.md', '---\ndescription: Meldepflicht nach Art. 33 DSGVO\n---\n# Andere Überschrift').description, 'Meldepflicht nach Art. 33 DSGVO');
  assert.equal(removeBoilerplate('DSGVO; ordnet Norm, Beweislast und Gegenargument; Prüfprodukt mit Risiko und nächstem Schritt.'), 'DSGVO;');
  assert.equal(metadata('recht/references/fachmodule.md', '# Fachmodule').kind, 'reference');
});

test('snippets belong to each original document and exact offsets; fallback and corpus filters are transparent', async () => {
  const root = await mkdtemp(join(tmpdir(), 'legal-search-'));
  const store = new ContentStore();
  const repo = join(root, 'repo');
  const files = {
    'arbeitsrecht/skills/a/SKILL.md': '# Frist\n' + 'Vorspann 😀\n'.repeat(450) + 'Kündigungsschutzklage Frist drei Wochen Zugang alphaunique\n',
    'arbeitsrecht/skills/b/SKILL.md': '# Frist\nKündigungsschutzklage Frist drei Wochen Zugang betaunique\n',
    'arbeitsrecht/skills/c/SKILL.md': '# Abmahnung\nAbmahnung Arbeitnehmer verhaltensbedingte Kündigung Betriebsrat Anhörung\n',
    'testakten/fixture.md': '# Bussgeld\nBussgeld Download Tabelle\n',
    'quality/report.md': '# Bussgeld\nBussgeld quality\n',
    'datenschutzrecht/skills/bussgeld/SKILL.md': '# Bussgeld\nBussgeld Fachtext\n',
    'binary.md': Buffer.from([0]),
    'large.md': 'x'.repeat(20000),
    'unsupported.bin': 'unparsed',
  };
  try {
    await mkdir(repo);
    for (const [path, content] of Object.entries(files)) {
      await mkdir(join(repo, path, '..'), { recursive: true });
      await writeFile(join(repo, path), content);
    }
    const git = (...args) => execFileSync('git', ['-C', repo, ...args], { stdio: 'pipe' });
    git('init'); git('add', '.');
    const output = join(root, 'index.sqlite');
    const stats = await buildIndex({ repoDir: repo, output, commit: 'fixture', maxFileBytes: 15000, sourceBaseUrl: 'https://example.invalid' });
    store.open(output);
    const result = store.search('Kündigungsschutzklage Frist drei Wochen Zugang', 3, 'arbeitsrecht');
    assert.equal(result.results.length, 2);
    assert.equal(result.fallback, false);
    assert.notEqual(result.results[0].snippet, result.results[1].snippet);
    assert.ok(result.results.some(hit => hit.start > 4000));
    for (const hit of result.results) {
      assert.equal(hit.snippet, files[hit.id].slice(hit.start, hit.end));
      assert.equal(hit.snippet, store.getContent(hit.id, hit.start, hit.end - hit.start).text);
      assert.ok(hit.snippet.length <= 600);
    }
    const relaxed = store.search('Abmahnung Arbeitnehmer verhaltensbedingte Kündigung Beweislast Betriebsrat Anhörung', 3, 'arbeitsrecht');
    assert.equal(relaxed.fallback, true);
    assert.equal(relaxed.results[0].id, 'arbeitsrecht/skills/c/SKILL.md');
    assert.deepEqual(relaxed.results[0].droppedTerms, ['beweislast']);
    assert.equal(relaxed.results[0].matchedTerms.length, 6);
    assert.equal(store.search('Abmahnung völlig unbekannt fremd').results.length, 0);
    assert.deepEqual(store.search('Bussgeld').results.map(hit => hit.kind), ['skill']);
    assert.equal(store.search('Bussgeld', 3, undefined, 'fixture').results[0].collection, 'testakten');
    assert.equal(store.search('Bussgeld', 3, undefined, 'meta').results[0].collection, 'quality');
    assert.deepEqual(stats.skippedByReason, { binary: 1, tooLarge: 1, unsupportedExtension: 1 });
    assert.equal(Object.values(stats.skippedByReason).reduce((a, b) => a + b, 0), stats.skipped);
  } finally { store.close(); await rm(root, { recursive: true, force: true }); }
});
