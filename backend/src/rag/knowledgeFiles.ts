import { basename, extname, isAbsolute } from 'node:path';

import { asc, eq } from 'drizzle-orm';

import { db } from '../db.js';
import { knowledgeDocuments } from '../schema.js';
import type { RagDocument } from './types.js';

export type KnowledgeDocument = RagDocument & {
  sizeBytes: number;
  updatedAt: string;
};

type KnowledgeDocumentRow = typeof knowledgeDocuments.$inferSelect;

export function listKnowledgeDocuments(): KnowledgeDocument[] {
  return db.select().from(knowledgeDocuments).orderBy(asc(knowledgeDocuments.path)).all().map(toKnowledgeDocument);
}

export function readKnowledgeDocument(file: string): KnowledgeDocument {
  const path = resolveKnowledgePath(file);
  const row = db.select().from(knowledgeDocuments).where(eq(knowledgeDocuments.path, path)).get();

  if (!row) throw new Error(`Document not found: ${path}`);

  return toKnowledgeDocument(row);
}

export function knowledgeDocumentExists(file: string) {
  const path = resolveKnowledgePath(file);
  return Boolean(db.select({ path: knowledgeDocuments.path }).from(knowledgeDocuments).where(eq(knowledgeDocuments.path, path)).get());
}

export function writeKnowledgeDocument(file: string, content: string) {
  const path = resolveKnowledgePath(file);
  const now = new Date().toISOString();
  const existing = db.select({ path: knowledgeDocuments.path }).from(knowledgeDocuments).where(eq(knowledgeDocuments.path, path)).get();

  if (existing) {
    db.update(knowledgeDocuments)
      .set({ content, updatedAt: now })
      .where(eq(knowledgeDocuments.path, path))
      .run();
  } else {
    db.insert(knowledgeDocuments).values({ path, content, createdAt: now, updatedAt: now }).run();
  }

  return readKnowledgeDocument(path);
}

export function deleteKnowledgeDocument(file: string) {
  const path = resolveKnowledgePath(file);
  return db.delete(knowledgeDocuments).where(eq(knowledgeDocuments.path, path)).run().changes > 0;
}

export function resolveKnowledgePath(file: string) {
  if (!file || file.includes('\0') || file.includes('\\') || isAbsolute(file)) {
    throw new Error('Document path must be a relative Markdown path');
  }

  const path = file.trim();
  const segments = path.split('/');

  if (!path || segments.some((segment) => !segment || segment === '.' || segment === '..')) {
    throw new Error('Document path must be a relative Markdown path');
  }

  if (extname(path).toLowerCase() !== '.md') {
    throw new Error('Only Markdown (.md) documents are supported');
  }

  return path;
}

function toKnowledgeDocument(row: KnowledgeDocumentRow): KnowledgeDocument {
  const lines = row.content.split(/\r?\n/);

  return {
    file: row.path,
    title: getDocumentTitle(lines, row.path),
    content: row.content,
    lineCount: lines.length,
    sizeBytes: Buffer.byteLength(row.content, 'utf8'),
    updatedAt: toIsoTimestamp(row.updatedAt)
  };
}

function getDocumentTitle(lines: string[], file: string) {
  const titleLine = lines.find((line) => line.startsWith('# '));
  return titleLine ? titleLine.replace(/^#\s+/, '').trim() : basename(file, extname(file));
}

function toIsoTimestamp(value: string) {
  return value.endsWith('Z') ? value : new Date(value.replace(' ', 'T') + 'Z').toISOString();
}
