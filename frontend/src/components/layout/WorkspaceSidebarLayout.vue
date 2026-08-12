<script setup lang="ts">
import { computed } from 'vue';

import PanelResizeHandle from '../common/PanelResizeHandle.vue';

const props = withDefaults(defineProps<{
  width: number;
  collapsed?: boolean;
  collapsedWidth?: number;
  minWidth: number;
  maxWidth: number;
  defaultWidth: number;
  resizeLabel?: string;
  mobileSidebarHeight?: number;
}>(), {
  collapsed: false,
  collapsedWidth: 60,
  resizeLabel: '调整侧栏宽度',
  mobileSidebarHeight: 72
});

const emit = defineEmits<{
  'update:width': [value: number];
}>();

const layoutStyle = computed(() => ({
  '--workspace-sidebar-width': `${props.collapsed ? props.collapsedWidth : props.width}px`,
  '--workspace-mobile-sidebar-height': `${props.mobileSidebarHeight}px`
}));
</script>

<template>
  <div
    class="relative grid h-full min-h-0 grid-cols-[var(--workspace-sidebar-width)_minmax(0,1fr)] overflow-hidden bg-background max-md:grid-cols-1 max-md:grid-rows-[var(--workspace-mobile-sidebar-height)_minmax(0,1fr)]"
    :style="layoutStyle"
  >
    <slot name="sidebar" />

    <PanelResizeHandle
      v-if="!collapsed"
      :width="width"
      edge="left"
      :min="minWidth"
      :max="maxWidth"
      :default-width="defaultWidth"
      :label="resizeLabel"
      class="max-md:hidden"
      @update:width="emit('update:width', $event)"
    />

    <slot />
  </div>
</template>
