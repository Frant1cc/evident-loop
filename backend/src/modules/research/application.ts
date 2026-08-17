import type { LlmProvider } from '../../llm/contracts.js';
import { LlmNotConfiguredError } from '../../llm/errors.js';
import { buildResearchContext } from '../../context/research/history.js';
import {
  cancelResearchRun,
  createAndStartResearchRun,
  getResearchRunSnapshot,
  subscribeToResearchRun
} from '../../research/service.js';
import {
  createResearchConversation,
  createResearchNote,
  deleteResearchConversation,
  deleteResearchNote,
  getActiveResearchRun,
  getResearchConversation,
  getResearchConversationDetail,
  getResearchRun,
  listResearchConversations,
  listResearchMessages,
  listResearchSteps,
  updateResearchNote
} from '../../research/store.js';
import type { ToolPolicy, ToolRuntime } from '../../tools/contracts.js';
import type { ApprovalManager } from '../../approvals/contracts.js';
import { normalizeToolPolicy, restrictToolPolicyToRegistered } from '../../tools/policy.js';
import type { ResearchSkillRuntime } from '../../skills/runtime.js';
import { builtInToolGroups, validateToolGroups, type ToolGroupDefinition } from '../../tools/groups.js';
import type { ResolvedResearchSkill } from '../../skills/contracts.js';
import { getMaxSequence, listStreamEventsAfter } from '../../streaming/eventStore.js';

export type ResearchApplicationDependencies = {
  llm?: LlmProvider;
  model: string;
  toolRuntime: ToolRuntime;
  skillRuntime: ResearchSkillRuntime;
  toolGroups?: ToolGroupDefinition[];
  approvalManager?: ApprovalManager;
};

/** Use-case boundary for research conversations and durable background runs. */
export function createResearchApplication(dependencies: ResearchApplicationDependencies) {
  const toolGroups = validateToolGroups(dependencies.toolGroups ?? builtInToolGroups, dependencies.toolRuntime.listModules());
  const requireLlm = () => {
    if (!dependencies.llm) throw new LlmNotConfiguredError();
    return dependencies.llm;
  };

  return {
    listTools: () => dependencies.toolRuntime.listModules()
      .filter((tool) => tool.exposedToModel !== false)
      .map((tool) => ({
        name: tool.definition.function.name,
        label: tool.label,
        description: tool.definition.function.description
      })),
    listToolGroups: () => toolGroups.map((group) => ({ ...group, toolNames: [...group.toolNames] })),
    listSkills: () => dependencies.skillRuntime.list(),
    normalizeToolPolicy: (value: unknown): ToolPolicy => {
      const registered = new Set(
        dependencies.toolRuntime.getDefinitions().map((tool) => tool.function.name)
      );
      return restrictToolPolicyToRegistered(normalizeToolPolicy(value), registered);
    },
    listConversations: listResearchConversations,
    createConversation: createResearchConversation,
    getConversation: (id: string) => {
      const conversation = getResearchConversation(id);
      if (!conversation) return undefined;
      const { promptPreview } = buildResearchContext(conversation, listResearchMessages(id), '', listResearchSteps(id));
       const detail = getResearchConversationDetail(id, promptPreview);
       if (!detail || !dependencies.approvalManager) return detail;
       return {
         ...detail,
         approvals: detail.activeRun
           ? dependencies.approvalManager.list({ type: 'research_run', id: detail.activeRun.id })
           : []
       };
    },
    deleteConversation: (id: string) => {
      if (getActiveResearchRun(id)) throw new Error('Stop the active research task before deleting this conversation');
      return deleteResearchConversation(id);
    },
    createNote: (conversationId: string, content: string) => {
      if (!getResearchConversation(conversationId)) return undefined;
      return createResearchNote(conversationId, content);
    },
    updateNote: updateResearchNote,
    deleteNote: deleteResearchNote,
    startMessage: (
      conversationId: string,
      content: string,
      toolPolicy: ToolPolicy,
      skillId?: string
    ) => {
      const registered = new Set(
        dependencies.toolRuntime.getDefinitions().map((tool) => tool.function.name)
      );
      const skill = skillId
        ? resolveSkillForRun(dependencies.skillRuntime, skillId, toolPolicy, registered)
        : undefined;
      return createAndStartResearchRun({
        conversationId,
        content,
        toolPolicy,
        toolRuntime: dependencies.toolRuntime,
        skill: skill?.snapshot,
        skillRuntime: dependencies.skillRuntime,
        llm: requireLlm(),
        model: dependencies.model,
        approvalManager: dependencies.approvalManager
      });
    },
    getRun: getResearchRun,
    getRunSnapshot: (id: string) => getResearchRunSnapshot(id, dependencies.approvalManager),
    subscribeToRun: subscribeToResearchRun,
    getStreamEventsAfter: listStreamEventsAfter,
    getStreamMaxSequence: getMaxSequence,
    cancelRun: cancelResearchRun
  };
}

export type ResearchApplication = ReturnType<typeof createResearchApplication>;

/** Thrown when a run selects a skill whose required tools are not authorized. */
export class ResearchSkillToolError extends Error {}

/** Thrown when a run references a skill id that is not registered. */
export class UnknownResearchSkillError extends Error {}

/**
 * Resolve the latest version of a skill and confirm the user's ToolPolicy already
 * authorizes every required tool. A skill never widens the policy (§4.4, §9).
 */
function resolveSkillForRun(
  skillRuntime: ResearchSkillRuntime,
  skillId: string,
  toolPolicy: ToolPolicy,
  registeredNames: Set<string>
): ResolvedResearchSkill {
  let resolved: ResolvedResearchSkill;
  try {
    resolved = skillRuntime.resolveLatest(skillId);
  } catch {
    throw new UnknownResearchSkillError(`未知技能：${skillId}`);
  }

  const authorized = authorizedToolNames(toolPolicy, registeredNames);
  const missing = resolved.definition.tools.required.filter((name) => !authorized.has(name));
  if (missing.length) {
    throw new ResearchSkillToolError(
      `技能“${resolved.definition.label}”需要启用工具：${missing.join('、')}`
    );
  }
  return resolved;
}

function authorizedToolNames(policy: ToolPolicy, registeredNames: Set<string>): Set<string> {
  if (policy.mode === 'all') return new Set(registeredNames);
  if (policy.mode === 'none') return new Set();
  return new Set(policy.names.filter((name) => registeredNames.has(name)));
}
