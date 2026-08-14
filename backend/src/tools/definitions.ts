import type { ToolCatalog } from './contracts.js';
import { builtInToolRuntime, createToolRuntime } from './runtime.js';

export function getToolDefinitions(catalog?: ToolCatalog) {
  return (catalog ? createToolRuntime(catalog) : builtInToolRuntime).getDefinitions();
}
