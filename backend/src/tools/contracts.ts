import type { ZodType } from 'zod';
import type { RagSource } from '../rag/types.js';

export type JsonSchema = {
  type: 'object';
  properties?: Record<string, unknown>;
  required?: string[];
  [key: string]: unknown;
};

export type ToolDefinition = {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: JsonSchema;
  };
};

export type ToolContext = {
  /** Aborted when the request is cancelled. Long-running tools should observe it. */
  signal?: AbortSignal;
  /**
   * The conversation this tool call belongs to. Optional: tools that need scoping to a
   * conversation (e.g. read_evidence) require it; stateless tools (calculator) can ignore it.
   */
  conversationId?: string;
  /** Explicit caller scope used by approval and durable execution seams. */
  toolScope?: ToolScope;
  /** Reports bounded, user-facing progress for long-running tools. */
  onProgress?: (progress: ToolProgress) => void | Promise<void>;
  /** Publishes an accepted source as soon as a long-running tool validates it. */
  onSource?: (source: RagSource) => void | Promise<void>;
};

export type ToolProgress = {
  stage: string;
  message: string;
  kind?: 'phase' | 'search' | 'page' | 'evidence' | 'coverage' | 'rewrite';
  status?: 'running' | 'completed' | 'warning';
  query?: string;
  url?: string;
  title?: string;
  detail?: string;
  current?: number;
  total?: number;
  coveredClaims?: number;
  totalClaims?: number;
};

export type ToolTrace = {
  id: string;
  name: string;
  arguments: unknown;
  result?: unknown;
  error?: string;
  errorDetails?: ToolExecutionErrorDetails;
};

export type ToolExecutionErrorCode =
  | 'unknown_tool'
  | 'unauthorized'
  | 'unavailable'
  | 'invalid_arguments'
  | 'schema_changed'
  | 'tool_rejected'
  | 'cancelled'
  | 'tool_limit_reached'
  | 'execution_failed';

export type ToolExecutionErrorDetails = {
  code: ToolExecutionErrorCode;
  message: string;
  retryable: boolean;
  reason?: string;
};

/** A stable, model-facing error shape used by tool adapters and agent traces. */
export class ToolExecutionError extends Error {
  readonly code: ToolExecutionErrorCode;
  readonly retryable: boolean;
  readonly reason?: string;

  constructor(details: ToolExecutionErrorDetails) {
    super(details.message);
    this.name = 'ToolExecutionError';
    this.code = details.code;
    this.retryable = details.retryable;
    this.reason = details.reason;
  }

  toDetails(): ToolExecutionErrorDetails {
    return {
      code: this.code,
      message: this.message,
      retryable: this.retryable,
      ...(this.reason ? { reason: this.reason } : {})
    };
  }
}

export type ToolAvailability = {
  status: 'available' | 'unavailable';
  reason?: string;
  retryable?: boolean;
};

export type ToolAnnotations = {
  /** MCP readOnlyHint; absence is treated as potentially side-effecting. */
  readOnlyHint?: boolean;
  [key: string]: unknown;
};

export type ToolModule = {
  /** Chinese display name for UI surfaces. The model sees the function name. */
  label: string;
  /** Internal tools remain executable but are omitted from model-facing catalogs. */
  exposedToModel?: boolean;
  definition: ToolDefinition;
  /** Zod is the source of truth for built-in input validation and JSON schema generation. */
  inputSchema?: ZodType;
  /** Dynamic providers can retain a definition while temporarily unavailable. */
  availability?: ToolAvailability | (() => ToolAvailability);
  /** Source metadata is intentionally provider-neutral so MCP adapters do not leak SDK types. */
  source?: 'builtin' | 'mcp' | string;
  sourceInfo?: {
    serverId?: string;
    serverName?: string;
    remoteName?: string;
  };
  annotations?: ToolAnnotations;
  execute: (args: unknown, context?: ToolContext) => unknown | Promise<unknown>;
};

export type ToolCatalog = ReadonlyMap<string, ToolModule>;

export type ToolScope =
  | string
  | {
      kind?: string;
      userId?: string;
      conversationId?: string;
      runId?: string;
      taskId?: string;
      [key: string]: unknown;
    };

export type ToolCall = {
  id?: string;
  name: string;
  arguments: unknown;
};

export type ToolSnapshot = Readonly<{
  version: number;
  scope?: ToolScope;
  policy: ToolPolicy;
  definitions: readonly ToolDefinition[];
  toolNames: ReadonlySet<string>;
  definitionHashes: ReadonlyMap<string, string>;
  /** Internal module view used by execute; callers should treat it as immutable. */
  modules: ReadonlyMap<string, ToolModule>;
}>;

export type ToolPolicy =
  | { mode: 'all' }
  | { mode: 'selected'; names: string[] }
  | { mode: 'none' };

export type ToolRuntime = {
  listModules: () => ToolModule[];
  getDefinitions: (policy?: ToolPolicy) => ToolDefinition[];
  getSnapshot: (policy?: ToolPolicy, scope?: ToolScope) => ToolSnapshot;
  listCatalog: () => ToolModule[];
  execute: {
    (snapshot: ToolSnapshot, toolCall: ToolCall, context?: ToolContext): Promise<unknown>;
    /** Compatibility overload for existing application/runtime callers. */
    (name: string, args: unknown, context?: ToolContext): Promise<unknown>;
  };
  /** Validate and normalize arguments before a custom audited executor runs. */
  validate?: (snapshot: ToolSnapshot, toolCall: ToolCall) => unknown;
  register?: (module: ToolModule) => void;
  upsert?: (module: ToolModule) => void;
  unregister?: (name: string) => void;
};
