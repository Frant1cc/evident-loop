import type { Response } from 'express';
import { Router } from 'express';

import { runAgentLoop } from '../agent/agentLoop.js';
import { getToolDefinitions } from '../tools/definitions.js';
import { toolRegistry } from '../tools/registry.js';
import { isExplicitWordDocumentRequest } from '../tools/wordDocumentTool.js';
import { failure, success } from '../response.js';
import { buildResearchContext, createConversationTitle } from '../research/context.js';
import {
  addResearchSource,
  createResearchConversation,
  createResearchMessage,
  createResearchNote,
  createResearchStep,
  deleteResearchConversation,
  deleteResearchNote,
  getResearchConversation,
  getResearchConversationDetail,
  listResearchConversations,
  listResearchMessages,
  updateResearchConversation,
  updateResearchMessage,
  updateResearchNote,
  updateResearchStep
} from '../research/store.js';
import type { ResearchPromptPreview, ResearchSource, ResearchStep } from '../research/types.js';

const DEFAULT_MODEL = 'deepseek-v4-flash';
const MAX_TOOL_ROUNDS = 4;
const DEFAULT_RESEARCH_TIMEOUT_MS = 90_000;
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
- For external facts the local knowledge base cannot answer (library comparisons, versions, releases, current events), call web_search.
- web_search snippets are often enough; call fetch_page only for results worth reading in depth, and always pass a focused query so long pages return the relevant parts.
- When retrieved sources support a claim, cite their provided keys such as [S1].
- Call generate_word_document only when the user explicitly asks to generate, export, download, or create a Word/DOCX file. Ordinary requests to summarize, analyze, or write content should remain normal chat replies.
- For generate_word_document, always put the complete body in contentMarkdown. Never construct a blocks array. Use <!-- pagebreak --> for explicit page breaks.
- When generate_word_document succeeds, call it only once. The client renders the document card from the structured tool result, so do not include downloadUrl, previewUrl, localhost URLs, Markdown download links, or redundant download instructions in the final answer. Give only a concise content summary when useful.
- If a tool fails, explain the failure based on the tool error instead of pretending it succeeded.
- Stop calling tools once you have enough information to answer.`;

export const researchRouter = Router();

researchRouter.get('/research/tools', (_req, res) => {
  res.json(
    success({
      tools: Object.values(toolRegistry).map((tool) => ({
        name: tool.definition.function.name,
        label: tool.label,
        description: tool.definition.function.description
      }))
    })
  );
});

researchRouter.get('/research/conversations', (_req, res) => {
  res.json(success({ conversations: listResearchConversations() }));
});

researchRouter.post('/research/conversations', (_req, res) => {
  res.status(201).json(success({ conversation: createResearchConversation() }));
});

researchRouter.get('/research/conversations/:conversationId', (req, res) => {
  const conversation = getResearchConversation(req.params.conversationId);
  if (!conversation) {
    res.status(404).json(failure('Research conversation not found'));
    return;
  }

  const { promptPreview } = buildResearchContext(conversation, listResearchMessages(conversation.id), '');
  res.json(success(getResearchConversationDetail(conversation.id, promptPreview)));
});

researchRouter.delete('/research/conversations/:conversationId', (req, res) => {
  if (!deleteResearchConversation(req.params.conversationId)) {
    res.status(404).json(failure('Research conversation not found'));
    return;
  }

  res.json(success({ deleted: true }));
});

researchRouter.post('/research/conversations/:conversationId/notes', (req, res) => {
  const conversationId = req.params.conversationId;
  if (!getResearchConversation(conversationId)) {
    res.status(404).json(failure('Research conversation not found'));
    return;
  }

  const content = String(req.body?.content ?? '').trim();
  if (!content) {
    res.status(400).json(failure('content is required'));
    return;
  }

  res.status(201).json(success({ note: createResearchNote(conversationId, content) }));
});

researchRouter.put('/research/notes/:noteId', (req, res) => {
  const content = String(req.body?.content ?? '').trim();
  if (!content) {
    res.status(400).json(failure('content is required'));
    return;
  }

  const note = updateResearchNote(req.params.noteId, content);
  if (!note) {
    res.status(404).json(failure('Research note not found'));
    return;
  }

  res.json(success({ note }));
});

researchRouter.delete('/research/notes/:noteId', (req, res) => {
  if (!deleteResearchNote(req.params.noteId)) {
    res.status(404).json(failure('Research note not found'));
    return;
  }

  res.json(success({ deleted: true }));
});

researchRouter.post('/research/conversations/:conversationId/messages/stream', async (req, res) => {
  const apiKey = process.env.DEEPSEEK_API_KEY;
  if (!apiKey) {
    res.status(500).json(failure('DEEPSEEK_API_KEY is not configured'));
    return;
  }

  const conversationId = req.params.conversationId;
  let conversation = getResearchConversation(conversationId);
  if (!conversation) {
    res.status(404).json(failure('Research conversation not found'));
    return;
  }

  const content = String(req.body?.content ?? '').trim();
  if (!content) {
    res.status(400).json(failure('content is required'));
    return;
  }

  // undefined = all tools; an explicit array (even empty) restricts the loop to exactly those tools.
  const allowedToolsRaw = req.body?.allowedTools;
  let allowedToolNames: string[] | undefined;
  if (Array.isArray(allowedToolsRaw)) {
    const registered = new Set(getToolDefinitions().map((tool) => tool.function.name));
    allowedToolNames = allowedToolsRaw.filter(
      (name): name is string => typeof name === 'string' && registered.has(name)
    );
  }

  if (conversation.title === '新研究') {
    conversation = updateResearchConversation(conversationId, {
      title: createConversationTitle(content),
      topic: content,
      summary: conversation.summary
    }) ?? conversation;
  }

  const priorMessages = listResearchMessages(conversationId);
  const { messages: contextMessages, promptPreview } = buildResearchContext(conversation, priorMessages, content);
  const userMessage = createResearchMessage({ conversationId, role: 'user', content, status: 'complete' });
  const assistantMessage = createResearchMessage({ conversationId, role: 'assistant', content: '', status: 'streaming' });

  prepareSse(res);
  sendEvent(res, 'research_message_started', { message: assistantMessage, userMessage });

  const abortController = new AbortController();
  let completed = false;
  const abortRequest = () => abortController.abort(new Error('Research request was cancelled'));
  req.once('aborted', abortRequest);
  res.once('close', () => {
    if (!completed) abortRequest();
  });
  const timeout = setTimeout(() => abortController.abort(new Error('Research request timed out')), getResearchTimeoutMs());

  let sequence = 0;
  let citationNumber = 0;
  const sourceIds = new Set<string>();
  const researchSources: ResearchSource[] = [];
  const activeToolSteps = new Map<string, ResearchStep>();
  let latestPromptPreview: ResearchPromptPreview = promptPreview;

  try {
    const result = await runAgentLoop({
      apiKey,
      message: content,
      contextMessages,
      model: process.env.DEEPSEEK_MODEL ?? DEFAULT_MODEL,
      systemPrompt: AGENT_SYSTEM_PROMPT,
      maxToolRounds: MAX_TOOL_ROUNDS,
      allowedToolNames,
      requiredToolName: isExplicitWordDocumentRequest(content)
        ? 'generate_word_document'
        : undefined,
      signal: abortController.signal,
      onEvent: async (event) => {
        if (abortController.signal.aborted || res.writableEnded) return;
        if (event.type === 'llm') {
          const step = createResearchStep({
            conversationId,
            messageId: assistantMessage.id,
            sequence: ++sequence,
            type: 'llm',
            status: 'complete',
            title: event.title,
            input: { model: event.model, tools: event.tools }
          });
          sendEvent(res, 'research_step', { step });
          return;
        }

        if (event.type === 'tool_started') {
          const step = createResearchStep({
            conversationId,
            messageId: assistantMessage.id,
            sequence: ++sequence,
            type: 'tool',
            status: 'running',
            title: event.toolCall.name,
            input: event.toolCall.arguments
          });
          activeToolSteps.set(event.toolCall.id, step);
          sendEvent(res, 'research_step', { step });
          sendEvent(res, 'tool_call_started', { step });
          return;
        }

        if (event.type === 'tool_completed') {
          const activeStep = activeToolSteps.get(event.toolCall.id);
          if (!activeStep) return;
          const step = updateResearchStep(activeStep.id, {
            status: event.toolCall.error ? 'error' : 'complete',
            output: event.toolCall.error ? undefined : event.toolCall.result,
            error: event.toolCall.error
          });
          activeToolSteps.delete(event.toolCall.id);
          if (step) {
            sendEvent(res, 'research_step', { step });
            sendEvent(res, 'tool_call_completed', { step });
          }
          return;
        }

        if (!sourceIds.has(event.source.id)) {
          sourceIds.add(event.source.id);
          const source = addResearchSource(assistantMessage.id, event.source, `S${++citationNumber}`);
          researchSources.push(source);
          sendEvent(res, 'research_source_found', { messageId: assistantMessage.id, source });
        }
      }
    });

    const replyWithCitations = appendMissingCitations(result.reply, researchSources);
    const completedMessage = updateResearchMessage(assistantMessage.id, { content: replyWithCitations, status: 'complete' });
    if (!completedMessage) throw new Error('Research assistant message could not be completed');
    sendEvent(res, 'assistant_delta', { messageId: completedMessage.id, content: replyWithCitations });

    const updatedConversation = getResearchConversation(conversationId) ?? conversation;
    latestPromptPreview = buildResearchContext(updatedConversation, listResearchMessages(conversationId), content).promptPreview;
    sendEvent(res, 'research_message_completed', {
      message: completedMessage,
      sources: researchSources,
      promptPreview: latestPromptPreview
    });
    sendEvent(res, 'done', {});
    completed = true;
    res.end();
  } catch (error) {
    const message = getResearchFailureMessage(error, abortController.signal);
    const failedMessage = updateResearchMessage(assistantMessage.id, { content: message, status: 'error' });

    for (const activeStep of activeToolSteps.values()) {
      const step = updateResearchStep(activeStep.id, { status: 'error', output: undefined, error: message });
      if (step && !res.writableEnded) sendEvent(res, 'research_step', { step });
    }

    if (!res.writableEnded) {
      sendEvent(res, 'error', { message, assistantMessage: failedMessage });
      completed = true;
      res.end();
    }
  } finally {
    clearTimeout(timeout);
    req.off('aborted', abortRequest);
  }
});

function getResearchTimeoutMs() {
  const configured = Number(process.env.RESEARCH_TIMEOUT_MS);
  return Number.isFinite(configured) && configured >= 5_000 ? configured : DEFAULT_RESEARCH_TIMEOUT_MS;
}

function getResearchFailureMessage(error: unknown, signal: AbortSignal) {
  const reason = signal.reason instanceof Error ? signal.reason.message : '';
  if (reason.includes('timed out')) return '研究任务超时，已停止继续调用。请缩小问题范围后重试。';
  if (signal.aborted) return '研究任务已取消，未能生成最终回答。';
  return error instanceof Error ? `研究任务失败：${error.message}` : '研究任务失败，请稍后重试。';
}

function appendMissingCitations(reply: string, sources: ResearchSource[]) {
  if (!sources.length) return reply;
  const missing = sources.filter((source) => !reply.includes(`[${source.citationKey}]`));
  if (!missing.length) return reply;
  return `${reply}\n\n参考来源：${missing.map((source) => `[${source.citationKey}]`).join(' ')}`;
}

function prepareSse(res: Response) {
  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();
}

function sendEvent(res: Response, event: string, data: unknown) {
  res.write(`event: ${event}\n`);
  res.write(`data: ${JSON.stringify(data)}\n\n`);
}
