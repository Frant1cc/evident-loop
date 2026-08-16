<script setup lang="ts">
import { PhCircleNotch } from '@phosphor-icons/vue';

import ResearchHeader from './ResearchHeader.vue';
import ResearchMessages from './ResearchMessages.vue';
import ResearchComposer from './ResearchComposer.vue';
import type { ResearchSkillInfo, ResearchToolGroupInfo, ResearchToolInfo } from '../../api/research';
import type { WordArtifact } from '../../types/artifacts';
import type { ResearchMessage } from '../../types/research';
import type { StreamConnectionState } from '../../types/streaming';

defineProps<{
  title?: string;
  conversationId?: string;
  messages: ResearchMessage[];
  artifactsByMessageId: Map<string, WordArtifact[]>;
  loading: boolean;
  stopping: boolean;
  error: string;
  connectionHint: string;
  connectionState: StreamConnectionState;
  toolGroups: ResearchToolGroupInfo[];
  standaloneTools: ResearchToolInfo[];
  enabledToolGroups: Record<string, boolean>;
  enabledStandaloneTools: Record<string, boolean>;
  lockedToolGroupIds: Set<string>;
  skills: ResearchSkillInfo[];
  selectedSkillId?: string;
}>();

const input = defineModel<string>('input', { required: true });

const emit = defineEmits<{
  send: [];
  stop: [];
  toggleToolGroup: [id: string];
  toggleStandaloneTool: [name: string];
  selectSkill: [id: string | undefined];
  citation: [key: string];
  preview: [artifact: WordArtifact];
}>();
</script>

<template>
  <main class="grid min-h-0 grid-rows-[auto_minmax(0,1fr)_auto] bg-background">
    <ResearchHeader :title="title" />

    <ResearchMessages
      :conversation-id="conversationId"
      :messages="messages"
      :artifacts-by-message-id="artifactsByMessageId"
      @citation="emit('citation', $event)"
      @preview="emit('preview', $event)"
    />

    <footer class="px-3 pb-2 pt-0 md:px-5">
      <div class="mx-auto grid w-full max-w-4xl gap-1.5">
        <div v-if="error" class="rounded-md bg-destructive/5 px-2.5 py-1.5 text-xs text-destructive" role="alert">{{ error }}</div>
        <p
          v-else-if="connectionHint"
          class="inline-flex items-center gap-1.5 px-1 text-xs font-medium"
          :class="connectionState === 'failed' ? 'text-destructive' : 'text-muted-foreground'"
          :role="connectionState === 'failed' ? 'alert' : 'status'"
        >
          <PhCircleNotch
            v-if="connectionState === 'reconnecting' || connectionState === 'connecting'"
            class="animate-spin motion-reduce:animate-none"
            :size="13"
            aria-hidden="true"
          />
          {{ connectionHint }}
        </p>
        <ResearchComposer
          v-model="input"
          :loading="loading"
          :stopping="stopping"
          :tool-groups="toolGroups"
          :standalone-tools="standaloneTools"
          :enabled-tool-groups="enabledToolGroups"
          :enabled-standalone-tools="enabledStandaloneTools"
          :locked-tool-group-ids="lockedToolGroupIds"
          :skills="skills"
          :selected-skill-id="selectedSkillId"
          @send="emit('send')"
          @stop="emit('stop')"
          @toggle-tool-group="emit('toggleToolGroup', $event)"
          @toggle-standalone-tool="emit('toggleStandaloneTool', $event)"
          @select-skill="emit('selectSkill', $event)"
        />
      </div>
    </footer>
  </main>
</template>
