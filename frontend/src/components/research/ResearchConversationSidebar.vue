<script setup lang="ts">
import { PhCaretDoubleLeft, PhPlus, PhTrash } from '@phosphor-icons/vue';

import { Button } from '@/components/ui/button';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import type { ResearchConversation } from '../../types/research';

defineProps<{
  conversations: ResearchConversation[];
  activeConversationId?: string;
  collapsed: boolean;
  busy: boolean;
}>();

const emit = defineEmits<{
  create: [];
  select: [id: string];
  delete: [conversation: ResearchConversation];
  toggle: [];
}>();

function formatUpdatedAt(value: string) {
  const date = new Date(value);
  const today = new Date();
  const sameDay = date.toDateString() === today.toDateString();

  return new Intl.DateTimeFormat('zh-CN', sameDay
    ? { hour: '2-digit', minute: '2-digit' }
    : { month: 'numeric', day: 'numeric' }
  ).format(date);
}
</script>

<template>
  <aside
    class="grid h-full min-h-0 min-w-0 grid-rows-[auto_minmax(0,1fr)] overflow-hidden border-r border-sidebar-border bg-sidebar text-sidebar-foreground max-md:grid-cols-[auto_minmax(0,1fr)] max-md:grid-rows-1 max-md:border-b max-md:border-r-0"
    :class="collapsed ? 'gap-2 p-2' : 'gap-3 p-3'"
    aria-label="研究会话列表"
  >
    <div v-if="collapsed" class="grid content-start justify-items-center gap-2 max-md:flex">
      <Tooltip>
        <TooltipTrigger as-child>
          <Button type="button" variant="ghost" size="icon" aria-label="展开会话栏" @click="emit('toggle')">
            <PhCaretDoubleLeft :size="17" class="rotate-180" aria-hidden="true" />
          </Button>
        </TooltipTrigger>
        <TooltipContent side="right">展开会话栏</TooltipContent>
      </Tooltip>
      <Tooltip>
        <TooltipTrigger as-child>
          <Button type="button" variant="secondary" size="icon" aria-label="新研究" @click="emit('create')">
            <PhPlus :size="17" weight="bold" aria-hidden="true" />
          </Button>
        </TooltipTrigger>
        <TooltipContent side="right">新研究</TooltipContent>
      </Tooltip>
    </div>

    <div v-else class="grid min-w-0 gap-3 max-md:block">
      <div class="flex items-center justify-between gap-2 max-md:hidden">
        <div class="min-w-0 px-1">
          <p class="m-0 text-[11px] font-semibold uppercase tracking-[0.12em] text-muted-foreground">Workspace</p>
          <h2 class="m-0 mt-1 text-sm font-semibold">研究会话</h2>
        </div>
        <Tooltip>
          <TooltipTrigger as-child>
            <Button type="button" variant="ghost" size="icon-sm" aria-label="收起会话栏" @click="emit('toggle')">
              <PhCaretDoubleLeft :size="16" aria-hidden="true" />
            </Button>
          </TooltipTrigger>
          <TooltipContent>收起会话栏</TooltipContent>
        </Tooltip>
      </div>

      <Button variant="secondary" class="w-full justify-start max-md:w-auto max-md:px-4" size="lg" aria-label="新研究" @click="emit('create')">
        <PhPlus :size="16" weight="bold" aria-hidden="true" />
        <span>新研究</span>
      </Button>
    </div>

    <nav
      v-if="!collapsed"
      class="app-scrollbar min-h-0 space-y-1 overflow-y-auto overscroll-contain max-md:flex max-md:space-y-0 max-md:space-x-1 max-md:overflow-x-auto max-md:overflow-y-hidden"
      aria-label="研究会话"
    >
      <div
        v-for="conversation in conversations"
        :key="conversation.id"
        class="group flex min-w-0 items-center rounded-lg transition-colors max-md:w-44 max-md:shrink-0"
        :class="conversation.id === activeConversationId ? 'bg-sidebar-accent text-sidebar-accent-foreground' : 'text-muted-foreground hover:bg-sidebar-accent/60 hover:text-sidebar-accent-foreground'"
      >
        <button
          type="button"
          class="flex min-w-0 flex-1 cursor-pointer items-center px-3 py-2.5 text-left outline-none focus-visible:ring-2 focus-visible:ring-sidebar-ring"
          :title="conversation.title"
          @click="emit('select', conversation.id)"
        >
          <span class="min-w-0 flex-1">
            <span class="block truncate text-sm font-medium">{{ conversation.title }}</span>
            <span class="mt-0.5 block text-[11px] text-muted-foreground">{{ formatUpdatedAt(conversation.updatedAt) }}</span>
          </span>
        </button>
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          class="mr-1 shrink-0 text-destructive opacity-0 group-hover:opacity-100 focus:opacity-100 max-md:opacity-100"
          :disabled="busy"
          :aria-label="`删除会话：${conversation.title}`"
          @click="emit('delete', conversation)"
        >
          <PhTrash :size="14" weight="bold" aria-hidden="true" />
        </Button>
      </div>

      <div v-if="!conversations.length" class="grid place-items-center px-3 py-10 text-center text-muted-foreground max-md:hidden">
        <p class="m-0 text-xs leading-5">创建第一个研究会话，围绕知识库展开研究。</p>
      </div>
    </nav>
  </aside>
</template>
