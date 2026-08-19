<script setup lang="ts">
import { computed } from 'vue';
import { PhCheck, PhCircleNotch, PhShieldWarning, PhX } from '@phosphor-icons/vue';

import { Button } from '@/components/ui/button';
import type { ToolApproval, ToolApprovalDecision } from '../../types/approvals';

const props = withDefaults(defineProps<{
  approval: ToolApproval;
  busy?: boolean;
  compact?: boolean;
}>(), {
  busy: false,
  compact: false
});

const emit = defineEmits<{
  decision: [decision: ToolApprovalDecision];
}>();

const isPending = computed(() => props.approval.status === 'pending');
const statusLabel = computed(() => ({
  pending: '待审批',
  approved: '已批准',
  rejected: '已拒绝',
  expired: '已过期',
  cancelled: '已取消',
  invalidated: '已失效'
}[props.approval.status]));
const riskLabel = computed(() => props.approval.readOnly ? '只读工具' : '有副作用 · 每次调用都需审批');

function formatJson(value: unknown) {
  try {
    return JSON.stringify(value, null, 2) ?? '无参数';
  } catch {
    return '参数不可展示';
  }
}

function formatTime(value?: string) {
  if (!value) return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  return new Intl.DateTimeFormat('zh-CN', { hour: '2-digit', minute: '2-digit' }).format(date);
}
</script>

<template>
  <article
    class="grid gap-3 rounded-xl border p-4 shadow-xs transition-colors"
    :class="[
      approval.status === 'pending'
        ? 'border-amber-500/35 bg-amber-500/5'
        : 'border-border bg-card',
      compact ? 'p-3' : 'p-4'
    ]"
    :aria-label="`工具审批：${approval.label || approval.toolName}`"
  >
    <header class="flex items-start gap-3">
      <span
        class="grid size-9 shrink-0 place-items-center rounded-lg"
        :class="approval.readOnly ? 'bg-sky-500/10 text-sky-700 dark:text-sky-300' : 'bg-amber-500/15 text-amber-700 dark:text-amber-300'"
        aria-hidden="true"
      >
        <PhShieldWarning :size="18" weight="bold" />
      </span>
      <div class="min-w-0 flex-1">
        <div class="flex flex-wrap items-center gap-2">
          <h3 class="m-0 text-sm font-semibold leading-5 text-foreground">{{ approval.label || approval.toolName }}</h3>
          <span
            class="rounded border px-1.5 py-0.5 font-mono text-[10px] font-semibold"
            :class="approval.status === 'pending' ? 'border-amber-500/25 bg-amber-500/10 text-amber-700 dark:text-amber-300' : 'border-border bg-muted text-muted-foreground'"
          >{{ statusLabel }}</span>
        </div>
        <p class="m-0 mt-1 break-all font-mono text-[10px] leading-4 text-muted-foreground">
          {{ approval.serverName || approval.source || '内置工具' }} · {{ approval.remoteName || approval.toolName }}
        </p>
      </div>
      <time v-if="formatTime(approval.decidedAt || approval.requestedAt)" class="shrink-0 font-mono text-[10px] text-muted-foreground">{{ formatTime(approval.decidedAt || approval.requestedAt) }}</time>
    </header>

    <p class="m-0 text-xs font-medium leading-5" :class="approval.readOnly ? 'text-sky-800 dark:text-sky-200' : 'text-amber-800 dark:text-amber-200'">
      {{ riskLabel }}
    </p>

    <details class="rounded-lg border border-border/80 bg-background/70" :open="!compact && isPending">
      <summary class="cursor-pointer px-3 py-2 text-xs font-medium text-muted-foreground">查看调用参数（已脱敏）</summary>
      <pre class="m-0 max-h-48 overflow-auto border-t border-border/80 px-3 py-2.5 whitespace-pre-wrap break-words font-mono text-[11px] leading-5 text-foreground">{{ formatJson(approval.arguments) }}</pre>
    </details>

    <footer v-if="isPending" class="flex flex-wrap items-center justify-end gap-2 border-t border-amber-500/15 pt-3">
      <Button type="button" variant="outline" size="sm" :disabled="busy" @click="emit('decision', 'reject')">
        <PhCircleNotch v-if="busy" class="animate-spin motion-reduce:animate-none" :size="14" aria-hidden="true" />
        <PhX v-else :size="14" weight="bold" aria-hidden="true" />
        拒绝
      </Button>
      <Button type="button" size="sm" :disabled="busy" @click="emit('decision', 'approve')">
        <PhCircleNotch v-if="busy" class="animate-spin motion-reduce:animate-none" :size="14" aria-hidden="true" />
        <PhCheck v-else :size="14" weight="bold" aria-hidden="true" />
        {{ busy ? '提交中' : '批准并继续' }}
      </Button>
    </footer>
  </article>
</template>

