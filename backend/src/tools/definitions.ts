import { toolRegistry } from './registry.js';

export function getToolDefinitions() {
  return Object.values(toolRegistry)
    .filter((tool) => tool.exposedToModel !== false)
    .map((tool) => tool.definition);
}
