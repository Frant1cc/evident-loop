<script setup lang="ts">
import { PhCaretDoubleLeft, PhPlus, PhTrash } from '@phosphor-icons/vue';

import type { ResearchConversation } from '../../types/research';

defineProps<{
  conversations: ResearchConversation[];
  activeConversationId?: string;
  collapsed: boolean;
  busy: boolean;
}>();

defineEmits<{
  create: [];
  select: [id: string];
  delete: [conversation: ResearchConversation];
  toggle: [];
}>();
</script>

<template>
  <aside
    class="grid min-w-0 grid-rows-[auto_minmax(0,1fr)] border-r border-[var(--agent-border)] bg-[var(--agent-surface-muted)] max-md:border-b max-md:border-r-0"
    :class="collapsed ? 'gap-3 p-2' : 'gap-3 p-3'"
    aria-label="研究会话列表"
  >
    <div v-if="collapsed" class="grid justify-items-center gap-2">
      <button type="button" class="grid h-8 w-8 place-items-center rounded-md text-[var(--agent-text-muted)] hover:bg-[var(--agent-surface)]" aria-label="展开会话栏" title="展开会话栏" @click="$emit('toggle')">
        <PhCaretDoubleLeft :size="17" class="rotate-180" />
      </button>
      <button type="button" class="grid h-8 w-8 place-items-center rounded-md bg-[var(--agent-selected-bg)] text-[var(--agent-selected-text)] hover:bg-[var(--agent-surface)]" aria-label="新研究" title="新研究" @click="$emit('create')">
        <PhPlus :size="17" weight="bold" />
      </button>
    </div>

    <template v-else>
      <div class="flex items-center justify-between gap-2">
        <button type="button" class="inline-flex h-8 items-center gap-2 rounded-md px-2 text-sm font-bold text-[var(--agent-text)] hover:bg-[var(--agent-surface)]" @click="$emit('create')">
          <PhPlus :size="17" weight="bold" />
          新研究
        </button>
        <button type="button" class="grid h-8 w-8 place-items-center rounded-md text-[var(--agent-text-muted)] hover:bg-[var(--agent-surface)]" aria-label="收起会话栏" title="收起会话栏" @click="$emit('toggle')">
          <PhCaretDoubleLeft :size="17" />
        </button>
      </div>
      <div class="chat-session-scroll grid content-start gap-1 overflow-auto">
        <div
          v-for="conversation in conversations"
          :key="conversation.id"
          class="group flex min-w-0 items-center rounded-md transition-colors"
          :class="conversation.id === activeConversationId ? 'bg-[var(--agent-selected-bg)] text-[var(--agent-selected-text)]' : 'text-[var(--agent-text-muted)] hover:bg-[var(--agent-surface)] hover:text-[var(--agent-text)]'"
        >
          <button
            type="button"
            class="min-w-0 flex-1 px-2.5 py-2 text-left text-sm font-semibold"
            :title="conversation.title"
            @click="$emit('select', conversation.id)"
          >
            <span class="block truncate">{{ conversation.title }}</span>
          </button>
          <button
            type="button"
            class="mr-1 grid size-7 shrink-0 place-items-center rounded-[5px] text-[var(--agent-error-text)] opacity-0 transition-opacity hover:bg-[var(--agent-error-bg)] focus:opacity-100 disabled:cursor-wait disabled:opacity-40 group-hover:opacity-100"
            :disabled="busy"
            :aria-label="`删除会话：${conversation.title}`"
            title="删除会话"
            @click="$emit('delete', conversation)"
          >
            <PhTrash :size="15" weight="bold" aria-hidden="true" />
          </button>
        </div>
      </div>
    </template>
  </aside>
</template>
