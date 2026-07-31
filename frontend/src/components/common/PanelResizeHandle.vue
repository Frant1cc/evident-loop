<script setup lang="ts">
import { computed, onBeforeUnmount, ref } from 'vue';
import { PhDotsSixVertical } from '@phosphor-icons/vue';

import { clampPanelWidth } from '../../composables/useResizablePanel';

const props = defineProps<{
  /** Layout edge the panel is docked to: a left panel grows on rightward drags, a right panel on leftward drags. */
  edge: 'left' | 'right';
  width: number;
  min: number;
  max: number;
  defaultWidth: number;
  label: string;
}>();

const emit = defineEmits<{ 'update:width': [value: number] }>();

const dragging = ref(false);
let startX = 0;
let startWidth = 0;

const positionStyle = computed(() =>
  props.edge === 'left'
    ? { left: `${props.width}px`, transform: 'translateX(-50%)' }
    : { right: `${props.width}px`, transform: 'translateX(50%)' }
);

function applyWidth(value: number) {
  emit('update:width', clampPanelWidth(value, props.min, props.max));
}

function onPointerDown(event: PointerEvent) {
  if (event.button !== 0) return;
  const target = event.currentTarget as HTMLElement;
  dragging.value = true;
  startX = event.clientX;
  startWidth = props.width;
  target.setPointerCapture(event.pointerId);
  target.focus();
  document.body.classList.add('is-panel-resizing');
  event.preventDefault();
}

function onPointerMove(event: PointerEvent) {
  if (!dragging.value) return;
  const delta = event.clientX - startX;
  applyWidth(props.edge === 'left' ? startWidth + delta : startWidth - delta);
}

function stopDragging(event: PointerEvent) {
  if (!dragging.value) return;
  dragging.value = false;
  const target = event.currentTarget as HTMLElement;
  if (target.hasPointerCapture(event.pointerId)) target.releasePointerCapture(event.pointerId);
  document.body.classList.remove('is-panel-resizing');
}

function onKeydown(event: KeyboardEvent) {
  if (event.key === 'Home') {
    event.preventDefault();
    applyWidth(props.defaultWidth);
    return;
  }

  const grow = props.edge === 'left' ? 'ArrowRight' : 'ArrowLeft';
  const shrink = props.edge === 'left' ? 'ArrowLeft' : 'ArrowRight';
  if (event.key !== grow && event.key !== shrink) return;

  event.preventDefault();
  const step = event.shiftKey ? 48 : 16;
  applyWidth(props.width + (event.key === grow ? step : -step));
}

onBeforeUnmount(() => document.body.classList.remove('is-panel-resizing'));
</script>

<template>
  <div
    class="group absolute inset-y-0 z-10 flex w-3 cursor-col-resize touch-none select-none items-center justify-center outline-none"
    :style="positionStyle"
    role="separator"
    aria-orientation="vertical"
    :aria-label="label"
    :aria-valuenow="Math.round(width)"
    :aria-valuemin="min"
    :aria-valuemax="max"
    tabindex="0"
    :title="`${label}：拖拽调整宽度，双击或按 Home 恢复默认`"
    @pointerdown="onPointerDown"
    @pointermove="onPointerMove"
    @pointerup="stopDragging"
    @pointercancel="stopDragging"
    @dblclick="applyWidth(defaultWidth)"
    @keydown="onKeydown"
  >
    <span
      class="pointer-events-none absolute inset-y-0 left-1/2 -translate-x-1/2 transition-all"
      :class="dragging ? 'w-0.5 bg-[var(--agent-text)]' : 'w-px bg-[var(--agent-border)] group-hover:w-0.5 group-hover:bg-[var(--agent-selected-border)] group-focus-visible:w-0.5 group-focus-visible:bg-[var(--agent-text)]'"
    />
    <span
      class="pointer-events-none relative grid h-7 w-3 place-items-center rounded-full border bg-[var(--agent-surface)] transition-colors"
      :class="dragging
        ? 'border-[var(--agent-text)] text-[var(--agent-text)]'
        : 'border-[var(--agent-border)] text-[var(--agent-text-muted)] group-hover:border-[var(--agent-selected-border)] group-hover:text-[var(--agent-text)]'"
    >
      <PhDotsSixVertical :size="12" weight="bold" aria-hidden="true" />
    </span>
  </div>
</template>
