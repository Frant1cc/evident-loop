import { toolRegistry, type ToolContext } from './registry.js';

export async function executeToolCall(name: string, args: unknown, context?: ToolContext) {
  const tool = toolRegistry[name];

  if (!tool) {
    throw new Error(`Unknown tool: ${name}`);
  }

  return tool.execute(args, context);
}
