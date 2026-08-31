<script setup lang="ts">
import { PhFileArrowDown, PhTrash } from '@phosphor-icons/vue';

import { Button } from '../ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '../ui/dialog';

withDefaults(defineProps<{
  open: boolean;
  title: string;
  description: string;
  detail?: string;
  confirmLabel?: string;
  cancelLabel?: string;
  busy?: boolean;
  destructive?: boolean;
}>(), {
  detail: undefined,
  confirmLabel: '确认',
  cancelLabel: '取消',
  busy: false,
  destructive: false
});

const emit = defineEmits<{
  'update:open': [open: boolean];
  confirm: [];
}>();
</script>

<template>
  <Dialog :open="open" @update:open="emit('update:open', $event)">
    <DialogContent class="sm:max-w-md">
      <DialogHeader>
        <div
          class="mb-1 flex size-10 items-center justify-center rounded-lg"
          :class="destructive
            ? 'bg-destructive/10 text-destructive'
            : 'bg-[var(--agent-selected-bg)] text-[var(--agent-selected-text)]'"
        >
          <PhTrash v-if="destructive" :size="19" weight="bold" aria-hidden="true" />
          <PhFileArrowDown v-else :size="19" weight="bold" aria-hidden="true" />
        </div>
        <DialogTitle>{{ title }}</DialogTitle>
        <DialogDescription>{{ description }}</DialogDescription>
      </DialogHeader>

      <div
        v-if="detail"
        class="rounded-lg border border-border bg-muted/50 px-3 py-2.5 text-sm font-semibold text-foreground"
      >
        {{ detail }}
      </div>

      <DialogFooter>
        <Button variant="outline" :disabled="busy" @click="emit('update:open', false)">
          {{ cancelLabel }}
        </Button>
        <Button :variant="destructive ? 'destructive' : 'default'" :disabled="busy" @click="emit('confirm')">
          {{ busy ? '处理中…' : confirmLabel }}
        </Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>
</template>
