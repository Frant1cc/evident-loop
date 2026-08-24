<script setup lang="ts">
import { PhX, PhTrash, PhDownloadSimple, PhEye } from '@phosphor-icons/vue';
import { computed, ref } from 'vue';
import type { ArtifactOutput, ResearchArtifactGeneration } from '../../types/artifacts';
import { Dialog, DialogContent } from '../ui/dialog';
import DocumentConfirmDialog from './DocumentConfirmDialog.vue';

const props = defineProps<{
  open: boolean;
  generations?: ResearchArtifactGeneration[];
  currentGenerationId?: string;
  busy?: boolean;
}>();

const emit = defineEmits<{
  'update:open': [open: boolean];
  'select': [id: string];
  'delete': [id: string];
  'preview-output': [output: ArtifactOutput];
}>();

const sortedGenerations = computed(() => {
  if (!props.generations) return [];
  return [...props.generations].sort((a, b) => b.version - a.version);
});
const deleteTarget = ref<ResearchArtifactGeneration>();

function statusLabel(status: string): string {
  const labels: Record<string, string> = {
    planning: '规划中',
    awaiting_confirmation: '待确认',
    rendering: '渲染中',
    validating: '质检中',
    repairing: '修复中',
    completed: '已完成',
    partial: '部分完成',
    failed: '失败',
    cancelled: '已取消',
    superseded: '已确认'
  };
  return labels[status] ?? status;
}

function formatDate(dateStr: string): string {
  return new Intl.DateTimeFormat('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit'
  }).format(new Date(dateStr));
}

function confirmDelete(generation: ResearchArtifactGeneration) {
  deleteTarget.value = generation;
}

function deleteConfirmed() {
  if (!deleteTarget.value) return;
  emit('delete', deleteTarget.value.id);
  deleteTarget.value = undefined;
}
</script>

<template>
  <Dialog :open="open" @update:open="emit('update:open', $event)">
    <DialogContent class="max-h-[85vh] max-w-3xl overflow-hidden">
      <div class="grid h-full max-h-[75vh] grid-rows-[auto_minmax(0,1fr)] gap-4">
        <div class="flex items-center justify-between border-b border-[var(--agent-border)] pb-3">
          <h2 class="m-0 text-lg font-bold text-[var(--agent-text)]">版本历史</h2>
          <button
            type="button"
            class="grid size-8 place-items-center rounded text-[var(--agent-text-muted)] transition-colors hover:bg-[var(--agent-surface-muted)] hover:text-[var(--agent-text)]"
            aria-label="关闭"
            @click="emit('update:open', false)"
          >
            <PhX :size="18" weight="bold" aria-hidden="true" />
          </button>
        </div>

        <div class="min-h-0 space-y-2 overflow-y-auto pr-2">
          <div
            v-for="generation in sortedGenerations"
            :key="generation.id"
            class="grid gap-2 rounded-lg border p-3 transition-colors"
            :class="generation.id === currentGenerationId
              ? 'border-[var(--agent-selected-border)] bg-[var(--agent-selected-bg)]/10'
              : 'border-[var(--agent-border)] bg-[var(--agent-surface)]'"
          >
            <div class="flex items-start justify-between gap-3">
              <div class="min-w-0 flex-1">
                <div class="flex items-center gap-2">
                  <span class="text-sm font-bold text-[var(--agent-text)]">v{{ generation.version }}</span>
                  <span class="rounded-full px-2 py-0.5 text-[10px] font-bold"
                    :class="generation.status === 'completed' || generation.status === 'partial'
                      ? 'bg-green-500/10 text-green-700 dark:text-green-400'
                      : generation.status === 'failed'
                      ? 'bg-destructive/10 text-destructive'
                      : 'bg-[var(--agent-surface-muted)] text-[var(--agent-text-muted)]'"
                  >
                    {{ statusLabel(generation.status) }}
                  </span>
                  <span v-if="generation.stale" class="rounded-full bg-amber-500/10 px-2 py-0.5 text-[10px] font-bold text-amber-700 dark:text-amber-400">
                    已失效
                  </span>
                </div>
                <p class="m-0 mt-1 text-sm text-[var(--agent-text)]">{{ generation.spec.title }}</p>
                <p class="m-0 mt-1 text-xs text-[var(--agent-text-muted)]">{{ formatDate(generation.createdAt) }}</p>
              </div>

              <div class="flex items-center gap-1">
                <button
                  v-if="generation.id !== currentGenerationId && generation.status === 'awaiting_confirmation' && !generation.stale"
                  type="button"
                  class="rounded border border-[var(--agent-border)] px-2 py-1 text-xs font-bold text-[var(--agent-text)] transition-colors hover:bg-[var(--agent-surface-muted)] disabled:opacity-50"
                  :disabled="busy"
                  @click="emit('select', generation.id)"
                >
                  切换
                </button>
                <button
                  type="button"
                  class="grid size-7 place-items-center rounded text-[var(--agent-text-muted)] transition-colors hover:bg-destructive/10 hover:text-destructive disabled:opacity-50"
                  :disabled="busy"
                  aria-label="删除版本"
                  @click="confirmDelete(generation)"
                >
                  <PhTrash :size="14" weight="bold" aria-hidden="true" />
                </button>
              </div>
            </div>

            <div v-if="generation.outputs.length" class="space-y-1 border-t border-[var(--agent-border)] pt-2">
              <p class="m-0 text-xs font-semibold text-[var(--agent-text-muted)]">输出文件</p>
              <div class="flex flex-wrap gap-2">
                <div
                  v-for="output in generation.outputs.filter(o => o.status === 'completed' && o.downloadUrl)"
                  :key="output.id"
                  class="inline-flex overflow-hidden rounded border border-[var(--agent-border)] bg-[var(--agent-surface)]"
                >
                  <button
                    type="button"
                    class="inline-flex items-center gap-1 px-2 py-1 text-xs font-bold text-[var(--agent-text)] transition-colors hover:bg-[var(--agent-surface-muted)]"
                    @click="emit('preview-output', output)"
                  >
                    <PhEye :size="12" weight="bold" aria-hidden="true" />
                    {{ output.format.toUpperCase() }}
                  </button>
                  <a
                    :href="output.downloadUrl"
                    :download="output.fileName"
                    class="grid place-items-center border-l border-[var(--agent-border)] px-2 text-[var(--agent-text-muted)] transition-colors hover:bg-[var(--agent-surface-muted)] hover:text-[var(--agent-text)]"
                    :aria-label="`下载 ${output.format.toUpperCase()}`"
                  >
                    <PhDownloadSimple :size="12" weight="bold" aria-hidden="true" />
                  </a>
                </div>
              </div>
            </div>

            <div v-if="generation.status === 'awaiting_confirmation' && !generation.stale" class="border-t border-[var(--agent-border)] pt-2 text-xs text-[var(--agent-text-muted)]">
              可编辑草稿
            </div>
            <div v-else-if="generation.stale" class="border-t border-[var(--agent-border)] pt-2 text-xs text-amber-700 dark:text-amber-400">
              研究会话已变化，此草稿已失效
            </div>
            <div v-else class="border-t border-[var(--agent-border)] pt-2 text-xs text-[var(--agent-text-muted)]">
              只读版本
            </div>
          </div>

          <div v-if="!sortedGenerations.length" class="rounded-lg border border-[var(--agent-border)] bg-[var(--agent-surface-muted)] px-4 py-8 text-center text-sm text-[var(--agent-text-muted)]">
            暂无版本历史
          </div>
        </div>
      </div>
    </DialogContent>
  </Dialog>

  <DocumentConfirmDialog
    :open="Boolean(deleteTarget)"
    title="删除文档版本"
    description="该版本及其输出文件会被永久删除，此操作无法撤销。"
    :detail="deleteTarget ? `版本 v${deleteTarget.version} · ${deleteTarget.spec.title}` : undefined"
    confirm-label="确认删除"
    destructive
    :busy="busy"
    @update:open="deleteTarget = $event ? deleteTarget : undefined"
    @confirm="deleteConfirmed"
  />
</template>
