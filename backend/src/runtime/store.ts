import { randomUUID } from 'node:crypto';

import { sqlite } from '../db.js';
import type {
  AgentCheckpoint,
  AgentCheckpointState,
  AgentEvent,
  AgentArtifact,
  AgentClaim,
  AgentEvidence,
  AgentReview,
  AgentSource,
  ClaimEvidence,
  EvidenceGap,
  AgentPlanStep,
  AgentTask,
  AgentTaskStatus,
  PlanStepDraft,
  ToolExecution
} from './types.js';

type TaskRow = {
  id: string;
  goal: string;
  status: AgentTaskStatus;
  current_step_id: string | null;
  max_steps: number;
  max_tokens: number;
  allowed_tools_json: string;
  checkpoint_version: number;
  created_at: string;
  updated_at: string;
};

type StepRow = {
  id: string;
  task_id: string;
  sequence: number;
  objective: string;
  expected_evidence_json: string;
  dependencies_json: string;
  status: AgentPlanStep['status'];
  attempts: number;
  input_json: string | null;
  output_json: string | null;
  error: string | null;
  started_at: string | null;
  completed_at: string | null;
  created_at: string;
  updated_at: string;
};

type EventRow = {
  id: string;
  task_id: string;
  sequence: number;
  type: string;
  payload_json: string;
  created_at: string;
};

type CheckpointRow = {
  id: string;
  task_id: string;
  version: number;
  state_json: string;
  created_at: string;
};

type ToolExecutionRow = {
  id: string;
  task_id: string;
  step_id: string | null;
  execution_key: string;
  tool_name: string;
  status: ToolExecution['status'];
  arguments_json: string;
  result_json: string | null;
  error: string | null;
  started_at: string;
  completed_at: string | null;
};

type ArtifactRow = {
  id: string;
  task_id: string;
  type: 'report';
  title: string;
  content: string;
  status: 'completed';
  created_at: string;
  updated_at: string;
};

type ReviewRow = {
  id: string;
  task_id: string;
  step_id: string;
  verdict: AgentReview['verdict'];
  summary: string;
  supported_claims_json: string;
  unsupported_claims_json: string;
  limitations_json: string;
  created_at: string;
};

type EvidenceGapRow = {
  id: string;
  review_id: string;
  task_id: string;
  step_id: string;
  description: string;
  required_evidence: string;
  suggested_query: string;
  status: EvidenceGap['status'];
  supplemental_step_id: string | null;
  created_at: string;
  resolved_at: string | null;
};

type SourceRow = {
  id: string;
  task_id: string;
  step_id: string | null;
  tool_execution_id: string | null;
  source_key: string;
  type: AgentSource['type'];
  title: string;
  uri: string | null;
  metadata_json: string | null;
  created_at: string;
  updated_at: string;
};

type AgentEvidenceRow = {
  id: string;
  task_id: string;
  step_id: string | null;
  source_id: string;
  evidence_key: string;
  content: string;
  context: string | null;
  locator_json: string | null;
  relevance_score: number | null;
  created_at: string;
  updated_at: string;
};

type ClaimRow = {
  id: string;
  task_id: string;
  step_id: string | null;
  claim_key: string;
  text: string;
  status: AgentClaim['status'];
  confidence: number | null;
  created_at: string;
  updated_at: string;
};

type ClaimEvidenceRow = {
  task_id: string;
  claim_id: string;
  evidence_id: string;
  relation: ClaimEvidence['relation'];
  rationale: string | null;
  created_at: string;
  updated_at: string;
};

export function insertTask(task: AgentTask) {
  sqlite.prepare(`INSERT INTO agent_tasks
    (id, goal, status, current_step_id, max_steps, max_tokens, allowed_tools_json, checkpoint_version, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(
      task.id,
      task.goal,
      task.status,
      task.currentStepId ?? null,
      task.maxSteps,
      task.maxTokens,
      JSON.stringify(task.allowedTools),
      task.checkpointVersion,
      task.createdAt,
      task.updatedAt
    );
}

export function listTasks(): AgentTask[] {
  return sqlite.prepare('SELECT * FROM agent_tasks ORDER BY updated_at DESC').all().map((row) => toTask(row as TaskRow));
}

export function getTask(id: string): AgentTask | undefined {
  const row = sqlite.prepare('SELECT * FROM agent_tasks WHERE id = ?').get(id) as TaskRow | undefined;
  return row ? toTask(row) : undefined;
}

export function deleteTask(id: string) {
  return sqlite.prepare('DELETE FROM agent_tasks WHERE id = ?').run(id).changes > 0;
}

export function updateTaskStatus(id: string, status: AgentTaskStatus, checkpointVersion: number, updatedAt: string) {
  sqlite.prepare('UPDATE agent_tasks SET status = ?, checkpoint_version = ?, updated_at = ? WHERE id = ?')
    .run(status, checkpointVersion, updatedAt, id);
}

export function updateTaskExecutionState(input: {
  id: string;
  status: AgentTaskStatus;
  currentStepId?: string;
  checkpointVersion: number;
  updatedAt: string;
}) {
  sqlite.prepare(`UPDATE agent_tasks
    SET status = ?, current_step_id = ?, checkpoint_version = ?, updated_at = ?
    WHERE id = ?`)
    .run(input.status, input.currentStepId ?? null, input.checkpointVersion, input.updatedAt, input.id);
}

export function listPlanSteps(taskId: string): AgentPlanStep[] {
  return sqlite.prepare('SELECT * FROM agent_plan_steps WHERE task_id = ? ORDER BY sequence ASC').all(taskId)
    .map((row) => toStep(row as StepRow));
}

export function getPlanStep(id: string): AgentPlanStep | undefined {
  const row = sqlite.prepare('SELECT * FROM agent_plan_steps WHERE id = ?').get(id) as StepRow | undefined;
  return row ? toStep(row) : undefined;
}

export function markPlanStepRunning(id: string, startedAt: string) {
  const result = sqlite.prepare(`UPDATE agent_plan_steps
    SET status = 'running', attempts = attempts + 1, error = NULL, started_at = ?, completed_at = NULL, updated_at = ?
    WHERE id = ? AND status = 'pending'`)
    .run(startedAt, startedAt, id);
  if (result.changes !== 1) throw new Error('Plan step is not pending');
  return getPlanStep(id);
}

export function markPlanStepCompleted(id: string, output: unknown, completedAt: string) {
  const result = sqlite.prepare(`UPDATE agent_plan_steps
    SET status = 'completed', output_json = ?, error = NULL, completed_at = ?, updated_at = ?
    WHERE id = ? AND status = 'running'`)
    .run(JSON.stringify(output), completedAt, completedAt, id);
  if (result.changes !== 1) throw new Error('Plan step is not running');
  return getPlanStep(id);
}

export function markPlanStepFailed(id: string, error: string, completedAt: string) {
  const result = sqlite.prepare(`UPDATE agent_plan_steps
    SET status = 'failed', error = ?, completed_at = ?, updated_at = ?
    WHERE id = ? AND status = 'running'`)
    .run(error, completedAt, completedAt, id);
  if (result.changes !== 1) throw new Error('Plan step is not running');
  return getPlanStep(id);
}

export function resetPlanStepForRetry(id: string, updatedAt: string) {
  const result = sqlite.prepare(`UPDATE agent_plan_steps
    SET status = 'pending', error = NULL, output_json = NULL, started_at = NULL, completed_at = NULL, updated_at = ?
    WHERE id = ? AND status = 'failed'`)
    .run(updatedAt, id);
  if (result.changes !== 1) throw new Error('Only failed plan steps can be retried');
  return getPlanStep(id);
}

export function insertPlanSteps(taskId: string, drafts: PlanStepDraft[], createdAt: string): AgentPlanStep[] {
  const steps: AgentPlanStep[] = [];
  const statement = sqlite.prepare(`INSERT INTO agent_plan_steps
    (id, task_id, sequence, objective, expected_evidence_json, dependencies_json, status, attempts, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, 'pending', 0, ?, ?)`);

  for (const [index, draft] of drafts.entries()) {
    const step: AgentPlanStep = {
      id: randomUUID(),
      taskId,
      sequence: index + 1,
      objective: draft.objective,
      expectedEvidence: draft.expectedEvidence,
      dependencies: index === 0 ? [] : [steps[index - 1].id],
      status: 'pending',
      attempts: 0,
      createdAt,
      updatedAt: createdAt
    };
    statement.run(
      step.id,
      step.taskId,
      step.sequence,
      step.objective,
      JSON.stringify(step.expectedEvidence),
      JSON.stringify(step.dependencies),
      step.createdAt,
      step.updatedAt
    );
    steps.push(step);
  }

  return steps;
}

export function replacePlanSteps(taskId: string, drafts: PlanStepDraft[], updatedAt: string): AgentPlanStep[] {
  sqlite.prepare('DELETE FROM agent_plan_steps WHERE task_id = ?').run(taskId);
  return insertPlanSteps(taskId, drafts, updatedAt);
}

export function insertSupplementalPlanStep(input: {
  taskId: string;
  objective: string;
  expectedEvidence: string[];
  dependencies: string[];
  stepInput: unknown;
  createdAt: string;
}): AgentPlanStep {
  const row = sqlite.prepare('SELECT COALESCE(MAX(sequence), 0) + 1 AS sequence FROM agent_plan_steps WHERE task_id = ?')
    .get(input.taskId) as { sequence: number };
  const step: AgentPlanStep = {
    id: randomUUID(),
    taskId: input.taskId,
    sequence: row.sequence,
    objective: input.objective,
    expectedEvidence: input.expectedEvidence,
    dependencies: input.dependencies,
    status: 'pending',
    attempts: 0,
    input: input.stepInput,
    createdAt: input.createdAt,
    updatedAt: input.createdAt
  };
  sqlite.prepare(`INSERT INTO agent_plan_steps
    (id, task_id, sequence, objective, expected_evidence_json, dependencies_json, status, attempts, input_json, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, 'pending', 0, ?, ?, ?)`).run(
      step.id,
      step.taskId,
      step.sequence,
      step.objective,
      JSON.stringify(step.expectedEvidence),
      JSON.stringify(step.dependencies),
      JSON.stringify(step.input),
      step.createdAt,
      step.updatedAt
    );
  return step;
}

export function insertReview(review: AgentReview) {
  sqlite.prepare(`INSERT INTO agent_reviews
    (id, task_id, step_id, verdict, summary, supported_claims_json, unsupported_claims_json, limitations_json, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      review.id,
      review.taskId,
      review.stepId,
      review.verdict,
      review.summary,
      JSON.stringify(review.supportedClaims),
      JSON.stringify(review.unsupportedClaims),
      JSON.stringify(review.limitations),
      review.createdAt
    );
}

export function getReviewForStep(stepId: string): AgentReview | undefined {
  const row = sqlite.prepare('SELECT * FROM agent_reviews WHERE step_id = ?').get(stepId) as ReviewRow | undefined;
  return row ? toReview(row) : undefined;
}

export function listReviews(taskId: string): AgentReview[] {
  return sqlite.prepare('SELECT * FROM agent_reviews WHERE task_id = ? ORDER BY created_at ASC').all(taskId)
    .map((row) => toReview(row as ReviewRow));
}

export function insertEvidenceGaps(gaps: EvidenceGap[]) {
  const statement = sqlite.prepare(`INSERT INTO agent_evidence_gaps
    (id, review_id, task_id, step_id, description, required_evidence, suggested_query, status, supplemental_step_id, created_at, resolved_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  for (const gap of gaps) {
    statement.run(
      gap.id,
      gap.reviewId,
      gap.taskId,
      gap.stepId,
      gap.description,
      gap.requiredEvidence,
      gap.suggestedQuery,
      gap.status,
      gap.supplementalStepId ?? null,
      gap.createdAt,
      gap.resolvedAt ?? null
    );
  }
}

export function listEvidenceGaps(taskId: string): EvidenceGap[] {
  return sqlite.prepare('SELECT * FROM agent_evidence_gaps WHERE task_id = ? ORDER BY created_at ASC, rowid ASC').all(taskId)
    .map((row) => toEvidenceGap(row as EvidenceGapRow));
}

export function scheduleEvidenceGaps(ids: string[], supplementalStepId: string) {
  const statement = sqlite.prepare(`UPDATE agent_evidence_gaps
    SET status = 'scheduled', supplemental_step_id = ? WHERE id = ? AND status = 'open'`);
  for (const id of ids) statement.run(supplementalStepId, id);
}

export function markEvidenceGapsUnresolved(ids: string[], resolvedAt: string) {
  const statement = sqlite.prepare(`UPDATE agent_evidence_gaps
    SET status = 'unresolved', resolved_at = ? WHERE id = ? AND status IN ('open', 'scheduled')`);
  for (const id of ids) statement.run(resolvedAt, id);
}

export function settleEvidenceGapsForSupplementalStep(
  supplementalStepId: string,
  status: 'resolved' | 'unresolved',
  resolvedAt: string
) {
  sqlite.prepare(`UPDATE agent_evidence_gaps SET status = ?, resolved_at = ?
    WHERE supplemental_step_id = ? AND status = 'scheduled'`).run(status, resolvedAt, supplementalStepId);
}

export function upsertSource(source: AgentSource): AgentSource {
  sqlite.prepare(`INSERT INTO agent_sources
    (id, task_id, step_id, tool_execution_id, source_key, type, title, uri, metadata_json, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(task_id, source_key) DO UPDATE SET
      step_id = excluded.step_id,
      tool_execution_id = excluded.tool_execution_id,
      type = excluded.type,
      title = excluded.title,
      uri = excluded.uri,
      metadata_json = excluded.metadata_json,
      updated_at = excluded.updated_at`).run(
      source.id,
      source.taskId,
      source.stepId ?? null,
      source.toolExecutionId ?? null,
      source.sourceKey,
      source.type,
      source.title,
      source.uri ?? null,
      source.metadata === undefined ? null : JSON.stringify(source.metadata),
      source.createdAt,
      source.updatedAt
    );
  const stored = getSourceByKey(source.taskId, source.sourceKey);
  if (!stored) throw new Error('Source disappeared while saving');
  return stored;
}

export function getSourceByKey(taskId: string, sourceKey: string): AgentSource | undefined {
  const row = sqlite.prepare('SELECT * FROM agent_sources WHERE task_id = ? AND source_key = ?')
    .get(taskId, sourceKey) as SourceRow | undefined;
  return row ? toSource(row) : undefined;
}

export function listSources(taskId: string): AgentSource[] {
  return sqlite.prepare('SELECT * FROM agent_sources WHERE task_id = ? ORDER BY created_at ASC, rowid ASC').all(taskId)
    .map((row) => toSource(row as SourceRow));
}

export function upsertEvidence(evidence: AgentEvidence): AgentEvidence {
  sqlite.prepare(`INSERT INTO agent_evidence
    (id, task_id, step_id, source_id, evidence_key, content, context, locator_json, relevance_score, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(task_id, evidence_key) DO UPDATE SET
      step_id = excluded.step_id,
      source_id = excluded.source_id,
      content = excluded.content,
      context = excluded.context,
      locator_json = excluded.locator_json,
      relevance_score = excluded.relevance_score,
      updated_at = excluded.updated_at`).run(
      evidence.id,
      evidence.taskId,
      evidence.stepId ?? null,
      evidence.sourceId,
      evidence.evidenceKey,
      evidence.content,
      evidence.context ?? null,
      evidence.locator === undefined ? null : JSON.stringify(evidence.locator),
      evidence.relevanceScore ?? null,
      evidence.createdAt,
      evidence.updatedAt
    );
  const stored = getEvidenceByKey(evidence.taskId, evidence.evidenceKey);
  if (!stored) throw new Error('Evidence disappeared while saving');
  return stored;
}

export function getEvidenceByKey(taskId: string, evidenceKey: string): AgentEvidence | undefined {
  const row = sqlite.prepare('SELECT * FROM agent_evidence WHERE task_id = ? AND evidence_key = ?')
    .get(taskId, evidenceKey) as AgentEvidenceRow | undefined;
  return row ? toAgentEvidence(row) : undefined;
}

export function listAgentEvidence(taskId: string): AgentEvidence[] {
  return sqlite.prepare('SELECT * FROM agent_evidence WHERE task_id = ? ORDER BY created_at ASC, rowid ASC').all(taskId)
    .map((row) => toAgentEvidence(row as AgentEvidenceRow));
}

export function upsertClaim(claim: AgentClaim): AgentClaim {
  sqlite.prepare(`INSERT INTO agent_claims
    (id, task_id, step_id, claim_key, text, status, confidence, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(task_id, claim_key) DO UPDATE SET
      step_id = excluded.step_id,
      text = excluded.text,
      status = excluded.status,
      confidence = excluded.confidence,
      updated_at = excluded.updated_at`).run(
      claim.id,
      claim.taskId,
      claim.stepId ?? null,
      claim.claimKey,
      claim.text,
      claim.status,
      claim.confidence ?? null,
      claim.createdAt,
      claim.updatedAt
    );
  const stored = getClaimByKey(claim.taskId, claim.claimKey);
  if (!stored) throw new Error('Claim disappeared while saving');
  return stored;
}

export function getClaimByKey(taskId: string, claimKey: string): AgentClaim | undefined {
  const row = sqlite.prepare('SELECT * FROM agent_claims WHERE task_id = ? AND claim_key = ?')
    .get(taskId, claimKey) as ClaimRow | undefined;
  return row ? toClaim(row) : undefined;
}

export function listClaims(taskId: string): AgentClaim[] {
  return sqlite.prepare('SELECT * FROM agent_claims WHERE task_id = ? ORDER BY created_at ASC, rowid ASC').all(taskId)
    .map((row) => toClaim(row as ClaimRow));
}

export function upsertClaimEvidence(link: ClaimEvidence): ClaimEvidence {
  sqlite.prepare(`INSERT INTO agent_claim_evidence
    (task_id, claim_id, evidence_id, relation, rationale, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(claim_id, evidence_id) DO UPDATE SET
      relation = excluded.relation,
      rationale = excluded.rationale,
      updated_at = excluded.updated_at`).run(
      link.taskId,
      link.claimId,
      link.evidenceId,
      link.relation,
      link.rationale ?? null,
      link.createdAt,
      link.updatedAt
    );
  const row = sqlite.prepare('SELECT * FROM agent_claim_evidence WHERE claim_id = ? AND evidence_id = ?')
    .get(link.claimId, link.evidenceId) as ClaimEvidenceRow | undefined;
  if (!row) throw new Error('Claim-evidence link disappeared while saving');
  return toClaimEvidence(row);
}

export function listClaimEvidence(taskId: string): ClaimEvidence[] {
  return sqlite.prepare('SELECT * FROM agent_claim_evidence WHERE task_id = ? ORDER BY created_at ASC, rowid ASC').all(taskId)
    .map((row) => toClaimEvidence(row as ClaimEvidenceRow));
}

export function listEvents(taskId: string): AgentEvent[] {
  return sqlite.prepare('SELECT * FROM agent_events WHERE task_id = ? ORDER BY sequence ASC').all(taskId)
    .map((row) => toEvent(row as EventRow));
}

export function appendEvent(taskId: string, type: string, payload: unknown, createdAt: string): AgentEvent {
  const sequenceRow = sqlite.prepare('SELECT COALESCE(MAX(sequence), 0) + 1 AS sequence FROM agent_events WHERE task_id = ?')
    .get(taskId) as { sequence: number };
  const event: AgentEvent = { id: randomUUID(), taskId, sequence: sequenceRow.sequence, type, payload, createdAt };
  sqlite.prepare('INSERT INTO agent_events (id, task_id, sequence, type, payload_json, created_at) VALUES (?, ?, ?, ?, ?, ?)')
    .run(event.id, event.taskId, event.sequence, event.type, JSON.stringify(event.payload), event.createdAt);
  return event;
}

export function insertCheckpoint(taskId: string, version: number, state: AgentCheckpointState, createdAt: string) {
  const checkpoint: AgentCheckpoint = { id: randomUUID(), taskId, version, state, createdAt };
  sqlite.prepare('INSERT INTO agent_checkpoints (id, task_id, version, state_json, created_at) VALUES (?, ?, ?, ?, ?)')
    .run(checkpoint.id, checkpoint.taskId, checkpoint.version, JSON.stringify(checkpoint.state), checkpoint.createdAt);
  return checkpoint;
}

export function getLatestCheckpoint(taskId: string): AgentCheckpoint | undefined {
  const row = sqlite.prepare('SELECT * FROM agent_checkpoints WHERE task_id = ? ORDER BY version DESC LIMIT 1')
    .get(taskId) as CheckpointRow | undefined;
  return row ? toCheckpoint(row) : undefined;
}

export function getToolExecutionByKey(executionKey: string): ToolExecution | undefined {
  const row = sqlite.prepare('SELECT * FROM tool_executions WHERE execution_key = ?').get(executionKey) as ToolExecutionRow | undefined;
  return row ? toToolExecution(row) : undefined;
}

export function insertToolExecution(execution: ToolExecution) {
  sqlite.prepare(`INSERT INTO tool_executions
    (id, task_id, step_id, execution_key, tool_name, status, arguments_json, result_json, error, started_at, completed_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(
      execution.id,
      execution.taskId,
      execution.stepId ?? null,
      execution.executionKey,
      execution.toolName,
      execution.status,
      JSON.stringify(execution.arguments),
      execution.result === undefined ? null : JSON.stringify(execution.result),
      execution.error ?? null,
      execution.startedAt,
      execution.completedAt ?? null
    );
}

export function completeToolExecution(id: string, result: unknown, completedAt: string) {
  sqlite.prepare(`UPDATE tool_executions
    SET status = 'completed', result_json = ?, error = NULL, completed_at = ? WHERE id = ?`)
    .run(JSON.stringify(result), completedAt, id);
  const row = sqlite.prepare('SELECT * FROM tool_executions WHERE id = ?').get(id) as ToolExecutionRow | undefined;
  return row ? toToolExecution(row) : undefined;
}

export function failToolExecution(id: string, error: string, completedAt: string) {
  sqlite.prepare(`UPDATE tool_executions
    SET status = 'failed', error = ?, completed_at = ? WHERE id = ?`)
    .run(error, completedAt, id);
  const row = sqlite.prepare('SELECT * FROM tool_executions WHERE id = ?').get(id) as ToolExecutionRow | undefined;
  return row ? toToolExecution(row) : undefined;
}

export function listToolExecutions(taskId: string): ToolExecution[] {
  return sqlite.prepare('SELECT * FROM tool_executions WHERE task_id = ? ORDER BY started_at ASC').all(taskId)
    .map((row) => toToolExecution(row as ToolExecutionRow));
}

export function insertArtifact(artifact: AgentArtifact) {
  sqlite.prepare(`INSERT INTO agent_artifacts
    (id, task_id, type, title, content, status, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(
      artifact.id,
      artifact.taskId,
      artifact.type,
      artifact.title,
      artifact.content,
      artifact.status,
      artifact.createdAt,
      artifact.updatedAt
    );
}

export function listArtifacts(taskId: string): AgentArtifact[] {
  return sqlite.prepare('SELECT * FROM agent_artifacts WHERE task_id = ? ORDER BY updated_at DESC').all(taskId)
    .map((row) => toArtifact(row as ArtifactRow));
}

export const runInTransaction = sqlite.transaction.bind(sqlite) as <TArgs extends unknown[], TResult>(
  fn: (...args: TArgs) => TResult
) => (...args: TArgs) => TResult;

function toTask(row: TaskRow): AgentTask {
  return {
    id: row.id,
    goal: row.goal,
    status: row.status,
    ...(row.current_step_id ? { currentStepId: row.current_step_id } : {}),
    maxSteps: row.max_steps,
    maxTokens: row.max_tokens,
    allowedTools: parseStringArray(row.allowed_tools_json),
    checkpointVersion: row.checkpoint_version,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function toStep(row: StepRow): AgentPlanStep {
  return {
    id: row.id,
    taskId: row.task_id,
    sequence: row.sequence,
    objective: row.objective,
    expectedEvidence: parseStringArray(row.expected_evidence_json),
    dependencies: parseStringArray(row.dependencies_json),
    status: row.status,
    attempts: row.attempts,
    ...(parseJson(row.input_json) === undefined ? {} : { input: parseJson(row.input_json) }),
    ...(parseJson(row.output_json) === undefined ? {} : { output: parseJson(row.output_json) }),
    ...(row.error ? { error: row.error } : {}),
    ...(row.started_at ? { startedAt: row.started_at } : {}),
    ...(row.completed_at ? { completedAt: row.completed_at } : {}),
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function toEvent(row: EventRow): AgentEvent {
  return {
    id: row.id,
    taskId: row.task_id,
    sequence: row.sequence,
    type: row.type,
    payload: parseJson(row.payload_json),
    createdAt: row.created_at
  };
}

function toCheckpoint(row: CheckpointRow): AgentCheckpoint {
  const state = JSON.parse(row.state_json) as Partial<AgentCheckpointState> & Pick<AgentCheckpointState, 'task' | 'steps'>;
  return {
    id: row.id,
    taskId: row.task_id,
    version: row.version,
    state: {
      task: state.task,
      steps: state.steps,
      reviews: state.reviews ?? [],
      evidenceGaps: state.evidenceGaps ?? [],
      sources: state.sources ?? [],
      evidence: state.evidence ?? [],
      claims: state.claims ?? [],
      claimEvidence: state.claimEvidence ?? []
    },
    createdAt: row.created_at
  };
}

function toReview(row: ReviewRow): AgentReview {
  return {
    id: row.id,
    taskId: row.task_id,
    stepId: row.step_id,
    verdict: row.verdict,
    summary: row.summary,
    supportedClaims: parseStringArray(row.supported_claims_json),
    unsupportedClaims: parseStringArray(row.unsupported_claims_json),
    limitations: parseStringArray(row.limitations_json),
    createdAt: row.created_at
  };
}

function toEvidenceGap(row: EvidenceGapRow): EvidenceGap {
  return {
    id: row.id,
    reviewId: row.review_id,
    taskId: row.task_id,
    stepId: row.step_id,
    description: row.description,
    requiredEvidence: row.required_evidence,
    suggestedQuery: row.suggested_query,
    status: row.status,
    ...(row.supplemental_step_id ? { supplementalStepId: row.supplemental_step_id } : {}),
    createdAt: row.created_at,
    ...(row.resolved_at ? { resolvedAt: row.resolved_at } : {})
  };
}

function toSource(row: SourceRow): AgentSource {
  return {
    id: row.id,
    taskId: row.task_id,
    ...(row.step_id ? { stepId: row.step_id } : {}),
    ...(row.tool_execution_id ? { toolExecutionId: row.tool_execution_id } : {}),
    sourceKey: row.source_key,
    type: row.type,
    title: row.title,
    ...(row.uri ? { uri: row.uri } : {}),
    ...(parseJson(row.metadata_json) === undefined ? {} : { metadata: parseJson(row.metadata_json) }),
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function toAgentEvidence(row: AgentEvidenceRow): AgentEvidence {
  return {
    id: row.id,
    taskId: row.task_id,
    ...(row.step_id ? { stepId: row.step_id } : {}),
    sourceId: row.source_id,
    evidenceKey: row.evidence_key,
    content: row.content,
    ...(row.context ? { context: row.context } : {}),
    ...(parseJson(row.locator_json) === undefined ? {} : { locator: parseJson(row.locator_json) }),
    ...(row.relevance_score === null ? {} : { relevanceScore: row.relevance_score }),
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function toClaim(row: ClaimRow): AgentClaim {
  return {
    id: row.id,
    taskId: row.task_id,
    ...(row.step_id ? { stepId: row.step_id } : {}),
    claimKey: row.claim_key,
    text: row.text,
    status: row.status,
    ...(row.confidence === null ? {} : { confidence: row.confidence }),
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function toClaimEvidence(row: ClaimEvidenceRow): ClaimEvidence {
  return {
    taskId: row.task_id,
    claimId: row.claim_id,
    evidenceId: row.evidence_id,
    relation: row.relation,
    ...(row.rationale ? { rationale: row.rationale } : {}),
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function toToolExecution(row: ToolExecutionRow): ToolExecution {
  return {
    id: row.id,
    taskId: row.task_id,
    ...(row.step_id ? { stepId: row.step_id } : {}),
    executionKey: row.execution_key,
    toolName: row.tool_name,
    status: row.status,
    arguments: parseJson(row.arguments_json),
    ...(parseJson(row.result_json) === undefined ? {} : { result: parseJson(row.result_json) }),
    ...(row.error ? { error: row.error } : {}),
    startedAt: row.started_at,
    ...(row.completed_at ? { completedAt: row.completed_at } : {})
  };
}

function toArtifact(row: ArtifactRow): AgentArtifact {
  return {
    id: row.id,
    taskId: row.task_id,
    type: row.type,
    title: row.title,
    content: row.content,
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function parseStringArray(value: string) {
  const parsed = parseJson(value);
  return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === 'string') : [];
}

function parseJson(value: string | null): unknown {
  if (!value) return undefined;
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return undefined;
  }
}
