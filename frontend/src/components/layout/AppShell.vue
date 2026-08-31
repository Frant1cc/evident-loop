<script setup lang="ts">
withDefaults(defineProps<{
  label?: string;
}>(), {
  label: 'EvidentLoop'
});
</script>

<template>
  <main class="grid h-[100dvh] min-h-0 min-w-0 grid-cols-[minmax(0,1fr)] overflow-hidden bg-background text-foreground">
    <section
      class="grid h-full min-h-0 min-w-0 w-full grid-cols-[minmax(0,1fr)] grid-rows-[auto_minmax(0,1fr)] overflow-hidden bg-background"
      :aria-label="label"
    >
      <header class="border-b border-border bg-background/95 px-4 py-3 backdrop-blur md:px-6">
        <slot name="navigation" />
      </header>
      <slot />
    </section>
  </main>
</template>
