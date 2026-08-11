<script setup lang="ts">
import type { BlockStatus } from '../../markdown/structuredBlockDetector';

const props = defineProps<{ status: BlockStatus }>();

const LABELS: Record<BlockStatus, string> = {
  generating: '生成中',
  complete: '',
  repaired: '格式已自动修复'
};
</script>

<template>
  <span v-if="props.status !== 'complete'" class="markdown-code-state">{{ LABELS[props.status] }}</span>
</template>
