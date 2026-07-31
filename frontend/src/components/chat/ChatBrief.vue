<script setup lang="ts">
defineProps<{
  title: string;
  loading: boolean;
  messageCount: number;
}>();
</script>

<template>
  <header class="flex items-start justify-between gap-4 border-b border-[var(--agent-border-soft)] pb-3.5 max-sm:grid">
    <div>
      <p class="mb-1 text-xs font-bold uppercase text-[var(--agent-text-muted)]">当前会话</p>
      <h2 class="m-0 text-2xl font-bold leading-tight tracking-normal text-[var(--agent-text)]">{{ title }}</h2>
    </div>

    <div class="flex flex-wrap justify-end gap-2 max-sm:justify-start" aria-label="会话状态">
      <span class="inline-flex min-h-7 items-center rounded-full bg-[var(--agent-primary-soft)] px-2.5 text-[13px] font-semibold text-[var(--agent-primary)]">
        {{ loading ? '思考中' : '在线' }}
      </span>
      <span class="inline-flex min-h-7 items-center rounded-full bg-[var(--agent-primary-soft)] px-2.5 text-[13px] font-semibold text-[var(--agent-primary)]">
        {{ messageCount }} 条消息
      </span>
    </div>
  </header>
</template>
