import { retrieveWebEvidence } from '../../web/controller.js';
import { fetchPage } from '../fetchPageTool.js';
import { webSearch } from '../webSearchTool.js';
import type { ToolModule } from '../contracts.js';

export const webToolModules: ToolModule[] = [
  {
    label: '受控联网检索',
    definition: {
      type: 'function',
      function: {
        name: 'retrieve_web_evidence',
        description:
          'Search the public web through one complete controlled quality loop. Call this tool at most once per user request: it already scores Tavily results, fetches diverse candidate pages, rejects irrelevant content, rewrites weak queries within a fixed budget, and returns auditable sources plus sufficient/empty/exhausted verdicts. Treat only sufficient results as strong evidence; exhausted means some related material was found but the quality budget ended before confidence was sufficient.',
        parameters: {
          type: 'object',
          properties: {
            question: { type: 'string', description: 'The complete external-information question to investigate.' },
            timeRange: {
              type: 'string',
              enum: ['day', 'week', 'month', 'year'],
              description: 'Optional freshness window for time-sensitive questions.'
            },
            includeDomains: {
              type: 'array',
              items: { type: 'string' },
              description: 'Optional trusted domains to prefer when the user or task explicitly identifies them.'
            },
            excludeDomains: {
              type: 'array',
              items: { type: 'string' },
              description: 'Optional domains that must not be searched.'
            }
          },
          required: ['question']
        }
      }
    },
    execute: (args, context) => retrieveWebEvidence(args, { signal: context?.signal })
  },
  {
    label: '联网搜索',
    exposedToModel: false,
    definition: {
      type: 'function',
      function: {
        name: 'web_search',
        description:
          'Search the public web for external facts the local knowledge base cannot answer: library comparisons, versions, releases, current events. Returns titles, urls, and snippets. Snippets are often enough; call fetch_page only for results worth reading in depth.',
        parameters: {
          type: 'object',
          properties: {
            query: { type: 'string', description: 'Search query. Prefer specific terms, e.g. "LangGraph vs Mastra 2026 comparison".' },
            limit: { type: 'integer', minimum: 1, maximum: 8, description: 'Maximum number of results to return. Defaults to 5.' }
          },
          required: ['query']
        }
      }
    },
    execute: (args, context) => webSearch(args, context?.signal)
  },
  {
    label: '网页阅读',
    exposedToModel: false,
    definition: {
      type: 'function',
      function: {
        name: 'fetch_page',
        description:
          'Fetch a public web page and return its readable text. Long pages are chunked and only the parts most relevant to `query` are returned, so always pass a focused query for long documentation pages. Use after web_search when a snippet is not enough.',
        parameters: {
          type: 'object',
          properties: {
            url: { type: 'string', description: 'Full http(s) url to fetch, usually taken from a web_search result.' },
            query: { type: 'string', description: 'What to look for in the page. Drives which chunks of a long page are returned.' },
            maxChunks: { type: 'integer', minimum: 1, maximum: 6, description: 'Maximum number of ~1200-char chunks to return for long pages. Defaults to 3.' }
          },
          required: ['url']
        }
      }
    },
    execute: (args, context) => fetchPage(args, context?.signal)
  }
];
