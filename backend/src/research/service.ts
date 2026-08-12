import type { StreamEventEnvelope } from '@evident-loop/stream-protocol';

import { DEFAULT_MAX_TOOL_ROUNDS } from '../agent/config.js';
import { runAgentLoop, type AgentLoopEvent, type RunAgentLoopOptions } from '../agent/agentLoop.js';
import type { LlmProvider } from '../llm/contracts.js';
import { appendStreamEvent } from '../streaming/eventStore.js';
import { publishStreamEvent, subscribeToStream } from '../streaming/eventHub.js';
import { isExplicitWordDocumentRequest } from '../tools/wordDocumentTool.js';
import { buildResearchContext, createConversationTitle } from './context.js';
import {
  addResearchSource,
  createResearchMessage,
  createResearchRun,
  createResearchStep,
  getActiveResearchRun,
  getResearchConversation,
  getResearchConversationDetail,
  getResearchRun,
  getResearchRunInput,
  listResearchMessages,
  listResearchSources,
  listResearchSteps,
  listUnfinishedResearchRuns,
  updateResearchConversation,
  updateResearchMessage,
  updateResearchRun,
  updateResearchStep
} from './store.js';
import type {
  ResearchConversationDetail,
  ResearchMessage,
  ResearchPromptPreview,
  ResearchRun,
  ResearchSource,
  ResearchStep
} from './types.js';

const DEFAULT_MODEL = 'deepseek-v4-flash';
const STOPPED_MESSAGE = '研究任务已停止，未能生成最终回答。';
const RESTARTED_MESSAGE = '研究服务已重启，先前的后台任务未能继续。请重新发起研究。';
const activeControllers = new Map<string, AbortController>();

const AGENT_SYSTEM_PROMPT = `You are EvidentLoop, an evidence-first durable research agent.

Use tools when they help answer with real local project data.

Rules:
- Only use tools listed in the provided tools array.
- Do not write or simulate tool calls in normal text.
- For knowledge base or documentation questions, call search_knowledge first.
- Treat search_knowledge.verdict as authoritative retrieval confidence:
  - sufficient: use the returned sources as evidence.
  - weak: if rewriteTriggered=true, the automatic rewrite budget is already exhausted; do not search the same intent again and state the evidence limitation. If rewriteTriggered=false, reformulate once with more specific terminology.
  - empty: do not use or cite the returned candidates as evidence; state that the local knowledge base does not cover the question.
- Use read_document only when search_knowledge snippets are not enough.
- Use search_docs only to locate text in a document already identified by a sufficient or weak retrieval; do not use it to override an empty verdict.
- For external facts the local knowledge base cannot answer (library comparisons, versions, releases, current events), call retrieve_web_evidence.
- Call retrieve_web_evidence at most once per user request. It already performs query rewriting and progressive search internally; a second call would incorrectly reset the quality budget.
- Treat retrieve_web_evidence.verdict as authoritative: sufficient may support an answer; exhausted may only support a qualified partial answer; empty must not be presented as evidence. Do not simulate lower-level web_search or fetch_page calls.
- When retrieved sources support a claim, cite their provided keys such as [S1].
- Call generate_word_document only when the user explicitly asks to generate, export, download, or create a Word/DOCX file. Ordinary requests to summarize, analyze, or write content should remain normal chat replies.
- For generate_word_document, always put the complete body in contentMarkdown. Never construct a blocks array. Use <!-- pagebreak --> for explicit page breaks.
- When generate_word_document succeeds, call it only once. The client renders the document card from the structured tool result, so do not include downloadUrl, previewUrl, localhost URLs, Markdown download links, or redundant download instructions in the final answer. Give only a concise content summary when useful.
- If a tool fails, explain the failure based on the tool error instead of pretending it succeeded.
- Stop calling tools once you have enough information to answer.`;

export type ResearchRunEvent =
  | { type: 'research_step'; step: ResearchStep }
  | { type: 'tool_call_started'; step: ResearchStep }
  | { type: 'tool_call_completed'; step: ResearchStep }
  | { type: 'research_source_found'; messageId: string; source: ResearchSource }
  | { type: 'assistant_delta'; messageId: string; content: string }
  | {
      type: 'research_message_completed';
      message: ResearchMessage;
      sources: ResearchSource[];
      promptPreview: ResearchPromptPreview;
      run: ResearchRun;
    }
  | { type: 'run_updated'; run: ResearchRun }
  | { type: 'error'; message: string; assistantMessage?: ResearchMessage; run: ResearchRun }
  | { type: 'done'; run: ResearchRun };

type ResearchAgentRunner = (options: RunAgentLoopOptions) => ReturnType<typeof runAgentLoop>;

export function createAndStartResearchRun(options: {
  conversationId: string;
  content: string;
  allowedToolNames?: string[];
  apiKey?: string;
  llm?: LlmProvider;
  model?: string;
  runAgent?: ResearchAgentRunner;
  schedule?: (callback: () => void) => void;
}) {
  let conversation = getResearchConversation(options.conversationId);
  if (!conversation) throw new Error('Research conversation not found');
  if (getActiveResearchRun(conversation.id)) throw new Error('A research task is already running in this conversation');

  if (conversation.title === '新研究') {
    conversation = updateResearchConversation(conversation.id, {
      title: createConversationTitle(options.content),
      topic: options.content,
      summary: conversation.summary
    }) ?? conversation;
  }

  const priorMessages = listResearchMessages(conversation.id);
  const { messages: contextMessages, promptPreview } = buildResearchContext(
    conversation,
    priorMessages,
    options.content
  );
  const userMessage = createResearchMessage({
    conversationId: conversation.id,
    role: 'user',
    content: options.content,
    status: 'complete'
  });
  const assistantMessage = createResearchMessage({
    conversationId: conversation.id,
    role: 'assistant',
    content: '',
    status: 'streaming'
  });
  const run = createResearchRun({
    conversationId: conversation.id,
    userMessageId: userMessage.id,
    assistantMessageId: assistantMessage.id,
    runInput: {
      content: options.content,
      contextMessages,
      promptPreview,
      allowedToolNames: options.allowedToolNames
    }
  });

  const schedule = options.schedule ?? ((callback: () => void) => setImmediate(callback));
  schedule(() => {
    void executePersistedResearchRun({
      runId: run.id,
      apiKey: options.apiKey,
      llm: options.llm,
      model: options.model ?? DEFAULT_MODEL,
      runAgent: options.runAgent ?? runAgentLoop
    });
  });

  return { run, userMessage, assistantMessage, promptPreview };
}

export function subscribeToResearchRun(
  id: string,
  listener: (envelope: StreamEventEnvelope<string, ResearchRunEvent>) => void
) {
  return subscribeToStream(id, listener as (envelope: StreamEventEnvelope) => void);
}

export function getResearchRunSnapshot(id: string): {
  run: ResearchRun;
  detail: ResearchConversationDetail;
} | undefined {
  const run = getResearchRun(id);
  if (!run) return undefined;
  const conversation = getResearchConversation(run.conversationId);
  if (!conversation) return undefined;
  const runInput = getResearchRunInput(id);
  const promptPreview = runInput?.promptPreview
    ?? buildResearchContext(conversation, listResearchMessages(conversation.id), '').promptPreview;
  const detail = getResearchConversationDetail(conversation.id, promptPreview);
  return detail ? { run, detail } : undefined;
}

export function cancelResearchRun(id: string) {
  const run = getResearchRun(id);
  if (!run) return undefined;
  if (isTerminal(run.status)) return run;

  activeControllers.get(id)?.abort(new Error('Research task was explicitly stopped'));
  const assistantMessage = updateResearchMessage(run.assistantMessageId, {
    content: STOPPED_MESSAGE,
    status: 'error'
  });
  failRunningSteps(run, STOPPED_MESSAGE);
  const cancelled = updateResearchRun(id, {
    status: 'cancelled',
    error: STOPPED_MESSAGE,
    completedAt: new Date().toISOString()
  });
  if (cancelled) emit(id, { type: 'error', message: STOPPED_MESSAGE, assistantMessage, run: cancelled });
  return cancelled;
}

export function failOrphanedResearchRuns() {
  for (const run of listUnfinishedResearchRuns()) {
    updateResearchMessage(run.assistantMessageId, {
      content: RESTARTED_MESSAGE,
      status: 'error'
    });
    failRunningSteps(run, RESTARTED_MESSAGE);
    updateResearchRun(run.id, {
      status: 'failed',
      error: RESTARTED_MESSAGE,
      completedAt: new Date().toISOString()
    });
  }
}

async function executePersistedResearchRun(options: {
  runId: string;
  apiKey?: string;
  llm?: LlmProvider;
  model: string;
  runAgent: ResearchAgentRunner;
}) {
  let run = getResearchRun(options.runId);
  const runInput = getResearchRunInput(options.runId);
  if (!run || !runInput || run.status !== 'queued') return;

  const abortController = new AbortController();
  activeControllers.set(run.id, abortController);
  run = updateResearchRun(run.id, { status: 'running', startedAt: new Date().toISOString() }) ?? run;
  emit(run.id, { type: 'run_updated', run });

  let sequence = listResearchSteps(run.conversationId)
    .filter((step) => step.messageId === run!.assistantMessageId)
    .reduce((maximum, step) => Math.max(maximum, step.sequence), 0);
  const existingSources = listResearchSources(run.conversationId)
    .filter((source) => source.messageId === run!.assistantMessageId);
  let citationNumber = existingSources.length;
  const sourceIds = new Set(existingSources.map((source) => source.id));
  const researchSources = [...existingSources];
  const activeToolSteps = new Map<string, ResearchStep>();

  try {
    const result = await options.runAgent({
      apiKey: options.apiKey,
      llm: options.llm,
      message: runInput.content,
      contextMessages: runInput.contextMessages,
      model: options.model,
      systemPrompt: AGENT_SYSTEM_PROMPT,
      maxToolRounds: DEFAULT_MAX_TOOL_ROUNDS,
      allowedToolNames: runInput.allowedToolNames,
      requiredToolName: isExplicitWordDocumentRequest(runInput.content)
        ? 'generate_word_document'
        : undefined,
      signal: abortController.signal,
      onEvent: async (event) => handleAgentEvent({
        event,
        run: run!,
        activeToolSteps,
        researchSources,
        sourceIds,
        nextSequence: () => ++sequence,
        nextCitation: () => `S${++citationNumber}`
      })
    });

    if (getResearchRun(run.id)?.status === 'cancelled') return;
    const replyWithCitations = appendMissingCitations(result.reply, researchSources);
    const completedMessage = updateResearchMessage(run.assistantMessageId, {
      content: replyWithCitations,
      status: 'complete'
    });
    if (!completedMessage) throw new Error('Research assistant message could not be completed');
    emit(run.id, { type: 'assistant_delta', messageId: completedMessage.id, content: replyWithCitations });

    const conversation = getResearchConversation(run.conversationId);
    if (!conversation) throw new Error('Research conversation disappeared during execution');
    const promptPreview = buildResearchContext(
      conversation,
      listResearchMessages(run.conversationId),
      runInput.content
    ).promptPreview;
    const completedRun = updateResearchRun(run.id, {
      status: 'completed',
      completedAt: new Date().toISOString()
    });
    if (!completedRun) throw new Error('Research task could not be completed');
    emit(run.id, {
      type: 'research_message_completed',
      message: completedMessage,
      sources: researchSources,
      promptPreview,
      run: completedRun
    });
    emit(run.id, { type: 'done', run: completedRun });
  } catch (error) {
    if (getResearchRun(run.id)?.status === 'cancelled') return;
    const message = getResearchFailureMessage(error);
    const failedMessage = updateResearchMessage(run.assistantMessageId, { content: message, status: 'error' });
    for (const activeStep of activeToolSteps.values()) {
      const step = updateResearchStep(activeStep.id, { status: 'error', output: undefined, error: message });
      if (step) emit(run.id, { type: 'research_step', step });
    }
    const failedRun = updateResearchRun(run.id, {
      status: 'failed',
      error: message,
      completedAt: new Date().toISOString()
    });
    if (failedRun) emit(run.id, { type: 'error', message, assistantMessage: failedMessage, run: failedRun });
  } finally {
    activeControllers.delete(run.id);
  }
}

async function handleAgentEvent(options: {
  event: AgentLoopEvent;
  run: ResearchRun;
  activeToolSteps: Map<string, ResearchStep>;
  researchSources: ResearchSource[];
  sourceIds: Set<string>;
  nextSequence: () => number;
  nextCitation: () => string;
}) {
  const { event, run } = options;
  if (getResearchRun(run.id)?.status === 'cancelled') return;

  if (event.type === 'llm') {
    const step = createResearchStep({
      conversationId: run.conversationId,
      messageId: run.assistantMessageId,
      sequence: options.nextSequence(),
      type: 'llm',
      status: 'complete',
      title: event.title,
      input: { model: event.model, tools: event.tools }
    });
    emit(run.id, { type: 'research_step', step });
    return;
  }

  if (event.type === 'tool_started') {
    const step = createResearchStep({
      conversationId: run.conversationId,
      messageId: run.assistantMessageId,
      sequence: options.nextSequence(),
      type: 'tool',
      status: 'running',
      title: event.toolCall.name,
      input: event.toolCall.arguments
    });
    options.activeToolSteps.set(event.toolCall.id, step);
    emit(run.id, { type: 'research_step', step });
    emit(run.id, { type: 'tool_call_started', step });
    return;
  }

  if (event.type === 'tool_completed') {
    const activeStep = options.activeToolSteps.get(event.toolCall.id);
    if (!activeStep) return;
    const step = updateResearchStep(activeStep.id, {
      status: event.toolCall.error ? 'error' : 'complete',
      output: event.toolCall.error ? undefined : event.toolCall.result,
      error: event.toolCall.error
    });
    options.activeToolSteps.delete(event.toolCall.id);
    if (step) {
      emit(run.id, { type: 'research_step', step });
      emit(run.id, { type: 'tool_call_completed', step });
    }
    return;
  }

  if (!options.sourceIds.has(event.source.id)) {
    options.sourceIds.add(event.source.id);
    const source = addResearchSource(run.assistantMessageId, event.source, options.nextCitation());
    options.researchSources.push(source);
    emit(run.id, { type: 'research_source_found', messageId: run.assistantMessageId, source });
  }
}

function failRunningSteps(run: ResearchRun, message: string) {
  for (const step of listResearchSteps(run.conversationId)) {
    if (step.messageId !== run.assistantMessageId || step.status !== 'running') continue;
    updateResearchStep(step.id, { status: 'error', output: undefined, error: message });
  }
}

function emit(id: string, event: ResearchRunEvent) {
  const envelope = appendStreamEvent(id, event.type, event);
  publishStreamEvent(envelope);
}

function isTerminal(status: ResearchRun['status']) {
  return status === 'completed' || status === 'failed' || status === 'cancelled';
}

function getResearchFailureMessage(error: unknown) {
  return error instanceof Error ? `研究任务失败：${error.message}` : '研究任务失败，请稍后重试。';
}

function appendMissingCitations(reply: string, sources: ResearchSource[]) {
  if (!sources.length) return reply;
  const missing = sources.filter((source) => !reply.includes(`[${source.citationKey}]`));
  if (!missing.length) return reply;
  return `${reply}\n\n参考来源：${missing.map((source) => `[${source.citationKey}]`).join(' ')}`;
}
