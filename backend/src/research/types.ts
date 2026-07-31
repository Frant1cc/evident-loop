import type { RagSource } from '../rag/types.js';

export type ResearchMessageStatus = 'streaming' | 'complete' | 'error';
export type ResearchStepStatus = 'running' | 'complete' | 'error';
export type ResearchStepType = 'llm' | 'tool';

export type ResearchConversation = {
  id: string;
  title: string;
  topic?: string;
  summary?: string;
  createdAt: string;
  updatedAt: string;
};

export type ResearchMessage = {
  id: string;
  conversationId: string;
  role: 'user' | 'assistant';
  content: string;
  status: ResearchMessageStatus;
  createdAt: string;
};

export type ResearchStep = {
  id: string;
  conversationId: string;
  messageId: string;
  sequence: number;
  type: ResearchStepType;
  status: ResearchStepStatus;
  title: string;
  input?: unknown;
  output?: unknown;
  error?: string;
  startedAt: string;
  completedAt?: string;
};

export type ResearchSource = RagSource & {
  messageId: string;
  citationKey: string;
  createdAt: string;
};

export type ResearchNote = {
  id: string;
  conversationId: string;
  content: string;
  createdAt: string;
  updatedAt: string;
};

export type ResearchPromptPreview = {
  topic?: string;
  summary?: string;
  historyMessageCount: number;
  currentMessage: string;
};

export type ResearchConversationDetail = {
  conversation: ResearchConversation;
  messages: ResearchMessage[];
  steps: ResearchStep[];
  sources: ResearchSource[];
  notes: ResearchNote[];
  promptPreview: ResearchPromptPreview;
};
