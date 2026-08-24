import type { StreamEventEnvelope } from '@evident-loop/stream-protocol';

import { DEFAULT_MAX_TOOL_ROUNDS } from '../agent/config.js';
import { runAgentLoop, type AgentLoopEvent, type RunAgentLoopOptions } from '../agent/agentLoop.js';
import type { ApprovalManager } from '../approvals/contracts.js';
import { redactToolArguments } from '../approvals/manager.js';
import type { LlmProvider } from '../llm/contracts.js';
import { resolveLlmProvider } from '../llm/provider.js';
import { appendStreamEvent } from '../streaming/eventStore.js';
import { publishStreamEvent, subscribeToStream } from '../streaming/eventHub.js';
import { isExplicitDocumentRequest } from '../tools/wordDocumentTool.js';
import type { ToolPolicy, ToolRuntime } from '../tools/contracts.js';
import { normalizeToolPolicy } from '../tools/policy.js';
import type { OfficialResearchSkill, ResearchSkillSnapshot } from '../skills/contracts.js';
import type { ResearchSkillRuntime } from '../skills/runtime.js';
import { buildResearchContext, createConversationTitle } from '../context/research/history.js';
import { createResearchContextManager } from '../context/research/manager.js';
import { resolveExecutionMode } from './executionMode.js';
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
  listResearchConversations,
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
  ResearchRunInput,
  ResearchSource,
  ResearchStep
} from './types.js';

const DEFAULT_MODEL = 'deepseek-v4-flash';
const STOPPED_MESSAGE = '研究任务已停止，未能生成最终回答。';
const RESTARTED_MESSAGE = '研究服务已重启，先前的后台任务未能继续。请重新发起研究。';
const activeControllers = new Map<string, AbortController>();
const activeApprovalManagers = new Map<string, ApprovalManager>();

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
- search_knowledge already combines semantic and keyword retrieval; use its optional file filter to search within an identified document.
- Use read_document only when search_knowledge snippets are not enough, and read the smallest relevant line range.
- After an empty knowledge search, do not guess a file name or scan documents with read_document.
- For external facts the local knowledge base cannot answer (library comparisons, versions, releases, current events), call retrieve_web_evidence.
- Call retrieve_web_evidence at most once per user request. It already performs query rewriting and progressive search internally; a second call would incorrectly reset the quality budget.
- Treat retrieve_web_evidence.verdict as authoritative: sufficient may support an answer; exhausted may only support a qualified partial answer; empty must not be presented as evidence. Do not simulate lower-level web_search or fetch_page calls.
- When retrieved sources support a claim, cite their provided keys such as [S1].
- Call start_document_generation when the user explicitly asks to generate, export, download, or create a document file (Word, DOCX, PDF report, PPT, PPTX, or slides). Set deliverables from the user request: presentation with formats ["pptx"] for PPT/PPTX/slides/演示文稿, longform with formats ["docx"] for Word, longform with formats ["pdf"] for PDF reports/长篇报告, or both deliverable types only when they asked for both presentation and report. Never default to all formats. If the format is unclear, ask which format they want instead of calling the tool. The runtime binds the current conversation and research-run scope; do not include conversationId or invent a scope argument. It creates an editable draft only; never render a document or claim a file exists before the user confirms the outline.
- If a tool fails, explain the failure based on the tool error instead of pretending it succeeded.
- Stop calling tools once you have enough information to answer.`;

// Quick conversations run a single streaming LLM call with no tools, no agent loop and
// no skill instructions (§6.3). The prompt stays short and never promises tool usage.
const QUICK_SYSTEM_PROMPT = `You are EvidentLoop, a clear and helpful AI assistant.
Answer the user's request directly and accurately.
Do not claim to have searched tools, documents, or the web when no tools were provided.
If current external information is required, explain that the user can enable an appropriate tool.`;

/**
 * Append a trusted skill block to the base prompt. The base prompt's evidence,
 * citation, tool-protocol and failure rules are never replaced (§4.2).
 */
export function composeResearchSystemPrompt(basePrompt: string, skill?: OfficialResearchSkill) {
  if (!skill) return basePrompt;
  return `${basePrompt}\n\n<official_research_skill id="${skill.id}" version="${skill.version}">\n${skill.instructions}\n</official_research_skill>`;
}

export type ResearchRunEvent =
  | { type: 'research_step'; step: ResearchStep }
  | { type: 'tool_call_started'; step: ResearchStep }
  | { type: 'tool_call_completed'; step: ResearchStep }
  | { type: 'tool_approval_requested'; approval: import('../approvals/contracts.js').ToolApprovalDto }
  | { type: 'tool_approval_resolved'; approval: import('../approvals/contracts.js').ToolApprovalDto }
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

type ArtifactDraftCoordinator = {
  flushPendingDrafts: (conversationId: string, researchRunId?: string) => Promise<unknown>;
  listDraftRequests: (conversationId: string, researchRunId?: string) => Array<{
    conversationId: string;
    researchRunId?: string;
    status: string;
  }>;
  finalizePendingDrafts?: (
    conversationId: string,
    status: 'failed' | 'cancelled',
    researchRunId?: string,
    error?: string
  ) => unknown;
};

export function createAndStartResearchRun(options: {
  conversationId: string;
  content: string;
  toolPolicy: ToolPolicy;
  toolRuntime: ToolRuntime;
  skill?: ResearchSkillSnapshot;
  skillRuntime?: ResearchSkillRuntime;
  apiKey?: string;
  llm?: LlmProvider;
  model?: string;
  runAgent?: ResearchAgentRunner;
  approvalManager?: ApprovalManager;
  schedule?: (callback: () => void) => void;
  artifactDraftCoordinator?: ArtifactDraftCoordinator;
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
    options.content,
    listResearchSteps(conversation.id)
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
  const toolPolicy = normalizeToolPolicy(options.toolPolicy);
  const run = createResearchRun({
    conversationId: conversation.id,
    userMessageId: userMessage.id,
    assistantMessageId: assistantMessage.id,
    runInput: {
      content: options.content,
      contextMessages,
      promptPreview,
      toolPolicy,
      ...(options.skill ? { skill: options.skill } : {}),
      executionMode: resolveExecutionMode(options.skill, toolPolicy)
    }
  });

  const schedule = options.schedule ?? ((callback: () => void) => setImmediate(callback));
  schedule(() => {
    void executePersistedResearchRun({
      runId: run.id,
      apiKey: options.apiKey,
      llm: options.llm,
      model: options.model ?? DEFAULT_MODEL,
      runAgent: options.runAgent ?? runAgentLoop,
      toolRuntime: options.toolRuntime,
      skillRuntime: options.skillRuntime,
      approvalManager: options.approvalManager,
      artifactDraftCoordinator: options.artifactDraftCoordinator
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

export function getResearchRunSnapshot(id: string, approvalManager?: ApprovalManager): {
  run: ResearchRun;
  detail: ResearchConversationDetail;
} | undefined {
  const run = getResearchRun(id);
  if (!run) return undefined;
  const conversation = getResearchConversation(run.conversationId);
  if (!conversation) return undefined;
  const runInput = getResearchRunInput(id);
  const promptPreview = runInput?.promptPreview
    ?? buildResearchContext(conversation, listResearchMessages(conversation.id), '', listResearchSteps(conversation.id)).promptPreview;
  const detail = getResearchConversationDetail(conversation.id, promptPreview);
  if (!detail) return undefined;
  const approvals = approvalManager?.list({ type: 'research_run', id });
  return {
    run,
    detail: approvals ? { ...detail, approvals } : detail
  };
}

export function cancelResearchRun(id: string) {
  const run = getResearchRun(id);
  if (!run) return undefined;
  if (isTerminal(run.status)) return run;

  activeControllers.get(id)?.abort(new Error('Research task was explicitly stopped'));
  // Abort listeners on the approval interceptor also cancel the row. This
  // explicit call covers a queued/just-created approval before its waiter is
  // attached and keeps cancellation durable.
  activeApprovalManagers.get(id)?.cancelScope({ type: 'research_run', id });
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

export function failOrphanedResearchRuns(artifactDraftCoordinator?: ArtifactDraftCoordinator) {
  for (const run of listUnfinishedResearchRuns()) {
    updateResearchMessage(run.assistantMessageId, {
      content: RESTARTED_MESSAGE,
      status: 'error'
    });
    failRunningSteps(run, RESTARTED_MESSAGE);
    const failed = updateResearchRun(run.id, {
      status: 'failed',
      error: RESTARTED_MESSAGE,
      completedAt: new Date().toISOString()
    });
    if (failed) {
      artifactDraftCoordinator?.finalizePendingDrafts?.(
        run.conversationId,
        'failed',
        run.id,
        RESTARTED_MESSAGE
      );
    }
  }
}

/**
 * Resume only requests whose originating run already reached completed before
 * a backend restart. Queued requests from unfinished runs are finalized by
 * failOrphanedResearchRuns; no request is ever consumed by a later run.
 */
export async function recoverCompletedArtifactDraftRequests(artifactDraftCoordinator: ArtifactDraftCoordinator) {
  for (const conversation of listResearchConversations()) {
    const requests = artifactDraftCoordinator.listDraftRequests(conversation.id)
      .filter((request) => request.status === 'queued' && request.researchRunId);
    for (const request of requests) {
      const run = getResearchRun(request.researchRunId!);
      if (run?.status === 'completed') {
        if (getActiveResearchRun(conversation.id)) {
          artifactDraftCoordinator.finalizePendingDrafts?.(
            conversation.id,
            'failed',
            run.id,
            'A later research run is active; the old deferred artifact request was not replayed'
          );
          continue;
        }
        await artifactDraftCoordinator.flushPendingDrafts(conversation.id, run.id);
      } else if (run?.status === 'failed' || run?.status === 'cancelled') {
        artifactDraftCoordinator.finalizePendingDrafts?.(
          conversation.id,
          run.status,
          run.id,
          run.error ?? `Research run ${run.status}`
        );
      }
    }
  }
}

async function executePersistedResearchRun(options: {
  runId: string;
  apiKey?: string;
  llm?: LlmProvider;
  model: string;
  runAgent: ResearchAgentRunner;
  toolRuntime: ToolRuntime;
  skillRuntime?: ResearchSkillRuntime;
  approvalManager?: ApprovalManager;
  artifactDraftCoordinator?: ArtifactDraftCoordinator;
}) {
  let run = getResearchRun(options.runId);
  const runInput = getResearchRunInput(options.runId);
  if (!run || !runInput || run.status !== 'queued') return;
  const storedInput = runInput as typeof runInput & { allowedToolNames?: string[] };
  const toolPolicy = normalizeToolPolicy(storedInput.toolPolicy ?? storedInput.allowedToolNames);
  // Runs created before executionMode existed are interpreted as 'research' (§6.1); we never
  // re-derive an old run's mode from today's rules.
  const executionMode = runInput.executionMode ?? 'research';

  const abortController = new AbortController();
  activeControllers.set(run.id, abortController);
  if (options.approvalManager) activeApprovalManagers.set(run.id, options.approvalManager);
  run = updateResearchRun(run.id, { status: 'running', startedAt: new Date().toISOString() }) ?? run;
  emit(run.id, { type: 'run_updated', run });

  if (executionMode === 'quick') {
    await runQuickConversation({ run, runInput, llm: options.llm, model: options.model, abortController });
    activeApprovalManagers.delete(run.id);
    return;
  }

  const activeToolSteps = new Map<string, ResearchStep>();
  const pendingLlmSteps: ResearchStep[] = [];
  const toolParentStepIds = new Map<string, string>();
  const contextManager = options.llm || options.apiKey
    ? createResearchContextManager({
        conversationId: run.conversationId,
        llm: resolveLlmProvider({ llm: options.llm, apiKey: options.apiKey }),
        model: options.model
      })
    : undefined;

  try {
    // Resolve the exact skill version and verify its digest inside the protected
    // lifecycle so a missing version or digest mismatch fails the persisted run.
    const resolvedSkill = runInput.skill && options.skillRuntime
      ? options.skillRuntime.resolveSnapshot(runInput.skill)
      : undefined;
    const systemPrompt = composeResearchSystemPrompt(AGENT_SYSTEM_PROMPT, resolvedSkill?.definition);
    let sequence = listResearchSteps(run.conversationId)
      .filter((step) => step.messageId === run!.assistantMessageId)
      .reduce((maximum, step) => Math.max(maximum, step.sequence), 0);
    const existingSources = listResearchSources(run.conversationId)
      .filter((source) => source.messageId === run!.assistantMessageId);
    let citationNumber = existingSources.length;
    const sourceIds = new Set(existingSources.map((source) => source.id));
    const researchSources = [...existingSources];

    const result = await options.runAgent({
      apiKey: options.apiKey,
      llm: options.llm,
      message: runInput.content,
      contextMessages: runInput.contextMessages,
      model: options.model,
      systemPrompt,
      maxToolRounds: DEFAULT_MAX_TOOL_ROUNDS,
      contextManager,
      toolPolicy,
      toolRuntime: options.toolRuntime,
      requiredToolName: isExplicitDocumentRequest(runInput.content)
        ? 'start_document_generation'
        : undefined,
      signal: abortController.signal,
      conversationId: run.conversationId,
      toolScope: { kind: 'research', runId: run.id, conversationId: run.conversationId },
      approvalManager: options.approvalManager,
      approvalScope: { type: 'research_run', id: run.id },
      onEvent: async (event) => handleAgentEvent({
        event,
        run: run!,
        skillSnapshot: resolvedSkill?.snapshot,
        activeToolSteps,
        pendingLlmSteps,
        toolParentStepIds,
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
      runInput.content,
      listResearchSteps(run.conversationId)
    ).promptPreview;
    const completedRun = updateResearchRun(run.id, {
      status: 'completed',
      completedAt: new Date().toISOString()
    });
    if (!completedRun) throw new Error('Research task could not be completed');
    // The artifact tool may have been requested during this run. Create its
    // plan only after the streaming assistant message is complete so the
    // frozen snapshot and its later stale check observe the same boundary.
    await options.artifactDraftCoordinator?.flushPendingDrafts(run.conversationId, run.id);
    emit(run.id, {
      type: 'research_message_completed',
      message: completedMessage,
      sources: researchSources,
      promptPreview,
      run: completedRun
    });
    emit(run.id, { type: 'run_updated', run: completedRun });
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
    if (failedRun) {
      options.artifactDraftCoordinator?.finalizePendingDrafts?.(
        run.conversationId,
        'failed',
        run.id,
        message
      );
    }
    if (failedRun) emit(run.id, { type: 'error', message, assistantMessage: failedMessage, run: failedRun });
  } finally {
    activeControllers.delete(run.id);
    activeApprovalManagers.delete(run.id);
  }
}

/**
 * Quick conversation branch (§6.2): a single streaming LLM call with no tools, no skill
 * instructions and no research steps or sources. It reuses the Research Run lifecycle and
 * SSE events (assistant_delta / research_message_completed / run_updated / done) so the
 * frontend renders it through the same pipeline as a research run.
 */
async function runQuickConversation(options: {
  run: ResearchRun;
  runInput: ResearchRunInput;
  llm?: LlmProvider;
  model: string;
  abortController: AbortController;
}) {
  const { run, runInput, abortController } = options;
  try {
    if (!options.llm) throw new Error('LLM provider is not configured');

    let reply = '';
    await options.llm.stream(
      {
        model: options.model,
        messages: [
          { role: 'system', content: QUICK_SYSTEM_PROMPT },
          ...runInput.contextMessages,
          { role: 'user', content: runInput.content }
        ],
        signal: abortController.signal
      },
      (delta) => {
        if (!delta.content) return;
        reply += delta.content;
        emit(run.id, { type: 'assistant_delta', messageId: run.assistantMessageId, content: delta.content });
      }
    );

    if (getResearchRun(run.id)?.status === 'cancelled') return;
    const completedMessage = updateResearchMessage(run.assistantMessageId, { content: reply, status: 'complete' });
    if (!completedMessage) throw new Error('Research assistant message could not be completed');

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
      sources: [],
      promptPreview,
      run: completedRun
    });
    emit(run.id, { type: 'run_updated', run: completedRun });
    emit(run.id, { type: 'done', run: completedRun });
  } catch (error) {
    if (getResearchRun(run.id)?.status === 'cancelled') return;
    const message = getResearchFailureMessage(error);
    const failedMessage = updateResearchMessage(run.assistantMessageId, { content: message, status: 'error' });
    const failedRun = updateResearchRun(run.id, {
      status: 'failed',
      error: message,
      completedAt: new Date().toISOString()
    });
    if (failedRun) emit(run.id, { type: 'error', message, assistantMessage: failedMessage, run: failedRun });
  } finally {
    activeControllers.delete(run.id);
    activeApprovalManagers.delete(run.id);
  }
}

async function handleAgentEvent(options: {
  event: AgentLoopEvent;
  run: ResearchRun;
  skillSnapshot?: ResearchSkillSnapshot;
  activeToolSteps: Map<string, ResearchStep>;
  pendingLlmSteps: ResearchStep[];
  toolParentStepIds: Map<string, string>;
  researchSources: ResearchSource[];
  sourceIds: Set<string>;
  nextSequence: () => number;
  nextCitation: () => string;
}) {
  const { event, run } = options;
  // A cancellation may settle an approval on the next microtask after the run
  // status is persisted. Keep the terminal approval resolution durable even
  // though ordinary agent/tool events are no longer accepted for the run.
  if (getResearchRun(run.id)?.status === 'cancelled' && event.type !== 'tool_approval_resolved') return;

  if (event.type === 'llm') {
    const step = createResearchStep({
      conversationId: run.conversationId,
      messageId: run.assistantMessageId,
      sequence: options.nextSequence(),
      type: 'llm',
      status: 'running',
      title: event.title,
      input: {
        model: event.model,
        tools: event.tools,
        ...(options.skillSnapshot ? { skill: options.skillSnapshot } : {})
      }
    });
    options.pendingLlmSteps.push(step);
    emit(run.id, { type: 'research_step', step });
    return;
  }

  if (event.type === 'llm_response') {
    const activeStep = options.pendingLlmSteps.shift();
    if (!activeStep) return;
    const step = updateResearchStep(activeStep.id, {
      status: 'complete',
      output: event.assistantMessage,
      error: undefined
    });
    for (const toolCall of event.assistantMessage.tool_calls ?? []) {
      options.toolParentStepIds.set(toolCall.id, activeStep.id);
    }
    if (step) emit(run.id, { type: 'research_step', step });
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
       input: redactToolArguments(event.toolCall.arguments),
      parentStepId: options.toolParentStepIds.get(event.toolCall.id),
      toolCallId: event.toolCall.id
    });
    options.activeToolSteps.set(event.toolCall.id, step);
    emit(run.id, { type: 'research_step', step });
    emit(run.id, { type: 'tool_call_started', step });
    return;
  }

  if (event.type === 'tool_approval_requested' || event.type === 'tool_approval_resolved') {
    emit(run.id, { type: event.type, approval: event.approval });
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
    options.toolParentStepIds.delete(event.toolCall.id);
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
