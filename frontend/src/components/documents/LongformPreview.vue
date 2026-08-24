<script setup lang="ts">
import { computed } from 'vue';
import type { LongformBlock } from '../../types/artifacts';

const props = defineProps<{
  blocks: LongformBlock[];
  selectedBlockId?: string;
}>();

const emit = defineEmits<{
  'update:selectedBlockId': [id: string];
}>();
</script>

<template>
  <div class="longform-preview h-full overflow-y-auto">
    <p class="m-0 mb-4 text-center text-[10px] text-[var(--agent-text-muted)]">连续阅读视图，分页以实际生成结果为准</p>

    <div
      class="mx-auto max-w-[680px] rounded-lg border border-[var(--agent-border)] bg-white px-12 py-10 shadow-sm dark:bg-[#1e1e1e]"
    >
      <div
        v-for="block in blocks"
        :key="block.id"
        class="block-item cursor-pointer rounded-sm transition-colors"
        :class="block.id === selectedBlockId
          ? 'ring-2 ring-[var(--agent-selected-border)]'
          : 'hover:bg-[var(--agent-surface-muted)]/30'"
        :aria-current="block.id === selectedBlockId ? 'true' : undefined"
        @click="emit('update:selectedBlockId', block.id)"
      >
        <h1
          v-if="block.type === 'heading' && block.level === 1"
          class="mb-3 mt-6 text-2xl font-bold text-[var(--agent-text)] first:mt-0"
        >
          {{ block.text || '（空标题）' }}
        </h1>
        <h2
          v-else-if="block.type === 'heading' && block.level === 2"
          class="mb-2 mt-5 text-xl font-bold text-[var(--agent-text)] first:mt-0"
        >
          {{ block.text || '（空标题）' }}
        </h2>
        <h3
          v-else-if="block.type === 'heading' && block.level === 3"
          class="mb-2 mt-4 text-base font-semibold text-[var(--agent-text)] first:mt-0"
        >
          {{ block.text || '（空标题）' }}
        </h3>

        <p
          v-else-if="block.type === 'paragraph'"
          class="mb-3 text-sm leading-relaxed text-[var(--agent-text)]"
        >
          {{ block.text || '（空段落）' }}
        </p>

        <ul
          v-else-if="block.type === 'bulletList'"
          class="mb-3 list-disc pl-6 text-sm leading-relaxed text-[var(--agent-text)]"
        >
          <li v-for="(item, i) in block.items" :key="i">{{ item }}</li>
        </ul>

        <ol
          v-else-if="block.type === 'numberedList'"
          class="mb-3 list-decimal pl-6 text-sm leading-relaxed text-[var(--agent-text)]"
        >
          <li v-for="(item, i) in block.items" :key="i">{{ item }}</li>
        </ol>

        <div
          v-else-if="block.type === 'table'"
          class="mb-3 overflow-x-auto"
        >
          <table class="w-full border-collapse text-sm">
            <thead>
              <tr>
                <th
                  v-for="(header, i) in block.headers"
                  :key="i"
                  class="border border-[var(--agent-border)] bg-[var(--agent-surface-muted)] px-3 py-2 text-left text-xs font-bold text-[var(--agent-text)]"
                >
                  {{ header }}
                </th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="(row, ri) in block.rows" :key="ri">
                <td
                  v-for="(cell, ci) in row"
                  :key="ci"
                  class="border border-[var(--agent-border)] px-3 py-2 text-xs text-[var(--agent-text)]"
                >
                  {{ cell }}
                </td>
              </tr>
            </tbody>
          </table>
        </div>

        <div
          v-else-if="block.type === 'pageBreak'"
          class="my-4 flex items-center gap-3 text-[10px] text-[var(--agent-text-muted)]"
        >
          <div class="h-px flex-1 bg-[var(--agent-border)]" aria-hidden="true" />
          分页符
          <div class="h-px flex-1 bg-[var(--agent-border)]" aria-hidden="true" />
        </div>
      </div>

      <div v-if="!blocks.length" class="py-16 text-center text-sm text-[var(--agent-text-muted)]">
        暂无内容块，从右侧添加
      </div>
    </div>
  </div>
</template>
