import { nextTick, ref, watch } from 'vue';

type WatchKey = string | number | boolean | null | undefined;

export function useMessageAutoScroll(
  getConversationKey: () => WatchKey,
  getMessageKey: () => WatchKey
) {
  const scrollContainer = ref<HTMLElement | null>(null);
  const shouldAutoScroll = ref(true);
  const bottomThreshold = 48;

  watch(
    getConversationKey,
    () => {
      shouldAutoScroll.value = true;
      void scrollToLatest();
    },
    { immediate: true, flush: 'post' }
  );

  watch(
    getMessageKey,
    () => {
      if (shouldAutoScroll.value) void scrollToLatest();
    },
    { immediate: true, flush: 'post' }
  );

  async function scrollToLatest() {
    await nextTick();
    const container = scrollContainer.value;
    if (!container) return;
    container.scrollTop = container.scrollHeight;
  }

  function handleScroll() {
    const container = scrollContainer.value;
    if (!container) return;

    const distanceToBottom = container.scrollHeight - container.scrollTop - container.clientHeight;
    shouldAutoScroll.value = distanceToBottom <= bottomThreshold;
  }

  return { handleScroll, scrollContainer, scrollToLatest };
}
