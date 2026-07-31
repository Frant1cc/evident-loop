import type { ChatMessage } from '../agent/types.js';
import type { ResearchConversation, ResearchMessage, ResearchPromptPreview } from './types.js';

const maxHistoryCharacters = 12_000;

export function buildResearchContext(
  conversation: ResearchConversation,
  messages: ResearchMessage[],
  currentMessage: string
): { messages: ChatMessage[]; promptPreview: ResearchPromptPreview } {
  const completeMessages = messages.filter((message) => message.status === 'complete');
  const recentMessages = selectRecentMessages(completeMessages);
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
    ...recentMessages.map<ChatMessage>((message) => ({
      role: message.role === 'assistant' ? 'assistant' : 'user',
      content: message.content
    }))
  );

  return {
    messages: context,
    promptPreview: {
      topic: conversation.topic,
      summary: conversation.summary,
      historyMessageCount: recentMessages.length,
      currentMessage
    }
  };
}

function selectRecentMessages(messages: ResearchMessage[]) {
  const selected: ResearchMessage[] = [];
  let characters = 0;

  for (const message of [...messages].reverse()) {
    if (characters + message.content.length > maxHistoryCharacters && selected.length) break;

    selected.push(message);
    characters += message.content.length;
  }

  return selected.reverse();
}

export function createConversationTitle(message: string) {
  const normalized = message.replace(/\s+/g, ' ').trim();
  return normalized.length > 28 ? `${normalized.slice(0, 28)}...` : normalized || '新研究';
}
