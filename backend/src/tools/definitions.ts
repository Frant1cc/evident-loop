import { toolRegistry } from './registry.js';

export function getToolDefinitions() {
  return Object.values(toolRegistry).map((tool) => tool.definition);
}
