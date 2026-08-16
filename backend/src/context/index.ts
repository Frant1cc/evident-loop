import type { ChatMessage } from '../llm/contracts.js';

/** The research models are configured for a 256K context window. */
export const CONTEXT_WINDOW_TOKENS = 256_000;
export const RESERVED_OUTPUT_TOKENS = 16_000;
export const MAX_INPUT_TOKENS = CONTEXT_WINDOW_TOKENS - RESERVED_OUTPUT_TOKENS;
export const MICRO_COMPRESSION_TOKENS = Math.floor(MAX_INPUT_TOKENS * 0.65);
export const SUMMARY_COMPRESSION_TOKENS = Math.floor(MAX_INPUT_TOKENS * 0.9);
export const SESSION_MEMORY_INTERVAL_TOKENS = 10_000;
export const SESSION_MEMORY_MAX_TOKENS = 1_500;
export const SUMMARY_MAX_TOKENS = 6_000;
export const TOOL_RESULT_MICRO_LIMIT_CHARS = 5_000;
export const TRUNCATED_TOOL_RESULT_MARKER = '[内容过长已经被截断]';

export type ContextState = {
  lastPromptTokens?: number;
  /** Canonical, non-generated context size at the last main model call. */
  lastCanonicalTokens?: number;
  sessionMemory?: string;
  /** Canonical context size covered by the current memory checkpoint. */
  sessionMemoryCheckpointTokens?: number;
  sessionMemoryCheckpointMessageCount?: number;
  sessionMemoryPending?: boolean;
  summary?: string;
  /** Canonical context size covered by the current large summary. */
  summaryCheckpointTokens?: number;
  /**
   * summaryCheckpointTokens value at the time the evidence manifest was last injected.
   * Undefined means the manifest has never been injected in this conversation.
   * The research adapter injects the manifest exactly once per summary-compression event,
   * so when state.summaryCheckpointTokens !== this value, the next prepare() must inject it.
   */
  manifestInjectedSummaryCheckpoint?: number;
};

export type ContextUnit = {
  /** Stable only within an assembled context; it is used to preserve sequence and dedupe tails. */
  id: string;
  messages: ChatMessage[];
  /** A tool-call assistant message and all of its tool results are one indivisible unit. */
  kind: 'message' | 'tool-call';
};

/**
 * Compact reference to a previously retrieved evidence (a row from research_sources). The neutral
 * context package does not build these; the research adapter reads them from DB and renders them
 * into a fixed-structure system message that survives summary compression.
 */
export type ContextEvidenceRef = {
  /** DB row id of the ResearchSource; stable across reads and is what read_evidence resolves to. */
  sourceId: string;
  /** Display key such as "S1" — the model writes this in citations. */
  citationKey: string;
  title: string;
  /** Web only: hostname / canonical domain. */
  domain?: string;
  /** Knowledge path or web URL. */
  file?: string;
  /** Truncated first ~EVIDENCE_EXCERPT_CHARS characters of the source body. */
  briefExcerpt: string;
  /** Relevance score from RAG retrieval or web page quality assessment. */
  score?: number;
  /** Which assistant message retrieved the source; useful for time grouping on the UI. */
  assistantMessageId: string;
  kind: 'web' | 'knowledge';
};

export type ContextPreparation = {
  messages: ChatMessage[];
  tools?: unknown[];
  model: string;
  signal?: AbortSignal;
};

/**
 * Neutral hook consumed by agentLoop. Implementations own persistence and any LLM calls used to
 * build memories/summaries. agentLoop deliberately does not know about research storage.
 */
export type ContextManager = {
  prepare(input: ContextPreparation): Promise<ChatMessage[]>;
  recordMainPromptUsage?(input: ContextPreparation & { promptTokens?: number }): Promise<void>;
};

export type PreparedContext = {
  messages: ChatMessage[];
  level: 'none' | 'micro' | 'summary';
  estimatedTokens: number;
  canonicalTokens: number;
  memoryDue: boolean;
  /** True when an evidence manifest was prepended as the first system message this call. */
  evidenceManifestInjected: boolean;
};

/** Conservative project-wide heuristic agreed for the first version: one character = 0.5 tokens. */
export function estimateTokens(value: unknown): number {
  let serialized: string;
  if (typeof value === 'string') serialized = value;
  else {
    try {
      serialized = JSON.stringify(value) ?? '';
    } catch {
      serialized = String(value);
    }
  }
  return Math.ceil(serialized.length * 0.5);
}

export function estimateContextTokens(messages: ChatMessage[], tools?: unknown[]): number {
  return estimateTokens({ messages, ...(tools?.length ? { tools } : {}) });
}

/** Groups tool messages with the assistant tool-call message that authorizes them. */
export function toLogicalUnits(messages: ChatMessage[]): ContextUnit[] {
  const units: ContextUnit[] = [];
  for (let index = 0; index < messages.length; index += 1) {
    const message = messages[index]!;
    if (message.role === 'assistant' && message.tool_calls?.length) {
      const expected = new Set(message.tool_calls.map((toolCall) => toolCall.id));
      const paired: ChatMessage[] = [message];
      let cursor = index + 1;
      while (cursor < messages.length) {
        const candidate = messages[cursor]!;
        if (candidate.role !== 'tool' || !candidate.tool_call_id || !expected.has(candidate.tool_call_id)) break;
        paired.push(candidate);
        expected.delete(candidate.tool_call_id);
        cursor += 1;
        if (!expected.size) break;
      }
      // Never split an incomplete pair. It belongs to the active request and remains raw.
      if (!expected.size) {
        units.push({ id: `tool:${index}`, messages: paired, kind: 'tool-call' });
        index = cursor - 1;
        continue;
      }
    }
    units.push({ id: `message:${index}`, messages: [message], kind: 'message' });
  }
  return units;
}

/**
 * Applies the agreed threshold policy to canonical messages. Generated summary and session
 * memory are supplied by the research adapter; this package intentionally has no research/db
 * dependency.
 */
export function prepareContext(input: {
  canonicalMessages: ChatMessage[];
  tools?: unknown[];
  state: ContextState;
  summaryContent?: string;
  sessionMemoryContent?: string;
  /** Pre-built evidence manifest string; when non-empty it is prepended as the first system message. */
  evidenceManifestContent?: string;
}): PreparedContext {
  const { canonicalMessages, tools, state, summaryContent, sessionMemoryContent, evidenceManifestContent } = input;
  const manifest = evidenceManifestContent?.trim() ? evidenceManifestContent : undefined;
  const evidenceManifestInjected = Boolean(manifest);
  const canonicalTokens = estimateTokens(canonicalMessages.filter((message) => message.role !== 'system'));
  const directEstimate = estimateContextTokens(canonicalMessages, tools);
  const projected = state.lastPromptTokens === undefined
    ? directEstimate
    : state.lastPromptTokens + Math.max(0, canonicalTokens - (state.lastCanonicalTokens ?? 0));
  // Once a large summary exists, raw audit history is intentionally no longer part of the model
  // view. The last provider usage plus new canonical content is the correct trigger baseline.
  // Crucially, the summary remains the model view even if a later estimate drops below 90%; a
  // lower estimate must never reintroduce the history that was already compressed.
  const hasSummary = Boolean(state.summary && summaryContent);
  const estimatedTokens = hasSummary && state.lastPromptTokens !== undefined
    ? projected
    : Math.max(directEstimate, projected);
  const memoryDue = canonicalTokens - (state.sessionMemoryCheckpointTokens ?? 0) >= SESSION_MEMORY_INTERVAL_TOKENS;

  if (hasSummary) {
    return {
      messages: prependEvidenceManifest(
        injectSessionMemory(
          assembleSummaryView(canonicalMessages, summaryContent!),
          sessionMemoryContent
        ),
        manifest
      ),
      level: 'summary',
      estimatedTokens,
      canonicalTokens,
      memoryDue,
      evidenceManifestInjected
    };
  }

  const history = estimatedTokens >= MICRO_COMPRESSION_TOKENS
    ? applyMicroCompression(canonicalMessages)
    : [...canonicalMessages];
  return {
    messages: prependEvidenceManifest(injectSessionMemory(history, sessionMemoryContent), manifest),
    level: estimatedTokens >= MICRO_COMPRESSION_TOKENS ? 'micro' : 'none',
    estimatedTokens,
    canonicalTokens,
    memoryDue,
    evidenceManifestInjected
  };
}

/** Prepends an evidence-manifest system message at the front of the prepared view. */
function prependEvidenceManifest(messages: ChatMessage[], manifest?: string): ChatMessage[] {
  if (!manifest) return [...messages];
  return [{ role: 'system', content: manifest }, ...messages];
}

/** A large summary reads this exact view: no micro truncation at the 90% threshold. */
export function buildSummarySource(messages: ChatMessage[], sessionMemory?: string): ChatMessage[] {
  return injectSessionMemory(messages, sessionMemory);
}

export function applyMicroCompression(messages: ChatMessage[]): ChatMessage[] {
  const system = messages.filter((message) => message.role === 'system');
  const conversation = messages.filter((message) => message.role !== 'system');
  const units = toLogicalUnits(conversation);
  const protectedUnitIds = new Set(units.slice(-5).map((unit) => unit.id));
  return [
    ...system,
    ...units.flatMap((unit) => unit.messages.map((message) => {
      if (protectedUnitIds.has(unit.id) || message.role !== 'tool') return { ...message };
      return { ...message, content: truncateToolContent(message.content) };
    }))
  ];
}

export function truncateToolContent(content: string): string {
  return content.length > TOOL_RESULT_MICRO_LIMIT_CHARS
    ? `${content.slice(0, TOOL_RESULT_MICRO_LIMIT_CHARS)}\n${TRUNCATED_TOOL_RESULT_MARKER}`
    : content;
}

/** Inserts generated memory after durable system instructions, never as a fake user request. */
export function injectSessionMemory(messages: ChatMessage[], memory?: string): ChatMessage[] {
  if (!memory) return [...messages];
  const firstNonSystem = messages.findIndex((message) => message.role !== 'system');
  const insertionIndex = firstNonSystem === -1 ? messages.length : firstNonSystem;
  return [
    ...messages.slice(0, insertionIndex),
    { role: 'system', content: `<system-message><session-memory>\n${memory}\n</session-memory></system-message>` },
    ...messages.slice(insertionIndex)
  ];
}

/**
 * Large summaries intentionally preserve an original tail: latest five logical units plus the
 * latest three final assistant replies. Dedupe is by the original message object position.
 */
export function assembleSummaryView(messages: ChatMessage[], summary: string): ChatMessage[] {
  const system = messages.filter((message) => message.role === 'system');
  const conversation = messages.filter((message) => message.role !== 'system');
  const units = toLogicalUnits(conversation);
  const tailUnits = units.slice(-5);
  const finalReplies = units.filter((unit) => unit.kind === 'message'
    && unit.messages[0]?.role === 'assistant'
    && !unit.messages[0]?.tool_calls).slice(-3);
  const selected = new Set([...tailUnits, ...finalReplies].map((unit) => unit.id));
  return [
    ...system,
    { role: 'system', content: `<context-summary>\n${summary}\n</context-summary>` },
    ...units.filter((unit) => selected.has(unit.id)).flatMap((unit) => unit.messages.map((message) => ({ ...message })))
  ];
}
