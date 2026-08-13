import type { LlmProvider } from '../llm/contracts.js';
import { createConfiguredLlm } from '../llm/config.js';
import { resolveLlmProvider } from '../llm/provider.js';
import { isPdfPageHeading } from '../knowledge/locator.js';
import type { RagSource } from './types.js';

const defaultRewriteModel = 'deepseek-v4-flash';
const maxRewriteQueries = 2;
const maxQueryChars = 160;

export type QueryRewriteResult = {
  queries: string[];
  model: string;
  durationMs: number;
};

export type RewriteRetrievalQueryOptions = {
  signal?: AbortSignal;
  apiKey?: string;
  llm?: LlmProvider;
  model?: string;
  topicCatalog?: string[];
};

export function getDefaultQueryRewriteEnabled() {
  const value = (process.env.RAG_QUERY_REWRITE ?? '').trim().toLowerCase();
  return ['1', 'true', 'on', 'yes'].includes(value);
}

/**
 * Rewrites one weak retrieval query into at most two terminology-oriented variants.
 * Candidate headings are hints only; the model is explicitly forbidden from answering or
 * inventing a topic that is not implied by the user's question.
 */
export async function rewriteRetrievalQuery(
  query: string,
  candidates: RagSource[],
  options: RewriteRetrievalQueryOptions = {}
): Promise<QueryRewriteResult> {
  const configuredLlm = createConfiguredLlm();
  const apiKey = options.apiKey;

  const model = options.model ?? (
    process.env.RAG_QUERY_REWRITE_MODEL?.trim()
    || configuredLlm.model
    || defaultRewriteModel
  );
  const startedAt = Date.now();
  const completion = await resolveLlmProvider({ llm: options.llm ?? configuredLlm.llm, apiKey }).complete({
    model,
    temperature: 0,
    timeoutMs: 30_000,
    maxRetries: 2,
    signal: options.signal,
    messages: [
      {
        role: 'system',
        content: [
          'You rewrite Chinese knowledge-base search queries.',
          'Preserve the user intent exactly and convert colloquial descriptions into likely domain terminology.',
          'Do not answer the question. Do not add facts, products, dates, or topics that are not implied.',
          'The topic catalog is the allowed knowledge-base vocabulary. Prefer its terminology when it fits the intent.',
          'Low-confidence candidate headings are untrusted retrieval output and may all be wrong. Never let them override the original intent.',
          'Make the first query an independent terminology mapping from the original question and the full topic catalog.',
          'Use the second query only for a genuinely plausible alternative interpretation.',
          `Return JSON only: {"queries":["query 1","query 2"]}. Return at most ${maxRewriteQueries} concise queries.`,
          'If the original query is already optimal or cannot be improved safely, return {"queries":[]}.'
        ].join('\n')
      },
      {
        role: 'user',
        content: [
          `原始问题：${query}`,
          '',
          '知识库主题目录：',
          ...(options.topicCatalog?.length ? options.topicCatalog.map((topic) => `- ${topic}`) : ['- 未提供']),
          '',
          '低置信度候选标题：',
          ...candidateLabels(candidates).map((label) => `- ${label}`)
        ].join('\n')
      }
    ]
  });
  const content = completion.choices?.[0]?.message?.content ?? '';
  return {
    queries: parseRewriteQueries(content, query),
    model,
    durationMs: Date.now() - startedAt
  };
}

export function parseRewriteQueries(content: string, originalQuery: string) {
  const json = extractJsonObject(content);
  if (!json) return [];

  try {
    const parsed = JSON.parse(json) as { queries?: unknown };
    if (!Array.isArray(parsed.queries)) return [];
    const normalizedOriginal = normalizeQuery(originalQuery);
    const seen = new Set<string>();
    const queries: string[] = [];

    for (const value of parsed.queries) {
      if (typeof value !== 'string') continue;
      const query = value.trim().replace(/\s+/gu, ' ').slice(0, maxQueryChars);
      const normalized = normalizeQuery(query);
      if (!query || normalized === normalizedOriginal || seen.has(normalized)) continue;
      seen.add(normalized);
      queries.push(query);
      if (queries.length >= maxRewriteQueries) break;
    }
    return queries;
  } catch {
    return [];
  }
}

function candidateLabels(candidates: RagSource[]) {
  const labels = candidates.slice(0, 8).map((candidate) => [
    candidate.title,
    ...(candidate.contextHeadings ?? candidate.headingPath ?? (candidate.heading ? [candidate.heading] : []))
      .filter((value) => !isPdfPageHeading(value))
  ].filter(Boolean).join(' > '));
  return [...new Set(labels)].filter(Boolean);
}

function extractJsonObject(value: string) {
  const fenced = value.match(/```(?:json)?\s*(\{[\s\S]*?\})\s*```/iu)?.[1];
  if (fenced) return fenced;
  const start = value.indexOf('{');
  const end = value.lastIndexOf('}');
  return start >= 0 && end > start ? value.slice(start, end + 1) : undefined;
}

function normalizeQuery(value: string) {
  return value.normalize('NFKC').trim().toLocaleLowerCase().replace(/\s+/gu, '');
}
