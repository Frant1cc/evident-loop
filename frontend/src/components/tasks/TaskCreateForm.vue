<script setup lang="ts">
import { PhCheck, PhCircleNotch, PhPlus } from '@phosphor-icons/vue';

import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';

defineProps<{
  availableTools: Array<{ name: string; label: string }>;
  busy: boolean;
  error: string;
}>();

const goal = defineModel<string>('goal', { required: true });
const maxSteps = defineModel<number>('maxSteps', { required: true });
const maxTokens = defineModel<number>('maxTokens', { required: true });
const selectedTools = defineModel<string[]>('selectedTools', { required: true });

const emit = defineEmits<{ submit: [] }>();

function toggleTool(name: string) {
  selectedTools.value = selectedTools.value.includes(name)
    ? selectedTools.value.filter((tool) => tool !== name)
    : [...selectedTools.value, name];
}
</script>

<template>
  <form class="mx-auto grid w-full max-w-3xl gap-8 px-8 py-9 max-md:px-4 max-md:py-6" @submit.prevent="emit('submit')">
    <header class="border-b border-border pb-5">
      <p class="m-0 text-[11px] font-semibold uppercase tracking-[0.12em] text-muted-foreground">New run</p>
      <h1 class="m-0 mt-1 text-xl font-semibold tracking-[-0.025em] text-foreground">创建 Agent 任务</h1>
      <p class="m-0 mt-2 max-w-xl text-sm leading-6 text-muted-foreground">定义目标与资源边界，Agent 会先生成可编辑计划，得到批准后才开始执行。</p>
    </header>

    <div>
      <label for="task-goal" class="text-sm font-medium text-foreground">任务目标</label>
      <Textarea
        id="task-goal"
        v-model="goal"
        rows="5"
        class="mt-2 min-h-32 resize-y bg-background p-4 text-base leading-7"
        placeholder="例如：比较两种 Agent 工作流方案，并基于知识库证据给出选型建议。"
        autofocus
      />
    </div>

    <div class="grid grid-cols-2 gap-4 max-sm:grid-cols-1">
      <label class="grid gap-2 text-sm font-medium text-foreground">
        <span>最大步骤数</span>
        <input v-model.number="maxSteps" type="number" min="1" max="12" class="h-10 rounded-lg border border-input bg-background px-3 font-mono text-sm outline-none transition-shadow focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50" />
        <span class="text-xs font-normal leading-5 text-muted-foreground">限制 Planner 可拆分的步骤数量。</span>
      </label>
      <label class="grid gap-2 text-sm font-medium text-foreground">
        <span>Token 预算</span>
        <input v-model.number="maxTokens" type="number" min="1000" step="1000" class="h-10 rounded-lg border border-input bg-background px-3 font-mono text-sm outline-none transition-shadow focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50" />
        <span class="text-xs font-normal leading-5 text-muted-foreground">控制本次执行允许使用的总预算。</span>
      </label>
    </div>

    <fieldset class="m-0 border-0 p-0">
      <div class="flex items-end justify-between gap-3">
        <div>
          <legend class="text-sm font-medium text-foreground">允许使用的工具</legend>
          <p class="m-0 mt-1 text-xs leading-5 text-muted-foreground">只选择本次任务真正需要访问的能力。</p>
        </div>
        <span class="shrink-0 font-mono text-xs tabular-nums text-muted-foreground">{{ selectedTools.length }}/{{ availableTools.length }}</span>
      </div>
      <div class="mt-3 grid grid-cols-2 gap-2 max-sm:grid-cols-1">
        <Button
          v-for="tool in availableTools"
          :key="tool.name"
          type="button"
          :variant="selectedTools.includes(tool.name) ? 'secondary' : 'outline'"
          size="lg"
          class="h-11 justify-between px-3 text-left"
          :aria-pressed="selectedTools.includes(tool.name)"
          @click="toggleTool(tool.name)"
        >
          <span class="truncate">{{ tool.label }}</span>
          <PhCheck v-if="selectedTools.includes(tool.name)" :size="15" weight="bold" aria-hidden="true" />
        </Button>
      </div>
    </fieldset>

    <p v-if="error" class="m-0 rounded-lg border border-destructive/20 bg-destructive/10 px-3 py-2.5 text-sm font-medium text-destructive" role="alert">{{ error }}</p>

    <div class="flex justify-end">
      <Button type="submit" size="lg" class="min-w-36" :disabled="!goal.trim() || busy">
        <PhCircleNotch v-if="busy" class="animate-spin" :size="17" aria-hidden="true" />
        <PhPlus v-else :size="17" weight="bold" aria-hidden="true" />
        {{ busy ? '正在创建' : '创建任务' }}
      </Button>
    </div>
  </form>
</template>
