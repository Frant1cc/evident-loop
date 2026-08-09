export type ToolDefinition = {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: {
      type: 'object';
      properties: Record<string, unknown>;
      required: string[];
    };
  };
};

export type ToolContext = {
  /** Aborted when the request is cancelled. Long-running tools should observe it. */
  signal?: AbortSignal;
};

export type ToolTrace = {
  id: string;
  name: string;
  arguments: unknown;
  result?: unknown;
  error?: string;
};

export type ToolModule = {
  /** Chinese display name for UI surfaces. The model sees the function name. */
  label: string;
  /** Internal tools remain executable but are omitted from model-facing catalogs. */
  exposedToModel?: boolean;
  definition: ToolDefinition;
  execute: (args: unknown, context?: ToolContext) => unknown | Promise<unknown>;
};

export type ToolCatalog = ReadonlyMap<string, ToolModule>;
