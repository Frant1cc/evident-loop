<script setup lang="ts">
import { computed, ref } from 'vue';

import type { ChatMessage } from '../../types/chat';

const props = defineProps<{
  messages: ChatMessage[];
  activeMessageId?: string;
}>();

const emit = defineEmits<{
  jump: [messageId: string];
}>();

type ConversationTurn = {
  id: string;
  user?: ChatMessage;
  assistant?: ChatMessage;
};

const turns = computed<ConversationTurn[]>(() => {
  const result: ConversationTurn[] = [];

  for (const message of props.messages) {
    if (message.role === 'user') {
      result.push({ id: message.id, user: message });
      continue;
    }

    const lastTurn = result[result.length - 1];
    if (lastTurn && !lastTurn.assistant) lastTurn.assistant = message;
    else result.push({ id: message.id, assistant: message });
  }

  return result;
});

const hoveredTurnId = ref<string>();
const hoveredTurn = computed(() => turns.value.find((turn) => turn.id === hoveredTurnId.value));

function isActiveTurn(turn: ConversationTurn) {
  return turn.user?.id === props.activeMessageId || turn.assistant?.id === props.activeMessageId;
}

function previewText(content: string) {
  const normalized = content
    .replace(/```[\s\S]*?```/g, '代码片段')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/^[#>*+-]+\s*/gm, '')
    .replace(/\*{1,2}|_{1,2}|~/g, '')
    .replace(/\s+/g, ' ')
    .trim();

  return normalized || '正在生成回复…';
}
</script>

<template>
  <aside
    v-if="turns.length > 1"
    class="pointer-events-none absolute inset-y-6 right-2 z-20 hidden w-12 items-center justify-center md:flex"
    aria-label="历史消息导航"
  >
    <div class="app-scrollbar pointer-events-auto flex max-h-full w-full flex-col items-center gap-1 overflow-y-auto py-1">
      <button
        v-for="(turn, index) in turns"
        :key="turn.id"
        type="button"
        class="relative h-3 w-10 shrink-0 cursor-pointer rounded-sm outline-none after:absolute after:left-1/2 after:top-1/2 after:h-0.5 after:-translate-x-1/2 after:-translate-y-1/2 after:rounded-full after:bg-border after:transition-[width,background-color] hover:after:w-8 hover:after:bg-foreground focus-visible:ring-2 focus-visible:ring-ring dark:after:bg-white/15 dark:hover:after:bg-white/75"
        :class="isActiveTurn(turn) ? 'after:w-8 after:bg-foreground' : 'after:w-5'"
        :aria-label="`跳转到第 ${index + 1} 轮对话`"
        @mouseenter="hoveredTurnId = turn.id"
        @mouseleave="hoveredTurnId = undefined"
        @focus="hoveredTurnId = turn.id"
        @blur="hoveredTurnId = undefined"
        @click="emit('jump', turn.user?.id || turn.assistant!.id)"
      />
    </div>

    <div
      v-if="hoveredTurn"
      class="pointer-events-none absolute right-12 top-1/2 w-80 -translate-y-1/2 rounded-xl border border-border bg-popover p-4 text-popover-foreground shadow-lg"
      role="status"
    >
      <p v-if="hoveredTurn.user" class="m-0 line-clamp-2 text-sm font-medium leading-6">
        {{ previewText(hoveredTurn.user.content) }}
      </p>
      <p v-if="hoveredTurn.assistant" class="m-0 mt-1.5 line-clamp-3 text-sm leading-6 text-muted-foreground">
        {{ previewText(hoveredTurn.assistant.content) }}
      </p>
    </div>
  </aside>
</template>
