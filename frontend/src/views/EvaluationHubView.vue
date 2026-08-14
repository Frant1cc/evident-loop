<script setup lang="ts">
import { ref } from 'vue';
import { PhGlobeHemisphereWest, PhStack } from '@phosphor-icons/vue';

import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import WebEvaluationView from './WebEvaluationView.vue';
import RagEvaluationView from './RagEvaluationView.vue';

defineOptions({ name: 'EvaluationHubView' });

const mode = ref<'web' | 'rag'>('web');
</script>

<template>
  <Tabs v-model="mode" class="grid h-full min-h-0 grid-rows-[auto_minmax(0,1fr)] gap-0 bg-background">
    <header class="flex min-h-12 items-center border-b border-border bg-card px-3 sm:px-4">
      <TabsList class="h-9 w-full max-w-md sm:w-auto">
        <TabsTrigger value="web" class="h-8 gap-1.5 px-3">
          <PhGlobeHemisphereWest :size="15" aria-hidden="true" />
          联网检索
        </TabsTrigger>
        <TabsTrigger value="rag" class="h-8 gap-1.5 px-3">
          <PhStack :size="15" aria-hidden="true" />
          知识库 RAG
        </TabsTrigger>
      </TabsList>
    </header>

    <div class="min-h-0">
      <TabsContent value="web" class="m-0 h-full"><WebEvaluationView /></TabsContent>
      <TabsContent value="rag" class="m-0 h-full"><RagEvaluationView /></TabsContent>
    </div>
  </Tabs>
</template>
