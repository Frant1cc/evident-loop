import { z } from 'zod';

import { searchKnowledge } from '../../rag/index.js';
import { readDocument } from '../docsTool.js';
import { defineTool } from '../defineTool.js';

const searchKnowledgeSchema = z.object({
  query: z.string().trim().min(1),
  file: z.string().trim().min(1).optional(),
  limit: z.number().int().min(1).max(10).optional()
});

const readDocumentSchema = z.object({
  file: z.string().trim().min(1),
  startLine: z.number().int().min(1).optional(),
  endLine: z.number().int().min(1).optional(),
  maxChars: z.number().int().min(1).max(12_000).optional()
});

export const knowledgeToolModules = [
  defineTool({
    label: '知识库检索',
    name: 'search_knowledge',
    description:
      'Search the indexed Markdown knowledge base. When P3 is enabled, a weak first pass is automatically rewritten and fused within a strict three-query budget. Returns sources, retrievalQueries, queryCount, rewriteTriggered, and a final verdict. Sufficient evidence may be used; weak means the automatic budget was exhausted (or rewrite was disabled); empty candidates are not evidence and must not be cited.',
    inputSchema: searchKnowledgeSchema,
    execute: (args, context) => searchKnowledge(args, { signal: context?.signal })
  }),
  defineTool({
    label: '文档定向阅读',
    name: 'read_document',
    description: 'Read a selected range from a knowledge document when search_knowledge snippets are insufficient. Read the smallest relevant range.',
    inputSchema: readDocumentSchema,
    execute: readDocument
  })
];