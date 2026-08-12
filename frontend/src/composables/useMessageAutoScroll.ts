import { nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';

type WatchKey = string | number | boolean | null | undefined;

export function useMessageAutoScroll(
  getConversationKey: () => WatchKey,
  getMessageKey: () => WatchKey
) {
  const scrollContainer = ref<HTMLElement | null>(null);
  const shouldAutoScroll = ref(true);
  const bottomThreshold = 48;
  let contentResizeObserver: ResizeObserver | undefined;
  let scrollFrame = 0;

  onMounted(async () => {
    await nextTick();
    const content = scrollContainer.value?.firstElementChild;
    if (!(content instanceof HTMLElement) || typeof ResizeObserver === 'undefined') return;

    contentResizeObserver = new ResizeObserver(() => {
      if (!shouldAutoScroll.value) return;
      window.cancelAnimationFrame(scrollFrame);
      scrollFrame = window.requestAnimationFrame(() => {
        const container = scrollContainer.value;
        if (container) container.scrollTop = container.scrollHeight;
      });
    });
    contentResizeObserver.observe(content);
  });

  onBeforeUnmount(() => {
    window.cancelAnimationFrame(scrollFrame);
    contentResizeObserver?.disconnect();
  });

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
    shouldAutoScroll.value = true;
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

  return { handleScroll, scrollContainer, scrollToLatest, shouldAutoScroll };
}
