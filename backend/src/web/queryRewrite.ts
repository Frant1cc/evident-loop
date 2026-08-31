import type { LlmProvider } from '../llm/contracts.js';
import { createConfiguredLlm } from '../llm/config.js';
import { resolveLlmProvider } from '../llm/provider.js';
import { normalizeQuery } from './quality.js';

export type RewriteWebQueryOptions = {
  question: string;
  previousQueries: string[];
  reason: string;
  uncoveredClaims?: string[];
  signal?: AbortSignal;
  llm?: LlmProvider;
  currentDate?: string;
};

export async function rewriteWebQuery(options: RewriteWebQueryOptions): Promise<string | undefined> {
  const configuredLlm = createConfiguredLlm();
  if (!configuredLlm.llm && !options.llm) return fallbackRewrite(options);

  const currentDate = normalizeCurrentDate(options.currentDate);
  try {
    const response = await resolveLlmProvider({ llm: options.llm ?? configuredLlm.llm }).complete({
      model: configuredLlm.model,
      temperature: 0,
      maxRetries: 1,
      signal: options.signal,
      messages: [
        {
          role: 'system',
          content:
            `Rewrite a web search query to fill a concrete evidence gap. Return JSON only: {"query":"..."}. Keep it focused, preserve named entities and dates, and do not repeat a previous query. Current date: ${currentDate}. Never introduce stale years for latest/recent requests; anchor them to the current year when a year improves retrieval.`
        },
        {
          role: 'user',
          content: JSON.stringify({
            question: options.question,
            previousQueries: options.previousQueries,
            failureReason: options.reason,
            uncoveredClaims: options.uncoveredClaims ?? [],
            currentDate
          })
        }
      ]
    });
    const content = response.choices?.[0]?.message?.content?.trim();
    if (!content) return fallbackRewrite(options);
    const parsed = JSON.parse(stripCodeFence(content)) as { query?: unknown };
    const query = typeof parsed.query === 'string' ? parsed.query.trim().slice(0, 500) : '';
    if (!query || hasSeen(query, options.previousQueries)) return fallbackRewrite(options);
    return query;
  } catch {
    return fallbackRewrite(options);
  }
}

function fallbackRewrite(options: RewriteWebQueryOptions) {
  const gap = options.uncoveredClaims?.find((claim) => claim.trim());
  if (gap) {
    const subject = extractSubject(options.question);
    const focused = `${subject} ${gap} ${/[一-鿿]/.test(options.question) ? '官方文档' : 'official documentation'}`.replace(/\s+/g, ' ').trim();
    if (!hasSeen(focused, options.previousQueries)) return focused;
  }
  const suffixes = /[一-鿿]/.test(options.question)
    ? [' 官方资料', ' 最新 权威来源']
    : [' official documentation', ' latest authoritative source'];
  return suffixes
    .map((suffix) => `${options.question}${suffix}`.trim())
    .find((candidate) => !hasSeen(candidate, options.previousQueries));
}

function extractSubject(question: string) {
  const api = question.match(/[A-Za-z0-9_.-]+\s+(?:Search\s+)?API/i)?.[0];
  const acronym = question.match(/\b[A-Z][A-Z0-9.-]{1,15}\b/)?.[0];
  return api ?? acronym ?? question.split(/[：:，,；;]/)[0]?.trim().slice(0, 80) ?? question.slice(0, 80);
}

function hasSeen(query: string, previousQueries: string[]) {
  const normalized = normalizeQuery(query);
  return previousQueries.some((previous) => normalizeQuery(previous) === normalized);
}

function stripCodeFence(value: string) {
  return value.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
}

function normalizeCurrentDate(value?: string) {
  const parsed = value ? new Date(value) : new Date();
  return Number.isNaN(parsed.getTime()) ? new Date().toISOString().slice(0, 10) : parsed.toISOString().slice(0, 10);
}
