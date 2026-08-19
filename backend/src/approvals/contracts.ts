import type {
  ToolCall,
  ToolContext,
  ToolRuntime,
  ToolSnapshot
} from '../tools/contracts.js';

export const approvalScopeTypes = ['research_run', 'agent_task'] as const;
export type ApprovalScopeType = typeof approvalScopeTypes[number];

export type ToolApprovalScope = {
  type: ApprovalScopeType;
  id: string;
};

export const toolApprovalStatuses = [
  'pending',
  'approved',
  'rejected',
  'expired',
  'cancelled',
  'invalidated'
] as const;
export type ToolApprovalStatus = typeof toolApprovalStatuses[number];

export type ToolApprovalDecision = 'approve' | 'reject';

/** The persisted representation. Arguments are retained for execution and are never sent directly by HTTP. */
export type ToolApprovalRecord = {
  id: string;
  scope: ToolApprovalScope;
  toolCallId: string;
  toolName: string;
  modelName: string;
  label: string;
  source: string;
  serverId?: string;
  serverName?: string;
  remoteName?: string;
  readOnly: boolean;
  arguments: unknown;
  definitionHash: string;
  status: ToolApprovalStatus;
  requestedAt: string;
  decidedAt?: string;
};

/** Safe API/event representation. Sensitive argument keys are redacted by the manager. */
export type ToolApprovalDto = Omit<ToolApprovalRecord, 'arguments'> & {
  arguments: unknown;
};

export type ApprovalAuthorizationRequest = {
  runtime: ToolRuntime;
  snapshot: ToolSnapshot;
  toolCall: ToolCall;
  scope: ToolApprovalScope;
  context?: ToolContext;
  onRequested?: (approval: ToolApprovalDto) => void | Promise<void>;
  onResolved?: (approval: ToolApprovalDto) => void | Promise<void>;
};

export type ApprovalStore = {
  ensureSchema: () => void;
  expirePending: (now: string) => number;
  create: (input: Omit<ToolApprovalRecord, 'id' | 'status' | 'decidedAt'>) => ToolApprovalRecord;
  get: (id: string) => ToolApprovalRecord | undefined;
  list: (scope?: ToolApprovalScope) => ToolApprovalRecord[];
  findPending: (scope: ToolApprovalScope, toolCallId: string) => ToolApprovalRecord | undefined;
  decide: (id: string, status: Extract<ToolApprovalStatus, 'approved' | 'rejected'>, decidedAt: string) => ToolApprovalRecord | undefined;
  transition: (id: string, from: ToolApprovalStatus, to: ToolApprovalStatus, decidedAt: string) => ToolApprovalRecord | undefined;
};

export type ApprovalManager = {
  authorize: (request: ApprovalAuthorizationRequest) => Promise<void>;
  /** Convenience seam for callers that want approval and snapshot execution as one operation. */
  execute: (request: ApprovalAuthorizationRequest) => Promise<unknown>;
  get: (id: string) => ToolApprovalDto | undefined;
  list: (scope?: ToolApprovalScope) => ToolApprovalDto[];
  decide: (id: string, decision: ToolApprovalDecision) => ToolApprovalDto;
  cancelScope: (scope: ToolApprovalScope) => ToolApprovalDto[];
  expirePending: () => number;
};

export type ApprovalManagerOptions = {
  store?: ApprovalStore;
  now?: () => Date;
};

export class ApprovalDecisionConflictError extends Error {
  readonly statusCode = 409;

  constructor(message = 'Tool approval is no longer pending') {
    super(message);
    this.name = 'ApprovalDecisionConflictError';
  }
}

export class ApprovalNotFoundError extends Error {
  readonly statusCode = 404;

  constructor(id: string) {
    super(`Tool approval not found: ${id}`);
    this.name = 'ApprovalNotFoundError';
  }
}
