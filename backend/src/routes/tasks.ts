import { Router } from 'express';

import { failure, success } from '../response.js';
import { executeAgentTask, finalizeAgentTask } from '../runtime/executor.js';
import { agentTaskStatuses, type AgentTaskStatus, type EvidenceChainDraft } from '../runtime/types.js';
import {
  createAgentTask,
  deleteAgentTask,
  getAgentTaskDetail,
  listAgentTaskEvents,
  listAgentTasks,
  planAgentTask,
  retryAgentPlanStep,
  saveAgentEvidenceChain,
  transitionAgentTask
} from '../runtime/service.js';
import { InvalidTaskTransitionError } from '../runtime/stateMachine.js';

export const tasksRouter = Router();

tasksRouter.get('/tasks', (_req, res) => {
  res.json(success({ tasks: listAgentTasks() }));
});

tasksRouter.delete('/tasks/:taskId', (req, res) => {
  try {
    const task = deleteAgentTask(req.params.taskId);
    if (!task) {
      res.status(404).json(failure('Agent task not found'));
      return;
    }
    res.json(success({ id: task.id }, 'Agent task deleted'));
  } catch (error) {
    res.status(409).json(failure(getErrorMessage(error)));
  }
});

tasksRouter.post('/tasks/:taskId/plan', async (req, res) => {
  const apiKey = process.env.DEEPSEEK_API_KEY;
  if (!apiKey) {
    res.status(500).json(failure('DEEPSEEK_API_KEY is not configured'));
    return;
  }

  try {
    const detail = await planAgentTask({
      id: req.params.taskId,
      apiKey,
      model: process.env.DEEPSEEK_MODEL ?? 'deepseek-v4-flash'
    });
    if (!detail) {
      res.status(404).json(failure('Agent task not found'));
      return;
    }
    res.json(success(detail, 'Agent plan created'));
  } catch (error) {
    res.status(error instanceof InvalidTaskTransitionError ? 409 : 502).json(failure(getErrorMessage(error)));
  }
});

tasksRouter.post('/tasks/:taskId/approve', (req, res) => {
  try {
    const detail = transitionAgentTask(req.params.taskId, 'running', 'plan approved');
    if (!detail) {
      res.status(404).json(failure('Agent task not found'));
      return;
    }
    res.json(success(detail, 'Agent plan approved'));
  } catch (error) {
    res.status(error instanceof InvalidTaskTransitionError ? 409 : 400).json(failure(getErrorMessage(error)));
  }
});

tasksRouter.post('/tasks/:taskId/run', async (req, res) => {
  const apiKey = process.env.DEEPSEEK_API_KEY;
  if (!apiKey) {
    res.status(500).json(failure('DEEPSEEK_API_KEY is not configured'));
    return;
  }

  const abortController = new AbortController();
  const abort = () => abortController.abort(new Error('Agent task request was cancelled'));
  req.once('aborted', abort);

  try {
    const detail = await executeAgentTask({
      id: req.params.taskId,
      apiKey,
      model: process.env.DEEPSEEK_MODEL ?? 'deepseek-v4-flash',
      signal: abortController.signal
    });
    if (!detail) {
      res.status(404).json(failure('Agent task not found'));
      return;
    }
    res.json(success(detail, detail.task.status === 'completed' ? 'Agent task completed' : 'Agent task stopped'));
  } catch (error) {
    if (!res.headersSent) res.status(502).json(failure(getErrorMessage(error)));
  } finally {
    req.off('aborted', abort);
  }
});

tasksRouter.post('/tasks/:taskId/finalize', async (req, res) => {
  const apiKey = process.env.DEEPSEEK_API_KEY;
  if (!apiKey) {
    res.status(500).json(failure('DEEPSEEK_API_KEY is not configured'));
    return;
  }

  try {
    const detail = await finalizeAgentTask({
      id: req.params.taskId,
      apiKey,
      model: process.env.DEEPSEEK_MODEL ?? 'deepseek-v4-flash'
    });
    if (!detail) {
      res.status(404).json(failure('Agent task not found'));
      return;
    }
    res.json(success(detail, 'Final artifact created'));
  } catch (error) {
    res.status(502).json(failure(getErrorMessage(error)));
  }
});

tasksRouter.post('/tasks/:taskId/steps/:stepId/retry', (req, res) => {
  try {
    const detail = retryAgentPlanStep(req.params.taskId, req.params.stepId);
    res.json(success(detail, 'Agent plan step queued for retry'));
  } catch (error) {
    res.status(getErrorMessage(error) === 'Agent task not found' ? 404 : 409).json(failure(getErrorMessage(error)));
  }
});

tasksRouter.post('/tasks/:taskId/steps/:stepId/evidence-chain', (req, res) => {
  try {
    const detail = saveAgentEvidenceChain(
      req.params.taskId,
      req.params.stepId,
      req.body as EvidenceChainDraft
    );
    res.json(success(detail, 'Source–Evidence–Claim chain saved'));
  } catch (error) {
    const message = getErrorMessage(error);
    res.status(message === 'Agent task not found' || message === 'Plan step not found' ? 404 : 400).json(failure(message));
  }
});

tasksRouter.post('/tasks', (req, res) => {
  try {
    const detail = createAgentTask({
      goal: String(req.body?.goal ?? ''),
      maxSteps: req.body?.maxSteps,
      maxTokens: req.body?.maxTokens,
      allowedTools: req.body?.allowedTools
    });
    res.status(201).json(success(detail, 'Agent task created'));
  } catch (error) {
    res.status(400).json(failure(getErrorMessage(error)));
  }
});

tasksRouter.get('/tasks/:taskId', (req, res) => {
  const detail = getAgentTaskDetail(req.params.taskId);
  if (!detail) {
    res.status(404).json(failure('Agent task not found'));
    return;
  }
  res.json(success(detail));
});

tasksRouter.get('/tasks/:taskId/events', (req, res) => {
  const events = listAgentTaskEvents(req.params.taskId);
  if (!events) {
    res.status(404).json(failure('Agent task not found'));
    return;
  }
  res.json(success({ events }));
});

tasksRouter.post('/tasks/:taskId/transitions', (req, res) => {
  const status = String(req.body?.status ?? '') as AgentTaskStatus;
  if (!agentTaskStatuses.includes(status)) {
    res.status(400).json(failure('status is invalid'));
    return;
  }

  try {
    const detail = transitionAgentTask(req.params.taskId, status, String(req.body?.reason ?? ''));
    if (!detail) {
      res.status(404).json(failure('Agent task not found'));
      return;
    }
    res.json(success(detail, 'Agent task transitioned'));
  } catch (error) {
    res.status(error instanceof InvalidTaskTransitionError ? 409 : 400).json(failure(getErrorMessage(error)));
  }
});

function getErrorMessage(error: unknown) {
  return error instanceof Error ? error.message : 'Agent task request failed';
}
