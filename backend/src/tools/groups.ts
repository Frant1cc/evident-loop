import type { ToolModule } from './contracts.js';

export type ToolGroupDefinition = {
  id: string;
  label: string;
  description: string;
  toolNames: string[];
};

export const builtInToolGroups: ToolGroupDefinition[] = [
  {
    id: 'knowledge',
    label: '知识库',
    description: '检索知识库，并在需要时阅读相关文档。',
    toolNames: ['search_knowledge', 'read_document']
  }
];

export function validateToolGroups(
  groups: ToolGroupDefinition[],
  modules: ToolModule[]
): ToolGroupDefinition[] {
  const modelTools = new Set(
    modules.filter((tool) => tool.exposedToModel !== false).map((tool) => tool.definition.function.name)
  );
  const internalTools = new Set(
    modules.filter((tool) => tool.exposedToModel === false).map((tool) => tool.definition.function.name)
  );
  const groupIds = new Set<string>();
  const groupedTools = new Set<string>();
  const validated: ToolGroupDefinition[] = [];

  for (const group of groups) {
    if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(group.id)) {
      throw new Error(`Invalid tool group id: ${group.id}`);
    }
    if (groupIds.has(group.id)) throw new Error(`Duplicate tool group id: ${group.id}`);
    groupIds.add(group.id);

    const names = group.toolNames.map((name) => name.trim()).filter(Boolean);
    if (!names.length) throw new Error(`Tool group ${group.id} must contain at least one tool`);
    if (new Set(names).size !== names.length) throw new Error(`Duplicate tool in group ${group.id}`);

    for (const name of names) {
      if (internalTools.has(name)) throw new Error(`Internal tool ${name} cannot be in a visible tool group`);
      if (!modelTools.has(name)) throw new Error(`Unknown tool ${name} in group ${group.id}`);
      if (groupedTools.has(name)) throw new Error(`Tool ${name} belongs to more than one visible tool group`);
      groupedTools.add(name);
    }
    validated.push({ ...group, toolNames: names });
  }

  return validated;
}
