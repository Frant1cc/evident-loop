<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref, watch } from 'vue';
import { PhArrowDown, PhCode, PhFileText, PhSparkle } from '@phosphor-icons/vue';

import { Button } from '@/components/ui/button';
import AgentMessage from '../agent/AgentMessage.vue';
import ChatHistoryRail from './ChatHistoryRail.vue';
import { useMessageAutoScroll } from '../../composables/useMessageAutoScroll';
import type { ChatMessage } from '../../types/chat';

const props = defineProps<{
  conversationId?: string;
  messages: ChatMessage[];
}>();

const messageSignature = computed(() => {
  const lastMessage = props.messages[props.messages.length - 1];
  return lastMessage
    ? `${props.messages.length}:${lastMessage.id}:${lastMessage.content.length}:${lastMessage.status}`
    : 'empty';
});

const { handleScroll, scrollContainer, scrollToLatest, shouldAutoScroll } = useMessageAutoScroll(
  () => props.conversationId,
  () => messageSignature.value
);

const activeHistoryMessageId = ref<string>();
let historyFrame = 0;

function syncHistoryPosition() {
  window.cancelAnimationFrame(historyFrame);
  historyFrame = window.requestAnimationFrame(() => {
    const container = scrollContainer.value;
    if (!container) return;

    const viewportCenter = container.getBoundingClientRect().top + container.clientHeight / 2;
    const messageElements = Array.from(container.querySelectorAll<HTMLElement>('[data-chat-message-id]'));
    let closestId = messageElements[0]?.dataset.chatMessageId;
    let closestDistance = Number.POSITIVE_INFINITY;

    for (const element of messageElements) {
      const rect = element.getBoundingClientRect();
      const center = rect.top + Math.min(rect.height, container.clientHeight) / 2;
      const distance = Math.abs(center - viewportCenter);
      if (distance < closestDistance) {
        closestDistance = distance;
        closestId = element.dataset.chatMessageId;
      }
    }

    activeHistoryMessageId.value = closestId;
  });
}

function onMessageScroll() {
  handleScroll();
  syncHistoryPosition();
}

function jumpToMessage(messageId: string) {
  const container = scrollContainer.value;
  if (!container) return;
  const element = Array.from(container.querySelectorAll<HTMLElement>('[data-chat-message-id]'))
    .find((candidate) => candidate.dataset.chatMessageId === messageId);
  if (!element) return;

  shouldAutoScroll.value = false;
  activeHistoryMessageId.value = messageId;
  element.scrollIntoView({ behavior: 'smooth', block: 'center' });
}

watch(
  () => [props.conversationId, messageSignature.value],
  async () => {
    await nextTick();
    syncHistoryPosition();
  },
  { immediate: true, flush: 'post' }
);

onBeforeUnmount(() => window.cancelAnimationFrame(historyFrame));
</script>

<template>
  <div class="relative min-h-0 min-w-0 overflow-hidden bg-background">
    <div
      ref="scrollContainer"
      class="app-scrollbar absolute inset-0 overflow-y-auto overscroll-contain [scrollbar-gutter:stable]"
      role="log"
      aria-label="对话消息"
      aria-live="polite"
      @scroll="onMessageScroll"
    >
      <div class="mx-auto flex min-h-full w-full max-w-4xl flex-col gap-6 px-4 py-5 md:px-6 md:py-6">
        <section v-if="!messages.length" class="grid min-h-[52vh] flex-1 place-items-center" aria-label="开始新会话">
          <div class="w-full max-w-xl text-center">
            <span class="mx-auto grid size-12 place-items-center rounded-xl border border-border bg-muted text-foreground shadow-xs">
              <PhSparkle :size="22" weight="fill" aria-hidden="true" />
            </span>
            <h2 class="m-0 mt-5 text-xl font-semibold tracking-[-0.025em] text-foreground">从一个问题开始</h2>
            <p class="mx-auto mb-0 mt-2 max-w-md text-sm leading-6 text-muted-foreground">
              询问知识库内容、分析文档，或让 EvidentLoop 帮你整理一个复杂任务。
            </p>
            <div class="mt-6 grid grid-cols-2 gap-2 text-left max-sm:grid-cols-1">
              <div class="rounded-xl border border-border bg-card p-3 text-sm text-card-foreground">
                <PhFileText :size="16" class="mb-2 text-muted-foreground" aria-hidden="true" />
                总结知识库中的关键结论
              </div>
              <div class="rounded-xl border border-border bg-card p-3 text-sm text-card-foreground">
                <PhCode :size="16" class="mb-2 text-muted-foreground" aria-hidden="true" />
                分析一段代码或技术方案
              </div>
            </div>
          </div>
        </section>

        <div
          v-for="message in messages"
          :key="message.id"
          :data-chat-message-id="message.id"
          class="min-w-0 shrink-0 [contain-intrinsic-size:auto_10rem] [content-visibility:auto]"
        >
          <AgentMessage :message="message" streaming-placeholder="正在思考…" />
        </div>
      </div>
    </div>

    <ChatHistoryRail
      :messages="messages"
      :active-message-id="activeHistoryMessageId"
      @jump="jumpToMessage"
    />

    <Button
      v-if="messages.length && !shouldAutoScroll"
      type="button"
      variant="secondary"
      size="icon-sm"
      class="absolute bottom-4 left-1/2 -translate-x-1/2 border border-border bg-background shadow-md"
      aria-label="回到最新消息"
      @click="scrollToLatest"
    >
      <PhArrowDown :size="16" weight="bold" aria-hidden="true" />
    </Button>
  </div>
</template>
