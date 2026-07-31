import type { RagSource } from '../rag/types.js';

export type ChatRole = 'system' | 'user' | 'assistant' | 'tool';

export type ChatMessage = {
  role: ChatRole;
  content: string;
  tool_call_id?: string;
  tool_calls?: ToolCall[];
};

export type ToolCall = {
  id: string;
  type: 'function';
  function: {
    name: string;
    arguments: string;
  };
};

export type DeepSeekChatResponse = {
  choices?: Array<{
    message?: ChatMessage;
  }>;
};

export type ToolTrace = {
  id: string;
  name: string;
  arguments: unknown;
  result?: unknown;
  error?: string;
};

export type ParsedToolCall = {
  id: string;
  name: string;
  arguments: unknown;
  parseError?: string;
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
      toolCalls: Array<Pick<ToolTrace, 'id' | 'name' | 'arguments'>>;
    }
  | {
      type: 'tool_result';
      label: string;
      toolCall: ToolTrace;
    }
  | {
      type: 'final_answer';
      label: string;
    };

export type AgentLoopResult = {
  reply: string;
  toolCalls: ToolTrace[];
  trace: AgentTraceStep[];
  sources: RagSource[];
};
