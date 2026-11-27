import { readdir, readFile } from 'node:fs/promises';
import { initDb } from './dist/db.js';
import { knowledgeDocumentExists, readKnowledgeDocument, writeKnowledgeDocument } from './dist/rag/knowledgeFiles.js';
import { syncRagIndex } from './dist/rag/sync.js';

const flags = process.argv.slice(2);
if (flags.some((flag) => flag !== '--index')) throw new Error('Usage: node seed-demo.mjs [--index]');
initDb();
let created = 0;
for (const file of (await readdir(new URL('./demo-knowledge/', import.meta.url))).filter((file) => file.endsWith('.md')).sort()) {
  const path = `public-demo/${file}`;
  const content = await readFile(new URL(`./demo-knowledge/${file}`, import.meta.url), 'utf8');
  if (knowledgeDocumentExists(path)) {
    if (readKnowledgeDocument(path).content !== content) throw new Error(`Existing document differs; no overwrite performed: ${path}`);
  } else {
    writeKnowledgeDocument(path, content);
    created += 1;
  }
}
console.log(`Public sample documents created: ${created}`);
if (flags.includes('--index')) {
  const result = await syncRagIndex();
  console.log(`Indexed ${result.documents} public documents (${result.chunks} chunks)`);
}
