import type { LlmProvider } from '../../llm/contracts.js';
import { LlmNotConfiguredError } from '../../llm/errors.js';
import { buildResearchContext } from '../../research/context.js';
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
  updateResearchNote
} from '../../research/store.js';
import { getToolDefinitions } from '../../tools/definitions.js';
import type { ToolCatalog } from '../../tools/contracts.js';
import { getMaxSequence, listStreamEventsAfter } from '../../streaming/eventStore.js';

export type ResearchApplicationDependencies = {
  llm?: LlmProvider;
  model: string;
  tools: ToolCatalog;
};

/** Use-case boundary for research conversations and durable background runs. */
export function createResearchApplication(dependencies: ResearchApplicationDependencies) {
  const requireLlm = () => {
    if (!dependencies.llm) throw new LlmNotConfiguredError();
    return dependencies.llm;
  };

  return {
    listTools: () => [...dependencies.tools.values()]
      .filter((tool) => tool.exposedToModel !== false)
      .map((tool) => ({
        name: tool.definition.function.name,
        label: tool.label,
        description: tool.definition.function.description
      })),
    normalizeAllowedTools: (value: unknown) => {
      if (!Array.isArray(value)) return undefined;
      const registered = new Set(getToolDefinitions(dependencies.tools).map((tool) => tool.function.name));
      return value.filter((name): name is string => typeof name === 'string' && registered.has(name));
    },
    listConversations: listResearchConversations,
    createConversation: createResearchConversation,
    getConversation: (id: string) => {
      const conversation = getResearchConversation(id);
      if (!conversation) return undefined;
      const { promptPreview } = buildResearchContext(conversation, listResearchMessages(id), '');
      return getResearchConversationDetail(id, promptPreview);
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
    startMessage: (conversationId: string, content: string, allowedTools?: string[]) =>
      createAndStartResearchRun({
        conversationId,
        content,
        allowedToolNames: allowedTools,
        llm: requireLlm(),
        model: dependencies.model
      }),
    getRun: getResearchRun,
    getRunSnapshot: getResearchRunSnapshot,
    subscribeToRun: subscribeToResearchRun,
    getStreamEventsAfter: listStreamEventsAfter,
    getStreamMaxSequence: getMaxSequence,
    cancelRun: cancelResearchRun
  };
}

export type ResearchApplication = ReturnType<typeof createResearchApplication>;
