export const agentTaskStatuses = [
  'created',
  'planning',
  'awaiting_approval',
  'running',
  'paused',
  'completed',
  'failed',
  'cancelled'
] as const;

export type AgentTaskStatus = typeof agentTaskStatuses[number];
export type PlanStepStatus = 'pending' | 'running' | 'completed' | 'failed' | 'blocked' | 'skipped';
export type ToolExecutionStatus = 'running' | 'completed' | 'failed';
export type AgentReviewVerdict = 'pass' | 'needs_more_evidence';
export type EvidenceGapStatus = 'open' | 'scheduled' | 'resolved' | 'unresolved';
export type AgentSourceType = 'knowledge_document' | 'document' | 'web' | 'tool_result' | 'other';
export type AgentClaimStatus = 'proposed' | 'supported' | 'unsupported' | 'conflicted';
export type ClaimEvidenceRelation = 'supports' | 'contradicts' | 'context';

export type AgentTask = {
  id: string;
  goal: string;
  status: AgentTaskStatus;
  currentStepId?: string;
  maxSteps: number;
  maxTokens: number;
  toolPolicy: ToolPolicy;
  checkpointVersion: number;
  createdAt: string;
  updatedAt: string;
};

export type AgentPlanStep = {
  id: string;
  taskId: string;
  sequence: number;
  objective: string;
  expectedEvidence: string[];
  dependencies: string[];
  status: PlanStepStatus;
  attempts: number;
  input?: unknown;
  output?: unknown;
  error?: string;
  startedAt?: string;
  completedAt?: string;
  createdAt: string;
  updatedAt: string;
};

export type PlanStepDraft = {
  objective: string;
  expectedEvidence: string[];
};

export type EvidenceGapDraft = {
  description: string;
  requiredEvidence: string;
  suggestedQuery: string;
};

export type AgentReviewDraft = {
  verdict: AgentReviewVerdict;
  summary: string;
  supportedClaims: string[];
  unsupportedClaims: string[];
  limitations: string[];
  evidenceGaps: EvidenceGapDraft[];
};

export type AgentReview = Omit<AgentReviewDraft, 'evidenceGaps'> & {
  id: string;
  taskId: string;
  stepId: string;
  createdAt: string;
};

export type EvidenceGap = EvidenceGapDraft & {
  id: string;
  reviewId: string;
  taskId: string;
  stepId: string;
  status: EvidenceGapStatus;
  supplementalStepId?: string;
  createdAt: string;
  resolvedAt?: string;
};

export type AgentSource = {
  id: string;
  taskId: string;
  stepId?: string;
  toolExecutionId?: string;
  sourceKey: string;
  type: AgentSourceType;
  title: string;
  uri?: string;
  metadata?: unknown;
  createdAt: string;
  updatedAt: string;
};

export type AgentEvidence = {
  id: string;
  taskId: string;
  stepId?: string;
  sourceId: string;
  evidenceKey: string;
  content: string;
  context?: string;
  locator?: unknown;
  relevanceScore?: number;
  createdAt: string;
  updatedAt: string;
};

export type AgentClaim = {
  id: string;
  taskId: string;
  stepId?: string;
  claimKey: string;
  text: string;
  status: AgentClaimStatus;
  confidence?: number;
  createdAt: string;
  updatedAt: string;
};

export type ClaimEvidence = {
  taskId: string;
  claimId: string;
  evidenceId: string;
  relation: ClaimEvidenceRelation;
  rationale?: string;
  createdAt: string;
  updatedAt: string;
};

export type EvidenceChainDraft = {
  sources: Array<{
    sourceKey: string;
    type: AgentSourceType;
    title: string;
    uri?: string;
    toolExecutionId?: string;
    metadata?: unknown;
  }>;
  evidence: Array<{
    evidenceKey: string;
    sourceKey: string;
    content: string;
    context?: string;
    locator?: unknown;
    relevanceScore?: number;
  }>;
  claims: Array<{
    claimKey: string;
    text: string;
    status: AgentClaimStatus;
    confidence?: number;
  }>;
  links: Array<{
    claimKey: string;
    evidenceKey: string;
    relation: ClaimEvidenceRelation;
    rationale?: string;
  }>;
};

export type AgentEvent = {
  id: string;
  taskId: string;
  sequence: number;
  type: string;
  payload: unknown;
  createdAt: string;
};

export type AgentCheckpointState = {
  task: AgentTask;
  steps: AgentPlanStep[];
  reviews: AgentReview[];
  evidenceGaps: EvidenceGap[];
  sources: AgentSource[];
  evidence: AgentEvidence[];
  claims: AgentClaim[];
  claimEvidence: ClaimEvidence[];
};

export type AgentCheckpoint = {
  id: string;
  taskId: string;
  version: number;
  state: AgentCheckpointState;
  createdAt: string;
};

export type ToolExecution = {
  id: string;
  taskId: string;
  stepId?: string;
  executionKey: string;
  toolName: string;
  status: ToolExecutionStatus;
  arguments: unknown;
  result?: unknown;
  error?: string;
  startedAt: string;
  completedAt?: string;
};

export type AgentArtifact = {
  id: string;
  taskId: string;
  type: 'report';
  title: string;
  content: string;
  status: 'completed';
  createdAt: string;
  updatedAt: string;
};

export type AgentTaskDetail = {
  task: AgentTask;
  steps: AgentPlanStep[];
  reviews: AgentReview[];
  evidenceGaps: EvidenceGap[];
  sources: AgentSource[];
  evidence: AgentEvidence[];
  claims: AgentClaim[];
  claimEvidence: ClaimEvidence[];
  toolExecutions: ToolExecution[];
  artifacts: AgentArtifact[];
  approvals?: import('../approvals/contracts.js').ToolApprovalDto[];
  latestCheckpoint?: AgentCheckpoint;
};
import type { ToolPolicy } from '../tools/contracts.js';
