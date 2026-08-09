import { Router } from 'express';

import { failure, success } from '../response.js';
import { createAndStartRagEvaluation, subscribeToRagEvaluation } from '../rag/eval/service.js';
import { deleteEvaluationRecord, getEvaluationRecord, listEvaluationRecords } from '../rag/eval/store.js';
import { createSseStream } from '../sse.js';

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

  const stream = createSseStream(res);
  const unsubscribe = subscribeToRagEvaluation(evaluation.id, (event) => {
    stream.send(event.type, event);
    if (event.type === 'completed' || event.type === 'failed') stream.close();
  });
  stream.onClose(unsubscribe);

  stream.send('snapshot', { type: 'snapshot', evaluation });
  if (evaluation.status === 'completed' || evaluation.status === 'failed') stream.close();
});

function getErrorMessage(error: unknown) {
  return error instanceof Error ? error.message : 'RAG evaluation request failed';
}
