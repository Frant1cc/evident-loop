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
  status: 'streaming' | 'complete' | 'error';
  createdAt: string;
};

export type ResearchStep = {
  id: string;
  conversationId: string;
  messageId: string;
  sequence: number;
  type: 'llm' | 'tool';
  status: 'running' | 'complete' | 'error';
  title: string;
  input?: unknown;
  output?: unknown;
  error?: string;
  startedAt: string;
  completedAt?: string;
};

export type ResearchSource = {
  id: string;
  messageId: string;
  citationKey: string;
  file: string;
  title: string;
  heading?: string;
  content: string;
  startLine: number;
  endLine: number;
  score: number;
  createdAt: string;
  format?: import('../lib/sourceLocator').KnowledgeFormat;
  locator?: import('../lib/sourceLocator').SourceLocator;
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

export type ResearchRunStatus = 'queued' | 'running' | 'completed' | 'failed' | 'cancelled';

export type ResearchRun = {
  id: string;
  conversationId: string;
  userMessageId: string;
  assistantMessageId: string;
  status: ResearchRunStatus;
  error?: string;
  createdAt: string;
  startedAt?: string;
  completedAt?: string;
  updatedAt: string;
};

export type ResearchConversationDetail = {
  conversation: ResearchConversation;
  messages: ResearchMessage[];
  steps: ResearchStep[];
  sources: ResearchSource[];
  notes: ResearchNote[];
  promptPreview: ResearchPromptPreview;
  activeRun?: ResearchRun;
};
