import { onScopeDispose, type Ref } from 'vue';

type StreamMessage = {
  id: string;
  content: string;
};

export function useStreamingMessageRenderer<Message extends StreamMessage>(
  messages: Ref<Message[]>,
  options: { flushIntervalMs?: number } = {}
) {
  const flushIntervalMs = options.flushIntervalMs ?? 80;
  const pendingChunks = new Map<string, string[]>();
  const pendingTimers = new Map<string, number>();

  function append(messageId: string, content: string) {
    if (!content) return;
    const chunks = pendingChunks.get(messageId) ?? [];
    chunks.push(content);
    pendingChunks.set(messageId, chunks);
    if (pendingTimers.has(messageId)) return;

    pendingTimers.set(messageId, window.setTimeout(() => flush(messageId), flushIntervalMs));
  }

  function flush(messageId?: string) {
    if (messageId !== undefined) {
      flushMessage(messageId);
      return;
    }
    for (const id of [...pendingChunks.keys()]) flushMessage(id);
  }

  function upsert(message: Message) {
    flushMessage(message.id);
    const index = messages.value.findIndex((current) => current.id === message.id);
    if (index === -1) messages.value.push(message);
    else messages.value[index] = message;
  }

  function replaceAll(nextMessages: Message[]) {
    reset();
    messages.value = nextMessages;
  }

  function reset() {
    for (const timer of pendingTimers.values()) window.clearTimeout(timer);
    pendingTimers.clear();
    pendingChunks.clear();
  }

  function flushMessage(messageId: string) {
    const timer = pendingTimers.get(messageId);
    if (timer !== undefined) window.clearTimeout(timer);
    pendingTimers.delete(messageId);

    const chunks = pendingChunks.get(messageId);
    pendingChunks.delete(messageId);
    if (!chunks?.length) return;

    const index = messages.value.findIndex((message) => message.id === messageId);
    if (index === -1) return;
    const current = messages.value[index]!;
    messages.value[index] = { ...current, content: `${current.content}${chunks.join('')}` };
  }

  onScopeDispose(reset);

  return { append, flush, replaceAll, reset, upsert };
}
