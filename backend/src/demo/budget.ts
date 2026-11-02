import type { ChatCompletionRequest, LlmProvider } from '../llm/contracts.js';
import type { ToolRuntime } from '../tools/contracts.js';
import { createToolRuntime } from '../tools/runtime.js';
import { searchKnowledge } from '../rag/index.js';
import type { DemoConfig } from './config.js';

const allowedTools = new Set(['search_knowledge', 'read_document', 'read_evidence']);

export function createDemoToolRuntime(runtime: ToolRuntime) {
  return createToolRuntime(new Map(runtime.listModules()
    .filter((tool) => tool.source !== 'mcp' && allowedTools.has(tool.definition.function.name))
    .map((tool) => [tool.definition.function.name, tool.definition.function.name === 'search_knowledge'
      ? { ...tool, execute: (args, context) => searchKnowledge(args, { signal: context?.signal, queryRewrite: false }) }
      : tool])));
}

/** One budget follows a background run until execution settles, independent of the HTTP response. */
export function createDemoRunBudget(llm: LlmProvider, runtime: ToolRuntime, config: DemoConfig, onSettled: () => void) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error('本次体验已达到运行时间上限，请缩小问题范围后再试。')), config.maxRunMs);
  timer.unref();
  let calls = 0;
  let toolCalls = 0;
  let finished = false;
  const stop = (message: string): never => {
    const error = new Error(message);
    controller.abort(error);
    throw error;
  };
  const request = (input: ChatCompletionRequest): ChatCompletionRequest => {
    controller.signal.throwIfAborted();
    if (++calls > config.maxLlmCalls) stop('本次体验已达到模型调用上限，请缩小问题范围后再试。');
    if (JSON.stringify(input.messages).length + JSON.stringify(input.tools ?? []).length > 40_000) {
      stop('本次会话内容已达到体验上限，请新建会话后再试。');
    }
    return {
      ...input,
      maxTokens: Math.min(input.maxTokens ?? config.maxOutputTokens, config.maxOutputTokens),
      maxRetries: 0,
      timeoutMs: Math.min(input.timeoutMs ?? 30_000, 30_000),
      reasoning: false,
      signal: input.signal ? AbortSignal.any([input.signal, controller.signal]) : controller.signal
    };
  };
  const provider: LlmProvider = {
    complete: async (input) => {
      const bounded = request(input);
      try {
        const result = await llm.complete(bounded);
        bounded.signal?.throwIfAborted();
        return result;
      } catch {
        bounded.signal?.throwIfAborted();
        throw new Error('模型服务暂时不可用，请稍后再试。');
      }
    },
    stream: async (input, onDelta) => {
      const bounded = request(input);
      let outputChars = 0;
      try {
        await llm.stream(bounded, (delta) => {
          outputChars += (delta.content?.length ?? 0) + (delta.reasoning?.length ?? 0);
          if (outputChars > config.maxOutputTokens * 8) stop('本次体验已达到输出长度上限。');
          bounded.signal?.throwIfAborted();
          onDelta({ content: delta.content });
        });
        bounded.signal?.throwIfAborted();
      } catch {
        bounded.signal?.throwIfAborted();
        throw new Error('模型服务暂时不可用，请稍后再试。');
      }
    }
  };
  const toolRuntime = createToolRuntime(new Map(runtime.listModules().map((tool) => [tool.definition.function.name, {
    ...tool,
    execute: (args, context) => {
      controller.signal.throwIfAborted();
      if (++toolCalls > config.maxToolCalls) stop('本次体验已达到工具调用上限。');
      if (JSON.stringify(args).length > 4_000) stop('工具请求过长，请缩小问题范围。');
      return tool.execute(args, { ...context, signal: context?.signal
        ? AbortSignal.any([context.signal, controller.signal]) : controller.signal });
    }
  }])));
  return {
    llm: provider,
    toolRuntime,
    signal: controller.signal,
    maxToolRounds: 3,
    onSettled: () => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      onSettled();
    }
  };
}
