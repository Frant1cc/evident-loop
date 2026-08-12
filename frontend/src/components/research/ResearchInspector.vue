<script setup lang="ts">
import { PhCaretDoubleLeft, PhCaretDoubleRight } from '@phosphor-icons/vue';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import ResearchTimeline from './ResearchTimeline.vue';
import ResearchSourcesPanel from './ResearchSourcesPanel.vue';
import ResearchDetailsPanel from './ResearchDetailsPanel.vue';
import type { ResearchNote, ResearchPromptPreview, ResearchSource, ResearchStep } from '../../types/research';

type RailTab = 'timeline' | 'sources' | 'details';
type DetailsTab = 'notes' | 'memory' | 'tool' | 'prompt';

defineProps<{
  collapsed: boolean;
  steps: ResearchStep[];
  sources: ResearchSource[];
  notes: ResearchNote[];
  promptPreview: ResearchPromptPreview;
  selectedStep?: ResearchStep;
  selectedSourceId?: string;
}>();

const activeTab = defineModel<RailTab>('activeTab', { required: true });
const activeDetailsTab = defineModel<DetailsTab>('activeDetailsTab', { required: true });

const emit = defineEmits<{
  toggle: [];
  selectStep: [step: ResearchStep];
  createNote: [content: string];
  deleteNote: [note: ResearchNote];
}>();
</script>

<template>
  <aside
    v-if="collapsed"
    class="grid min-h-0 min-w-0 content-start justify-items-center gap-3 border-l border-border bg-card p-2 max-md:h-[min(40vh,360px)] max-md:border-l-0 max-md:border-t"
  >
    <Tooltip>
      <TooltipTrigger as-child>
        <Button type="button" variant="ghost" size="icon" aria-label="展开研究检查器" @click="emit('toggle')">
          <PhCaretDoubleLeft :size="17" aria-hidden="true" />
        </Button>
      </TooltipTrigger>
      <TooltipContent side="left">展开研究检查器</TooltipContent>
    </Tooltip>
  </aside>

  <aside
    v-else
    class="grid min-h-0 min-w-0 grid-rows-[auto_minmax(0,1fr)] border-l border-border bg-card max-md:h-[min(52vh,440px)] max-md:border-l-0 max-md:border-t"
    aria-label="研究检查器"
  >
    <Tabs v-model="activeTab" class="grid min-h-0 grid-rows-[auto_minmax(0,1fr)] gap-0">
      <header class="flex items-center gap-2 border-b border-border px-3 py-2.5">
        <TabsList class="flex-1">
          <TabsTrigger value="timeline" class="gap-1.5">
            过程<Badge variant="secondary" class="tabular-nums">{{ steps.length }}</Badge>
          </TabsTrigger>
          <TabsTrigger value="sources" class="gap-1.5">
            来源<Badge variant="secondary" class="tabular-nums">{{ sources.length }}</Badge>
          </TabsTrigger>
          <TabsTrigger value="details">详情</TabsTrigger>
        </TabsList>
        <Tooltip>
          <TooltipTrigger as-child>
            <Button type="button" variant="ghost" size="icon-sm" class="shrink-0" aria-label="收起研究检查器" @click="emit('toggle')">
              <PhCaretDoubleRight :size="16" aria-hidden="true" />
            </Button>
          </TooltipTrigger>
          <TooltipContent side="left">收起研究检查器</TooltipContent>
        </Tooltip>
      </header>

      <div class="min-h-0">
        <TabsContent value="timeline" class="m-0 h-full">
          <ResearchTimeline class="h-full" :steps="steps" :selected-step-id="selectedStep?.id" @select="emit('selectStep', $event)" />
        </TabsContent>
        <TabsContent value="sources" class="m-0 h-full">
          <ResearchSourcesPanel class="h-full" :sources="sources" :selected-source-id="selectedSourceId" />
        </TabsContent>
        <TabsContent value="details" class="m-0 h-full">
          <ResearchDetailsPanel
            class="h-full"
            v-model:active-tab="activeDetailsTab"
            :notes="notes"
            :prompt-preview="promptPreview"
            :selected-step="selectedStep"
            @create-note="emit('createNote', $event)"
            @delete-note="emit('deleteNote', $event)"
          />
        </TabsContent>
      </div>
    </Tabs>
  </aside>
</template>
