import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';

import { Document, Packer, Paragraph, TextRun } from 'docx';

import { buildEmptyTextPdf, buildTextPdf } from '../knowledge/pdfFixture.js';

const dataDir = mkdtempSync(join(tmpdir(), 'knowledge-api-'));
process.env.SQLITE_DB_PATH = join(dataDir, 'test.sqlite');
process.env.KNOWLEDGE_FILES_DIR = join(dataDir, 'files');
process.env.KNOWLEDGE_MAX_UPLOAD_BYTES = '20000000';

const { initDb } = await import('../db.js');
const { createApp } = await import('../app.js');

initDb();
const app = createApp();
const server = createServer(app);
let baseUrl = '';

before(async () => {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Test server did not bind');
  baseUrl = `http://127.0.0.1:${address.port}`;
});

after(async () => {
  await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  rmSync(dataDir, { recursive: true, force: true });
});

test('multipart upload accepts md/txt/docx/pdf and downloads original bytes', async () => {
  const md = await upload('note.md', Buffer.from('# 笔记\n\n正文内容。'), 'text/markdown');
  assert.equal(md.status, 201);
  const mdBody = await md.json() as { code: number; data: { document: { path: string; editable: boolean } } };
  assert.equal(mdBody.data.document.editable, false);

  const txt = await upload('plain.txt', Buffer.from('风险说明标题\n\n段落一。'), 'text/plain');
  assert.equal(txt.status, 201);

  const docx = await Packer.toBuffer(new Document({
    sections: [{ children: [new Paragraph({ children: [new TextRun('Word 段落')] })] }]
  }));
  const word = await upload('memo.docx', Buffer.from(docx), 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
  assert.equal(word.status, 201);

  const pdfBytes = buildTextPdf([['PDF Title', 'Extractable text layer about duration risk.']]);
  const pdf = await upload('report.pdf', pdfBytes, 'application/pdf');
  assert.equal(pdf.status, 201);
  const pdfBody = await pdf.json() as { data: { document: { path: string; format: string; pageCount?: number } } };
  assert.equal(pdfBody.data.document.format, 'pdf');

  const download = await fetch(`${baseUrl}/api/knowledge/documents/original?path=${encodeURIComponent(pdfBody.data.document.path)}`);
  assert.equal(download.status, 200);
  assert.equal(download.headers.get('content-disposition')?.startsWith('attachment'), true);
  assert.deepEqual(Buffer.from(await download.arrayBuffer()), pdfBytes);
});

test('same path conflicts, oversize files and scanned PDFs do not create documents', async () => {
  const first = await upload('dup.md', Buffer.from('# Dup\n\ntext'), 'text/markdown');
  assert.equal(first.status, 201);
  const second = await upload('dup.md', Buffer.from('# Dup\n\nagain'), 'text/markdown');
  assert.equal(second.status, 409);

  const scanned = await upload('scanned.pdf', buildEmptyTextPdf(), 'application/pdf');
  assert.equal(scanned.status, 422);
  const missing = await fetch(`${baseUrl}/api/knowledge/documents/content?path=${encodeURIComponent('scanned.pdf')}`);
  assert.equal(missing.status, 404);
});

test('imported documents reject PUT edits and delete cleans original files', async () => {
  const created = await upload('readonly.md', Buffer.from('# 只读\n\n内容'), 'text/markdown');
  const body = await created.json() as { data: { document: { path: string } } };
  const path = body.data.document.path;

  const edited = await fetch(`${baseUrl}/api/knowledge/documents`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ path, content: '# 改写\n\n不行', autoIndex: false })
  });
  assert.equal(edited.status, 409);

  const deleted = await fetch(`${baseUrl}/api/knowledge/documents?path=${encodeURIComponent(path)}&autoIndex=false`, { method: 'DELETE' });
  assert.equal(deleted.status, 200);
  const after = await fetch(`${baseUrl}/api/knowledge/documents/original?path=${encodeURIComponent(path)}`);
  assert.equal(after.status, 404);
});

test('upload succeeds even when indexing fails', async () => {
  const previous = process.env.EMBEDDING_API_KEY;
  process.env.EMBEDDING_API_KEY = '';
  const response = await upload('pending.md', Buffer.from('# 待索引\n\n仍然保存。'), 'text/markdown', true);
  process.env.EMBEDDING_API_KEY = previous;
  assert.equal(response.status, 201);
  const body = await response.json() as { code: number; data: { indexStatus: string; document: { path: string } } };
  assert.equal(body.code, 1);
  assert.equal(body.data.indexStatus, 'pending');
  const saved = await fetch(`${baseUrl}/api/knowledge/documents/content?path=${encodeURIComponent(body.data.document.path)}`);
  assert.equal(saved.status, 200);
});

async function upload(name: string, bytes: Buffer, type: string, autoIndex = false) {
  const form = new FormData();
  form.set('file', new Blob([Uint8Array.from(bytes)], { type }), name);
  form.set('autoIndex', String(autoIndex));
  return fetch(`${baseUrl}/api/knowledge/documents/upload`, { method: 'POST', body: form });
}
