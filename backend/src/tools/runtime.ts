import type { ToolCatalog, ToolContext, ToolDefinition, ToolPolicy, ToolRuntime } from './contracts.js';
import { toolCatalog } from './registry.js';

export function createToolRuntime(catalog: ToolCatalog): ToolRuntime {
  return {
    listModules: () => [...catalog.values()],
    getDefinitions: (policy = { mode: 'all' }) => filterDefinitions(catalog, policy),
    execute: async (name: string, args: unknown, context?: ToolContext) => {
      const tool = catalog.get(name);
      if (!tool) throw new Error(`Unknown tool: ${name}`);
      return tool.execute(args, context);
    }
  };
}

function filterDefinitions(catalog: ToolCatalog, policy: ToolPolicy): ToolDefinition[] {
  if (policy.mode === 'none') return [];
  const selected = policy.mode === 'selected' ? new Set(policy.names) : undefined;
  return [...catalog.values()]
    .filter((tool) => tool.exposedToModel !== false)
    .filter((tool) => !selected || selected.has(tool.definition.function.name))
    .map((tool) => tool.definition);
}

export const builtInToolRuntime = createToolRuntime(toolCatalog);
