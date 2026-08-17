import { Router } from 'express';

import {
  ApprovalDecisionConflictError,
  ApprovalNotFoundError,
  approvalScopeTypes,
  type ApprovalManager,
  type ToolApprovalDecision,
  type ToolApprovalScope
} from './contracts.js';
import { failure, success } from '../response.js';

export function createToolApprovalRouter(approvals: ApprovalManager) {
  const router = Router();

  router.get('/tool-approvals', (req, res) => {
    const type = req.query.scopeType ? String(req.query.scopeType) : undefined;
    const id = req.query.scopeId ? String(req.query.scopeId) : undefined;
    if ((type && !id) || (id && !type) || (type && !approvalScopeTypes.includes(type as ToolApprovalScope['type']))) {
      res.status(400).json(failure('scopeType and scopeId must describe a valid approval scope'));
      return;
    }
    res.json(success({ approvals: approvals.list(type && id ? { type: type as ToolApprovalScope['type'], id } : undefined) }));
  });

  router.get('/tool-approvals/:approvalId', (req, res) => {
    const approval = approvals.get(req.params.approvalId);
    if (!approval) {
      res.status(404).json(failure('Tool approval not found'));
      return;
    }
    res.json(success({ approval }));
  });

  router.post('/tool-approvals/:approvalId/decision', (req, res) => {
    const decision = req.body?.decision as ToolApprovalDecision;
    if (decision !== 'approve' && decision !== 'reject') {
      res.status(400).json(failure("decision must be 'approve' or 'reject'"));
      return;
    }
    try {
      const approval = approvals.decide(req.params.approvalId, decision);
      res.json(success({ approval }));
    } catch (error) {
      if (error instanceof ApprovalNotFoundError) {
        res.status(404).json(failure(error.message));
        return;
      }
      if (error instanceof ApprovalDecisionConflictError) {
        res.status(409).json(failure(error.message));
        return;
      }
      res.status(500).json(failure(error instanceof Error ? error.message : 'Tool approval decision failed'));
    }
  });

  return router;
}
