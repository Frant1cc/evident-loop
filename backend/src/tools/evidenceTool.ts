import { listResearchSources } from '../research/store.js';
import type { ResearchSource } from '../research/types.js';
import type { ToolContext } from './contracts.js';

const DEFAULT_MAX_CHARS = 8_000;
const MAX_MAX_CHARS = 24_000;

type ReadEvidenceArgs = {
  citationKey?: unknown;
  sourceId?: unknown;
  maxChars?: unknown;
};

export type ReadEvidenceResult = {
  sourceId: string;
  citationKey: string;
  title: string;
  file: string;
  heading?: string;
  content: string;
  truncated: boolean;
  totalChars: number;
};

/**
 * Returns the full text of a previously retrieved evidence, addressed either by its display
 * citation key (e.g. "S1") or by its durable ResearchSource id. Does NOT perform new retrieval —
 * it only reads rows that already exist in research_sources for the current conversation.
 *
 * This is the tool that lets the model recover the exact body of a source after summary
 * compression has stripped the tool messages that originally introduced it.
 */
export async function readEvidence(args: unknown, context?: ToolContext): Promise<ReadEvidenceResult> {
  throwIfAborted(context?.signal);
  const parsed = parseArgs(args);
  const conversationId = context?.conversationId;

  if (!conversationId) {
    throw new Error('read_evidence 缺少会话上下文：conversationId 未注入');
  }

  const sources = listResearchSources(conversationId);
  const target = resolveTarget(sources, parsed);

  if (!target) {
    const identifier = parsed.citationKey ? `citationKey="${parsed.citationKey}"` : `sourceId="${parsed.sourceId}"`;
    throw new Error(`未在本会话的已检索证据中找到 ${identifier}`);
  }

  throwIfAborted(context?.signal);
  const max = clampMaxChars(parsed.maxChars);
  const truncated = target.content.length > max;

  return {
    sourceId: target.id,
    citationKey: target.citationKey,
    title: target.title,
    file: target.file,
    ...(target.heading ? { heading: target.heading } : {}),
    content: target.content.slice(0, max),
    truncated,
    totalChars: target.content.length
  };
}

function resolveTarget(sources: ResearchSource[], parsed: { citationKey?: string; sourceId?: string }) {
  if (parsed.citationKey) {
    return sources.find((source) => source.citationKey === parsed.citationKey);
  }
  if (parsed.sourceId) {
    return sources.find((source) => source.id === parsed.sourceId);
  }
  return undefined;
}

function parseArgs(args: unknown) {
  if (!args || typeof args !== 'object') {
    throw new Error('read_evidence requires { citationKey } or { sourceId }');
  }

  const { citationKey, sourceId, maxChars } = args as ReadEvidenceArgs;

  const normalizedCitationKey = typeof citationKey === 'string' && citationKey.trim()
    ? citationKey.trim()
    : undefined;
  const normalizedSourceId = typeof sourceId === 'string' && sourceId.trim()
    ? sourceId.trim()
    : undefined;

  if (!normalizedCitationKey && !normalizedSourceId) {
    throw new Error('read_evidence requires either citationKey or sourceId');
  }
  if (normalizedCitationKey && normalizedSourceId) {
    throw new Error('read_evidence accepts citationKey or sourceId, not both');
  }

  return {
    ...(normalizedCitationKey ? { citationKey: normalizedCitationKey } : {}),
    ...(normalizedSourceId ? { sourceId: normalizedSourceId } : {}),
    maxChars: typeof maxChars === 'number' && Number.isInteger(maxChars) && maxChars > 0
      ? maxChars
      : DEFAULT_MAX_CHARS
  };
}

function clampMaxChars(value: number): number {
  if (!Number.isFinite(value) || value <= 0) return DEFAULT_MAX_CHARS;
  return Math.min(value, MAX_MAX_CHARS);
}

function throwIfAborted(signal?: AbortSignal) {
  if (signal?.aborted) {
    throw signal.reason instanceof Error ? signal.reason : new Error('read_evidence was cancelled');
  }
}
