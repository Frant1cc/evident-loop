<script setup lang="ts">
const model = defineModel<string>({ required: true });

defineProps<{
  loading: boolean;
}>();

const emit = defineEmits<{
  send: [];
}>();
</script>

<template>
  <form @submit.prevent="emit('send')">
    <label for="prompt" class="sr-only">输入</label>
    <div class="flex gap-2">
      <input
        id="prompt"
        v-model="model"
        type="text"
        placeholder="输入你想让 Agent 处理的任务..."
        autocomplete="off"
        class="min-w-0 flex-1 rounded-md border border-[var(--agent-border)] bg-[var(--agent-surface-muted)] px-3 py-2.5 text-sm text-[var(--agent-text)] outline-none focus:border-[var(--agent-selected-border)]"
      />
      <button
        type="submit"
        :disabled="loading || !model.trim()"
        class="cursor-pointer rounded-md bg-[var(--agent-selected-bg)] px-4 text-sm font-bold text-[var(--agent-selected-text)] transition-colors hover:bg-[var(--agent-surface-muted)] disabled:cursor-not-allowed disabled:opacity-50"
      >
        {{ loading ? '发送中' : '发送' }}
      </button>
    </div>
  </form>
</template>
