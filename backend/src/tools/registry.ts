import { searchKnowledge } from '../rag/index.js';
import { readDocument, searchDocs } from './docsTool.js';
import { fetchPage } from './fetchPageTool.js';
import { webSearch } from './webSearchTool.js';
import { generateWordDocument } from './wordDocumentTool.js';

export type ToolDefinition = {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: {
      type: 'object';
      properties: Record<string, unknown>;
      required: string[];
    };
  };
};

export type ToolContext = {
  /** Aborted when the client disconnects or the request is cancelled. Long-running tools should observe it. */
  signal?: AbortSignal;
};

type ToolRegistryEntry = {
  /** Chinese display name for UI surfaces (toggles, panels). The model always sees the English function name. */
  label: string;
  definition: ToolDefinition;
  execute: (args: unknown, context?: ToolContext) => unknown | Promise<unknown>;
};

export const toolRegistry: Record<string, ToolRegistryEntry> = {
  search_knowledge: {
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
  search_docs: {
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
  read_document: {
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
  },
  generate_word_document: {
    label: '生成 Word 文档',
    definition: {
      type: 'function',
      function: {
        name: 'generate_word_document',
        description:
          'Generate a downloadable DOCX only when the user explicitly asks to create, export, or download a Word/DOCX document. Put the complete body in contentMarkdown instead of constructing JSON block arrays. Supported Markdown: #/##/### headings, paragraphs, - bullet lists, 1. numbered lists, pipe tables, fenced code as plain text, and <!-- pagebreak -->. Do not repeat title/subtitle in contentMarkdown. Choose research-report for research and analysis, technical-report for architecture and implementation plans, business-report for decisions and action plans, and simple for general notes. Call at most once per user request. The client renders preview and download actions from the structured tool result. Do not repeat downloadUrl, previewUrl, localhost URLs, Markdown download links, or download instructions in the final prose.',
        parameters: {
          type: 'object',
          properties: {
            fileName: {
              type: 'string',
              description: 'Optional user-facing file name. The .docx extension is added automatically.'
            },
            title: {
              type: 'string',
              description: 'Document title.'
            },
            subtitle: {
              type: 'string',
              description: 'Optional subtitle.'
            },
            author: {
              type: 'string',
              description: 'Optional author or organization.'
            },
            contentMarkdown: {
              type: 'string',
              minLength: 1,
              maxLength: 40000,
              description:
                'Complete document body as Markdown. Use <!-- pagebreak --> where a new page is needed. Do not wrap the Markdown in a code fence.'
            },
            format: {
              type: 'object',
              description:
                'Optional style overrides. Omitted values inherit from the selected preset.',
              properties: {
                preset: {
                  type: 'string',
                  enum: ['research-report', 'technical-report', 'business-report', 'simple']
                },
                pageSize: {
                  type: 'string',
                  enum: ['A4', 'LETTER']
                },
                orientation: {
                  type: 'string',
                  enum: ['portrait', 'landscape']
                },
                margins: {
                  type: 'object',
                  description: 'Page margins in millimeters, each between 5 and 50.',
                  properties: {
                    top: { type: 'number' },
                    right: { type: 'number' },
                    bottom: { type: 'number' },
                    left: { type: 'number' }
                  }
                },
                titleFont: { type: 'string' },
                titleFontSize: { type: 'number' },
                headingFont: { type: 'string' },
                bodyFont: { type: 'string' },
                bodyFontSize: { type: 'number' },
                lineSpacing: { type: 'number' },
                primaryColor: {
                  type: 'string',
                  description: 'Six-digit hex color, with or without #.'
                },
                showHeader: { type: 'boolean' },
                headerText: { type: 'string' },
                footerText: { type: 'string' },
                showPageNumber: { type: 'boolean' }
              }
            }
          },
          required: ['title', 'contentMarkdown']
        }
      }
    },
    execute: generateWordDocument
  },
  web_search: {
    label: '联网搜索',
    definition: {
      type: 'function',
      function: {
        name: 'web_search',
        description:
          'Search the public web for external facts the local knowledge base cannot answer: library comparisons, versions, releases, current events. Returns titles, urls, and snippets. Snippets are often enough; call fetch_page only for results worth reading in depth.',
        parameters: {
          type: 'object',
          properties: {
            query: {
              type: 'string',
              description: 'Search query. Prefer specific terms, e.g. "LangGraph vs Mastra 2026 comparison".'
            },
            limit: {
              type: 'integer',
              minimum: 1,
              maximum: 8,
              description: 'Maximum number of results. Defaults to 5.'
            }
          },
          required: ['query']
        }
      }
    },
    execute: (args, context) => webSearch(args, context?.signal)
  },
  fetch_page: {
    label: '网页阅读',
    definition: {
      type: 'function',
      function: {
        name: 'fetch_page',
        description:
          'Fetch a public web page and return its readable text. Long pages are chunked and only the parts most relevant to `query` are returned, so always pass a focused query for long documentation pages. Use after web_search when a snippet is not enough.',
        parameters: {
          type: 'object',
          properties: {
            url: {
              type: 'string',
              description: 'Full http(s) url to fetch, usually taken from a web_search result.'
            },
            query: {
              type: 'string',
              description: 'What to look for in the page. Drives which chunks of a long page are returned.'
            },
            maxChunks: {
              type: 'integer',
              minimum: 1,
              maximum: 6,
              description: 'Maximum number of ~1200-char chunks to return for long pages. Defaults to 3.'
            }
          },
          required: ['url']
        }
      }
    },
    execute: (args, context) => fetchPage(args, context?.signal)
  }
} satisfies Record<string, ToolRegistryEntry>;
