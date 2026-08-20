<script setup lang="ts">
import { ref } from 'vue';

import AppShell from '../components/layout/AppShell.vue';
import AppTopNavigation from '../components/navigation/AppTopNavigation.vue';
import ResearchWorkbench from './ResearchWorkbench.vue';
import EvaluationHubView from './EvaluationHubView.vue';
import SettingsView from './SettingsView.vue';
import McpManagementView from './McpManagementView.vue';
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

function changeTab(tab: AppTabKey) {
  activeTab.value = tab;
}

function updateTabVisibility(visibility: TabVisibility) {
  tabVisibility.value = visibility;
  saveTabVisibility(visibility);

  if (activeTab.value !== 'settings' && activeTab.value !== 'mcp' && !visibility[activeTab.value as ConfigurableTabKey]) {
    activeTab.value = 'settings';
  }
}
</script>

<template>
  <AppShell>
    <template #navigation>
      <AppTopNavigation :active-tab="activeTab" :tab-visibility="tabVisibility" @change="changeTab" />
    </template>

    <KeepAlive>
      <TaskConsoleView v-if="activeTab === 'tasks'" key="tasks" />
      <ResearchWorkbench v-else-if="activeTab === 'research'" key="research" />
      <EvaluationHubView v-else-if="activeTab === 'evaluations'" key="evaluations" />
      <KnowledgeBasePanel v-else-if="activeTab === 'knowledge'" key="knowledge" />
      <McpManagementView v-else-if="activeTab === 'mcp'" key="mcp" />
      <SettingsView v-else-if="activeTab === 'settings'" key="settings" :tab-visibility="tabVisibility" @update:tab-visibility="updateTabVisibility" />
    </KeepAlive>
  </AppShell>
</template>
