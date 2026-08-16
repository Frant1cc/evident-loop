import type { ChatMessage } from '../../agent/types.js';
import type { ResearchConversation, ResearchMessage, ResearchPromptPreview, ResearchStep } from '../../research/types.js';

export function buildResearchContext(
  conversation: ResearchConversation,
  messages: ResearchMessage[],
  currentMessage: string,
  steps: ResearchStep[] = []
): { messages: ChatMessage[]; promptPreview: ResearchPromptPreview } {
  const completeMessages = messages.filter((message) => message.status === 'complete');
  const context: ChatMessage[] = [];

  if (conversation.summary) {
    context.push({
      role: 'system',
      content: `Research memory summary:\n${conversation.summary}`
    });
  }

  if (conversation.topic) {
    context.push({ role: 'system', content: `Current research topic: ${conversation.topic}` });
  }

  context.push(
    ...rebuildResearchHistory(completeMessages, steps)
  );

  return {
    messages: context,
    promptPreview: {
      topic: conversation.topic,
      summary: conversation.summary,
      historyMessageCount: completeMessages.length,
      currentMessage
    }
  };
}

/**
 * Replays newly persisted native tool-call pairs. Rows created before the durable protocol fields
 * are deliberately ignored: inventing tool_call_id values would create invalid provider messages.
 */
export function rebuildResearchHistory(messages: ResearchMessage[], steps: ResearchStep[]): ChatMessage[] {
  const context: ChatMessage[] = [];
  const stepsByMessage = new Map<string, ResearchStep[]>();
  for (const step of steps) {
    const entries = stepsByMessage.get(step.messageId) ?? [];
    entries.push(step);
    stepsByMessage.set(step.messageId, entries);
  }

  for (const message of messages) {
    if (message.role === 'user') {
      context.push({ role: 'user', content: message.content });
      continue;
    }

    const messageSteps = stepsByMessage.get(message.id) ?? [];
    const toolStepsByParent = new Map<string, ResearchStep[]>();
    for (const step of messageSteps) {
      if (step.type !== 'tool' || !step.parentStepId || !step.toolCallId) continue;
      const children = toolStepsByParent.get(step.parentStepId) ?? [];
      children.push(step);
      toolStepsByParent.set(step.parentStepId, children);
    }
    for (const llmStep of messageSteps.filter((step) => step.type === 'llm').sort((a, b) => a.sequence - b.sequence)) {
      const assistantMessage = asToolCallAssistantMessage(llmStep.output);
      if (!assistantMessage) continue;
      const toolSteps = toolStepsByParent.get(llmStep.id) ?? [];
      const byCallId = new Map(toolSteps.map((step) => [step.toolCallId!, step]));
      // Tool protocol pairs must be whole: do not inject incomplete (or legacy) pairs.
      if (!assistantMessage.tool_calls!.every((toolCall) => byCallId.has(toolCall.id))) continue;
      context.push(assistantMessage);
      for (const toolCall of assistantMessage.tool_calls!) {
        const toolStep = byCallId.get(toolCall.id)!;
        context.push({
          role: 'tool',
          tool_call_id: toolCall.id,
          content: JSON.stringify(toolStep.error ? { error: toolStep.error } : toolStep.output) ?? 'null'
        });
      }
    }
    context.push({ role: 'assistant', content: message.content });
  }
  return context;
}

function asToolCallAssistantMessage(value: unknown): ChatMessage | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const candidate = value as ChatMessage;
  return candidate.role === 'assistant' && Array.isArray(candidate.tool_calls) && candidate.tool_calls.length
    ? { ...candidate, tool_calls: candidate.tool_calls.map((toolCall) => ({ ...toolCall, function: { ...toolCall.function } })) }
    : undefined;
}

export function createConversationTitle(message: string) {
  const normalized = message.replace(/\s+/g, ' ').trim();
  return normalized.length > 28 ? `${normalized.slice(0, 28)}...` : normalized || '新研究';
}
