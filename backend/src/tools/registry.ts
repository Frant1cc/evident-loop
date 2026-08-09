import { builtInToolModules } from './catalog/index.js';
import type { ToolCatalog, ToolModule } from './contracts.js';

export function createToolCatalog(modules: ToolModule[]): ToolCatalog {
  const catalog = new Map<string, ToolModule>();

  for (const tool of modules) {
    const name = tool.definition.function.name;
    if (catalog.has(name)) throw new Error(`Duplicate tool registration: ${name}`);
    catalog.set(name, tool);
  }

  return catalog;
}

/** The composition root for built-in tools. Feature modules own their definitions and executors. */
export const toolCatalog = createToolCatalog(builtInToolModules);
