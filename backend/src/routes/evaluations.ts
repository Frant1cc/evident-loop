import { Router } from 'express';

import { failure, success } from '../response.js';
import { createAndStartRagEvaluation, subscribeToRagEvaluation } from '../rag/eval/service.js';
import { deleteEvaluationRecord, getEvaluationRecord, listEvaluationRecords } from '../rag/eval/store.js';
import { createSseStream } from '../sse.js';
import { createAndStartWebEvaluation, exportWebEvaluationLibrary, getWebEvaluationLibrary, subscribeToWebEvaluation } from '../web/eval/service.js';
import { deleteWebEvaluationRecord, getWebEvaluationRecord, listWebEvaluationRecords } from '../web/eval/store.js';
import { createCustomWebEvalCase, deleteCustomWebEvalCase, importCustomWebEvalCases } from '../web/eval/caseStore.js';

export const evaluationsRouter = Router();

evaluationsRouter.get('/web/evaluation-cases', (_req, res) => {
  res.json(success(getWebEvaluationLibrary()));
});

evaluationsRouter.get('/web/evaluation-cases/export', (_req, res) => {
  res.json(success({ library: exportWebEvaluationLibrary() }));
});

evaluationsRouter.post('/web/evaluation-cases/import', (req, res) => {
  try {
    const result = importCustomWebEvalCases(req.body);
    res.status(201).json(success(result, `已导入 ${result.importedCount} 道本地题`));
  } catch (error) {
    res.status(400).json(failure(getErrorMessage(error, '导入题库失败')));
  }
});

evaluationsRouter.post('/web/evaluation-cases', (req, res) => {
  try {
    const testCase = createCustomWebEvalCase(req.body);
    res.status(201).json(success({ case: {
      ...testCase,
      evidenceNeeds: testCase.expectedEvidence.map(({ id, label }) => ({ id, label }))
    } }, '自定义题已保存'));
  } catch (error) {
    res.status(400).json(failure(getErrorMessage(error, '保存自定义题失败')));
  }
});

evaluationsRouter.delete('/web/evaluation-cases/:caseId', (req, res) => {
  if (!req.params.caseId.startsWith('custom-')) {
    res.status(409).json(failure('固定基线题不能删除')); return;
  }
  if (!deleteCustomWebEvalCase(req.params.caseId)) {
    res.status(404).json(failure('自定义题不存在')); return;
  }
  res.json(success({ id: req.params.caseId }, '自定义题已删除'));
});

evaluationsRouter.get('/web/evaluations', (req, res) => {
  const limit = Number(req.query.limit ?? 50);
  res.json(success({ evaluations: listWebEvaluationRecords(Number.isFinite(limit) ? limit : 50) }));
});

evaluationsRouter.post('/web/evaluations', (req, res) => {
  try {
    const evaluation = createAndStartWebEvaluation({ name: req.body?.name, caseIds: req.body?.caseIds, k: req.body?.k });
    res.status(202).json(success({ evaluation }, '联网评测已加入队列'));
  } catch (error) {
    res.status(400).json(failure(getErrorMessage(error, '联网评测请求失败')));
  }
});

evaluationsRouter.get('/web/evaluations/:evaluationId', (req, res) => {
  const evaluation = getWebEvaluationRecord(req.params.evaluationId);
  if (!evaluation) { res.status(404).json(failure('联网评测不存在')); return; }
  res.json(success({ evaluation }));
});

evaluationsRouter.delete('/web/evaluations/:evaluationId', (req, res) => {
  const evaluation = getWebEvaluationRecord(req.params.evaluationId);
  if (!evaluation) { res.status(404).json(failure('联网评测不存在')); return; }
  if (evaluation.status === 'queued' || evaluation.status === 'running') {
    res.status(409).json(failure('运行中的联网评测不能删除')); return;
  }
  deleteWebEvaluationRecord(evaluation.id);
  res.json(success({ id: evaluation.id }, '联网评测已删除'));
});

evaluationsRouter.get('/web/evaluations/:evaluationId/events', (req, res) => {
  const evaluation = getWebEvaluationRecord(req.params.evaluationId);
  if (!evaluation) { res.status(404).json(failure('联网评测不存在')); return; }
  const stream = createSseStream(res);
  const unsubscribe = subscribeToWebEvaluation(evaluation.id, (event) => {
    stream.send(event.type, event);
    if (event.type === 'completed' || event.type === 'failed') stream.close();
  });
  stream.onClose(unsubscribe);
  stream.send('snapshot', { type: 'snapshot', evaluation });
  if (evaluation.status === 'completed' || evaluation.status === 'failed') stream.close();
});

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

function getErrorMessage(error: unknown, fallback = 'RAG evaluation request failed') {
  return error instanceof Error ? error.message : fallback;
}
