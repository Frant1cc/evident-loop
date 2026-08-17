import type { ToolPolicy } from '../tools/contracts.js';
import type { ResearchSkillSnapshot } from '../skills/contracts.js';

export type ResearchExecutionMode = 'quick' | 'research';

/**
 * Derive how a run executes from its final configuration (§3.1). A run is a quick
 * conversation only when it selects no skill and enables no tools; any skill or any
 * authorized tool upgrades it to the research agent. A skill never widens the policy.
 */
export function resolveExecutionMode(
  skill: ResearchSkillSnapshot | undefined,
  toolPolicy: ToolPolicy
): ResearchExecutionMode {
  return !skill && toolPolicy.mode === 'none' ? 'quick' : 'research';
}
