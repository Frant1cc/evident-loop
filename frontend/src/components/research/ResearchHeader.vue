<script setup lang="ts">
defineProps<{
  title?: string;
}>();
</script>

<template>
  <header class="flex h-11 min-h-11 items-center border-b border-border bg-background px-4 md:px-5">
    <h1 class="m-0 min-w-0 truncate text-sm font-semibold tracking-[-0.01em] text-foreground">
      {{ title || '研究工作台' }}
    </h1>
  </header>
</template>
