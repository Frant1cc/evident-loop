export type AgentTaskStatus =
  | 'created'
  | 'planning'
  | 'awaiting_approval'
  | 'running'
  | 'paused'
  | 'completed'
  | 'failed'
  | 'cancelled';

export type PlanStepStatus = 'pending' | 'running' | 'completed' | 'failed' | 'blocked' | 'skipped';
export type AgentReviewVerdict = 'pass' | 'needs_more_evidence';
export type EvidenceGapStatus = 'open' | 'scheduled' | 'resolved' | 'unresolved';
export type AgentSourceType = 'knowledge_document' | 'document' | 'web' | 'tool_result' | 'other';
export type AgentClaimStatus = 'proposed' | 'supported' | 'unsupported' | 'conflicted';
export type ClaimEvidenceRelation = 'supports' | 'contradicts' | 'context';
export type ToolPolicy =
  | { mode: 'all' }
  | { mode: 'selected'; names: string[] }
  | { mode: 'none' };

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

export type AgentEvent = {
  id: string;
  taskId: string;
  sequence: number;
  type: string;
  payload: unknown;
  createdAt: string;
};

export type AgentReview = {
  id: string;
  taskId: string;
  stepId: string;
  verdict: AgentReviewVerdict;
  summary: string;
  supportedClaims: string[];
  unsupportedClaims: string[];
  limitations: string[];
  createdAt: string;
};

export type EvidenceGap = {
  id: string;
  reviewId: string;
  taskId: string;
  stepId: string;
  description: string;
  requiredEvidence: string;
  suggestedQuery: string;
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

export type ToolExecution = {
  id: string;
  taskId: string;
  stepId?: string;
  executionKey: string;
  toolName: string;
  status: 'running' | 'completed' | 'failed';
  arguments: unknown;
  result?: unknown;
  error?: string;
  startedAt: string;
  completedAt?: string;
};

export type AgentCheckpoint = {
  id: string;
  taskId: string;
  version: number;
  state: {
    task: AgentTask;
    steps: AgentPlanStep[];
    reviews: AgentReview[];
    evidenceGaps: EvidenceGap[];
    sources: AgentSource[];
    evidence: AgentEvidence[];
    claims: AgentClaim[];
    claimEvidence: ClaimEvidence[];
  };
  createdAt: string;
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

export type AgentArtifactLibraryItem = AgentArtifact & {
  taskGoal: string;
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
  latestCheckpoint?: AgentCheckpoint;
  approvals?: import('./approvals').ToolApproval[];
};
