import type { ToolCatalog, ToolContext } from './contracts.js';
import { builtInToolRuntime, createToolRuntime } from './runtime.js';

export async function executeToolCall(
  name: string,
  args: unknown,
  context?: ToolContext,
  catalog?: ToolCatalog
) {
  return (catalog ? createToolRuntime(catalog) : builtInToolRuntime).execute(name, args, context);
}
