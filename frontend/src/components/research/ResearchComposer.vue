<script setup lang="ts">
import { computed, ref } from 'vue';
import { onClickOutside } from '@vueuse/core';
import { PhArrowUp, PhCaretDown, PhCheck, PhCircleNotch, PhLightbulb, PhStop, PhWrench } from '@phosphor-icons/vue';

import { Button } from '@/components/ui/button';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { Textarea } from '@/components/ui/textarea';
import type { ResearchSkillInfo, ResearchToolInfo } from '../../api/research';

const model = defineModel<string>({ required: true });

const props = defineProps<{
  loading: boolean;
  stopping: boolean;
  tools: ResearchToolInfo[];
  enabledTools: Record<string, boolean>;
  skills: ResearchSkillInfo[];
  selectedSkillId?: string;
}>();

const emit = defineEmits<{
  send: [];
  stop: [];
  toggleTool: [name: string];
  selectSkill: [id: string | undefined];
}>();

const toolsOpen = ref(false);
const toolsMenu = ref<HTMLElement>();
const skillsOpen = ref(false);
const skillsMenu = ref<HTMLElement>();

onClickOutside(toolsMenu, () => (toolsOpen.value = false));
onClickOutside(skillsMenu, () => (skillsOpen.value = false));

const enabledCount = computed(() => props.tools.filter((tool) => props.enabledTools[tool.name]).length);
const allDisabled = computed(() => props.tools.length > 0 && enabledCount.value === 0);

const selectedSkill = computed(() => props.skills.find((skill) => skill.id === props.selectedSkillId));
// "No skill" is an unselected state, not a pseudo-skill (§4.3, §15).
const skillLabel = computed(() => selectedSkill.value?.label ?? '技能');
// Tools the active skill requires are locked on and cannot be toggled off (§12.3).
const requiredToolNames = computed(() => new Set(selectedSkill.value?.requiredTools ?? []));

function handleKeydown(event: KeyboardEvent) {
  if (event.key !== 'Enter' || event.shiftKey || event.isComposing || props.loading) return;
  event.preventDefault();
  emit('send');
}

function selectSkill(id: string | undefined) {
  emit('selectSkill', id);
  skillsOpen.value = false;
}

function handleToggleTool(name: string) {
  if (requiredToolNames.value.has(name)) return;
  emit('toggleTool', name);
}
</script>

<template>
  <form
    class="rounded-2xl border border-input bg-card p-2 shadow-[0_12px_40px_-24px_oklch(0.145_0_0_/_0.45)] transition-shadow focus-within:border-ring focus-within:ring-3 focus-within:ring-ring/20 dark:border-white/[0.09] dark:bg-card/80 dark:shadow-[0_18px_48px_-30px_rgb(0_0_0_/_0.9)]"
    @submit.prevent="loading || emit('send')"
  >
    <label for="research-prompt" class="sr-only">输入问题</label>
    <Textarea
      id="research-prompt"
      v-model="model"
      rows="1"
      placeholder="输入问题…"
      autocomplete="off"
      class="max-h-44 min-h-12 resize-none border-0 bg-transparent px-2.5 py-2.5 shadow-none focus-visible:ring-0 dark:bg-transparent"
      @keydown="handleKeydown"
    />

    <div class="mt-1 flex items-center justify-between gap-3">
      <div class="flex min-w-0 items-center gap-2">
        <div v-if="skills.length" ref="skillsMenu" class="relative">
          <Collapsible v-model:open="skillsOpen">
            <CollapsibleTrigger as-child>
              <Button type="button" variant="ghost" size="sm" class="gap-1.5" :disabled="loading" :aria-expanded="skillsOpen">
                <PhLightbulb :size="14" weight="bold" aria-hidden="true" />
                {{ skillLabel }}
                <PhCaretDown :size="13" class="transition-transform" :class="skillsOpen ? 'rotate-180' : ''" aria-hidden="true" />
              </Button>
            </CollapsibleTrigger>

            <CollapsibleContent
              class="absolute bottom-full left-0 z-30 mb-2 w-72 overflow-hidden rounded-xl border border-border bg-popover p-1.5 text-popover-foreground shadow-lg data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:animate-in data-[state=open]:fade-in-0"
            >
              <p class="px-2 py-1 text-[11px] font-medium text-muted-foreground">研究技能</p>
              <button
                type="button"
                :disabled="loading || !selectedSkillId"
                class="flex w-full items-center gap-2 rounded-lg px-2 py-2 text-left text-sm transition-colors hover:bg-accent disabled:cursor-not-allowed disabled:opacity-40"
                @click="selectSkill(undefined)"
              >
                <span class="min-w-0 flex-1 font-medium text-foreground">清除技能</span>
              </button>
              <button
                v-for="skill in skills"
                :key="skill.id"
                type="button"
                :disabled="loading"
                :aria-pressed="selectedSkillId === skill.id"
                class="flex w-full items-start gap-2 rounded-lg px-2 py-2 text-left text-sm transition-colors hover:bg-accent disabled:cursor-not-allowed disabled:opacity-60"
                @click="selectSkill(skill.id)"
              >
                <span class="min-w-0 flex-1">
                  <span class="block font-medium text-foreground">{{ skill.label }}</span>
                  <span class="block truncate text-[11px] text-muted-foreground">{{ skill.description }}</span>
                </span>
                <PhCheck v-if="selectedSkillId === skill.id" :size="15" weight="bold" class="mt-0.5 shrink-0 text-primary" aria-hidden="true" />
              </button>
            </CollapsibleContent>
          </Collapsible>
        </div>

        <div v-if="tools.length" ref="toolsMenu" class="relative">
          <Collapsible v-model:open="toolsOpen">
            <CollapsibleTrigger as-child>
              <Button type="button" variant="ghost" size="sm" class="gap-1.5" :disabled="loading" :aria-expanded="toolsOpen">
                <PhWrench :size="14" weight="bold" aria-hidden="true" />
                工具 {{ enabledCount }}/{{ tools.length }}
                <PhCaretDown :size="13" class="transition-transform" :class="toolsOpen ? 'rotate-180' : ''" aria-hidden="true" />
              </Button>
            </CollapsibleTrigger>

            <CollapsibleContent
              class="absolute bottom-full left-0 z-30 mb-2 w-64 overflow-hidden rounded-xl border border-border bg-popover p-1.5 text-popover-foreground shadow-lg data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:animate-in data-[state=open]:fade-in-0"
            >
              <p class="px-2 py-1 text-[11px] font-medium text-muted-foreground">工具</p>
              <button
                v-for="tool in tools"
                :key="tool.name"
                type="button"
                :disabled="loading || requiredToolNames.has(tool.name)"
                :aria-pressed="Boolean(enabledTools[tool.name])"
                class="flex w-full items-center gap-2 rounded-lg px-2 py-2 text-left text-sm transition-colors hover:bg-accent disabled:cursor-not-allowed disabled:opacity-60"
                @click="handleToggleTool(tool.name)"
              >
                <PhWrench :size="16" class="shrink-0 text-muted-foreground" aria-hidden="true" />
                <span class="min-w-0 flex-1 truncate font-medium text-foreground">{{ tool.label || tool.name }}</span>
                <span v-if="requiredToolNames.has(tool.name)" class="shrink-0 text-[10px] font-medium text-muted-foreground">技能必需</span>
                <PhCheck v-if="enabledTools[tool.name]" :size="15" weight="bold" class="shrink-0 text-primary" aria-hidden="true" />
              </button>
            </CollapsibleContent>
          </Collapsible>
        </div>

        <span v-if="allDisabled" class="truncate text-[11px] text-muted-foreground">
          未启用工具，本轮直接对话
        </span>
      </div>

      <Button
        v-if="loading"
        type="button"
        variant="destructive"
        size="icon"
        class="rounded-xl"
        :disabled="stopping"
        :aria-label="stopping ? '正在停止' : '停止生成'"
        @click="emit('stop')"
      >
        <PhCircleNotch v-if="stopping" :size="17" class="animate-spin" aria-hidden="true" />
        <PhStop v-else :size="16" weight="fill" aria-hidden="true" />
      </Button>
      <Button
        v-else
        type="submit"
        size="icon"
        class="rounded-xl"
        :disabled="!model.trim()"
        aria-label="发送消息"
      >
        <PhArrowUp :size="17" weight="bold" aria-hidden="true" />
      </Button>
    </div>
  </form>
</template>
