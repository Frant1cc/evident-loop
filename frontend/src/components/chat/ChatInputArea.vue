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
  <footer class="px-3 pb-2 pt-0 md:px-5">
    <div class="mx-auto grid w-full max-w-4xl gap-1.5">
      <div v-if="error" class="rounded-md bg-destructive/5 px-2.5 py-1.5 text-xs text-destructive" role="alert">
        {{ error }}
      </div>
      <ChatComposer v-model="model" :loading="loading" @send="emit('send')" />
    </div>
  </footer>
</template>
