import { getRagSourcesFromToolTraces } from '../rag/index.js';
import { getToolDefinitions } from '../tools/definitions.js';
import { DEFAULT_MAX_TOOL_ROUNDS } from './config.js';
import { createDeepSeekChatCompletion } from './deepseekClient.js';
import {
  executeToolRound,
  type AgentLoopEvent,
  type AgentToolExecutor
} from './toolRound.js';
import type {
  AgentLoopResult,
  AgentTraceStep,
  ChatMessage,
  DeepSeekChatResponse,
  ToolTrace
} from './types.js';

const defaultMaxToolResultChars = 4_000;
const defaultTemperature = 0.2;

const leakedMarkupCorrectionPrompt =
  'Your previous reply wrote tool-call markup as plain text instead of using the function-calling interface. Never output tool-call markup (DSML or similar tags) in message content. Either call tools through the function-calling interface, or answer directly in natural language.';

export type { AgentLoopEvent } from './toolRound.js';

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
  executeTool?: AgentToolExecutor;
};

export async function runAgentLoop({
  apiKey,
  message,
  model,
  systemPrompt,
  contextMessages = [],
  maxToolRounds = DEFAULT_MAX_TOOL_ROUNDS,
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
    // The controlled web tool already owns its query-rewrite loop; once the model
    // has called it, stop offering it so the quality budget is not reset by a second call.
    const roundTools = searchToolCalls.has('retrieve_web_evidence')
      ? tools.filter((tool) => tool.function.name !== 'retrieve_web_evidence')
      : tools;
    const roundResult = await executeToolRound({
      apiKey,
      model,
      messages,
      tools: roundTools,
      temperature,
      maxToolResultChars,
      decisionLabel: `模型选择调用工具（第 ${round + 1} 轮）`,
      signal,
      onEvent,
      executeTool,
      searchToolCalls
    });
    const { assistantMessage, parsedToolCalls, reply } = roundResult;

    if (!parsedToolCalls.length) {
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

    const malformedRequiredToolCall = parsedToolCalls.find(
      (toolCall) =>
        toolCall.parseError &&
        toolCall.name === requiredToolName &&
        toolNames.includes(toolCall.name)
    );

    toolTraces.push(...roundResult.toolTraces);
    trace.push(...roundResult.trace);

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

  const requiredTool = requiredToolName
    ? tools.find((tool) => tool.function.name === requiredToolName)
    : undefined;
  const requiredToolSucceeded = requiredToolName
    ? toolTraces.some((toolTrace) => toolTrace.name === requiredToolName && !toolTrace.error)
    : true;

  if (requiredTool && !requiredToolSucceeded) {
    throwIfAborted(signal);
    const reservedTools = [requiredTool];
    const reservedToolNames = [requiredToolName!];
    const reservedRoundPrompt =
      `The normal tool rounds are exhausted, but the user explicitly requested an artifact and ${requiredToolName} has not succeeded. ` +
      `This is the reserved artifact-generation round. Call ${requiredToolName} now using the evidence already available. ` +
      'Do not call any other tool and do not answer in prose.';

    messages.push({ role: 'system', content: reservedRoundPrompt });
    trace.push({
      type: 'llm_call',
      label: `保留额外轮次以调用必需工具 ${requiredToolName}`,
      model,
      tools: reservedToolNames
    });
    await onEvent?.({
      type: 'llm',
      title: `保留额外轮次以调用必需工具 ${requiredToolName}`,
      model,
      tools: reservedToolNames
    });

    const reservedRound = await executeToolRound({
      apiKey,
      model,
      messages,
      tools: reservedTools,
      temperature,
      maxToolResultChars,
      decisionLabel: '模型在保留轮次调用必需工具',
      successLabel: '必需工具在保留轮次执行完成',
      signal,
      onEvent,
      executeTool,
      searchToolCalls,
      requiredSingleToolName: requiredToolName
    });
    toolTraces.push(...reservedRound.toolTraces);
    trace.push(...reservedRound.trace);

    const failedRequiredTool = reservedRound.toolTraces.find((toolTrace) => toolTrace.error);
    if (failedRequiredTool?.error) {
      throw new Error(
        `Required tool ${requiredToolName} failed in the reserved artifact-generation round: ${failedRequiredTool.error}`
      );
    }
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
      throw new Error(describeEmptyCompletion(completion));
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

/**
 * Builds a diagnosable message when the completion parsed as JSON but carried no assistant message.
 * Surfaces choices count and a truncated raw payload so an empty/malformed choice can be identified.
 */
function describeEmptyCompletion(completion: DeepSeekChatResponse): string {
  const choiceCount = completion.choices?.length ?? 0;
  let raw: string;
  try {
    raw = JSON.stringify(completion).slice(0, 500);
  } catch {
    raw = '<unserializable completion>';
  }
  return `DeepSeek returned an empty response (choices: ${choiceCount}): ${raw}`;
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
