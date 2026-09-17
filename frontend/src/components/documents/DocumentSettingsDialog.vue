<script setup lang="ts">
import { PhFileText, PhPalette, PhSlidersHorizontal, PhX } from '@phosphor-icons/vue';
import { computed, ref, watch } from 'vue';
import type { ArtifactSpec } from '../../types/artifacts';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '../ui/dialog';
import type { DraftSaveState } from './documentEditor';

const props = defineProps<{
  open: boolean;
  spec?: ArtifactSpec;
  editable?: boolean;
  saveState?: DraftSaveState;
}>();

const emit = defineEmits<{
  'update:open': [open: boolean];
  'update-spec': [spec: ArtifactSpec];
}>();

const activeTab = ref<'general' | 'branding' | 'page'>('general');
const colorDraft = ref('');
const colorError = ref(false);
const settingsTabs = [
  { id: 'general', label: '基本信息', icon: PhSlidersHorizontal },
  { id: 'branding', label: '品牌与字体', icon: PhPalette },
  { id: 'page', label: '页面设置', icon: PhFileText }
] as const;

watch(() => props.open, (open) => {
  if (open) {
    activeTab.value = 'general';
    colorDraft.value = props.spec?.branding.primaryColor ?? '';
    colorError.value = false;
  }
});

const saveStateLabel = computed(() => ({
  saved: '所有更改已保存',
  dirty: '等待保存…',
  saving: '正在保存…',
  error: '保存失败，请修改后重试'
}[props.saveState ?? 'saved']));

function updateSpec(updates: Partial<ArtifactSpec>) {
  if (!props.spec) return;
  emit('update-spec', { ...props.spec, ...updates });
}

function updateBranding(updates: Partial<ArtifactSpec['branding']>) {
  if (!props.spec) return;
  emit('update-spec', { ...props.spec, branding: { ...props.spec.branding, ...updates } });
}

function commitPrimaryColor() {
  const value = colorDraft.value.trim();
  if (!value) {
    colorError.value = false;
    updateBranding({ primaryColor: undefined });
    return;
  }
  if (!/^#?[0-9a-fA-F]{6}$/.test(value)) {
    colorError.value = true;
    return;
  }
  const normalized = value.startsWith('#') ? value : `#${value}`;
  colorDraft.value = normalized;
  colorError.value = false;
  updateBranding({ primaryColor: normalized });
}

function updateOptionalBranding(key: 'titleFont' | 'bodyFont', value: string) {
  updateBranding({ [key]: value.trim() || undefined });
}

function updateRequiredText(key: 'title' | 'audience', input: HTMLInputElement) {
  if (!props.spec) return;
  const value = input.value.trim();
  if (!value) {
    input.value = props.spec[key];
    return;
  }
  input.value = value;
  updateSpec({ [key]: value });
}

function updateOptionalPageText(key: 'header' | 'footer', value: string) {
  updatePageSettings({ [key]: value.trim() || undefined });
}

function updateMargin(
  key: 'marginTop' | 'marginBottom' | 'marginLeft' | 'marginRight',
  input: HTMLInputElement
) {
  const value = Number(input.value);
  const normalized = Math.min(50, Math.max(5, Number.isFinite(value) ? value : 25.4));
  input.value = String(normalized);
  updatePageSettings({ [key]: normalized });
}

function updatePageSettings(updates: Partial<ArtifactSpec['longform']['pageSettings']>) {
  if (!props.spec) return;
  emit('update-spec', {
    ...props.spec,
    longform: {
      ...props.spec.longform,
      pageSettings: { ...props.spec.longform.pageSettings, ...updates }
    }
  });
}

function toggleFormat(format: 'pptx' | 'pdf' | 'docx') {
  if (!props.spec) return;
  const formats = props.spec.formats.includes(format)
    ? props.spec.formats.filter(f => f !== format)
    : [...props.spec.formats, format];

  if (!formats.length) return;

  emit('update-spec', { ...props.spec, formats });
}

</script>

<template>
  <Dialog :open="open" @update:open="emit('update:open', $event)">
    <DialogContent
      :show-close-button="false"
      class="h-[min(88dvh,760px)] max-w-[calc(100%-1rem)] gap-0 overflow-hidden p-0 sm:max-w-3xl"
    >
      <div class="grid h-full min-h-0 grid-rows-[auto_minmax(0,1fr)_auto]">
        <header class="flex items-center justify-between gap-4 border-b border-[var(--agent-border)] px-4 py-3.5 sm:px-5">
          <div class="min-w-0">
            <div class="flex items-center gap-2">
              <DialogTitle class="text-base font-semibold text-[var(--agent-text)]">文稿设置</DialogTitle>
              <span v-if="!editable" class="rounded-md bg-[var(--agent-surface-muted)] px-1.5 py-0.5 text-[10px] font-semibold text-[var(--agent-text-muted)]">只读</span>
            </div>
            <DialogDescription class="mt-1 text-xs text-[var(--agent-text-muted)]">
              管理文稿信息、品牌样式和页面规格。
            </DialogDescription>
          </div>
          <button
            type="button"
            class="grid size-8 shrink-0 place-items-center rounded-md text-[var(--agent-text-muted)] transition-[background-color,color,transform] hover:bg-[var(--agent-surface-muted)] hover:text-[var(--agent-text)] active:scale-95 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--agent-focus-ring)]"
            aria-label="关闭"
            @click="emit('update:open', false)"
          >
            <PhX :size="18" weight="bold" aria-hidden="true" />
          </button>
        </header>

        <div class="grid min-h-0 grid-rows-[auto_minmax(0,1fr)] sm:grid-cols-[190px_minmax(0,1fr)] sm:grid-rows-1">
          <nav class="app-scrollbar flex gap-1 overflow-x-auto border-b border-[var(--agent-border)] bg-[var(--agent-surface-muted)]/35 p-2 sm:flex-col sm:overflow-x-visible sm:border-b-0 sm:border-r" aria-label="设置分类">
            <button
              v-for="tab in settingsTabs"
              :key="tab.id"
              type="button"
              class="inline-flex shrink-0 items-center gap-2 rounded-md px-3 py-2 text-left text-xs font-semibold transition-[background-color,color,box-shadow] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--agent-focus-ring)] sm:w-full"
              :class="activeTab === tab.id
                ? 'bg-[var(--agent-surface)] text-[var(--agent-text)] shadow-sm'
                : 'text-[var(--agent-text-muted)] hover:bg-[var(--agent-surface-muted)] hover:text-[var(--agent-text)]'"
              :aria-current="activeTab === tab.id ? 'page' : undefined"
              @click="activeTab = tab.id"
            >
              <component :is="tab.icon" :size="15" weight="bold" aria-hidden="true" />
              {{ tab.label }}
            </button>
          </nav>

          <div class="app-scrollbar min-h-0 overflow-y-auto p-4 sm:p-5">
            <!-- General -->
            <div v-if="activeTab === 'general' && spec" class="max-w-xl space-y-4">
              <label class="grid gap-1 text-xs font-semibold text-[var(--agent-text-muted)]">
                标题
                <input
                  v-if="editable"
                  :value="spec.title"
                  type="text"
                  class="rounded-md border border-[var(--agent-border)] bg-transparent px-2 py-1.5 text-sm text-[var(--agent-text)]"
                  @change="updateRequiredText('title', $event.target as HTMLInputElement)"
                />
                <div v-else class="rounded-md border border-[var(--agent-border)] bg-[var(--agent-surface-muted)] px-2 py-1.5 text-sm text-[var(--agent-text)]">
                  {{ spec.title }}
                </div>
              </label>

              <label class="grid gap-1 text-xs font-semibold text-[var(--agent-text-muted)]">
                受众
                <input
                  v-if="editable"
                  :value="spec.audience"
                  type="text"
                  class="rounded-md border border-[var(--agent-border)] bg-transparent px-2 py-1.5 text-sm text-[var(--agent-text)]"
                  @change="updateRequiredText('audience', $event.target as HTMLInputElement)"
                />
                <div v-else class="rounded-md border border-[var(--agent-border)] bg-[var(--agent-surface-muted)] px-2 py-1.5 text-sm text-[var(--agent-text)]">
                  {{ spec.audience }}
                </div>
              </label>

              <label class="grid gap-1 text-xs font-semibold text-[var(--agent-text-muted)]">
                主题
                <select
                  v-if="editable"
                  :value="spec.theme"
                  class="rounded-md border border-[var(--agent-border)] bg-transparent px-2 py-1.5 text-sm text-[var(--agent-text)]"
                  @change="updateSpec({ theme: ($event.target as HTMLSelectElement).value as ArtifactSpec['theme'] })"
                >
                  <option value="research">研究汇报</option>
                  <option value="technical">技术方案</option>
                  <option value="business">商业汇报</option>
                </select>
                <div v-else class="rounded-md border border-[var(--agent-border)] bg-[var(--agent-surface-muted)] px-2 py-1.5 text-sm text-[var(--agent-text)]">
                  {{ { research: '研究汇报', technical: '技术方案', business: '商业汇报' }[spec.theme] }}
                </div>
              </label>

              <div class="space-y-2">
                <span class="text-xs font-semibold text-[var(--agent-text-muted)]">输出格式</span>
                <div class="flex flex-wrap gap-3">
                  <label class="flex items-center gap-2 text-sm text-[var(--agent-text)]">
                    <input
                      type="checkbox"
                      :checked="spec.formats.includes('pptx')"
                      :disabled="!editable || (spec.formats.includes('pptx') && spec.formats.length === 1)"
                      @change="toggleFormat('pptx')"
                    />
                    PPTX
                  </label>
                  <label class="flex items-center gap-2 text-sm text-[var(--agent-text)]">
                    <input
                      type="checkbox"
                      :checked="spec.formats.includes('docx')"
                      :disabled="!editable || (spec.formats.includes('docx') && spec.formats.length === 1)"
                      @change="toggleFormat('docx')"
                    />
                    DOCX
                  </label>
                  <label class="flex items-center gap-2 text-sm text-[var(--agent-text)]">
                    <input
                      type="checkbox"
                      :checked="spec.formats.includes('pdf')"
                      :disabled="!editable || (spec.formats.includes('pdf') && spec.formats.length === 1)"
                      @change="toggleFormat('pdf')"
                    />
                    PDF
                  </label>
                </div>
              </div>
            </div>

            <!-- Branding -->
            <div v-if="activeTab === 'branding' && spec" class="max-w-xl space-y-4">
              <label class="grid gap-1 text-xs font-semibold text-[var(--agent-text-muted)]">
                品牌色
                <input
                  v-if="editable"
                  v-model="colorDraft"
                  type="text"
                  placeholder="#2563eb"
                  class="rounded-md border border-[var(--agent-border)] bg-transparent px-2 py-1.5 text-sm text-[var(--agent-text)]"
                  :aria-invalid="colorError"
                  @change="commitPrimaryColor"
                />
                <div v-else class="rounded-md border border-[var(--agent-border)] bg-[var(--agent-surface-muted)] px-2 py-1.5 text-sm text-[var(--agent-text)]">
                  {{ spec.branding.primaryColor || '默认' }}
                </div>
                <span v-if="colorError" class="text-[11px] font-medium text-destructive">请输入 6 位十六进制颜色，例如 #2563eb</span>
              </label>

              <label class="grid gap-1 text-xs font-semibold text-[var(--agent-text-muted)]">
                标题字体
                <input
                  v-if="editable"
                  :value="spec.branding.titleFont || ''"
                  placeholder="Arial"
                  class="rounded-md border border-[var(--agent-border)] bg-transparent px-2 py-1.5 text-sm text-[var(--agent-text)]"
                  @change="updateOptionalBranding('titleFont', ($event.target as HTMLInputElement).value)"
                />
                <div v-else class="rounded-md border border-[var(--agent-border)] bg-[var(--agent-surface-muted)] px-2 py-1.5 text-sm text-[var(--agent-text)]">
                  {{ spec.branding.titleFont || '默认' }}
                </div>
              </label>

              <label class="grid gap-1 text-xs font-semibold text-[var(--agent-text-muted)]">
                正文字体
                <input
                  v-if="editable"
                  :value="spec.branding.bodyFont || ''"
                  placeholder="Arial"
                  class="rounded-md border border-[var(--agent-border)] bg-transparent px-2 py-1.5 text-sm text-[var(--agent-text)]"
                  @change="updateOptionalBranding('bodyFont', ($event.target as HTMLInputElement).value)"
                />
                <div v-else class="rounded-md border border-[var(--agent-border)] bg-[var(--agent-surface-muted)] px-2 py-1.5 text-sm text-[var(--agent-text)]">
                  {{ spec.branding.bodyFont || '默认' }}
                </div>
              </label>
            </div>

            <!-- Page Settings -->
            <div v-if="activeTab === 'page' && spec" class="max-w-xl space-y-4">
              <label class="grid gap-1 text-xs font-semibold text-[var(--agent-text-muted)]">
                页面大小
                <select
                  v-if="editable"
                  :value="spec.longform.pageSettings.size"
                  class="rounded-md border border-[var(--agent-border)] bg-transparent px-2 py-1.5 text-sm text-[var(--agent-text)]"
                  @change="updatePageSettings({ size: ($event.target as HTMLSelectElement).value as 'A4' | 'Letter' })"
                >
                  <option value="A4">A4</option>
                  <option value="Letter">Letter</option>
                </select>
                <div v-else class="rounded-md border border-[var(--agent-border)] bg-[var(--agent-surface-muted)] px-2 py-1.5 text-sm text-[var(--agent-text)]">
                  {{ spec.longform.pageSettings.size }}
                </div>
              </label>

              <label class="grid gap-1 text-xs font-semibold text-[var(--agent-text-muted)]">
                方向
                <select
                  v-if="editable"
                  :value="spec.longform.pageSettings.orientation"
                  class="rounded-md border border-[var(--agent-border)] bg-transparent px-2 py-1.5 text-sm text-[var(--agent-text)]"
                  @change="updatePageSettings({ orientation: ($event.target as HTMLSelectElement).value as 'portrait' | 'landscape' })"
                >
                  <option value="portrait">纵向</option>
                  <option value="landscape">横向</option>
                </select>
                <div v-else class="rounded-md border border-[var(--agent-border)] bg-[var(--agent-surface-muted)] px-2 py-1.5 text-sm text-[var(--agent-text)]">
                  {{ spec.longform.pageSettings.orientation === 'portrait' ? '纵向' : '横向' }}
                </div>
              </label>

              <div class="grid grid-cols-2 gap-3">
                <label class="grid gap-1 text-xs font-semibold text-[var(--agent-text-muted)]">
                  上边距 (mm)
                  <input
                    v-if="editable"
                    :value="spec.longform.pageSettings.marginTop"
                    type="number"
                    min="5"
                    max="50"
                    class="rounded-md border border-[var(--agent-border)] bg-transparent px-2 py-1.5 text-sm text-[var(--agent-text)]"
                    @change="updateMargin('marginTop', $event.target as HTMLInputElement)"
                  />
                  <div v-else class="rounded-md border border-[var(--agent-border)] bg-[var(--agent-surface-muted)] px-2 py-1.5 text-sm text-[var(--agent-text)]">
                    {{ spec.longform.pageSettings.marginTop }}
                  </div>
                </label>
                <label class="grid gap-1 text-xs font-semibold text-[var(--agent-text-muted)]">
                  下边距 (mm)
                  <input
                    v-if="editable"
                    :value="spec.longform.pageSettings.marginBottom"
                    type="number"
                    min="5"
                    max="50"
                    class="rounded-md border border-[var(--agent-border)] bg-transparent px-2 py-1.5 text-sm text-[var(--agent-text)]"
                    @change="updateMargin('marginBottom', $event.target as HTMLInputElement)"
                  />
                  <div v-else class="rounded-md border border-[var(--agent-border)] bg-[var(--agent-surface-muted)] px-2 py-1.5 text-sm text-[var(--agent-text)]">
                    {{ spec.longform.pageSettings.marginBottom }}
                  </div>
                </label>
                <label class="grid gap-1 text-xs font-semibold text-[var(--agent-text-muted)]">
                  左边距 (mm)
                  <input
                    v-if="editable"
                    :value="spec.longform.pageSettings.marginLeft"
                    type="number"
                    min="5"
                    max="50"
                    class="rounded-md border border-[var(--agent-border)] bg-transparent px-2 py-1.5 text-sm text-[var(--agent-text)]"
                    @change="updateMargin('marginLeft', $event.target as HTMLInputElement)"
                  />
                  <div v-else class="rounded-md border border-[var(--agent-border)] bg-[var(--agent-surface-muted)] px-2 py-1.5 text-sm text-[var(--agent-text)]">
                    {{ spec.longform.pageSettings.marginLeft }}
                  </div>
                </label>
                <label class="grid gap-1 text-xs font-semibold text-[var(--agent-text-muted)]">
                  右边距 (mm)
                  <input
                    v-if="editable"
                    :value="spec.longform.pageSettings.marginRight"
                    type="number"
                    min="5"
                    max="50"
                    class="rounded-md border border-[var(--agent-border)] bg-transparent px-2 py-1.5 text-sm text-[var(--agent-text)]"
                    @change="updateMargin('marginRight', $event.target as HTMLInputElement)"
                  />
                  <div v-else class="rounded-md border border-[var(--agent-border)] bg-[var(--agent-surface-muted)] px-2 py-1.5 text-sm text-[var(--agent-text)]">
                    {{ spec.longform.pageSettings.marginRight }}
                  </div>
                </label>
              </div>

              <label class="grid gap-1 text-xs font-semibold text-[var(--agent-text-muted)]">
                页眉
                <input
                  v-if="editable"
                  :value="spec.longform.pageSettings.header || ''"
                  type="text"
                  class="rounded-md border border-[var(--agent-border)] bg-transparent px-2 py-1.5 text-sm text-[var(--agent-text)]"
                  @change="updateOptionalPageText('header', ($event.target as HTMLInputElement).value)"
                />
                <div v-else class="rounded-md border border-[var(--agent-border)] bg-[var(--agent-surface-muted)] px-2 py-1.5 text-sm text-[var(--agent-text)]">
                  {{ spec.longform.pageSettings.header || '无' }}
                </div>
              </label>

              <label class="grid gap-1 text-xs font-semibold text-[var(--agent-text-muted)]">
                页脚
                <input
                  v-if="editable"
                  :value="spec.longform.pageSettings.footer || ''"
                  type="text"
                  class="rounded-md border border-[var(--agent-border)] bg-transparent px-2 py-1.5 text-sm text-[var(--agent-text)]"
                  @change="updateOptionalPageText('footer', ($event.target as HTMLInputElement).value)"
                />
                <div v-else class="rounded-md border border-[var(--agent-border)] bg-[var(--agent-surface-muted)] px-2 py-1.5 text-sm text-[var(--agent-text)]">
                  {{ spec.longform.pageSettings.footer || '无' }}
                </div>
              </label>

              <label class="flex items-center gap-2 text-sm text-[var(--agent-text)]">
                <input
                  type="checkbox"
                  :checked="spec.longform.pageSettings.pageNumbers"
                  :disabled="!editable"
                  @change="updatePageSettings({ pageNumbers: ($event.target as HTMLInputElement).checked })"
                />
                显示页码
              </label>
            </div>

          </div>
        </div>

        <footer class="flex items-center justify-between gap-3 border-t border-[var(--agent-border)] bg-[var(--agent-surface)] px-4 py-3 sm:px-5">
          <span
            class="text-[11px] font-medium"
            :class="saveState === 'error' ? 'text-destructive' : 'text-[var(--agent-text-muted)]'"
            role="status"
          >
            {{ saveStateLabel }}
          </span>
          <button
            type="button"
            class="h-8 rounded-md bg-[var(--agent-primary)] px-3 text-xs font-semibold text-[var(--agent-primary-text)] transition-[opacity,transform] hover:opacity-90 active:scale-[0.98]"
            @click="emit('update:open', false)"
          >
            完成
          </button>
        </footer>
      </div>
    </DialogContent>
  </Dialog>
</template>

<style scoped>
:deep(input:not([type='checkbox'])),
:deep(select) {
  min-height: 2.5rem;
  background: var(--agent-bg);
  line-height: 1.5;
  transition: border-color 140ms ease, box-shadow 140ms ease;
}

:deep(input:not([type='checkbox']):hover),
:deep(select:hover) {
  border-color: color-mix(in oklch, var(--agent-text-muted), transparent 40%);
}

:deep(input:not([type='checkbox']):focus),
:deep(select:focus) {
  border-color: var(--agent-text-muted);
  box-shadow: 0 0 0 3px var(--agent-focus-ring);
  outline: none;
}
</style>
