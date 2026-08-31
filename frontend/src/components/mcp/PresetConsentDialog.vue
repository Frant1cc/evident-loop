<script setup lang="ts">
import { ref, computed } from 'vue';
import { PhX, PhWarning, PhCheckCircle, PhSpinner } from '@phosphor-icons/vue';
import type { McpPresetPublic } from '../../types/mcp-presets';
import { enableMcpPreset } from '../../api/mcp';

const props = defineProps<{
  preset: McpPresetPublic;
  open: boolean;
}>();

const emit = defineEmits<{
  (e: 'close'): void;
  (e: 'success'): void;
}>();

const stage = ref<'consent' | 'enabling' | 'testing' | 'connected' | 'error'>('consent');
const error = ref('');

const stageLabels = {
  consent: '确认启用',
  enabling: '正在准备',
  testing: '正在测试连接',
  connected: '已连接',
  error: '启用失败'
};

async function handleConfirm() {
  stage.value = 'enabling';
  error.value = '';

  try {
    // 调用启用 API
    stage.value = 'testing';
    await enableMcpPreset(props.preset.id, props.preset.consentVersion);

    stage.value = 'connected';

    // 2秒后关闭并通知成功
    setTimeout(() => {
      emit('success');
      emit('close');
      stage.value = 'consent';
    }, 2000);
  } catch (e) {
    stage.value = 'error';
    error.value = e instanceof Error ? e.message : '启用失败';
  }
}

function handleClose() {
  if (stage.value === 'enabling' || stage.value === 'testing') {
    // 正在启用时不允许关闭
    return;
  }
  emit('close');
  // 重置状态
  setTimeout(() => {
    stage.value = 'consent';
    error.value = '';
  }, 300);
}
</script>

<template>
  <Teleport to="body">
    <Transition name="dialog">
      <div
        v-if="open"
        class="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4"
        @click.self="handleClose"
      >
        <div
          class="relative w-full max-w-lg rounded-lg border border-border bg-background shadow-lg"
          @click.stop
        >
          <!-- Header -->
          <div class="flex items-center justify-between border-b border-border px-6 py-4">
            <h2 class="text-lg font-semibold text-foreground">
              {{ stageLabels[stage] }}
            </h2>
            <button
              v-if="stage !== 'enabling' && stage !== 'testing'"
              @click="handleClose"
              class="rounded-md p-1 hover:bg-accent"
            >
              <PhX :size="20" />
            </button>
          </div>

          <!-- Content -->
          <div class="px-6 py-5">
            <!-- Consent Stage -->
            <div v-if="stage === 'consent'" class="space-y-4">
              <div>
                <h3 class="text-base font-medium text-foreground mb-2">{{ preset.name }}</h3>
                <p class="text-sm text-muted-foreground">{{ preset.description }}</p>
              </div>

              <div class="space-y-2 text-sm">
                <div class="flex items-start gap-2">
                  <span class="font-medium text-foreground min-w-20">发布者：</span>
                  <span class="text-muted-foreground">{{ preset.publisher }}</span>
                </div>
                <div class="flex items-start gap-2">
                  <span class="font-medium text-foreground min-w-20">包名：</span>
                  <span class="text-muted-foreground font-mono text-xs">
                    {{ preset.package.name }}@{{ preset.package.version }}
                  </span>
                </div>
                <div class="flex items-start gap-2">
                  <span class="font-medium text-foreground min-w-20">审批策略：</span>
                  <span class="text-muted-foreground">{{ preset.approvalPolicyDescription }}</span>
                </div>
              </div>

              <div class="rounded-md bg-muted/50 p-4">
                <div class="flex items-start gap-2">
                  <PhWarning :size="20" class="text-yellow-600 mt-0.5 flex-shrink-0" />
                  <div class="text-sm text-muted-foreground">
                    <p class="font-medium text-foreground mb-1">数据说明</p>
                    <p>启用后，对话上下文将发送给该服务以执行工具调用。请确保你信任此服务提供商。</p>
                  </div>
                </div>
              </div>
            </div>

            <!-- Enabling/Testing Stage -->
            <div v-else-if="stage === 'enabling' || stage === 'testing'" class="py-8">
              <div class="flex flex-col items-center gap-4">
                <PhSpinner :size="48" class="animate-spin text-primary" />
                <div class="text-center">
                  <p class="text-base font-medium text-foreground mb-1">
                    {{ stage === 'enabling' ? '正在准备运行环境' : '正在测试连接并读取工具清单' }}
                  </p>
                  <p class="text-sm text-muted-foreground">这可能需要几秒钟...</p>
                </div>
              </div>
            </div>

            <!-- Connected Stage -->
            <div v-else-if="stage === 'connected'" class="py-8">
              <div class="flex flex-col items-center gap-4">
                <PhCheckCircle :size="48" class="text-green-600" />
                <div class="text-center">
                  <p class="text-base font-medium text-foreground mb-1">已成功启用</p>
                  <p class="text-sm text-muted-foreground">工具将在下一轮对话中生效</p>
                </div>
              </div>
            </div>

            <!-- Error Stage -->
            <div v-else-if="stage === 'error'" class="space-y-4">
              <div class="flex items-start gap-3 rounded-md bg-red-50 p-4 dark:bg-red-950/20">
                <PhWarning :size="20" class="text-red-600 mt-0.5 flex-shrink-0" />
                <div class="flex-1">
                  <p class="text-sm font-medium text-red-900 dark:text-red-400 mb-1">启用失败</p>
                  <p class="text-sm text-red-800 dark:text-red-300">{{ error }}</p>
                </div>
              </div>

              <div class="text-sm text-muted-foreground">
                <p class="font-medium mb-2">可能的原因：</p>
                <ul class="list-disc list-inside space-y-1 ml-2">
                  <li>Node.js 或 npm 未安装</li>
                  <li>网络连接失败，无法下载包</li>
                  <li>端口被占用或权限不足</li>
                </ul>
              </div>
            </div>
          </div>

          <!-- Footer -->
          <div class="flex justify-end gap-3 border-t border-border px-6 py-4">
            <button
              v-if="stage === 'consent'"
              @click="handleClose"
              class="rounded-md border border-border bg-background px-4 py-2 text-sm font-medium hover:bg-accent"
            >
              取消
            </button>
            <button
              v-if="stage === 'consent'"
              @click="handleConfirm"
              class="rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90"
            >
              确认启用
            </button>
            <button
              v-if="stage === 'error'"
              @click="handleClose"
              class="rounded-md border border-border bg-background px-4 py-2 text-sm font-medium hover:bg-accent"
            >
              关闭
            </button>
            <button
              v-if="stage === 'error'"
              @click="handleConfirm"
              class="rounded-md bg-orange-600 px-4 py-2 text-sm font-medium text-white hover:bg-orange-700"
            >
              重试
            </button>
          </div>
        </div>
      </div>
    </Transition>
  </Teleport>
</template>

<style scoped>
.dialog-enter-active,
.dialog-leave-active {
  transition: opacity 0.2s ease;
}

.dialog-enter-from,
.dialog-leave-to {
  opacity: 0;
}

.dialog-enter-active > div,
.dialog-leave-active > div {
  transition: transform 0.2s ease, opacity 0.2s ease;
}

.dialog-enter-from > div,
.dialog-leave-to > div {
  transform: scale(0.95);
  opacity: 0;
}
</style>
