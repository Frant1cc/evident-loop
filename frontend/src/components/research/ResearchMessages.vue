<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref, watch } from 'vue';
import { PhArrowDown, PhCode, PhFileText, PhSparkle } from '@phosphor-icons/vue';

import { Button } from '@/components/ui/button';
import AgentMessage from '../agent/AgentMessage.vue';
import ConversationHistoryRail from '../conversation/ConversationHistoryRail.vue';
import WordArtifactCard from '../documents/WordArtifactCard.vue';
import ArtifactGenerationPanel from '../artifacts/ArtifactGenerationPanel.vue';
import { useMessageAutoScroll } from '../../composables/useMessageAutoScroll';
import type { WordArtifact } from '../../types/artifacts';
import type { ResearchMessage, ResearchStep } from '../../types/research';
import type { AuxiliaryState } from '../../lib/auxiliaryState';

const props = defineProps<{
  conversationId?: string;
  messages: ResearchMessage[];
  steps?: ResearchStep[];
  artifactsByMessageId: Map<string, WordArtifact[]>;
  auxiliaryStateByMessageId?: Map<string, AuxiliaryState>;
  artifactEnabled?: boolean;
}>();

const artifactHostMessageId = computed(() => {
  const steps = props.steps ?? [];
  for (let index = steps.length - 1; index >= 0; index -= 1) {
    const step = steps[index];
    if (step?.type !== 'tool' || step.title !== 'start_artifact_generation') continue;
    if (props.messages.some((message) => message.id === step.messageId)) return step.messageId;
  }
  return [...props.messages].reverse().find((message) => message.role === 'assistant')?.id
    ?? props.messages.at(-1)?.id;
});

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

const auxiliarySummaryLabel = '生成的文档';
const auxiliarySummaryActivity = '正在生成文档…';

const EMPTY_AUXILIARY_STATE: AuxiliaryState = {
  status: 'idle',
  label: auxiliarySummaryLabel,
  activity: auxiliarySummaryActivity,
  count: 0
};

function auxiliaryStateFor(messageId: string): AuxiliaryState {
  return props.auxiliaryStateByMessageId?.get(messageId) ?? EMPTY_AUXILIARY_STATE;
}

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
    const messageElements = Array.from(container.querySelectorAll<HTMLElement>('[data-research-message-id]'));
    let closestId = messageElements[0]?.dataset.researchMessageId;
    let closestDistance = Number.POSITIVE_INFINITY;

    for (const element of messageElements) {
      const rect = element.getBoundingClientRect();
      const center = rect.top + Math.min(rect.height, container.clientHeight) / 2;
      const distance = Math.abs(center - viewportCenter);
      if (distance < closestDistance) {
        closestDistance = distance;
        closestId = element.dataset.researchMessageId;
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
  const element = Array.from(container.querySelectorAll<HTMLElement>('[data-research-message-id]'))
    .find((candidate) => candidate.dataset.researchMessageId === messageId);
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

defineExpose({ scrollContainer });
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
          :data-research-message-id="message.id"
          class="min-w-0 shrink-0"
          :class="message.id === artifactHostMessageId
            ? ''
            : '[contain-intrinsic-size:auto_10rem] [content-visibility:auto]'"
        >
          <AgentMessage
            :message="message"
            streaming-placeholder="正在生成回复…"
            :auxiliary-status="auxiliaryStateFor(message.id).status"
            :auxiliary-label="auxiliaryStateFor(message.id).label"
            :auxiliary-activity="auxiliaryStateFor(message.id).activity"
            :auxiliary-count="auxiliaryStateFor(message.id).count"
            @citation="emit('citation', $event)"
          >
            <template #auxiliary>
              <WordArtifactCard
                v-for="artifact in artifactsByMessageId.get(message.id) ?? []"
                :key="artifact.artifactId"
                :artifact="artifact"
                @preview="emit('preview', $event)"
              />
            </template>
          </AgentMessage>
          <ArtifactGenerationPanel
            v-if="message.id === artifactHostMessageId"
            class="mt-3"
            :conversation-id="conversationId"
            :messages="messages"
            :enabled="artifactEnabled !== false"
          />
        </div>
      </div>
    </div>

    <ConversationHistoryRail
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
