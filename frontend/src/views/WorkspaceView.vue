<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';
import { demoStatus, refreshDemoStatus } from '../api/demo';

import AppShell from '../components/layout/AppShell.vue';
import AppTopNavigation from '../components/navigation/AppTopNavigation.vue';
import ResearchWorkbench from './ResearchWorkbench.vue';
import ArtifactLibraryView from './ArtifactLibraryView.vue';
import EvaluationHubView from './EvaluationHubView.vue';
import SettingsView from './SettingsView.vue';
import TaskConsoleView from './TaskConsoleView.vue';
import KnowledgeBasePanel from '../components/knowledge/KnowledgeBasePanel.vue';
import {
  loadTabVisibility,
  saveTabVisibility,
  type AppTabKey,
  type ConfigurableTabKey,
  type TabVisibility
} from '../types/navigation';

const tabVisibility = ref(loadTabVisibility());
const activeTab = ref<AppTabKey>(tabVisibility.value.research ? 'research' : 'settings');
const ready = ref(false);
const startupError = ref('');
let demoRefreshTimer: ReturnType<typeof setInterval> | undefined;
const refreshUsage = () => { if (demoStatus.value.enabled) void refreshDemoStatus().catch(() => {}); };
const visibleTabs = computed(() => demoStatus.value.enabled
  ? { research: true, artifacts: false, tasks: false, evaluations: false, knowledge: false }
  : tabVisibility.value);

onMounted(async () => {
  try {
    await refreshDemoStatus();
    if (demoStatus.value.enabled) activeTab.value = 'research';
    if (demoStatus.value.enabled) {
      demoRefreshTimer = setInterval(refreshUsage, 60_000);
      window.addEventListener('focus', refreshUsage);
    }
    ready.value = true;
  } catch (error) {
    startupError.value = error instanceof Error ? error.message : '无法加载工作台，请刷新页面重试。';
  }
});

onBeforeUnmount(() => {
  clearInterval(demoRefreshTimer);
  window.removeEventListener('focus', refreshUsage);
});

function changeTab(tab: AppTabKey) {
  if (demoStatus.value.enabled && tab !== 'research') return;
  activeTab.value = tab;
}

function updateTabVisibility(visibility: TabVisibility) {
  tabVisibility.value = visibility;
  saveTabVisibility(visibility);

  if (activeTab.value !== 'settings' && !visibility[activeTab.value as ConfigurableTabKey]) {
    activeTab.value = 'settings';
  }
}
</script>

<template>
  <AppShell>
    <template #navigation>
      <AppTopNavigation :active-tab="activeTab" :tab-visibility="visibleTabs" :demo="demoStatus.enabled" @change="changeTab" />
    </template>

    <p v-if="startupError" class="m-auto max-w-lg p-6 text-sm text-destructive" role="alert">{{ startupError }}</p>
    <p v-else-if="!ready" class="m-auto p-6 text-sm text-muted-foreground" role="status">正在加载工作台…</p>
    <KeepAlive v-else>
      <TaskConsoleView v-if="activeTab === 'tasks'" key="tasks" />
      <ResearchWorkbench v-else-if="activeTab === 'research'" key="research" />
      <ArtifactLibraryView v-else-if="activeTab === 'artifacts'" key="artifacts" @open-source="changeTab" />
      <EvaluationHubView v-else-if="activeTab === 'evaluations'" key="evaluations" />
      <KnowledgeBasePanel v-else-if="activeTab === 'knowledge'" key="knowledge" />
      <SettingsView v-else-if="activeTab === 'settings'" key="settings" :tab-visibility="tabVisibility" @update:tab-visibility="updateTabVisibility" />
    </KeepAlive>
  </AppShell>
</template>
