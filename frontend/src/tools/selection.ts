import type { ResearchToolGroupInfo, ResearchToolInfo } from '../api/research';
import type { ToolPolicy } from '../types/tasks';

export function standaloneTools(tools: ResearchToolInfo[], groups: ResearchToolGroupInfo[]) {
  const grouped = new Set(groups.flatMap((group) => group.toolNames));
  return tools.filter((tool) => !grouped.has(tool.name));
}

export function expandSelectedTools(
  groups: ResearchToolGroupInfo[],
  enabledGroups: Record<string, boolean>,
  enabledStandalone: Record<string, boolean>
) {
  const names = new Set<string>();
  for (const group of groups) {
    if (enabledGroups[group.id]) group.toolNames.forEach((name) => names.add(name));
  }
  for (const [name, enabled] of Object.entries(enabledStandalone)) {
    if (enabled) names.add(name);
  }
  return [...names];
}

export function buildSelectedToolPolicy(
  groups: ResearchToolGroupInfo[],
  enabledGroups: Record<string, boolean>,
  enabledStandalone: Record<string, boolean>
): ToolPolicy {
  const names = expandSelectedTools(groups, enabledGroups, enabledStandalone);
  return names.length ? { mode: 'selected', names } : { mode: 'none' };
}

export function requiredGroupIds(groups: ResearchToolGroupInfo[], requiredTools: string[]) {
  const required = new Set(requiredTools);
  return new Set(groups.filter((group) => group.toolNames.some((name) => required.has(name))).map((group) => group.id));
}
