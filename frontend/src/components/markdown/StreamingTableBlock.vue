<script setup lang="ts">
import { computed } from 'vue';

import type { Alignment, BlockStatus } from '../../markdown/structuredBlockDetector';
import StructuredBlockStatus from './StructuredBlockStatus.vue';

const props = defineProps<{
  headerCells: string[];
  alignments: Alignment[];
  completedRows: string[][];
  currentRow: string[] | null;
  status: BlockStatus;
}>();

const ALIGN: Record<Alignment, 'left' | 'center' | 'right' | undefined> = {
  left: 'left',
  center: 'center',
  right: 'right',
  none: undefined
};

function styleOf(index: number): { textAlign: 'left' | 'center' | 'right' } | undefined {
  const align = ALIGN[props.alignments[index] ?? 'none'];
  return align ? { textAlign: align } : undefined;
}
</script>

<template>
  <div class="stream-table-block">
    <div class="stream-table-header-bar">
      <StructuredBlockStatus :status="status" />
    </div>
    <div class="stream-table-scroll">
      <table>
        <thead>
          <tr>
            <th v-for="(cell, index) in headerCells" :key="index" :style="styleOf(index)">
              {{ cell }}
            </th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="(row, rowIndex) in completedRows" :key="`r-${rowIndex}`">
            <td v-for="(cell, cellIndex) in row" :key="cellIndex" :style="styleOf(cellIndex)">
              {{ cell }}
            </td>
          </tr>
          <tr v-if="currentRow" class="stream-table-current">
            <td
              v-for="(cell, cellIndex) in currentRow"
              :key="cellIndex"
              :style="styleOf(cellIndex)"
            >
              {{ cell }}
            </td>
          </tr>
        </tbody>
      </table>
    </div>
  </div>
</template>

<style scoped>
.stream-table-block {
  margin-top: 0.8rem;
}

.stream-table-header-bar {
  display: flex;
  justify-content: flex-end;
  min-height: 1rem;
}

.stream-table-header-bar :deep(.markdown-code-state) {
  display: inline-flex;
  align-items: center;
  gap: 0.35rem;
  color: #8a5a14;
  font-size: 0.68rem;
  font-weight: 650;
}

.stream-table-header-bar :deep(.markdown-code-state::before) {
  width: 0.34rem;
  height: 0.34rem;
  border-radius: 999px;
  background: #b7791f;
  content: '';
  animation: stream-table-pulse 1.2s ease-in-out infinite;
}

.stream-table-scroll {
  overflow-x: auto;
  max-width: 100%;
}

table {
  border-collapse: collapse;
  width: max-content;
  max-width: none;
}

th,
td {
  border: 1px solid var(--agent-border);
  padding: 0.45rem 0.65rem;
  text-align: left;
  color: var(--agent-text);
}

th {
  background: var(--agent-surface-muted);
  font-weight: 750;
}

.stream-table-current td {
  background: var(--agent-surface-muted);
  color: var(--agent-text-muted);
}

@keyframes stream-table-pulse {
  0%, 100% { opacity: 0.35; transform: scale(0.82); }
  50% { opacity: 1; transform: scale(1); }
}

@media (prefers-reduced-motion: reduce) {
  .stream-table-header-bar :deep(.markdown-code-state::before) {
    animation: none;
  }
}
</style>
