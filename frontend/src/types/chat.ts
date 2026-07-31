export type ChatMessageStatus = 'streaming' | 'complete' | 'error';

export type ChatMessage = {
  id: string;
  conversationId: string;
  role: 'user' | 'assistant';
  content: string;
  status: ChatMessageStatus;
  createdAt: string;
};

export type ChatConversation = {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
};

export type ChatConversationDetail = {
  conversation: ChatConversation;
  messages: ChatMessage[];
};

export type ToolCallTrace = {
  id: string;
  name: string;
  arguments: unknown;
  result?: unknown;
  error?: string;
};

export type RagSource = {
  id: string;
  file: string;
  title: string;
  heading?: string;
  headingPath?: string[];
  content: string;
  startLine: number;
  endLine: number;
  score: number;
  mergedChunkIds?: string[];
  contextHeadings?: string[];
};

export type AgentTraceStep =
  | {
      type: 'llm_call';
      label: string;
      model: string;
      tools?: string[];
    }
  | {
      type: 'tool_decision';
      label: string;
      toolCalls: Array<Pick<ToolCallTrace, 'id' | 'name' | 'arguments'>>;
    }
  | {
      type: 'tool_result';
      label: string;
      toolCall: ToolCallTrace;
    }
  | {
      type: 'final_answer';
      label: string;
    };
