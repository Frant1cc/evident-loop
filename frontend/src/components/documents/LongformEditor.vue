<script setup lang="ts">
import { PhPlus, PhTrash, PhCaretUp, PhCaretDown } from '@phosphor-icons/vue';
import { computed } from 'vue';
import type { LongformBlock } from '../../types/artifacts';
import { generateBlockId } from './documentEditor';

const props = defineProps<{
  blocks: LongformBlock[];
  selectedBlockId?: string;
  editable?: boolean;
}>();

const emit = defineEmits<{
  'update:selectedBlockId': [id: string];
  'add-block': [type: LongformBlock['type'], afterId?: string];
  'update-block': [id: string, block: LongformBlock];
  'delete-block': [id: string];
  'move-up': [id: string];
  'move-down': [id: string];
}>();

const selectedBlock = computed(() => {
  return props.blocks.find(b => b.id === props.selectedBlockId);
});

const selectedIndex = computed(() => {
  const block = selectedBlock.value;
  if (!block) return -1;
  return props.blocks.findIndex(b => b.id === block.id);
});

const canMoveUp = computed(() => selectedIndex.value > 0);
const canMoveDown = computed(() => selectedIndex.value >= 0 && selectedIndex.value < props.blocks.length - 1);

function selectBlock(id: string) {
  emit('update:selectedBlockId', id);
}

function updateSelectedBlock(updates: Partial<LongformBlock>) {
  if (!selectedBlock.value) return;
  emit('update-block', selectedBlock.value.id, { ...selectedBlock.value, ...updates } as LongformBlock);
}

function updateTableCell(rowIndex: number, colIndex: number, value: string) {
  const block = selectedBlock.value;
  if (!block || block.type !== 'table') return;
  const rows = block.rows.map((row, ri) =>
    ri === rowIndex ? row.map((cell, ci) => (ci === colIndex ? value : cell)) : row
  );
  updateSelectedBlock({ rows });
}

function addTableRow() {
  const block = selectedBlock.value;
  if (!block || block.type !== 'table') return;
  const newRow = new Array(block.headers.length).fill('');
  updateSelectedBlock({ rows: [...block.rows, newRow] });
}

function removeTableRow(index: number) {
  const block = selectedBlock.value;
  if (!block || block.type !== 'table' || block.rows.length <= 1) return;
  updateSelectedBlock({ rows: block.rows.filter((_, i) => i !== index) });
}

function updateListItem(index: number, value: string) {
  const block = selectedBlock.value;
  if (!block || (block.type !== 'bulletList' && block.type !== 'numberedList')) return;
  const items = [...block.items];
  items[index] = value;
  updateSelectedBlock({ items });
}

function addListItem() {
  const block = selectedBlock.value;
  if (!block || (block.type !== 'bulletList' && block.type !== 'numberedList')) return;
  updateSelectedBlock({ items: [...block.items, ''] });
}

function removeListItem(index: number) {
  const block = selectedBlock.value;
  if (!block || (block.type !== 'bulletList' && block.type !== 'numberedList')) return;
  const items = block.items.filter((_, i) => i !== index);
  updateSelectedBlock({ items: items.length ? items : [''] });
}

const blockTypeLabel = computed(() => {
  const block = selectedBlock.value;
  if (!block) return '';
  const labels: Record<LongformBlock['type'], string> = {
    heading: '标题',
    paragraph: '段落',
    bulletList: '无序列表',
    numberedList: '有序列表',
    table: '表格',
    pageBreak: '分页符'
  };
  return labels[block.type];
});
</script>

<template>
  <div class="longform-editor grid h-full grid-rows-[auto_minmax(0,1fr)] gap-3">
    <div class="flex items-center gap-2 border-b border-[var(--agent-border)] pb-3">
      <span class="text-sm font-semibold text-[var(--agent-text-muted)]">{{ blockTypeLabel || '选择内容块' }}</span>

      <button
        v-if="editable && selectedBlock"
        type="button"
        class="inline-flex h-7 items-center gap-1 rounded border border-[var(--agent-border)] bg-[var(--agent-surface)] px-2 text-xs font-bold text-[var(--agent-text)] transition-colors hover:bg-[var(--agent-surface-muted)] disabled:opacity-50"
        :disabled="!canMoveUp"
        aria-label="上移内容块"
        @click="emit('move-up', selectedBlock.id)"
      >
        <PhCaretUp :size="14" weight="bold" aria-hidden="true" />
      </button>

      <button
        v-if="editable && selectedBlock"
        type="button"
        class="inline-flex h-7 items-center gap-1 rounded border border-[var(--agent-border)] bg-[var(--agent-surface)] px-2 text-xs font-bold text-[var(--agent-text)] transition-colors hover:bg-[var(--agent-surface-muted)] disabled:opacity-50"
        :disabled="!canMoveDown"
        aria-label="下移内容块"
        @click="emit('move-down', selectedBlock.id)"
      >
        <PhCaretDown :size="14" weight="bold" aria-hidden="true" />
      </button>

      <button
        v-if="editable && selectedBlock"
        type="button"
        class="inline-flex h-7 items-center gap-1 rounded border border-destructive/30 bg-[var(--agent-surface)] px-2 text-xs font-bold text-destructive transition-colors hover:bg-destructive/5"
        aria-label="删除内容块"
        @click="emit('delete-block', selectedBlock.id)"
      >
        <PhTrash :size="14" weight="bold" aria-hidden="true" />
      </button>

      <div v-if="editable" class="relative ml-auto">
        <select
          class="h-7 appearance-none rounded bg-[var(--agent-selected-bg)] pl-2 pr-6 text-xs font-bold text-[var(--agent-selected-text)]"
          @change="emit('add-block', ($event.target as HTMLSelectElement).value as LongformBlock['type'], selectedBlock?.id); ($event.target as HTMLSelectElement).value = ''"
        >
          <option value="" disabled selected>添加内容块</option>
          <option value="heading">标题</option>
          <option value="paragraph">段落</option>
          <option value="bulletList">无序列表</option>
          <option value="numberedList">有序列表</option>
          <option value="table">表格</option>
          <option value="pageBreak">分页符</option>
        </select>
        <PhPlus :size="14" weight="bold" class="pointer-events-none absolute right-2 top-1/2 -translate-y-1/2" aria-hidden="true" />
      </div>
    </div>

    <div class="min-h-0 space-y-3 overflow-y-auto px-1">
      <div v-if="!selectedBlock" class="rounded-md border border-[var(--agent-border)] bg-[var(--agent-surface-muted)] px-4 py-8 text-center text-sm text-[var(--agent-text-muted)]">
        从左侧选择或添加内容块
      </div>

      <!-- Heading -->
      <div v-else-if="selectedBlock.type === 'heading'" class="space-y-2">
        <label class="grid gap-1 text-xs font-semibold text-[var(--agent-text-muted)]">
          级别
          <select
            v-if="editable"
            :value="selectedBlock.level"
            class="rounded-md border border-[var(--agent-border)] bg-transparent px-2 py-1.5 text-sm text-[var(--agent-text)]"
            @change="updateSelectedBlock({ level: Number(($event.target as HTMLSelectElement).value) as 1 | 2 | 3 })"
          >
            <option :value="1">一级标题</option>
            <option :value="2">二级标题</option>
            <option :value="3">三级标题</option>
          </select>
          <div v-else class="rounded-md border border-[var(--agent-border)] bg-[var(--agent-surface-muted)] px-2 py-1.5 text-sm text-[var(--agent-text)]">
            {{ { 1: '一级标题', 2: '二级标题', 3: '三级标题' }[selectedBlock.level] }}
          </div>
        </label>
        <label class="grid gap-1 text-xs font-semibold text-[var(--agent-text-muted)]">
          内容
          <input
            v-if="editable"
            :value="selectedBlock.text"
            type="text"
            class="rounded-md border border-[var(--agent-border)] bg-transparent px-2 py-1.5 text-sm text-[var(--agent-text)]"
            @input="updateSelectedBlock({ text: ($event.target as HTMLInputElement).value })"
          />
          <div v-else class="rounded-md border border-[var(--agent-border)] bg-[var(--agent-surface-muted)] px-2 py-1.5 text-sm text-[var(--agent-text)]">
            {{ selectedBlock.text }}
          </div>
        </label>
        <label class="grid gap-1 text-xs font-semibold text-[var(--agent-text-muted)]">
          引用
          <textarea
            v-if="editable"
            :value="selectedBlock.citations.join('\n')"
            rows="2"
            class="rounded-md border border-[var(--agent-border)] bg-transparent px-2 py-1.5 text-xs text-[var(--agent-text)]"
            @input="updateSelectedBlock({ citations: ($event.target as HTMLTextAreaElement).value.split('\n').map(s => s.trim()).filter(Boolean) })"
          />
          <div v-else class="rounded-md border border-[var(--agent-border)] bg-[var(--agent-surface-muted)] px-2 py-1.5 text-xs text-[var(--agent-text)]">
            {{ selectedBlock.citations.join(', ') || '无' }}
          </div>
        </label>
      </div>

      <!-- Paragraph -->
      <div v-else-if="selectedBlock.type === 'paragraph'" class="space-y-2">
        <label class="grid gap-1 text-xs font-semibold text-[var(--agent-text-muted)]">
          内容
          <textarea
            v-if="editable"
            :value="selectedBlock.text"
            rows="6"
            class="rounded-md border border-[var(--agent-border)] bg-transparent px-2 py-1.5 text-sm text-[var(--agent-text)]"
            @input="updateSelectedBlock({ text: ($event.target as HTMLTextAreaElement).value })"
          />
          <div v-else class="rounded-md border border-[var(--agent-border)] bg-[var(--agent-surface-muted)] px-2 py-1.5 text-sm text-[var(--agent-text)] whitespace-pre-wrap">
            {{ selectedBlock.text }}
          </div>
        </label>
        <label class="grid gap-1 text-xs font-semibold text-[var(--agent-text-muted)]">
          引用
          <textarea
            v-if="editable"
            :value="selectedBlock.citations.join('\n')"
            rows="2"
            class="rounded-md border border-[var(--agent-border)] bg-transparent px-2 py-1.5 text-xs text-[var(--agent-text)]"
            @input="updateSelectedBlock({ citations: ($event.target as HTMLTextAreaElement).value.split('\n').map(s => s.trim()).filter(Boolean) })"
          />
          <div v-else class="rounded-md border border-[var(--agent-border)] bg-[var(--agent-surface-muted)] px-2 py-1.5 text-xs text-[var(--agent-text)]">
            {{ selectedBlock.citations.join(', ') || '无' }}
          </div>
        </label>
      </div>

      <!-- Bullet List / Numbered List -->
      <div v-else-if="selectedBlock.type === 'bulletList' || selectedBlock.type === 'numberedList'" class="space-y-2">
        <div class="flex items-center justify-between">
          <span class="text-xs font-semibold text-[var(--agent-text-muted)]">列表项</span>
          <button
            v-if="editable"
            type="button"
            class="inline-flex h-6 items-center gap-1 rounded border border-[var(--agent-border)] px-2 text-[10px] font-bold text-[var(--agent-text)] transition-colors hover:bg-[var(--agent-surface-muted)]"
            @click="addListItem"
          >
            <PhPlus :size="12" weight="bold" aria-hidden="true" />
            添加
          </button>
        </div>
        <div class="space-y-2">
          <div v-for="(item, index) in selectedBlock.items" :key="index" class="flex items-start gap-2">
            <span class="mt-2 text-xs text-[var(--agent-text-muted)]">{{ selectedBlock.type === 'numberedList' ? `${index + 1}.` : '•' }}</span>
            <input
              v-if="editable"
              :value="item"
              type="text"
              class="flex-1 rounded border border-[var(--agent-border)] bg-transparent px-2 py-1.5 text-xs text-[var(--agent-text)]"
              @input="updateListItem(index, ($event.target as HTMLInputElement).value)"
            />
            <div v-else class="flex-1 rounded border border-[var(--agent-border)] bg-[var(--agent-surface-muted)] px-2 py-1.5 text-xs text-[var(--agent-text)]">
              {{ item }}
            </div>
            <button
              v-if="editable"
              type="button"
              class="mt-1 text-[var(--agent-text-muted)] transition-colors hover:text-destructive"
              :aria-label="`删除第 ${index + 1} 项`"
              @click="removeListItem(index)"
            >
              <PhTrash :size="14" weight="bold" aria-hidden="true" />
            </button>
          </div>
        </div>
        <label class="grid gap-1 text-xs font-semibold text-[var(--agent-text-muted)]">
          引用
          <textarea
            v-if="editable"
            :value="selectedBlock.citations.join('\n')"
            rows="2"
            class="rounded-md border border-[var(--agent-border)] bg-transparent px-2 py-1.5 text-xs text-[var(--agent-text)]"
            @input="updateSelectedBlock({ citations: ($event.target as HTMLTextAreaElement).value.split('\n').map(s => s.trim()).filter(Boolean) })"
          />
          <div v-else class="rounded-md border border-[var(--agent-border)] bg-[var(--agent-surface-muted)] px-2 py-1.5 text-xs text-[var(--agent-text)]">
            {{ selectedBlock.citations.join(', ') || '无' }}
          </div>
        </label>
      </div>

      <!-- Table -->
      <div v-else-if="selectedBlock.type === 'table'" class="space-y-2">
        <label class="grid gap-1 text-xs font-semibold text-[var(--agent-text-muted)]">
          表头（逗号分隔）
          <input
            v-if="editable"
            :value="selectedBlock.headers.join(', ')"
            type="text"
            class="rounded-md border border-[var(--agent-border)] bg-transparent px-2 py-1.5 text-xs text-[var(--agent-text)]"
            @input="updateSelectedBlock({ headers: ($event.target as HTMLInputElement).value.split(',').map(s => s.trim()).filter(Boolean) })"
          />
          <div v-else class="rounded-md border border-[var(--agent-border)] bg-[var(--agent-surface-muted)] px-2 py-1.5 text-xs text-[var(--agent-text)]">
            {{ selectedBlock.headers.join(', ') }}
          </div>
        </label>
        <div class="space-y-2">
          <div class="flex items-center justify-between">
            <span class="text-xs font-semibold text-[var(--agent-text-muted)]">表格行</span>
            <button
              v-if="editable"
              type="button"
              class="inline-flex h-6 items-center gap-1 rounded border border-[var(--agent-border)] px-2 text-[10px] font-bold text-[var(--agent-text)] transition-colors hover:bg-[var(--agent-surface-muted)]"
              @click="addTableRow"
            >
              <PhPlus :size="12" weight="bold" aria-hidden="true" />
              添加行
            </button>
          </div>
          <div v-for="(row, rowIndex) in selectedBlock.rows" :key="rowIndex" class="space-y-1">
            <div class="flex items-center gap-2">
              <span class="text-xs text-[var(--agent-text-muted)]">行 {{ rowIndex + 1 }}</span>
              <button
                v-if="editable && selectedBlock.rows.length > 1"
                type="button"
                class="text-[var(--agent-text-muted)] transition-colors hover:text-destructive"
                :aria-label="`删除行 ${rowIndex + 1}`"
                @click="removeTableRow(rowIndex)"
              >
                <PhTrash :size="12" weight="bold" aria-hidden="true" />
              </button>
            </div>
            <div class="grid gap-2" :style="{ gridTemplateColumns: `repeat(${selectedBlock.headers.length}, 1fr)` }">
              <template v-for="(cell, colIndex) in row" :key="colIndex">
                <input
                  v-if="editable"
                  :value="cell"
                  type="text"
                  class="rounded border border-[var(--agent-border)] bg-transparent px-2 py-1 text-xs text-[var(--agent-text)]"
                  @input="updateTableCell(rowIndex, colIndex, ($event.target as HTMLInputElement).value)"
                />
                <div
                  v-else
                  class="rounded border border-[var(--agent-border)] bg-[var(--agent-surface-muted)] px-2 py-1 text-xs text-[var(--agent-text)]"
                >
                  {{ cell }}
                </div>
              </template>
            </div>
          </div>
        </div>
        <label class="grid gap-1 text-xs font-semibold text-[var(--agent-text-muted)]">
          引用
          <textarea
            v-if="editable"
            :value="selectedBlock.citations.join('\n')"
            rows="2"
            class="rounded-md border border-[var(--agent-border)] bg-transparent px-2 py-1.5 text-xs text-[var(--agent-text)]"
            @input="updateSelectedBlock({ citations: ($event.target as HTMLTextAreaElement).value.split('\n').map(s => s.trim()).filter(Boolean) })"
          />
          <div v-else class="rounded-md border border-[var(--agent-border)] bg-[var(--agent-surface-muted)] px-2 py-1.5 text-xs text-[var(--agent-text)]">
            {{ selectedBlock.citations.join(', ') || '无' }}
          </div>
        </label>
      </div>

      <!-- Page Break -->
      <div v-else-if="selectedBlock.type === 'pageBreak'" class="rounded-md border border-[var(--agent-border)] bg-[var(--agent-surface-muted)] px-4 py-8 text-center text-sm text-[var(--agent-text-muted)]">
        分页符（将在此处开始新页）
      </div>
    </div>
  </div>
</template>
