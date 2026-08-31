import { z } from 'zod';

import { retrieveWebEvidence } from '../../web/controller.js';
import { defineTool } from '../defineTool.js';
import { fetchPage } from '../fetchPageTool.js';
import { webSearch } from '../webSearchTool.js';

const retrieveWebEvidenceSchema = z.object({
  question: z.string().trim().min(1).max(1_000),
  maxQueries: z.number().int().min(1).max(5).optional(),
  maxPages: z.number().int().min(1).max(10).optional(),
  timeRange: z.enum(['day', 'week', 'month', 'year']).optional(),
  includeDomains: z.array(z.string().trim().min(1).max(253)).max(20).optional(),
  excludeDomains: z.array(z.string().trim().min(1).max(253)).max(20).optional(),
  requiredEvidence: z.array(z.object({
    id: z.string().trim().min(1).max(80),
    label: z.string().trim().min(1).max(240),
    groups: z.array(z.array(z.string().trim().min(1).max(120)).min(1)).min(1).max(12)
  })).max(12).optional(),
  expectNoAnswer: z.boolean().optional()
});

const webSearchSchema = z.object({
  query: z.string().trim().min(1),
  limit: z.number().int().min(1).max(8).optional()
});

const fetchPageSchema = z.object({
  url: z.string().trim().url(),
  query: z.string().trim().min(1).optional(),
  maxChunks: z.number().int().min(1).max(6).optional()
});

export const webToolModules = [
  defineTool({
    label: '受控联网检索',
    name: 'retrieve_web_evidence',
    description:
      'Retrieve public web evidence through one controlled quality loop. Call this tool at most once per user request: it detects URL/PDF, official-docs, freshness, China-domestic, dynamic-page, verification, and vertical-domain signals; builds an auditable provider route; directly fetches explicit URLs when appropriate; then scores search results, fetches diverse pages, and rewrites weak queries toward uncovered claims within a fixed budget. Treat only sufficient results with adequate claim coverage as strong evidence.',
    inputSchema: retrieveWebEvidenceSchema,
    execute: (args, context) => retrieveWebEvidence(args, {
      signal: context?.signal,
      onProgress: context?.onProgress,
      onSource: context?.onSource
    })
  }),
  defineTool({
    label: '联网搜索',
    exposedToModel: false,
    name: 'web_search',
    description:
      'Search the public web for external facts the local knowledge base cannot answer: library comparisons, versions, releases, current events. Returns titles, urls, and snippets. Snippets are often enough; call fetch_page only for results worth reading in depth.',
    inputSchema: webSearchSchema,
    execute: (args, context) => webSearch(args, context?.signal)
  }),
  defineTool({
    label: '网页阅读',
    exposedToModel: false,
    name: 'fetch_page',
    description:
      'Fetch a public web page and return its readable text. Long pages are chunked and only the parts most relevant to `query` are returned, so always pass a focused query for long documentation pages. Use after web_search when a snippet is not enough.',
    inputSchema: fetchPageSchema,
    execute: (args, context) => fetchPage(args, context?.signal)
  })
];
