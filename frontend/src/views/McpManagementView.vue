<script setup lang="ts">
import { ref, onMounted } from 'vue';
import { PhTerminalWindow } from '@phosphor-icons/vue';

import McpSettingsPanel from '../components/mcp/McpSettingsPanel.vue';
import McpPresetCard from '../components/mcp/McpPresetCard.vue';
import PresetConsentDialog from '../components/mcp/PresetConsentDialog.vue';
import type { McpPresetPublic } from '../types/mcp-presets';
import { listMcpPresets } from '../api/mcp';

const presets = ref<McpPresetPublic[]>([]);
const loading = ref(true);
const selectedPreset = ref<McpPresetPublic | null>(null);
const consentDialogOpen = ref(false);

async function loadPresets() {
  loading.value = true;
  try {
    const result = await listMcpPresets();
    presets.value = result.presets;
  } catch (error) {
    console.error('Failed to load presets:', error);
  } finally {
    loading.value = false;
  }
}

function handleEnablePreset(presetId: string) {
  const preset = presets.value.find((p) => p.id === presetId);
  if (preset) {
    selectedPreset.value = preset;
    consentDialogOpen.value = true;
  }
}

function handleConsentSuccess() {
  loadPresets();
}

onMounted(() => {
  loadPresets();
});
</script>

<template>
  <section class="h-full min-h-0 overflow-auto bg-background" aria-label="MCP 管理">
    <div class="mx-auto grid w-full max-w-6xl gap-7 px-5 py-7 md:px-8 md:py-9">
      <header class="border-b border-border pb-6">
        <p class="m-0 flex items-center gap-2 font-mono text-[10px] font-semibold uppercase tracking-[0.16em] text-muted-foreground"><PhTerminalWindow :size="13" weight="bold" aria-hidden="true" /> Tool connections</p>
        <h1 class="m-0 mt-1.5 text-2xl font-semibold tracking-[-0.035em] text-foreground">MCP 管理</h1>
        <p class="m-0 mt-1.5 max-w-2xl text-sm leading-6 text-muted-foreground">将本地或远程 MCP 工具接入研究工作台和 Agent 运行时。每个连接都必须先测试，再由你显式启用。</p>
      </header>

      <section aria-labelledby="mcp-presets-title">
        <div class="mb-4">
          <p class="m-0 font-mono text-[10px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">Built-in presets</p>
          <h2 id="mcp-presets-title" class="m-0 mt-1 text-base font-semibold">内置连接</h2>
          <p class="m-0 mt-1 text-sm text-muted-foreground">一键启用审核通过的 MCP 工具</p>
        </div>

        <div v-if="loading" class="py-8 text-center text-sm text-muted-foreground">
          加载中...
        </div>

        <div v-else class="grid gap-4 md:grid-cols-2">
          <McpPresetCard
            v-for="preset in presets"
            :key="preset.id"
            :preset="preset"
            @enable="handleEnablePreset"
            @update="loadPresets"
          />
        </div>
      </section>

      <section aria-labelledby="custom-mcp-title" class="mt-8">
        <div class="mb-4">
          <p class="m-0 font-mono text-[10px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">Custom connections</p>
          <h2 id="custom-mcp-title" class="m-0 mt-1 text-base font-semibold">自定义 MCP 连接</h2>
        </div>
        <McpSettingsPanel />
      </section>

      <PresetConsentDialog
        v-if="selectedPreset"
        :preset="selectedPreset"
        :open="consentDialogOpen"
        @close="consentDialogOpen = false"
        @success="handleConsentSuccess"
      />
    </div>
  </section>
</template>
