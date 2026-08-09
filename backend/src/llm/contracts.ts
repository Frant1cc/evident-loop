export type ChatRole = 'system' | 'user' | 'assistant' | 'tool';

export type ToolCall = {
  id: string;
  type: 'function';
  function: {
    name: string;
    arguments: string;
  };
};

export type ChatMessage = {
  role: ChatRole;
  content: string;
  tool_call_id?: string;
  tool_calls?: ToolCall[];
  reasoning_content?: string | null;
  reasoning_details?: Array<{ type?: string; text?: string; [key: string]: unknown }>;
};

export type ChatCompletion = {
  choices?: Array<{
    message?: ChatMessage;
  }>;
};

export type ChatCompletionRequest = {
  model: string;
  messages: ChatMessage[];
  tools?: unknown[];
  toolChoice?: 'auto';
  temperature?: number;
  signal?: AbortSignal;
  timeoutMs?: number;
  maxRetries?: number;
  reasoning?: boolean;
};

export type ChatStreamDelta = {
  content?: string;
  reasoning?: string;
};

/** Application-facing LLM port. Provider credentials and URLs stay in adapters. */
export type LlmProvider = {
  complete(request: ChatCompletionRequest): Promise<ChatCompletion>;
  stream(request: ChatCompletionRequest, onDelta: (delta: ChatStreamDelta) => void): Promise<void>;
};
