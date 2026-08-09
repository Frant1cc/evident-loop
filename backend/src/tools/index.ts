import type { ToolCatalog, ToolContext } from './contracts.js';
import { toolCatalog } from './registry.js';

export async function executeToolCall(
  name: string,
  args: unknown,
  context?: ToolContext,
  catalog: ToolCatalog = toolCatalog
) {
  const tool = catalog.get(name);

  if (!tool) {
    throw new Error(`Unknown tool: ${name}`);
  }

  return tool.execute(args, context);
}
