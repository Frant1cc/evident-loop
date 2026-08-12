<script setup lang="ts">
import { computed } from 'vue';
import { PhArrowDown, PhFlask } from '@phosphor-icons/vue';

import { Button } from '@/components/ui/button';
import AgentMessage from '../agent/AgentMessage.vue';
import WordArtifactCard from '../documents/WordArtifactCard.vue';
import { useMessageAutoScroll } from '../../composables/useMessageAutoScroll';
import type { WordArtifact } from '../../types/artifacts';
import type { ResearchMessage } from '../../types/research';

const props = defineProps<{
  conversationId?: string;
  messages: ResearchMessage[];
  artifactsByMessageId: Map<string, WordArtifact[]>;
}>();

const emit = defineEmits<{
  citation: [key: string];
  preview: [artifact: WordArtifact];
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

defineExpose({ scrollContainer });
</script>

<template>
  <div class="relative min-h-0 min-w-0 overflow-hidden bg-background">
    <div
      ref="scrollContainer"
      class="app-scrollbar absolute inset-0 overflow-y-auto overscroll-contain [scrollbar-gutter:stable]"
      role="log"
      aria-label="研究对话"
      aria-live="polite"
      @scroll="handleScroll"
    >
      <div class="mx-auto flex min-h-full w-full max-w-4xl flex-col gap-6 px-4 py-5 md:px-6 md:py-6">
        <section v-if="!messages.length" class="grid min-h-[52vh] flex-1 place-items-center" aria-label="开始研究">
          <div class="w-full max-w-xl text-center">
            <span class="mx-auto grid size-12 place-items-center rounded-xl border border-border bg-muted text-foreground shadow-xs">
              <PhFlask :size="22" weight="fill" aria-hidden="true" />
            </span>
            <h2 class="m-0 mt-5 text-xl font-semibold tracking-[-0.025em] text-foreground">围绕知识库开始研究</h2>
            <p class="mx-auto mb-0 mt-2 max-w-md text-sm leading-6 text-muted-foreground">
              工作台会保存对话、工具过程和资料来源，便于持续深入研究。
            </p>
          </div>
        </section>

        <div
          v-for="message in messages"
          :key="message.id"
          :data-research-message-id="message.id"
          class="min-w-0 shrink-0 [contain-intrinsic-size:auto_10rem] [content-visibility:auto]"
        >
          <AgentMessage :message="message" streaming-placeholder="正在整理研究结果…" @citation="emit('citation', $event)">
            <WordArtifactCard
              v-for="artifact in artifactsByMessageId.get(message.id) ?? []"
              :key="artifact.artifactId"
              :artifact="artifact"
              @preview="emit('preview', $event)"
            />
          </AgentMessage>
        </div>
      </div>
    </div>

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
