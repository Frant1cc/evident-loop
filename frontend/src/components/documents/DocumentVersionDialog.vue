<script setup lang="ts">
import { PhCheck, PhDownloadSimple, PhEye, PhTrash, PhX } from '@phosphor-icons/vue';
import { computed, ref } from 'vue';
import type { ArtifactOutput, ResearchArtifactGeneration } from '../../types/artifacts';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '../ui/dialog';
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

function availableOutputs(generation: ResearchArtifactGeneration) {
  return generation.outputs.filter(output => output.status === 'completed' && output.downloadUrl);
}

function deleteConfirmed() {
  if (!deleteTarget.value) return;
  emit('delete', deleteTarget.value.id);
  deleteTarget.value = undefined;
}
</script>

<template>
  <Dialog :open="open" @update:open="emit('update:open', $event)">
    <DialogContent
      :show-close-button="false"
      class="h-[min(86dvh,720px)] max-w-[calc(100%-1rem)] gap-0 overflow-hidden p-0 sm:max-w-3xl"
    >
      <div class="grid h-full min-h-0 grid-rows-[auto_minmax(0,1fr)]">
        <header class="flex items-center justify-between gap-4 border-b border-[var(--agent-border)] px-4 py-3.5 sm:px-5">
          <div class="min-w-0">
            <div class="flex items-center gap-2">
              <DialogTitle class="text-base font-semibold text-[var(--agent-text)]">版本历史</DialogTitle>
              <span class="rounded-md bg-[var(--agent-surface-muted)] px-1.5 py-0.5 text-[10px] font-semibold text-[var(--agent-text-muted)]">{{ sortedGenerations.length }} 个版本</span>
            </div>
            <DialogDescription class="mt-1 text-xs text-[var(--agent-text-muted)]">
              查看历史草稿、预览输出文件，或切换到其他版本。
            </DialogDescription>
          </div>
          <button
            type="button"
            class="grid size-8 shrink-0 place-items-center rounded-md text-[var(--agent-text-muted)] transition-[background-color,color,transform] hover:bg-[var(--agent-surface-muted)] hover:text-[var(--agent-text)] active:scale-95 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--agent-focus-ring)]"
            aria-label="关闭"
            @click="emit('update:open', false)"
          >
            <PhX :size="18" weight="bold" aria-hidden="true" />
          </button>
        </header>

        <div class="app-scrollbar min-h-0 space-y-3 overflow-y-auto p-3 sm:p-5">
          <article
            v-for="generation in sortedGenerations"
            :key="generation.id"
            class="grid gap-3 rounded-xl border p-3.5 transition-[border-color,background-color,box-shadow] sm:p-4"
            :class="generation.id === currentGenerationId
              ? 'border-[var(--agent-text-muted)] bg-[var(--agent-selected-bg)]/55 shadow-[inset_3px_0_0_var(--agent-text)]'
              : 'border-[var(--agent-border)] bg-[var(--agent-surface)] hover:border-[var(--agent-text-muted)]/45'"
          >
            <div class="flex items-start justify-between gap-3">
              <div class="flex min-w-0 flex-1 items-start gap-3">
                <span class="grid size-10 shrink-0 place-items-center rounded-lg border border-[var(--agent-border)] bg-[var(--agent-surface)] font-mono text-xs font-bold text-[var(--agent-text)]">v{{ generation.version }}</span>
                <div class="min-w-0 flex-1">
                  <div class="flex flex-wrap items-center gap-1.5">
                    <span v-if="generation.id === currentGenerationId" class="inline-flex items-center gap-1 rounded-md bg-[var(--agent-primary)] px-1.5 py-0.5 text-[10px] font-semibold text-[var(--agent-primary-text)]">
                      <PhCheck :size="10" weight="bold" aria-hidden="true" />当前版本
                    </span>
                    <span class="rounded-md px-1.5 py-0.5 text-[10px] font-semibold"
                    :class="generation.status === 'completed' || generation.status === 'partial'
                      ? 'bg-green-500/10 text-green-700 dark:text-green-400'
                      : generation.status === 'failed'
                      ? 'bg-destructive/10 text-destructive'
                      : 'bg-[var(--agent-surface-muted)] text-[var(--agent-text-muted)]'"
                    >{{ statusLabel(generation.status) }}</span>
                    <span v-if="generation.stale" class="rounded-md bg-amber-500/10 px-1.5 py-0.5 text-[10px] font-semibold text-amber-700 dark:text-amber-400">已失效</span>
                  </div>
                  <h3 class="m-0 mt-1.5 truncate text-sm font-semibold text-[var(--agent-text)]" :title="generation.spec.title">{{ generation.spec.title }}</h3>
                  <p class="m-0 mt-1 text-[11px] text-[var(--agent-text-muted)]">创建于 {{ formatDate(generation.createdAt) }}</p>
                </div>
              </div>

              <div class="flex shrink-0 items-center gap-1">
                <button
                  v-if="generation.id !== currentGenerationId"
                  type="button"
                  class="h-8 rounded-md border border-[var(--agent-border)] bg-[var(--agent-surface)] px-2.5 text-xs font-semibold text-[var(--agent-text)] transition-[background-color,transform] hover:bg-[var(--agent-surface-muted)] active:scale-[0.98] disabled:opacity-50"
                  :disabled="busy"
                  @click="emit('select', generation.id)"
                >
                  {{ generation.status === 'awaiting_confirmation' && !generation.stale ? '继续编辑' : '查看' }}
                </button>
                <button
                  type="button"
                  class="grid size-8 place-items-center rounded-md text-[var(--agent-text-muted)] transition-[background-color,color,transform] hover:bg-destructive/10 hover:text-destructive active:scale-95 disabled:opacity-50"
                  :disabled="busy"
                  aria-label="删除版本"
                  title="删除版本"
                  @click="confirmDelete(generation)"
                >
                  <PhTrash :size="14" weight="bold" aria-hidden="true" />
                </button>
              </div>
            </div>

            <div v-if="availableOutputs(generation).length" class="flex flex-wrap items-center justify-between gap-2 border-t border-[var(--agent-border)] pt-3">
              <p class="m-0 text-xs font-medium text-[var(--agent-text-muted)]">输出文件</p>
              <div class="flex flex-wrap gap-2">
                <div
                  v-for="output in availableOutputs(generation)"
                  :key="output.id"
                  class="inline-flex overflow-hidden rounded-md border border-[var(--agent-border)] bg-[var(--agent-surface)]"
                >
                  <button
                    type="button"
                    class="inline-flex h-8 items-center gap-1.5 px-2.5 text-xs font-semibold text-[var(--agent-text)] transition-colors hover:bg-[var(--agent-surface-muted)]"
                    @click="emit('preview-output', output)"
                  >
                    <PhEye :size="12" weight="bold" aria-hidden="true" />
                    {{ output.format.toUpperCase() }}
                  </button>
                  <a
                    :href="output.downloadUrl"
                    :download="output.fileName"
                    class="grid w-8 place-items-center border-l border-[var(--agent-border)] text-[var(--agent-text-muted)] transition-colors hover:bg-[var(--agent-surface-muted)] hover:text-[var(--agent-text)]"
                    :aria-label="`下载 ${output.format.toUpperCase()}`"
                  >
                    <PhDownloadSimple :size="12" weight="bold" aria-hidden="true" />
                  </a>
                </div>
              </div>
            </div>

            <p v-if="generation.status === 'awaiting_confirmation' && !generation.stale" class="m-0 border-t border-[var(--agent-border)] pt-2 text-xs text-[var(--agent-text-muted)]">可编辑草稿</p>
            <p v-else-if="generation.stale" class="m-0 border-t border-[var(--agent-border)] pt-2 text-xs text-amber-700 dark:text-amber-400">研究会话已变化，此草稿已失效</p>
            <p v-else class="m-0 border-t border-[var(--agent-border)] pt-2 text-xs text-[var(--agent-text-muted)]">只读版本，可查看或下载历史输出</p>
          </article>

          <div v-if="!sortedGenerations.length" class="grid min-h-64 place-items-center rounded-xl border border-dashed border-[var(--agent-border)] bg-[var(--agent-surface-muted)]/35 px-4 py-8 text-center">
            <div>
              <strong class="text-sm font-semibold text-[var(--agent-text)]">还没有历史版本</strong>
              <p class="m-0 mt-1 text-xs text-[var(--agent-text-muted)]">保存或生成文稿后，版本会显示在这里。</p>
            </div>
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
