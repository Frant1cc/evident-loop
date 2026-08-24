<script setup lang="ts">
import { ref } from 'vue';
import { PhBookOpenText, PhBrain, PhCheckCircle, PhWarning, PhSpinner } from '@phosphor-icons/vue';
import type { McpPresetPublic } from '../../types/mcp-presets';
import { enableMcpPreset, disableMcpPreset } from '../../api/mcp';

const props = defineProps<{
  preset: McpPresetPublic;
}>();

const emit = defineEmits<{
  (e: 'update'): void;
  (e: 'enable', presetId: string): void;
}>();

const loading = ref(false);
const error = ref('');

const statusLabels: Record<McpPresetPublic['status'], string> = {
  not_installed: '未安装',
  disabled: '已停用',
  connecting: '连接中',
  connected: '已连接',
  unavailable: '不可用',
  authorization_required: '需要授权',
  credential_unavailable: '凭证不可用',
  error: '错误'
};

const statusColors: Record<McpPresetPublic['status'], string> = {
  not_installed: 'text-muted-foreground',
  disabled: 'text-muted-foreground',
  connecting: 'text-blue-600',
  connected: 'text-green-600',
  unavailable: 'text-orange-600',
  authorization_required: 'text-yellow-600',
  credential_unavailable: 'text-red-600',
  error: 'text-red-600'
};

const icon = props.preset.id === 'context7' ? PhBookOpenText : PhBrain;

async function handleEnable() {
  loading.value = true;
  error.value = '';
  try {
    emit('enable', props.preset.id);
  } catch (e) {
    error.value = e instanceof Error ? e.message : '启用失败';
  } finally {
    loading.value = false;
  }
}

async function handleDisable() {
  loading.value = true;
  error.value = '';
  try {
    await disableMcpPreset(props.preset.id);
    emit('update');
  } catch (e) {
    error.value = e instanceof Error ? e.message : '停用失败';
  } finally {
    loading.value = false;
  }
}

async function handleRetry() {
  await handleEnable();
}
</script>

<template>
  <div class="preset-card rounded-lg border border-border bg-card p-5 transition-shadow hover:shadow-md">
    <div class="flex items-start gap-4">
      <div class="flex h-12 w-12 items-center justify-center rounded-lg bg-muted">
        <component :is="icon" :size="24" class="text-foreground" />
      </div>

      <div class="flex-1 min-w-0">
        <div class="flex items-center gap-2 mb-1">
          <h3 class="text-base font-semibold text-foreground">{{ preset.name }}</h3>
          <span :class="['text-xs font-medium', statusColors[preset.status]]">
            {{ statusLabels[preset.status] }}
          </span>
        </div>

        <p class="text-sm text-muted-foreground mb-2">{{ preset.description }}</p>

        <div class="flex items-center gap-3 text-xs text-muted-foreground mb-3">
          <span>{{ preset.publisher }}</span>
          <span>·</span>
          <span>{{ preset.package.name }}@{{ preset.package.version }}</span>
          <span v-if="preset.status === 'connected' && preset.toolCount > 0">·</span>
          <span v-if="preset.status === 'connected' && preset.toolCount > 0">
            {{ preset.toolCount }} 个工具
          </span>
        </div>

        <div v-if="error" class="flex items-center gap-2 text-sm text-red-600 mb-3">
          <PhWarning :size="16" />
          <span>{{ error }}</span>
        </div>

        <div v-if="preset.lastError" class="text-sm text-orange-600 mb-3">
          {{ preset.lastError }}
        </div>

        <div class="flex items-center gap-2">
          <button
            v-if="preset.status === 'not_installed'"
            @click="handleEnable"
            :disabled="loading"
            class="inline-flex items-center gap-2 rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
          >
            <PhSpinner v-if="loading" :size="16" class="animate-spin" />
            <span>{{ loading ? '正在启用...' : '启用' }}</span>
          </button>

          <button
            v-else-if="preset.status === 'connected'"
            @click="handleDisable"
            :disabled="loading"
            class="inline-flex items-center gap-2 rounded-md border border-border bg-background px-4 py-2 text-sm font-medium hover:bg-accent disabled:opacity-50"
          >
            <PhCheckCircle :size="16" class="text-green-600" />
            <span>已启用</span>
          </button>

          <button
            v-else-if="preset.status === 'error' || preset.status === 'unavailable'"
            @click="handleRetry"
            :disabled="loading"
            class="inline-flex items-center gap-2 rounded-md bg-orange-600 px-4 py-2 text-sm font-medium text-white hover:bg-orange-700 disabled:opacity-50"
          >
            <PhSpinner v-if="loading" :size="16" class="animate-spin" />
            <span>{{ loading ? '正在重试...' : '重试' }}</span>
          </button>

          <button
            v-else-if="preset.status === 'connecting'"
            disabled
            class="inline-flex items-center gap-2 rounded-md bg-blue-600 px-4 py-2 text-sm font-medium text-white opacity-75"
          >
            <PhSpinner :size="16" class="animate-spin" />
            <span>正在连接...</span>
          </button>

          <button
            v-else
            @click="handleEnable"
            :disabled="loading"
            class="inline-flex items-center gap-2 rounded-md border border-border bg-background px-4 py-2 text-sm font-medium hover:bg-accent disabled:opacity-50"
          >
            <PhSpinner v-if="loading" :size="16" class="animate-spin" />
            <span>{{ loading ? '正在启用...' : '启用' }}</span>
          </button>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.preset-card {
  transition: box-shadow 0.2s ease-in-out;
}
</style>
