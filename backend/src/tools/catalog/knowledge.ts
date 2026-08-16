import { searchKnowledge } from '../../rag/index.js';
import { readDocument } from '../docsTool.js';
import type { ToolModule } from '../contracts.js';

export const knowledgeToolModules: ToolModule[] = [
  {
    label: '知识库检索',
    definition: {
      type: 'function',
      function: {
        name: 'search_knowledge',
        description:
          'Search the indexed Markdown knowledge base. When P3 is enabled, a weak first pass is automatically rewritten and fused within a strict three-query budget. Returns sources, retrievalQueries, queryCount, rewriteTriggered, and a final verdict. Sufficient evidence may be used; weak means the automatic budget was exhausted (or rewrite was disabled); empty candidates are not evidence and must not be cited.',
        parameters: {
          type: 'object',
          properties: {
            query: {
              type: 'string',
              description: 'Question or search query.'
            },
            file: {
              type: 'string',
              description: 'Optional knowledge-relative document path. When set, both semantic and keyword retrieval are restricted to this document.'
            },
            limit: {
              type: 'integer',
              minimum: 1,
              maximum: 10,
              description: 'Maximum number of source chunks to return. Defaults to 5.'
            }
          },
          required: ['query']
        }
      }
    },
    execute: (args, context) => searchKnowledge(args, { signal: context?.signal })
  },
  {
    label: '文档定向阅读',
    definition: {
      type: 'function',
      function: {
        name: 'read_document',
        description: 'Read a selected range from a knowledge document when search_knowledge snippets are insufficient. Read the smallest relevant range.',
        parameters: {
          type: 'object',
          properties: {
            file: {
              type: 'string',
              description: 'Knowledge-relative file path returned by search_knowledge.'
            },
            startLine: {
              type: 'integer',
              minimum: 1,
              description: 'Optional 1-based first line. Defaults to 1.'
            },
            endLine: {
              type: 'integer',
              minimum: 1,
              description: 'Optional 1-based inclusive last line. Defaults to the document end.'
            },
            maxChars: {
              type: 'number',
              description: 'Maximum number of characters to return. Defaults to 12000 and is capped at 12000.'
            }
          },
          required: ['file']
        }
      }
    },
    execute: readDocument
  }
];
