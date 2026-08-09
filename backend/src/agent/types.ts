import type { RagSource } from '../rag/types.js';
import type { ToolTrace } from '../tools/contracts.js';
export type { ChatMessage, ChatRole, ToolCall } from '../llm/contracts.js';
export type { ChatCompletion as DeepSeekChatResponse } from '../llm/contracts.js';
export type { ToolTrace } from '../tools/contracts.js';

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
