import { onScopeDispose, type Ref } from 'vue';

import { StreamRenderScheduler, type PendingMessageDelta } from '../streaming/StreamRenderScheduler';

type StreamMessage = {
  id: string;
  content: string;
};

export function useStreamingMessageRenderer<Message extends StreamMessage>(
  messages: Ref<Message[]>,
  _options: { flushIntervalMs?: number } = {}
) {
  const scheduler = new StreamRenderScheduler({
    now: () => performance.now(),
    requestAnimationFrame: (cb) => window.requestAnimationFrame(cb),
    cancelAnimationFrame: (handle) => window.cancelAnimationFrame(handle),
    setTimeout: (cb, ms) => window.setTimeout(cb, ms),
    clearTimeout: (handle) => window.clearTimeout(handle),
    isDocumentHidden: () => document.hidden,
    onFlush: commit
  });

  function commit(batch: PendingMessageDelta[]) {
    for (const entry of batch) {
      const index = messages.value.findIndex((message) => message.id === entry.messageId);
      if (index === -1) continue;
      const current = messages.value[index]!;
      // One join and one reference replacement per message (plan §5.3 steps 2–3).
      messages.value[index] = { ...current, content: `${current.content}${entry.chunks.join('')}` };
    }
  }

  function append(messageId: string, content: string) {
    scheduler.enqueue(messageId, content);
  }

  function beginStream() {
    scheduler.dispose();
  }

  function markTerminal() {
    scheduler.markTerminal();
  }

  function flush(messageId?: string) {
    if (messageId !== undefined) scheduler.flushMessage(messageId);
    else scheduler.flushAll();
  }

  function upsert(message: Message) {
    // Flush any buffered deltas before we overwrite the message wholesale.
    scheduler.flushMessage(message.id);
    const index = messages.value.findIndex((current) => current.id === message.id);
    if (index === -1) messages.value.push(message);
    else messages.value[index] = message;
  }

  function replaceAll(nextMessages: Message[]) {
    reset();
    messages.value = nextMessages;
  }

  function reset() {
    scheduler.dispose();
  }

  onScopeDispose(reset);

  return { append, beginStream, flush, markTerminal, replaceAll, reset, upsert };
}
