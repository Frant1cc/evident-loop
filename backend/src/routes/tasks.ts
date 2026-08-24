import { Router } from 'express';

import { LlmNotConfiguredError } from '../llm/errors.js';
import {
  agentTaskStatuses,
  InvalidTaskTransitionError,
  type AgentTaskStatus,
  type EvidenceChainDraft,
  type PlanStepDraft,
  type TaskApplication
} from '../modules/tasks/index.js';
import { failure, success } from '../response.js';

/** HTTP adapter for task use cases. It does not know stores, executors, or provider credentials. */
export function createTasksRouter(tasks: TaskApplication) {
  const router = Router();

  router.get('/tasks', (_req, res) => {
    res.json(success({ tasks: tasks.list() }));
  });

  router.get('/tasks/artifacts', (_req, res) => {
    res.json(success({ artifacts: tasks.listArtifacts() }));
  });

  router.delete('/tasks/:taskId', (req, res) => {
    try {
      const task = tasks.delete(req.params.taskId);
      if (!task) {
        res.status(404).json(failure('Agent task not found'));
        return;
      }
      res.json(success({ id: task.id }, 'Agent task deleted'));
    } catch (error) {
      res.status(409).json(failure(getErrorMessage(error)));
    }
  });

  router.post('/tasks/:taskId/plan', async (req, res) => {
    try {
      const detail = await tasks.plan(req.params.taskId);
      if (!detail) {
        res.status(404).json(failure('Agent task not found'));
        return;
      }
      res.json(success(detail, 'Agent plan created'));
    } catch (error) {
      const status = error instanceof LlmNotConfiguredError
        ? 500
        : error instanceof InvalidTaskTransitionError ? 409 : 502;
      res.status(status).json(failure(getErrorMessage(error)));
    }
  });

  router.put('/tasks/:taskId/plan', (req, res) => {
    try {
      const detail = tasks.updatePlan(req.params.taskId, req.body?.steps as PlanStepDraft[]);
      if (!detail) {
        res.status(404).json(failure('Agent task not found'));
        return;
      }
      res.json(success(detail, 'Agent plan updated'));
    } catch (error) {
      const message = getErrorMessage(error);
      const conflict = message === 'Only a task awaiting approval can edit its plan'
        || message === 'Only a fully pending plan can be edited';
      res.status(conflict ? 409 : 400).json(failure(message));
    }
  });

  router.post('/tasks/:taskId/approve', (req, res) => {
    try {
      const detail = tasks.approve(req.params.taskId);
      if (!detail) {
        res.status(404).json(failure('Agent task not found'));
        return;
      }
      res.json(success(detail, 'Agent plan approved'));
    } catch (error) {
      res.status(error instanceof InvalidTaskTransitionError ? 409 : 400).json(failure(getErrorMessage(error)));
    }
  });

  router.post('/tasks/:taskId/run', async (req, res) => {
    const abortController = new AbortController();
    const abort = () => abortController.abort(new Error('Agent task request was cancelled'));
    req.once('aborted', abort);
    try {
      const detail = await tasks.run(req.params.taskId, abortController.signal);
      if (!detail) {
        res.status(404).json(failure('Agent task not found'));
        return;
      }
      res.json(success(detail, detail.task.status === 'completed' ? 'Agent task completed' : 'Agent task stopped'));
    } catch (error) {
      const status = error instanceof LlmNotConfiguredError ? 500 : 502;
      if (!res.headersSent) res.status(status).json(failure(getErrorMessage(error)));
    } finally {
      req.off('aborted', abort);
    }
  });

  router.post('/tasks/:taskId/finalize', async (req, res) => {
    try {
      const detail = await tasks.finalize(req.params.taskId);
      if (!detail) {
        res.status(404).json(failure('Agent task not found'));
        return;
      }
      res.json(success(detail, 'Final artifact created'));
    } catch (error) {
      res.status(error instanceof LlmNotConfiguredError ? 500 : 502).json(failure(getErrorMessage(error)));
    }
  });

  router.post('/tasks/:taskId/steps/:stepId/retry', (req, res) => {
    try {
      res.json(success(tasks.retryStep(req.params.taskId, req.params.stepId), 'Agent plan step queued for retry'));
    } catch (error) {
      res.status(getErrorMessage(error) === 'Agent task not found' ? 404 : 409).json(failure(getErrorMessage(error)));
    }
  });

  router.post('/tasks/:taskId/steps/:stepId/evidence-chain', (req, res) => {
    try {
      const detail = tasks.saveEvidenceChain(req.params.taskId, req.params.stepId, req.body as EvidenceChainDraft);
      res.json(success(detail, 'Source–Evidence–Claim chain saved'));
    } catch (error) {
      const message = getErrorMessage(error);
      res.status(message === 'Agent task not found' || message === 'Plan step not found' ? 404 : 400).json(failure(message));
    }
  });

  router.post('/tasks', (req, res) => {
    try {
      const detail = tasks.create({
        goal: String(req.body?.goal ?? ''),
        maxSteps: req.body?.maxSteps,
        maxTokens: req.body?.maxTokens,
        toolPolicy: req.body?.toolPolicy,
        allowedTools: req.body?.allowedTools
      });
      res.status(201).json(success(detail, 'Agent task created'));
    } catch (error) {
      res.status(400).json(failure(getErrorMessage(error)));
    }
  });

  router.get('/tasks/:taskId', (req, res) => {
    const detail = tasks.get(req.params.taskId);
    if (!detail) {
      res.status(404).json(failure('Agent task not found'));
      return;
    }
    res.json(success(detail));
  });

  router.get('/tasks/:taskId/events', (req, res) => {
    const events = tasks.events(req.params.taskId);
    if (!events) {
      res.status(404).json(failure('Agent task not found'));
      return;
    }
    res.json(success({ events }));
  });

  router.post('/tasks/:taskId/transitions', (req, res) => {
    const status = String(req.body?.status ?? '') as AgentTaskStatus;
    if (!agentTaskStatuses.includes(status)) {
      res.status(400).json(failure('status is invalid'));
      return;
    }
    try {
      const detail = tasks.transition(req.params.taskId, status, String(req.body?.reason ?? ''));
      if (!detail) {
        res.status(404).json(failure('Agent task not found'));
        return;
      }
      res.json(success(detail, 'Agent task transitioned'));
    } catch (error) {
      res.status(error instanceof InvalidTaskTransitionError ? 409 : 400).json(failure(getErrorMessage(error)));
    }
  });

  return router;
}

function getErrorMessage(error: unknown) {
  return error instanceof Error ? error.message : 'Agent task request failed';
}
