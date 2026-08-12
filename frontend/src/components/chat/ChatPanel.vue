<script setup lang="ts">
import ChatInputArea from './ChatInputArea.vue';
import ChatMessages from './ChatMessages.vue';
import type { ChatMessage } from '../../types/chat';

const model = defineModel<string>({ required: true });

defineProps<{
  conversationId?: string;
  conversationTitle?: string;
  messages: ChatMessage[];
  loading: boolean;
  error: string;
}>();

const emit = defineEmits<{
  send: [];
}>();
</script>

<template>
  <section class="grid h-full min-h-0 min-w-0 grid-rows-[auto_minmax(0,1fr)_auto] overflow-hidden bg-background">
    <header class="flex h-11 min-h-11 items-center border-b border-border px-4 md:px-5">
      <h1 class="m-0 min-w-0 truncate text-sm font-semibold tracking-[-0.01em] text-foreground">
        {{ conversationTitle || '新会话' }}
      </h1>
    </header>

    <ChatMessages :conversation-id="conversationId" :messages="messages" />
    <ChatInputArea v-model="model" :loading="loading" :error="error" @send="emit('send')" />
  </section>
</template>
