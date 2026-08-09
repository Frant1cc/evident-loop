import type { ToolCatalog } from './contracts.js';
import { toolCatalog } from './registry.js';

export function getToolDefinitions(catalog: ToolCatalog = toolCatalog) {
  return [...catalog.values()]
    .filter((tool) => tool.exposedToModel !== false)
    .map((tool) => tool.definition);
}
