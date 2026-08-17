import { getRagSourcesFromToolTraces } from '../rag/index.js';
import type { LlmProvider } from '../llm/contracts.js';
import type { ContextManager } from '../context/index.js';
import type { ToolDefinition, ToolRuntime } from '../tools/contracts.js';
import type { RagSource } from '../rag/types.js';
import type {
  AgentTraceStep,
  ChatMessage,
  DeepSeekChatResponse,
  ParsedToolCall,
  ToolCall,
  ToolTrace
} from './types.js';

export type AgentLoopEvent =
  | { type: 'llm'; title: string; model: string; tools?: string[] }
  | { type: 'llm_response'; assistantMessage: ChatMessage }
  | { type: 'tool_started'; toolCall: Pick<ParsedToolCall, 'id' | 'name' | 'arguments'> }
  | { type: 'tool_completed'; toolCall: ToolTrace }
  | { type: 'source_found'; source: RagSource };

export type AgentToolExecutor = (
  toolCall: Pick<ParsedToolCall, 'id' | 'name' | 'arguments'>,
  context?: { signal?: AbortSignal; conversationId?: string }
) => Promise<unknown>;

type ExecuteToolRoundOptions = {
  llm: LlmProvider;
  model: string;
  messages: ChatMessage[];
  tools: ToolDefinition[];
  temperature: number;
  maxToolResultChars: number;
  decisionLabel: string;
  successLabel?: string;
  signal?: AbortSignal;
  onEvent?: (event: AgentLoopEvent) => void | Promise<void>;
  executeTool?: AgentToolExecutor;
  toolRuntime: ToolRuntime;
  searchToolCalls: Set<string>;
  requiredSingleToolName?: string;
  contextManager?: ContextManager;
  /** Forwarded to ToolContext so conversation-scoped tools (e.g. read_evidence) can resolve sources. */
  conversationId?: string;
};

export type ToolRoundResult = {
  assistantMessage: ChatMessage;
  reply?: string;
  parsedToolCalls: ParsedToolCall[];
  toolTraces: ToolTrace[];
  trace: AgentTraceStep[];
};

/**
 * Runs one model/tool turn and appends structured assistant/tool messages to the shared context.
 * A prose-only model response is returned without mutating messages so the loop can decide whether
 * to retry it, accept it as final, or replace it with a required-tool instruction.
 */
export async function executeToolRound({
  llm,
  model,
  messages,
  tools,
  temperature,
  maxToolResultChars,
  decisionLabel,
  successLabel = '工具执行完成',
  signal,
  onEvent,
  executeTool,
  toolRuntime,
  searchToolCalls,
  requiredSingleToolName,
  contextManager,
  conversationId
}: ExecuteToolRoundOptions): Promise<ToolRoundResult> {
  throwIfAborted(signal);
  const preparedMessages = contextManager
    ? await contextManager.prepare({ messages, tools, model, signal })
    : messages;
  const completion = await llm.complete({
    model,
    messages: preparedMessages,
    tools: tools.length ? tools : undefined,
    toolChoice: tools.length ? 'auto' : undefined,
    temperature,
    signal
  });
  const assistantMessage = completion.choices?.[0]?.message;

  if (!assistantMessage) {
    throw new Error(describeEmptyCompletion(completion));
  }
  await contextManager?.recordMainPromptUsage?.({
    messages,
    tools,
    model,
    signal,
    promptTokens: completion.usage?.prompt_tokens
  });
  await onEvent?.({ type: 'llm_response', assistantMessage });

  const rawToolCalls = assistantMessage.tool_calls ?? [];
  const reply = assistantMessage.content?.trim();
  if (!rawToolCalls.length) {
    if (requiredSingleToolName) {
      throw new Error(
        `Required tool ${requiredSingleToolName} was not called in the reserved artifact-generation round`
      );
    }
    return { assistantMessage, reply, parsedToolCalls: [], toolTraces: [], trace: [] };
  }

  const parsedToolCalls = rawToolCalls.map(parseToolCall);
  if (
    requiredSingleToolName &&
    (parsedToolCalls.length !== 1 || parsedToolCalls[0]?.name !== requiredSingleToolName)
  ) {
    throw new Error(
      `Required tool ${requiredSingleToolName} was not called exclusively in the reserved artifact-generation round`
    );
  }

  const trace: AgentTraceStep[] = [
    {
      type: 'tool_decision',
      label: decisionLabel,
      toolCalls: parsedToolCalls.map((toolCall) => ({
        id: toolCall.id,
        name: toolCall.name,
        arguments: toolCall.arguments
      }))
    }
  ];
  const toolTraces: ToolTrace[] = [];
  messages.push(assistantMessage);

  for (const toolCall of parsedToolCalls) {
    throwIfAborted(signal);
    await onEvent?.({
      type: 'tool_started',
      toolCall: { id: toolCall.id, name: toolCall.name, arguments: toolCall.arguments }
    });
    const toolTrace = isRepeatedSearch(toolCall, searchToolCalls)
      ? createRepeatedSearchTrace(toolCall)
      : await executeParsedToolCall(toolCall, toolRuntime, signal, executeTool, conversationId);
    toolTraces.push(toolTrace);
    await onEvent?.({ type: 'tool_completed', toolCall: toolTrace });

    for (const source of getRagSourcesFromToolTraces([toolTrace])) {
      await onEvent?.({ type: 'source_found', source });
    }

    trace.push({
      type: 'tool_result',
      label: toolTrace.error ? getToolErrorLabel(toolCall) : successLabel,
      toolCall: toolTrace
    });
    messages.push({
      role: 'tool',
      tool_call_id: toolCall.id,
      content: serializeToolResultForModel(
        toolTrace.error ? { error: toolTrace.error } : toolTrace.result,
        maxToolResultChars
      )
    });
  }

  return { assistantMessage, reply, parsedToolCalls, toolTraces, trace };
}

async function executeParsedToolCall(
  toolCall: ParsedToolCall,
  toolRuntime: ToolRuntime,
  signal?: AbortSignal,
  executeTool?: AgentToolExecutor,
  conversationId?: string
): Promise<ToolTrace> {
  throwIfAborted(signal);

  if (toolCall.parseError) {
    return {
      id: toolCall.id,
      name: toolCall.name,
      arguments: toolCall.arguments,
      error: toolCall.parseError
    };
  }

  const toolContext = conversationId ? { signal, conversationId } : { signal };
  try {
    const result = executeTool
      ? await executeTool(
          { id: toolCall.id, name: toolCall.name, arguments: toolCall.arguments },
          toolContext
        )
      : await toolRuntime.execute(toolCall.name, toolCall.arguments, toolContext);
    throwIfAborted(signal);
    return {
      id: toolCall.id,
      name: toolCall.name,
      arguments: toolCall.arguments,
      result
    };
  } catch (error) {
    if (signal?.aborted) throw error;
    return {
      id: toolCall.id,
      name: toolCall.name,
      arguments: toolCall.arguments,
      error: error instanceof Error ? error.message : 'Tool call failed'
    };
  }
}

const dedupedSearchToolNames = new Set([
  'search_knowledge',
  'retrieve_web_evidence',
  'web_search',
  'fetch_page'
]);

function isRepeatedSearch(toolCall: ParsedToolCall, searchToolCalls: Set<string>) {
  if (!dedupedSearchToolNames.has(toolCall.name)) return false;
  // This tool already owns its query-rewrite loop. A second outer call would reset its budget.
  const fingerprint = toolCall.name === 'retrieve_web_evidence'
    ? toolCall.name
    : `${toolCall.name}:${stableStringify(toolCall.arguments)}`;
  if (searchToolCalls.has(fingerprint)) return true;
  searchToolCalls.add(fingerprint);
  return false;
}

function createRepeatedSearchTrace(toolCall: ParsedToolCall): ToolTrace {
  return {
    id: toolCall.id,
    name: toolCall.name,
    arguments: toolCall.arguments,
    error: toolCall.name === 'retrieve_web_evidence'
      ? 'retrieve_web_evidence already completed its controlled search loop for this research request; use its existing verdict and sources'
      : `${toolCall.name} has already been called with the same arguments for this research request`
  };
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, nested]) => `${JSON.stringify(key)}:${stableStringify(nested)}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

function serializeToolResultForModel(payload: unknown, maxChars: number): string {
  const serialized = JSON.stringify(payload) ?? 'null';
  if (serialized.length <= maxChars) return serialized;
  return `${serialized.slice(0, maxChars)}\n...[tool result truncated: showing first ${maxChars} of ${serialized.length} characters]`;
}

function getToolErrorLabel(toolCall: ParsedToolCall) {
  return toolCall.parseError ? '工具参数解析失败' : '工具执行失败';
}

function parseToolCall(toolCall: ToolCall): ParsedToolCall {
  try {
    return {
      id: toolCall.id,
      name: toolCall.function.name,
      arguments: parseToolArguments(toolCall.function.arguments)
    };
  } catch (error) {
    return {
      id: toolCall.id,
      name: toolCall.function.name,
      arguments: { raw: toolCall.function.arguments },
      parseError: error instanceof Error ? error.message : 'Failed to parse tool arguments'
    };
  }
}

function parseToolArguments(value: string) {
  if (!value.trim()) return {};

  try {
    return JSON.parse(value) as unknown;
  } catch (error) {
    const details = error instanceof SyntaxError ? `: ${error.message}` : '';
    throw new Error(`Failed to parse tool arguments${details}`);
  }
}

function throwIfAborted(signal?: AbortSignal) {
  if (signal?.aborted) {
    throw signal.reason instanceof Error ? signal.reason : new Error('Research request was cancelled');
  }
}

/**
 * Builds a diagnosable message when the completion parsed as JSON but carried no assistant message.
 * Surfaces choices count and a truncated raw payload so an empty/malformed choice can be identified.
 */
export function describeEmptyCompletion(completion: DeepSeekChatResponse): string {
  const choiceCount = completion.choices?.length ?? 0;
  let raw: string;
  try {
    raw = JSON.stringify(completion).slice(0, 500);
  } catch {
    raw = '<unserializable completion>';
  }
  return `DeepSeek returned an empty response (choices: ${choiceCount}): ${raw}`;
}
