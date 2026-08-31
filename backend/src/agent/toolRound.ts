import { getRagSourcesFromToolTraces } from '../rag/index.js';
import type { ApprovalManager, ToolApprovalScope } from '../approvals/contracts.js';
import type { LlmProvider } from '../llm/contracts.js';
import type { ContextManager } from '../context/index.js';
import {
  ToolExecutionError,
  type ToolCall as RuntimeToolCall,
  type ToolDefinition,
  type ToolContext,
  type ToolProgress,
  type ToolRuntime,
  type ToolSnapshot
} from '../tools/contracts.js';
import { serializeToolResultForModel } from './toolResultSerializer.js';
import type { RagSource } from '../rag/types.js';
import type {
  AgentTraceStep,
  ChatMessage,
  DeepSeekChatResponse,
  ParsedToolCall,
  ToolCall,
  ToolTrace
} from './types.js';
import { containsLeakedToolMarkup, stripLeakedToolMarkup } from './toolMarkup.js';

export type AgentLoopEvent =
  | { type: 'llm'; title: string; model: string; tools?: string[] }
  | { type: 'llm_response'; assistantMessage: ChatMessage }
  | { type: 'tool_started'; toolCall: Pick<ParsedToolCall, 'id' | 'name' | 'arguments'> }
  | { type: 'tool_progress'; toolCall: Pick<ParsedToolCall, 'id' | 'name'>; progress: ToolProgress }
  | { type: 'tool_completed'; toolCall: ToolTrace }
  | { type: 'tool_approval_requested'; approval: import('../approvals/contracts.js').ToolApprovalDto }
  | { type: 'tool_approval_resolved'; approval: import('../approvals/contracts.js').ToolApprovalDto }
  | { type: 'source_found'; source: RagSource };

export type AgentToolExecutor = (
  toolCall: Pick<ParsedToolCall, 'id' | 'name' | 'arguments'>,
  context?: {
    signal?: AbortSignal;
    conversationId?: string;
    toolScope?: import('../tools/contracts.js').ToolScope;
    snapshot?: ToolSnapshot;
    onProgress?: ToolContext['onProgress'];
    onSource?: ToolContext['onSource'];
  }
) => Promise<unknown>;

type ExecuteToolRoundOptions = {
  llm: LlmProvider;
  model: string;
  messages: ChatMessage[];
  tools: ToolDefinition[];
  snapshot: ToolSnapshot;
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
  toolScope?: import('../tools/contracts.js').ToolScope;
  approvalManager?: ApprovalManager;
  approvalScope?: ToolApprovalScope;
  originalUserMessage: string;
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
  snapshot,
  searchToolCalls,
  requiredSingleToolName,
  contextManager,
  conversationId,
  toolScope,
  approvalManager,
  approvalScope,
  originalUserMessage
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
  const rawToolCalls = assistantMessage.tool_calls ?? [];
  const reply = assistantMessage.content?.trim();
  const eventMessage = !rawToolCalls.length && reply && containsLeakedToolMarkup(reply)
    ? { ...assistantMessage, content: stripLeakedToolMarkup(reply) }
    : assistantMessage;
  await onEvent?.({ type: 'llm_response', assistantMessage: eventMessage });

  if (!rawToolCalls.length) {
    if (requiredSingleToolName) {
      throw new Error(
        `Required tool ${requiredSingleToolName} was not called in the reserved artifact-generation round`
      );
    }
    return { assistantMessage, reply, parsedToolCalls: [], toolTraces: [], trace: [] };
  }

  const parsedToolCalls = rawToolCalls
    .map(parseToolCall)
    .map((toolCall) => bindOriginalWebQuestion(toolCall, originalUserMessage));
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
      : await executeParsedToolCall(
          toolCall,
          toolRuntime,
          snapshot,
          signal,
          executeTool,
          conversationId,
          toolScope,
          approvalManager,
          approvalScope,
          onEvent
        );
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
        toolCall.name,
        toolTrace.error
          ? { error: toolTrace.error, ...(toolTrace.errorDetails ? { details: toolTrace.errorDetails } : {}) }
          : toolTrace.result,
        maxToolResultChars
      )
    });
  }

  return { assistantMessage, reply, parsedToolCalls, toolTraces, trace };
}

async function executeParsedToolCall(
  toolCall: ParsedToolCall,
  toolRuntime: ToolRuntime,
  snapshot: ToolSnapshot,
  signal?: AbortSignal,
  executeTool?: AgentToolExecutor,
  conversationId?: string,
  toolScope?: import('../tools/contracts.js').ToolScope,
  approvalManager?: ApprovalManager,
  approvalScope?: ToolApprovalScope,
  onEvent?: (event: AgentLoopEvent) => void | Promise<void>
): Promise<ToolTrace> {
  throwIfAborted(signal);

  if (toolCall.parseError) {
    return {
      id: toolCall.id,
      name: toolCall.name,
      arguments: toolCall.arguments,
      error: toolCall.parseError,
      errorDetails: {
        code: 'invalid_arguments',
        message: toolCall.parseError,
        retryable: true,
        reason: 'The model emitted malformed JSON for the tool arguments.'
      }
    };
  }

  const toolContext: ToolContext = {
    signal,
    onProgress: async (progress) => {
      await onEvent?.({ type: 'tool_progress', toolCall: { id: toolCall.id, name: toolCall.name }, progress });
    },
    onSource: async (source) => { await onEvent?.({ type: 'source_found', source }); },
    ...(conversationId ? { conversationId } : {}),
    ...(toolScope ? { toolScope } : {})
  };
  try {
    const runtimeCall: RuntimeToolCall = {
      id: toolCall.id,
      name: toolCall.name,
      arguments: toolCall.arguments
    };
    if (approvalManager && approvalScope) {
      await approvalManager.authorize({
        runtime: toolRuntime,
        snapshot,
        toolCall: runtimeCall,
        scope: approvalScope,
        context: toolContext,
        onRequested: (approval) => onEvent?.({ type: 'tool_approval_requested', approval }),
        onResolved: (approval) => onEvent?.({ type: 'tool_approval_resolved', approval })
      });
    }
    const result = executeTool
      ? await executeTool(
          {
            id: toolCall.id,
            name: toolCall.name,
            arguments: toolRuntime.validate
              ? toolRuntime.validate(snapshot, runtimeCall)
              : runtimeCall.arguments
          },
          { ...toolContext, snapshot }
        )
      : await toolRuntime.execute(snapshot, runtimeCall, toolContext);
    throwIfAborted(signal);
    return {
      id: toolCall.id,
      name: toolCall.name,
      arguments: toolCall.arguments,
      result
    };
  } catch (error) {
    if (signal?.aborted) throw error;
    const details = error instanceof ToolExecutionError
      ? error.toDetails()
      : {
          code: 'execution_failed' as const,
          message: error instanceof Error ? error.message : 'Tool call failed',
          retryable: false
        };
    return {
      id: toolCall.id,
      name: toolCall.name,
      arguments: toolCall.arguments,
      error: error instanceof Error ? error.message : 'Tool call failed',
      ...(details ? { errorDetails: details } : {})
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
  // Malformed calls never reached the controlled search loop and must not
  // consume its once-per-request budget; the corrective retry needs to run.
  if (toolCall.parseError) return false;
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
  const message = toolCall.name === 'retrieve_web_evidence'
    ? 'retrieve_web_evidence already completed its controlled search loop for this research request; use its existing verdict and sources'
    : `${toolCall.name} has already been called with the same arguments for this research request`;
  return {
    id: toolCall.id,
    name: toolCall.name,
    arguments: toolCall.arguments,
    error: message,
    errorDetails: {
      code: toolCall.name === 'retrieve_web_evidence' ? 'tool_limit_reached' : 'tool_rejected',
      message,
      retryable: false,
      reason: 'This tool call has already consumed the current research request budget.'
    }
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

function bindOriginalWebQuestion(toolCall: ParsedToolCall, originalUserMessage: string): ParsedToolCall {
  if (toolCall.name !== 'retrieve_web_evidence' || toolCall.parseError || !toolCall.arguments || typeof toolCall.arguments !== 'object' || Array.isArray(toolCall.arguments)) return toolCall;
  return { ...toolCall, arguments: { ...(toolCall.arguments as Record<string, unknown>), question: originalUserMessage } };
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
