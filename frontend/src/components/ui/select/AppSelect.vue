<script setup lang="ts">
import type { HTMLAttributes } from 'vue';
import { PhCaretDown, PhCheck } from '@phosphor-icons/vue';
import {
  SelectContent,
  SelectItem,
  SelectItemIndicator,
  SelectItemText,
  SelectPortal,
  SelectRoot,
  SelectTrigger,
  SelectValue,
  SelectViewport
} from 'reka-ui';

import { cn } from '@/lib/utils';

defineOptions({ inheritAttrs: false });

const props = defineProps<{
  modelValue: string;
  options: Array<{ value: string; label: string }>;
  label: string;
  class?: HTMLAttributes['class'];
}>();

const emit = defineEmits<{
  'update:modelValue': [value: string];
}>();
</script>

<template>
  <SelectRoot :model-value="modelValue" @update:model-value="(value) => emit('update:modelValue', String(value))">
    <SelectTrigger
      :aria-label="label"
      :class="cn(
        'group/select inline-flex h-9 min-w-0 items-center justify-between gap-3 rounded-lg border border-input bg-background px-3 text-sm font-medium text-foreground shadow-xs outline-none transition-[border-color,box-shadow,background-color] hover:bg-muted/45 focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/20 data-[state=open]:border-ring data-[state=open]:bg-muted/45 data-[state=open]:ring-3 data-[state=open]:ring-ring/15',
        props.class
      )"
    >
      <SelectValue class="min-w-0 truncate" />
      <PhCaretDown class="size-3.5 shrink-0 text-muted-foreground transition-transform duration-150 group-data-[state=open]/select:rotate-180" weight="bold" aria-hidden="true" />
    </SelectTrigger>

    <SelectPortal>
      <SelectContent
        position="popper"
        side="bottom"
        align="start"
        :side-offset="5"
        class="z-[80] min-w-[var(--reka-select-trigger-width)] overflow-hidden rounded-lg border border-border bg-popover text-popover-foreground shadow-md data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95"
      >
        <SelectViewport class="max-h-72 p-1">
          <SelectItem
            v-for="option in options"
            :key="option.value"
            :value="option.value"
            class="relative flex h-8 cursor-default select-none items-center rounded-md py-1.5 pl-8 pr-3 text-sm outline-none transition-colors data-[highlighted]:bg-accent data-[highlighted]:text-accent-foreground data-[disabled]:pointer-events-none data-[disabled]:opacity-50"
          >
            <SelectItemIndicator class="absolute left-2.5 grid size-4 place-items-center text-foreground">
              <PhCheck :size="13" weight="bold" aria-hidden="true" />
            </SelectItemIndicator>
            <SelectItemText>{{ option.label }}</SelectItemText>
          </SelectItem>
        </SelectViewport>
      </SelectContent>
    </SelectPortal>
  </SelectRoot>
</template>
