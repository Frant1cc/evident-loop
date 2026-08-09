import { Router } from 'express';

import { LlmNotConfiguredError } from '../llm/errors.js';
import type { ResearchApplication, ResearchRunStatus } from '../modules/research/index.js';
import { failure, success } from '../response.js';
import { createSseStream } from '../sse.js';

/** HTTP/SSE adapter for research use cases. Persistence and tools are hidden behind the application boundary. */
export function createResearchRouter(research: ResearchApplication) {
  const router = Router();

  router.get('/research/tools', (_req, res) => {
    res.json(success({ tools: research.listTools() }));
  });

  router.get('/research/conversations', (_req, res) => {
    res.json(success({ conversations: research.listConversations() }));
  });

  router.post('/research/conversations', (_req, res) => {
    res.status(201).json(success({ conversation: research.createConversation() }));
  });

  router.get('/research/conversations/:conversationId', (req, res) => {
    const detail = research.getConversation(req.params.conversationId);
    if (!detail) {
      res.status(404).json(failure('Research conversation not found'));
      return;
    }
    res.json(success(detail));
  });

  router.delete('/research/conversations/:conversationId', (req, res) => {
    try {
      if (!research.deleteConversation(req.params.conversationId)) {
        res.status(404).json(failure('Research conversation not found'));
        return;
      }
      res.json(success({ deleted: true }));
    } catch (error) {
      res.status(409).json(failure(getErrorMessage(error)));
    }
  });

  router.post('/research/conversations/:conversationId/notes', (req, res) => {
    const content = String(req.body?.content ?? '').trim();
    if (!content) {
      res.status(400).json(failure('content is required'));
      return;
    }
    const note = research.createNote(req.params.conversationId, content);
    if (!note) {
      res.status(404).json(failure('Research conversation not found'));
      return;
    }
    res.status(201).json(success({ note }));
  });

  router.put('/research/notes/:noteId', (req, res) => {
    const content = String(req.body?.content ?? '').trim();
    if (!content) {
      res.status(400).json(failure('content is required'));
      return;
    }
    const note = research.updateNote(req.params.noteId, content);
    if (!note) {
      res.status(404).json(failure('Research note not found'));
      return;
    }
    res.json(success({ note }));
  });

  router.delete('/research/notes/:noteId', (req, res) => {
    if (!research.deleteNote(req.params.noteId)) {
      res.status(404).json(failure('Research note not found'));
      return;
    }
    res.json(success({ deleted: true }));
  });

  router.post('/research/conversations/:conversationId/messages', (req, res) => {
    const content = String(req.body?.content ?? '').trim();
    if (!content) {
      res.status(400).json(failure('content is required'));
      return;
    }
    try {
      const started = research.startMessage(
        req.params.conversationId,
        content,
        research.normalizeAllowedTools(req.body?.allowedTools)
      );
      res.status(202).json(success(started, 'Research task queued'));
    } catch (error) {
      const message = getErrorMessage(error);
      const status = error instanceof LlmNotConfiguredError
        ? 500
        : message === 'Research conversation not found' ? 404 : 409;
      res.status(status).json(failure(message));
    }
  });

  router.get('/research/runs/:runId/events', (req, res) => {
    const initial = research.getRunSnapshot(req.params.runId);
    if (!initial) {
      res.status(404).json(failure('Research task not found'));
      return;
    }
    const stream = createSseStream(res);
    const unsubscribe = research.subscribeToRun(initial.run.id, (event) => {
      stream.send(event.type, event);
      if (event.type === 'done' || event.type === 'error') stream.close();
    });
    stream.onClose(unsubscribe);
    stream.send('snapshot', initial);
    if (isTerminal(initial.run.status)) stream.close();
  });

  router.post('/research/runs/:runId/cancel', (req, res) => {
    const current = research.getRun(req.params.runId);
    if (!current) {
      res.status(404).json(failure('Research task not found'));
      return;
    }
    const run = research.cancelRun(current.id);
    res.json(success({ run }, run?.status === 'cancelled' ? 'Research task stopped' : 'Research task already finished'));
  });

  return router;
}

function isTerminal(status: ResearchRunStatus) {
  return status === 'completed' || status === 'failed' || status === 'cancelled';
}

function getErrorMessage(error: unknown) {
  return error instanceof Error ? error.message : 'Research request failed';
}
