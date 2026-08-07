import type { Response } from 'express';
import { Router } from 'express';

import { getToolDefinitions } from '../tools/definitions.js';
import { toolRegistry } from '../tools/registry.js';
import { failure, success } from '../response.js';
import { buildResearchContext } from '../research/context.js';
import {
  cancelResearchRun,
  createAndStartResearchRun,
  getResearchRunSnapshot,
  subscribeToResearchRun,
  type ResearchRunEvent
} from '../research/service.js';
import {
  createResearchConversation,
  createResearchNote,
  deleteResearchConversation,
  deleteResearchNote,
  getActiveResearchRun,
  getResearchConversation,
  getResearchConversationDetail,
  getResearchRun,
  listResearchConversations,
  listResearchMessages,
  updateResearchNote
} from '../research/store.js';
import type { ResearchRunStatus } from '../research/types.js';

export const researchRouter = Router();

researchRouter.get('/research/tools', (_req, res) => {
  res.json(
    success({
      tools: Object.values(toolRegistry).filter((tool) => tool.exposedToModel !== false).map((tool) => ({
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
  if (getActiveResearchRun(req.params.conversationId)) {
    res.status(409).json(failure('Stop the active research task before deleting this conversation'));
    return;
  }
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

researchRouter.post('/research/conversations/:conversationId/messages', (req, res) => {
  const apiKey = process.env.DEEPSEEK_API_KEY;
  if (!apiKey) {
    res.status(500).json(failure('DEEPSEEK_API_KEY is not configured'));
    return;
  }

  const content = String(req.body?.content ?? '').trim();
  if (!content) {
    res.status(400).json(failure('content is required'));
    return;
  }

  try {
    const started = createAndStartResearchRun({
      conversationId: req.params.conversationId,
      content,
      allowedToolNames: parseAllowedToolNames(req.body?.allowedTools),
      apiKey,
      model: process.env.DEEPSEEK_MODEL
    });
    res.status(202).json(success(started, 'Research task queued'));
  } catch (error) {
    const message = getErrorMessage(error);
    res.status(message === 'Research conversation not found' ? 404 : 409).json(failure(message));
  }
});

researchRouter.get('/research/runs/:runId/events', (req, res) => {
  const initial = getResearchRunSnapshot(req.params.runId);
  if (!initial) {
    res.status(404).json(failure('Research task not found'));
    return;
  }

  prepareSse(res);
  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    clearInterval(heartbeat);
    unsubscribe();
    if (!res.writableEnded) res.end();
  };
  const unsubscribe = subscribeToResearchRun(initial.run.id, (event) => {
    sendEvent(res, event.type, event);
    if (event.type === 'done' || event.type === 'error') close();
  });
  const heartbeat = setInterval(() => res.write(': heartbeat\n\n'), 15_000);

  sendEvent(res, 'snapshot', initial);
  if (isTerminal(initial.run.status)) close();
  req.on('close', close);
});

researchRouter.post('/research/runs/:runId/cancel', (req, res) => {
  const current = getResearchRun(req.params.runId);
  if (!current) {
    res.status(404).json(failure('Research task not found'));
    return;
  }
  const run = cancelResearchRun(current.id);
  res.json(success({ run }, run?.status === 'cancelled' ? 'Research task stopped' : 'Research task already finished'));
});

function parseAllowedToolNames(value: unknown) {
  if (!Array.isArray(value)) return undefined;
  const registered = new Set(getToolDefinitions().map((tool) => tool.function.name));
  return value.filter((name): name is string => typeof name === 'string' && registered.has(name));
}

function isTerminal(status: ResearchRunStatus) {
  return status === 'completed' || status === 'failed' || status === 'cancelled';
}

function prepareSse(res: Response) {
  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();
}

function sendEvent(res: Response, event: string, data: ResearchRunEvent | NonNullable<ReturnType<typeof getResearchRunSnapshot>>) {
  if (res.writableEnded) return;
  res.write(`event: ${event}\n`);
  res.write(`data: ${JSON.stringify(data)}\n\n`);
}

function getErrorMessage(error: unknown) {
  return error instanceof Error ? error.message : 'Research request failed';
}
