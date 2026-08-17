import type { RagSource } from '../rag/types.js';
import type { ChatMessage } from '../agent/types.js';
import type { ContextState } from '../context/index.js';
import type { ToolPolicy } from '../tools/contracts.js';
import type { ResearchSkillSnapshot } from '../skills/contracts.js';
import type { ResearchExecutionMode } from './executionMode.js';

export type ResearchMessageStatus = 'streaming' | 'complete' | 'error';
export type ResearchStepStatus = 'running' | 'complete' | 'error';
export type ResearchStepType = 'llm' | 'tool';
export type ResearchRunStatus = 'queued' | 'running' | 'completed' | 'failed' | 'cancelled';

export type ResearchConversation = {
  id: string;
  title: string;
  topic?: string;
  summary?: string;
  contextState?: ContextState;
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
  parentStepId?: string;
  toolCallId?: string;
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

export type ResearchRunInput = {
  content: string;
  contextMessages: ChatMessage[];
  promptPreview: ResearchPromptPreview;
  toolPolicy: ToolPolicy;
  /** Selected official skill. Absent means "通用研究" (general research). */
  skill?: ResearchSkillSnapshot;
  /**
   * Derived server-side after skill resolution and tool-policy normalization (§6.1).
   * Absent on runs created before this field existed; those are interpreted as 'research'.
   */
  executionMode?: ResearchExecutionMode;
};

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
