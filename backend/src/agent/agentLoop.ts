import { getRagSourcesFromToolTraces } from '../rag/index.js';
import { getToolDefinitions } from '../tools/definitions.js';
import { executeToolCall as executeRegisteredToolCall } from '../tools/index.js';
import { createDeepSeekChatCompletion } from './deepseekClient.js';
import type { RagSource } from '../rag/types.js';
import type { AgentLoopResult, AgentTraceStep, ChatMessage, ParsedToolCall, ToolCall, ToolTrace } from './types.js';

const defaultMaxToolRounds = 4;
const defaultMaxToolResultChars = 4_000;
const defaultTemperature = 0.2;

const leakedMarkupCorrectionPrompt =
  'Your previous reply wrote tool-call markup as plain text instead of using the function-calling interface. Never output tool-call markup (DSML or similar tags) in message content. Either call tools through the function-calling interface, or answer directly in natural language.';

export type AgentLoopEvent =
  | { type: 'llm'; title: string; model: string; tools?: string[] }
  | { type: 'tool_started'; toolCall: Pick<ParsedToolCall, 'id' | 'name' | 'arguments'> }
  | { type: 'tool_completed'; toolCall: ToolTrace }
  | { type: 'source_found'; source: RagSource };

export type RunAgentLoopOptions = {
  apiKey: string;
  message: string;
  model: string;
  systemPrompt: string;
  contextMessages?: ChatMessage[];
  maxToolRounds?: number;
  /** Character budget for a single tool result when written back into model context. Defaults to 4000. */
  maxToolResultChars?: number;
  /** Sampling temperature. Low values keep tool-call formatting stable. Defaults to 0.2. */
  temperature?: number;
  signal?: AbortSignal;
  onEvent?: (event: AgentLoopEvent) => void | Promise<void>;
  allowedToolNames?: string[];
  /** Retry once with an explicit instruction when a required tool was not called. */
  requiredToolName?: string;
  executeTool?: (
    toolCall: Pick<ParsedToolCall, 'id' | 'name' | 'arguments'>,
    context?: { signal?: AbortSignal }
  ) => Promise<unknown>;
};

export async function runAgentLoop({
  apiKey,
  message,
  model,
  systemPrompt,
  contextMessages = [],
  maxToolRounds = defaultMaxToolRounds,
  maxToolResultChars = defaultMaxToolResultChars,
  temperature = defaultTemperature,
  signal,
  onEvent,
  allowedToolNames,
  requiredToolName,
  executeTool
}: RunAgentLoopOptions): Promise<AgentLoopResult> {
  const messages: ChatMessage[] = [
    { role: 'system', content: systemPrompt },
    ...contextMessages,
    { role: 'user', content: message }
  ];
  // undefined = all registered tools; an explicit array (even empty) restricts to exactly those tools.
  const allowedToolSet = allowedToolNames ? normalizeAllowedToolNames(allowedToolNames) : undefined;
  const tools = getToolDefinitions().filter((tool) => !allowedToolSet || allowedToolSet.has(tool.function.name));
  const toolNames = tools.map((tool) => tool.function.name);
  const trace: AgentTraceStep[] = [
    {
      type: 'llm_call',
      label: '模型判断是否需要工具',
      model,
      tools: toolNames
    }
  ];
  const toolTraces: ToolTrace[] = [];
  const searchToolCalls = new Set<string>();
  let leakRetryUsed = false;
  let requiredToolRetryUsed = false;
  let toolArgumentRetryUsed = false;
  let bonusToolRounds = 0;

  throwIfAborted(signal);
  await onEvent?.({ type: 'llm', title: '模型判断是否需要工具', model, tools: toolNames });

  for (let round = 0; round < maxToolRounds + bonusToolRounds; round += 1) {
    throwIfAborted(signal);
    const roundTools = searchToolCalls.has('retrieve_web_evidence')
      ? tools.filter((tool) => tool.function.name !== 'retrieve_web_evidence')
      : tools;
    const completion = await createDeepSeekChatCompletion({
      apiKey,
      model,
      messages,
      tools: roundTools.length ? roundTools : undefined,
      toolChoice: roundTools.length ? 'auto' : undefined,
      temperature,
      signal
    });
    const assistantMessage = completion.choices?.[0]?.message;

    if (!assistantMessage) {
      throw new Error('DeepSeek returned an empty response');
    }

    const toolCalls = assistantMessage.tool_calls ?? [];
    const reply = assistantMessage.content?.trim();

    if (!toolCalls.length) {
      // Provider-side parsing sometimes leaks the model's native tool-call markup (e.g. DeepSeek DSML)
      // into plain content instead of structured tool_calls. Ask the model to redo the turn once.
      if (reply && containsLeakedToolMarkup(reply) && !leakRetryUsed) {
        leakRetryUsed = true;
        messages.push(assistantMessage);
        messages.push({ role: 'system', content: leakedMarkupCorrectionPrompt });
        trace.push({ type: 'llm_call', label: '检测到工具调用标记泄漏为正文，要求模型重新生成', model, tools: toolNames });
        await onEvent?.({ type: 'llm', title: '检测到工具调用标记泄漏为正文，要求模型重新生成', model, tools: toolNames });
        continue;
      }

      const requiredToolIsMissing =
        requiredToolName &&
        toolNames.includes(requiredToolName) &&
        !toolTraces.some(
          (toolTrace) => toolTrace.name === requiredToolName && !toolTrace.error
        );
      if (requiredToolIsMissing && !requiredToolRetryUsed) {
        requiredToolRetryUsed = true;
        bonusToolRounds += 1;
        messages.push(assistantMessage);
        messages.push({
          role: 'system',
          content: `The user explicitly requested an artifact that requires the ${requiredToolName} tool. Call that tool now with complete structured arguments. Do not answer with a simulated link or tool markup.`
        });
        trace.push({
          type: 'llm_call',
          label: `检测到明确文档导出意图，要求模型调用 ${requiredToolName}`,
          model,
          tools: toolNames
        });
        await onEvent?.({
          type: 'llm',
          title: `检测到明确文档导出意图，要求模型调用 ${requiredToolName}`,
          model,
          tools: toolNames
        });
        continue;
      }

      const cleanedReply = reply ? stripLeakedToolMarkup(reply) : '';
      const finalReply = cleanedReply || createEmptyReplyFallback(toolTraces.length > 0);
      trace.push({ type: 'final_answer', label: cleanedReply ? (toolTraces.length ? '模型已给出最终回答' : '模型直接回答，未调用工具') : '模型未返回可展示回答' });
      return { reply: finalReply, toolCalls: toolTraces, trace, sources: getRagSourcesFromToolTraces(toolTraces) };
    }

    const parsedToolCalls = toolCalls.map(parseToolCall);
    const malformedRequiredToolCall = parsedToolCalls.find(
      (toolCall) =>
        toolCall.parseError &&
        toolCall.name === requiredToolName &&
        toolNames.includes(toolCall.name)
    );

    trace.push({
      type: 'tool_decision',
      label: `模型选择调用工具（第 ${round + 1} 轮）`,
      toolCalls: parsedToolCalls.map((toolCall) => ({
        id: toolCall.id,
        name: toolCall.name,
        arguments: toolCall.arguments
      }))
    });
    messages.push(assistantMessage);

    for (const toolCall of parsedToolCalls) {
      throwIfAborted(signal);
      await onEvent?.({
        type: 'tool_started',
        toolCall: { id: toolCall.id, name: toolCall.name, arguments: toolCall.arguments }
      });
      const toolTrace = isRepeatedSearch(toolCall, searchToolCalls)
        ? createRepeatedSearchTrace(toolCall)
        : await executeParsedToolCall(toolCall, signal, executeTool);
      toolTraces.push(toolTrace);
      await onEvent?.({ type: 'tool_completed', toolCall: toolTrace });

      for (const source of getRagSourcesFromToolTraces([toolTrace])) {
        await onEvent?.({ type: 'source_found', source });
      }

      trace.push({
        type: 'tool_result',
        label: toolTrace.error ? getToolErrorLabel(toolCall) : '工具执行完成',
        toolCall: toolTrace
      });
      messages.push({
        role: 'tool',
        tool_call_id: toolCall.id,
        // Truncated only in model context; toolTraces/trace keep the full result for the UI.
        content: serializeToolResultForModel(toolTrace.error ? { error: toolTrace.error } : toolTrace.result, maxToolResultChars)
      });
    }

    if (malformedRequiredToolCall && !toolArgumentRetryUsed) {
      toolArgumentRetryUsed = true;
      bonusToolRounds += 1;
      const correctionPrompt =
        requiredToolName === 'generate_word_document'
          ? 'The generate_word_document arguments were invalid JSON. Retry the tool call once. Use only title, optional metadata/format, and one contentMarkdown string for the complete body. Do not send blocks. Ensure the function arguments are valid JSON and escape any quotation marks inside contentMarkdown.'
          : `The ${requiredToolName} arguments were invalid JSON. Retry the tool call once with valid JSON matching the tool schema.`;
      messages.push({ role: 'system', content: correctionPrompt });
      trace.push({
        type: 'llm_call',
        label: `${requiredToolName} 参数无效，要求模型纠正后重试`,
        model,
        tools: toolNames
      });
      await onEvent?.({
        type: 'llm',
        title: `${requiredToolName} 参数无效，要求模型纠正后重试`,
        model,
        tools: toolNames
      });
      continue;
    }

    trace.push({ type: 'llm_call', label: '模型根据工具结果继续推理', model, tools: toolNames });
    await onEvent?.({ type: 'llm', title: '模型根据工具结果继续推理', model, tools: toolNames });
  }

  if (toolTraces.length) {
    throwIfAborted(signal);
    trace.push({ type: 'llm_call', label: '达到工具调用轮数上限，根据已有上下文生成最终回答', model });
    messages.push({
      role: 'system',
      content: 'Tool rounds are complete. Answer now using the available tool results. Do not call tools. If the evidence is insufficient, say so clearly.'
    });
    const completion = await createDeepSeekChatCompletion({ apiKey, model, messages, temperature, signal });
    const assistantMessage = completion.choices?.[0]?.message;

    if (!assistantMessage) {
      throw new Error('DeepSeek returned an empty response');
    }

    trace.push({ type: 'final_answer', label: '达到工具调用轮数上限，生成最终回答' });
    return {
      reply: stripLeakedToolMarkup(assistantMessage.content?.trim() ?? '') || createEmptyReplyFallback(true),
      toolCalls: toolTraces,
      trace,
      sources: getRagSourcesFromToolTraces(toolTraces)
    };
  }

  trace.push({ type: 'final_answer', label: '达到工具调用轮数上限，未获得工具上下文' });
  return {
    reply: '工具调用轮数已达到上限，请缩小问题范围后重试。',
    toolCalls: toolTraces,
    trace,
    sources: getRagSourcesFromToolTraces(toolTraces)
  };
}

async function executeParsedToolCall(
  toolCall: ParsedToolCall,
  signal?: AbortSignal,
  executeTool?: RunAgentLoopOptions['executeTool']
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

  try {
    const result = executeTool
      ? await executeTool({ id: toolCall.id, name: toolCall.name, arguments: toolCall.arguments }, { signal })
      : await executeRegisteredToolCall(toolCall.name, toolCall.arguments, { signal });
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
  'search_docs',
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

function normalizeAllowedToolNames(allowedToolNames: string[]) {
  const names = new Set(allowedToolNames);
  // Persisted tasks created before the controlled web tool may still store the two legacy names.
  if (names.has('web_search') || names.has('fetch_page')) names.add('retrieve_web_evidence');
  return names;
}

/** Detects the model's native tool-call markup leaking into plain content (e.g. DeepSeek DSML tags). */
function containsLeakedToolMarkup(text: string): boolean {
  if (text.includes('<｜')) return true;
  return /<\|{1,2}[^>]{0,60}(dsml|tool[▁_\- ]?call|invoke)/i.test(text);
}

/** Keeps any prose before the first leaked markup tag and drops the markup itself. */
function stripLeakedToolMarkup(text: string): string {
  const fullWidthIndex = text.indexOf('<｜');
  const asciiMatch = text.match(/<\|{1,2}[^>]{0,60}(dsml|tool[▁_\- ]?call|invoke)/i);
  const candidates = [fullWidthIndex, asciiMatch?.index ?? -1].filter((index) => index >= 0);

  if (!candidates.length) return text.trim();

  return text.slice(0, Math.min(...candidates)).trim();
}

function serializeToolResultForModel(payload: unknown, maxChars: number): string {
  const serialized = JSON.stringify(payload) ?? 'null';
  if (serialized.length <= maxChars) return serialized;
  return `${serialized.slice(0, maxChars)}\n...[tool result truncated: showing first ${maxChars} of ${serialized.length} characters]`;
}

function createEmptyReplyFallback(hasToolContext: boolean) {
  return hasToolContext
    ? '已完成资料检索，但模型没有生成可展示的结论。请缩小问题范围，或查看右侧 Sources 中的检索结果。'
    : '模型没有返回可展示的回答。请换一种表述后重试。';
}

function throwIfAborted(signal?: AbortSignal) {
  if (signal?.aborted) {
    throw signal.reason instanceof Error ? signal.reason : new Error('Research request was cancelled');
  }
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
