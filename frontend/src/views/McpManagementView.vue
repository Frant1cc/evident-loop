<script setup lang="ts">
import { ref } from 'vue';
import { PhBrain, PhBookOpenText, PhPlus, PhTerminalWindow } from '@phosphor-icons/vue';

import McpSettingsPanel from '../components/mcp/McpSettingsPanel.vue';
import { builtInMcpPresets, type McpPreset } from '../mcp/presets';
import { Button } from '@/components/ui/button';

const panel = ref<{ openPreset: (preset: McpPreset) => void }>();

function usePreset(preset: McpPreset) {
  panel.value?.openPreset(preset);
}
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
        <div class="mb-3 flex items-baseline justify-between gap-3"><div><p class="m-0 font-mono text-[10px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">Built-in starters</p><h2 id="mcp-presets-title" class="m-0 mt-1 text-base font-semibold">内置连接</h2></div><span class="text-xs text-muted-foreground">保存后仍需测试</span></div>
        <div class="grid gap-4 md:grid-cols-2">
          <article v-for="preset in builtInMcpPresets" :key="preset.id" class="group relative overflow-hidden rounded-xl border border-border bg-card p-5 shadow-xs">
            <div class="absolute right-0 top-0 h-20 w-20 -translate-y-7 translate-x-7 rounded-full bg-primary/10 blur-2xl" aria-hidden="true" />
            <component :is="preset.id === 'context7' ? PhBookOpenText : PhBrain" :size="22" weight="duotone" class="text-primary" aria-hidden="true" />
            <h3 class="m-0 mt-4 text-base font-semibold">{{ preset.name }}</h3>
            <p class="m-0 mt-1.5 min-h-12 text-sm leading-6 text-muted-foreground">{{ preset.description }}</p>
            <p class="m-0 mt-4 break-all rounded-md border border-border/70 bg-muted/45 px-2.5 py-2 font-mono text-[10px] leading-4 text-muted-foreground">cmd /c npx -y {{ preset.draft.args?.[preset.draft.args.length - 1] }}</p>
            <Button type="button" variant="outline" size="sm" class="mt-4" @click="usePreset(preset)"><PhPlus :size="14" weight="bold" aria-hidden="true" />使用此预置</Button>
          </article>
        </div>
      </section>

      <McpSettingsPanel ref="panel" />
    </div>
  </section>
</template>
