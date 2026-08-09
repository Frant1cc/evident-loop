import { searchKnowledge } from '../../rag/index.js';
import { readDocument, searchDocs } from '../docsTool.js';
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
    label: '文档关键词搜索',
    definition: {
      type: 'function',
      function: {
        name: 'search_docs',
        description: 'Search Markdown documentation files in the fixed docs directory and return matching lines.',
        parameters: {
          type: 'object',
          properties: {
            query: {
              type: 'string',
              description: 'Text to search for in Markdown documentation.'
            },
            limit: {
              type: 'number',
              description: 'Maximum number of matches to return. Defaults to 5 and is capped at 20.'
            }
          },
          required: ['query']
        }
      }
    },
    execute: searchDocs
  },
  {
    label: '文档全文阅读',
    definition: {
      type: 'function',
      function: {
        name: 'read_document',
        description: 'Read a Markdown document from the fixed docs directory. Use this after search_docs when matching lines are not enough.',
        parameters: {
          type: 'object',
          properties: {
            file: {
              type: 'string',
              description: 'Docs-relative Markdown file path returned by search_docs, such as "backend-guide.md".'
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
