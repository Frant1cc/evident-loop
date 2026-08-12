<script setup lang="ts">
import { PhArrowUp, PhCircleNotch, PhPaperclip } from '@phosphor-icons/vue';

import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';

const model = defineModel<string>({ required: true });

defineProps<{
  loading: boolean;
}>();

const emit = defineEmits<{
  send: [];
}>();

function handleKeydown(event: KeyboardEvent) {
  if (event.key !== 'Enter' || event.shiftKey || event.isComposing) return;
  event.preventDefault();
  emit('send');
}
</script>

<template>
  <form class="rounded-2xl border border-input bg-card p-2 shadow-[0_12px_40px_-24px_oklch(0.145_0_0_/_0.45)] transition-shadow focus-within:border-ring focus-within:ring-3 focus-within:ring-ring/20 dark:border-white/[0.09] dark:bg-card/80 dark:shadow-[0_18px_48px_-30px_rgb(0_0_0_/_0.9)]" @submit.prevent="emit('send')">
    <label for="prompt" class="sr-only">输入消息</label>
    <Textarea
      id="prompt"
      v-model="model"
      rows="1"
      placeholder="向 EvidentLoop 提问…"
      autocomplete="off"
      class="max-h-44 min-h-12 resize-none border-0 bg-transparent px-2.5 py-2.5 shadow-none focus-visible:ring-0 dark:bg-transparent"
      @keydown="handleKeydown"
    />
    <div class="mt-1 flex items-center justify-between gap-3">
      <Tooltip>
        <TooltipTrigger as-child>
          <Button type="button" variant="ghost" size="icon-sm" aria-label="添加附件" disabled>
            <PhPaperclip :size="16" weight="bold" aria-hidden="true" />
          </Button>
        </TooltipTrigger>
        <TooltipContent>附件功能即将提供</TooltipContent>
      </Tooltip>

      <Button type="submit" size="icon" class="rounded-xl" :disabled="loading || !model.trim()" :aria-label="loading ? '正在生成回复' : '发送消息'">
        <PhCircleNotch v-if="loading" :size="17" class="animate-spin" aria-hidden="true" />
        <PhArrowUp v-else :size="17" weight="bold" aria-hidden="true" />
      </Button>
    </div>
  </form>
</template>
