import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { chunkMarkdownDocument } from '../chunker.js';
import type { RagDocument } from '../types.js';
import { ragEvalCases } from './fixtures.js';

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
const knowledgeDirectory = resolve(projectRoot, 'docs/knowledge');

async function main() {
  const errors: string[] = [];
  const ids = new Set<string>();
  const documentCache = new Map<string, RagDocument>();
  const chunkCache = new Map<string, ReturnType<typeof chunkMarkdownDocument>>();
  const categoryCounts = new Map<string, number>();

  for (const testCase of ragEvalCases) {
    if (ids.has(testCase.id)) errors.push(`${testCase.id}: duplicate case id`);
    ids.add(testCase.id);
    categoryCounts.set(testCase.category ?? 'uncategorized', (categoryCounts.get(testCase.category ?? 'uncategorized') ?? 0) + 1);

    const answerable = testCase.answerable ?? true;

    if (!answerable) {
      if (testCase.expectedFiles.length) errors.push(`${testCase.id}: unanswerable case must not declare expectedFiles`);
      if (testCase.expectedHeadings?.length) errors.push(`${testCase.id}: unanswerable case must not declare expectedHeadings`);
      if (testCase.expectedAnchors?.length) errors.push(`${testCase.id}: unanswerable case must not declare expectedAnchors`);
      if (testCase.category !== 'unanswerable') errors.push(`${testCase.id}: unanswerable case should use category "unanswerable"`);
      continue;
    }

    if (!testCase.expectedFiles.length) errors.push(`${testCase.id}: expectedFiles is empty`);
    if (testCase.category === 'unanswerable') errors.push(`${testCase.id}: category "unanswerable" requires answerable: false`);

    const expectedDocuments: RagDocument[] = [];
    for (const file of testCase.expectedFiles) {
      let document = documentCache.get(file);
      if (!document) {
        try {
          const content = await readFile(resolve(knowledgeDirectory, file), 'utf8');
          const lines = content.split(/\r?\n/);
          document = {
            file,
            title: lines.find((line) => line.startsWith('# '))?.slice(2).trim() ?? file,
            content,
            lineCount: lines.length
          };
          documentCache.set(file, document);
        } catch {
          errors.push(`${testCase.id}: missing expected file ${file}`);
          continue;
        }
      }
      expectedDocuments.push(document);
    }

    for (const heading of testCase.expectedHeadings ?? []) {
      const escapedHeading = heading.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const headingPattern = new RegExp(`^#{2,3}\\s+${escapedHeading}\\s*#*\\s*$`, 'm');
      if (!expectedDocuments.some((document) => headingPattern.test(document.content))) {
        errors.push(`${testCase.id}: heading "${heading}" not found in expected documents`);
      }
    }

    for (const evidence of testCase.expectedEvidence ?? []) {
      if (!evidence.trim()) errors.push(`${testCase.id}: expectedEvidence contains an empty answer point`);
    }

    for (const anchor of testCase.expectedAnchors ?? []) {
      if (!anchor.trim()) {
        errors.push(`${testCase.id}: expectedAnchors contains an empty anchor`);
        continue;
      }

      // 锚点必须出现在某个可被检索到的 chunk 中（逐字匹配），保证证据级指标可信
      const anchorInChunk = expectedDocuments.some((document) => {
        let chunks = chunkCache.get(document.file);
        if (!chunks) {
          chunks = chunkMarkdownDocument(document);
          chunkCache.set(document.file, chunks);
        }
        return chunks.some((chunk) => chunk.content.includes(anchor));
      });

      if (!anchorInChunk) {
        errors.push(`${testCase.id}: anchor "${anchor.slice(0, 40)}..." not found verbatim in any chunk of expected documents`);
      }
    }
  }

  const chunkCount = [...documentCache.values()].reduce((total, document) => {
    let chunks = chunkCache.get(document.file);
    if (!chunks) {
      chunks = chunkMarkdownDocument(document);
      chunkCache.set(document.file, chunks);
    }
    if (!chunks.length) errors.push(`${document.file}: chunker returned no chunks`);
    return total + chunks.length;
  }, 0);

  if (errors.length) {
    for (const error of errors) console.error(`- ${error}`);
    throw new Error(`RAG fixture validation failed with ${errors.length} error(s).`);
  }

  const anchorCount = ragEvalCases.reduce((total, testCase) => total + (testCase.expectedAnchors?.length ?? 0), 0);
  const categories = [...categoryCounts.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([category, count]) => `${category}=${count}`)
    .join(', ');

  console.log(`Validated ${ragEvalCases.length} cases, ${documentCache.size} documents, ${chunkCount} chunks and ${anchorCount} anchors.`);
  console.log(`Categories: ${categories}`);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
