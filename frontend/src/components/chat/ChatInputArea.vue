<script setup lang="ts">
import ChatComposer from './ChatComposer.vue';

const model = defineModel<string>({ required: true });

defineProps<{
  loading: boolean;
  error: string;
}>();

const emit = defineEmits<{
  send: [];
}>();
</script>

<template>
  <footer class="grid gap-2 border-t border-[var(--agent-border)] p-4">
    <p v-if="error" class="m-0 text-sm font-semibold text-[var(--agent-error-text)]">{{ error }}</p>
    <ChatComposer v-model="model" :loading="loading" @send="emit('send')" />
  </footer>
</template>
