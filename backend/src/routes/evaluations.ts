import { Router, type Response } from 'express';

import { failure, success } from '../response.js';
import { createAndStartRagEvaluation, subscribeToRagEvaluation } from '../rag/eval/service.js';
import { deleteEvaluationRecord, getEvaluationRecord, listEvaluationRecords } from '../rag/eval/store.js';

export const evaluationsRouter = Router();

evaluationsRouter.get('/rag/evaluations', (req, res) => {
  const limit = Number(req.query.limit ?? 50);
  res.json(success({ evaluations: listEvaluationRecords(Number.isFinite(limit) ? limit : 50) }));
});

evaluationsRouter.post('/rag/evaluations', (req, res) => {
  try {
    const evaluation = createAndStartRagEvaluation({
      name: typeof req.body?.name === 'string' ? req.body.name : undefined,
      k: req.body?.k,
      thresholds: req.body?.thresholds,
      retrieval: req.body?.retrieval,
      queryRewrite: req.body?.queryRewrite
    });
    res.status(202).json(success({ evaluation }, 'RAG evaluation queued'));
  } catch (error) {
    res.status(400).json(failure(getErrorMessage(error)));
  }
});

evaluationsRouter.get('/rag/evaluations/:evaluationId', (req, res) => {
  const evaluation = getEvaluationRecord(req.params.evaluationId);
  if (!evaluation) {
    res.status(404).json(failure('RAG evaluation not found'));
    return;
  }
  res.json(success({ evaluation }));
});

evaluationsRouter.delete('/rag/evaluations/:evaluationId', (req, res) => {
  const evaluation = getEvaluationRecord(req.params.evaluationId);
  if (!evaluation) {
    res.status(404).json(failure('RAG evaluation not found'));
    return;
  }
  if (evaluation.status === 'queued' || evaluation.status === 'running') {
    res.status(409).json(failure('Running evaluations cannot be deleted'));
    return;
  }
  deleteEvaluationRecord(evaluation.id);
  res.json(success({ id: evaluation.id }, 'RAG evaluation deleted'));
});

evaluationsRouter.get('/rag/evaluations/:evaluationId/events', (req, res) => {
  const evaluation = getEvaluationRecord(req.params.evaluationId);
  if (!evaluation) {
    res.status(404).json(failure('RAG evaluation not found'));
    return;
  }

  res.status(200);
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  writeEvent(res, 'snapshot', { type: 'snapshot', evaluation });
  const unsubscribe = subscribeToRagEvaluation(evaluation.id, (event) => {
    writeEvent(res, event.type, event);
    if (event.type === 'completed' || event.type === 'failed') res.end();
  });
  const heartbeat = setInterval(() => res.write(': heartbeat\n\n'), 15_000);
  req.on('close', () => {
    clearInterval(heartbeat);
    unsubscribe();
  });
});

function writeEvent(res: Response, event: string, data: unknown) {
  res.write(`event: ${event}\n`);
  res.write(`data: ${JSON.stringify(data)}\n\n`);
}

function getErrorMessage(error: unknown) {
  return error instanceof Error ? error.message : 'RAG evaluation request failed';
}
