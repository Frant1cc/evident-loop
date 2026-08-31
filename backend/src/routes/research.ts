import { Router } from 'express';

import { isTerminalEventType, SNAPSHOT_EVENT_TYPE, type StreamEventEnvelope } from '@evident-loop/stream-protocol';

import { LlmNotConfiguredError } from '../llm/errors.js';
import {
  ResearchSkillToolError,
  UnknownResearchSkillError,
  type ResearchApplication,
  type ResearchRunStatus
} from '../modules/research/index.js';
import { failure, success } from '../response.js';
import { createSseStream } from '../sse.js';

/** HTTP/SSE adapter for research use cases. Persistence and tools are hidden behind the application boundary. */
export function createResearchRouter(research: ResearchApplication) {
  const router = Router();

  router.get('/research/tools', (_req, res) => {
    res.json(success({ tools: research.listTools(), groups: research.listToolGroups() }));
  });

  router.get('/research/skills', (_req, res) => {
    res.json(success({ skills: research.listSkills() }));
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

  router.delete('/research/conversations/:conversationId', async (req, res) => {
    try {
      if (!await Promise.resolve(research.deleteConversation(req.params.conversationId))) {
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
    const skillId = req.body?.skillId === undefined || req.body?.skillId === null
      ? undefined
      : String(req.body.skillId);
    try {
      const started = research.startMessage(
        req.params.conversationId,
        content,
        research.normalizeToolPolicy(req.body?.toolPolicy ?? req.body?.allowedTools),
        skillId
      );
      res.status(202).json(success(started, 'Research task queued'));
    } catch (error) {
      const message = getErrorMessage(error);
      const status = error instanceof LlmNotConfiguredError
        ? 500
        : error instanceof UnknownResearchSkillError
          ? 400
          : error instanceof ResearchSkillToolError
            ? 409
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

    const runId = initial.run.id;
    const cursor = parseCursor(req.headers['last-event-id']);
    const stream = createSseStream(res);

    // Buffer live events until replay has caught up, so events produced during
    // the replay query are neither lost nor delivered out of order.
    let replayed = false;
    let lastSent = cursor;
    const liveBuffer: StreamEventEnvelope[] = [];

    const forward = (envelope: StreamEventEnvelope) => {
      if (envelope.sequence <= lastSent) return;
      lastSent = envelope.sequence;
      stream.send(envelope.type, envelope, String(envelope.sequence));
      if (isTerminalEventType(envelope.type)) stream.close();
    };

    const unsubscribe = research.subscribeToRun(runId, (envelope) => {
      if (!replayed) {
        liveBuffer.push(envelope);
        return;
      }
      forward(envelope);
    });
    stream.onClose(unsubscribe);

    const maxSequence = research.getStreamMaxSequence(runId);
    // First connection, or the requested cursor is beyond what remains after
    // cleanup: fall back to a full snapshot instead of replaying a partial log.
    if (cursor === 0 || cursor > maxSequence) {
      stream.send(SNAPSHOT_EVENT_TYPE, { ...initial, lastSequence: maxSequence });
      lastSent = maxSequence;
    } else {
      for (const envelope of research.getStreamEventsAfter(runId, cursor)) forward(envelope);
    }

    // Compensation pass: drain any events that landed between the replay query
    // and now, then switch to live tailing. Dedupe by sequence via `forward`.
    replayed = true;
    for (const envelope of research.getStreamEventsAfter(runId, lastSent)) forward(envelope);
    const buffered = liveBuffer.splice(0).sort((a, b) => a.sequence - b.sequence);
    for (const envelope of buffered) forward(envelope);

    if (isTerminal(initial.run.status) && lastSent >= maxSequence) stream.close();
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

function parseCursor(header: string | string[] | undefined): number {
  const raw = Array.isArray(header) ? header[0] : header;
  const value = Number(raw);
  return Number.isInteger(value) && value > 0 ? value : 0;
}

function getErrorMessage(error: unknown) {
  return error instanceof Error ? error.message : 'Research request failed';
}
