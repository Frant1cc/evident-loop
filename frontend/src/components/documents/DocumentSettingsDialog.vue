<script setup lang="ts">
import { PhX } from '@phosphor-icons/vue';
import { ref, watch } from 'vue';
import type { ArtifactSpec, ArtifactImageConsent } from '../../types/artifacts';
import { Dialog, DialogContent } from '../ui/dialog';

const props = defineProps<{
  open: boolean;
  spec?: ArtifactSpec;
  editable?: boolean;
  imageConsents?: ArtifactImageConsent[];
  consentBusy?: boolean;
  sourceImageBusy?: boolean;
}>();

const emit = defineEmits<{
  'update:open': [open: boolean];
  'update-spec': [spec: ArtifactSpec];
  'confirm-consent': [imageUrl: string, sourceId?: string];
  'fetch-source-image': [];
}>();

const activeTab = ref<'general' | 'branding' | 'page' | 'assets'>('general');
const consentUrl = ref('');
const consentSourceId = ref('');

watch(() => props.open, (open) => {
  if (open) {
    activeTab.value = 'general';
    const consent = props.imageConsents?.[0];
    consentUrl.value = '';
    consentSourceId.value = consent?.sourceId ?? '';
  }
});

function updateSpec(updates: Partial<ArtifactSpec>) {
  if (!props.spec) return;
  emit('update-spec', { ...props.spec, ...updates });
}

function updateBranding(updates: Partial<ArtifactSpec['branding']>) {
  if (!props.spec) return;
  emit('update-spec', { ...props.spec, branding: { ...props.spec.branding, ...updates } });
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

  // Presentation must have pptx
  if (format === 'pptx' && !formats.includes('pptx')) {
    return;
  }

  // Longform must have at least one of docx/pdf
  const hasLongform = formats.includes('docx') || formats.includes('pdf');
  if ((format === 'docx' || format === 'pdf') && !hasLongform) {
    return;
  }

  emit('update-spec', { ...props.spec, formats });
}

function confirmConsent() {
  if (!consentUrl.value.trim()) return;
  emit('confirm-consent', consentUrl.value.trim(), consentSourceId.value.trim() || undefined);
}
</script>

<template>
  <Dialog :open="open" @update:open="emit('update:open', $event)">
    <DialogContent class="max-h-[85vh] max-w-3xl overflow-hidden">
      <div class="grid h-full max-h-[75vh] grid-rows-[auto_minmax(0,1fr)] gap-4">
        <div class="flex items-center justify-between border-b border-[var(--agent-border)] pb-3">
          <h2 class="m-0 text-lg font-bold text-[var(--agent-text)]">文稿设置</h2>
          <button
            type="button"
            class="grid size-8 place-items-center rounded text-[var(--agent-text-muted)] transition-colors hover:bg-[var(--agent-surface-muted)] hover:text-[var(--agent-text)]"
            aria-label="关闭"
            @click="emit('update:open', false)"
          >
            <PhX :size="18" weight="bold" aria-hidden="true" />
          </button>
        </div>

        <div class="grid min-h-0 grid-cols-[180px_minmax(0,1fr)] gap-4">
          <nav class="flex flex-col gap-1 border-r border-[var(--agent-border)] pr-4">
            <button
              type="button"
              class="rounded px-3 py-2 text-left text-sm font-semibold transition-colors"
              :class="activeTab === 'general' ? 'bg-[var(--agent-selected-bg)] text-[var(--agent-selected-text)]' : 'text-[var(--agent-text)] hover:bg-[var(--agent-surface-muted)]'"
              @click="activeTab = 'general'"
            >
              基本信息
            </button>
            <button
              type="button"
              class="rounded px-3 py-2 text-left text-sm font-semibold transition-colors"
              :class="activeTab === 'branding' ? 'bg-[var(--agent-selected-bg)] text-[var(--agent-selected-text)]' : 'text-[var(--agent-text)] hover:bg-[var(--agent-surface-muted)]'"
              @click="activeTab = 'branding'"
            >
              品牌与字体
            </button>
            <button
              type="button"
              class="rounded px-3 py-2 text-left text-sm font-semibold transition-colors"
              :class="activeTab === 'page' ? 'bg-[var(--agent-selected-bg)] text-[var(--agent-selected-text)]' : 'text-[var(--agent-text)] hover:bg-[var(--agent-surface-muted)]'"
              @click="activeTab = 'page'"
            >
              页面设置
            </button>
            <button
              type="button"
              class="rounded px-3 py-2 text-left text-sm font-semibold transition-colors"
              :class="activeTab === 'assets' ? 'bg-[var(--agent-selected-bg)] text-[var(--agent-selected-text)]' : 'text-[var(--agent-text)] hover:bg-[var(--agent-surface-muted)]'"
              @click="activeTab = 'assets'"
            >
              素材授权
            </button>
          </nav>

          <div class="min-h-0 overflow-y-auto pr-2">
            <!-- General -->
            <div v-if="activeTab === 'general' && spec" class="space-y-3">
              <label class="grid gap-1 text-xs font-semibold text-[var(--agent-text-muted)]">
                标题
                <input
                  v-if="editable"
                  :value="spec.title"
                  type="text"
                  class="rounded-md border border-[var(--agent-border)] bg-transparent px-2 py-1.5 text-sm text-[var(--agent-text)]"
                  @input="updateSpec({ title: ($event.target as HTMLInputElement).value })"
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
                  @input="updateSpec({ audience: ($event.target as HTMLInputElement).value })"
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
                      :disabled="!editable || spec.formats.includes('pptx')"
                      @change="toggleFormat('pptx')"
                    />
                    PPTX（演示文稿必选）
                  </label>
                  <label class="flex items-center gap-2 text-sm text-[var(--agent-text)]">
                    <input
                      type="checkbox"
                      :checked="spec.formats.includes('docx')"
                      :disabled="!editable"
                      @change="toggleFormat('docx')"
                    />
                    DOCX
                  </label>
                  <label class="flex items-center gap-2 text-sm text-[var(--agent-text)]">
                    <input
                      type="checkbox"
                      :checked="spec.formats.includes('pdf')"
                      :disabled="!editable"
                      @change="toggleFormat('pdf')"
                    />
                    PDF
                  </label>
                </div>
              </div>
            </div>

            <!-- Branding -->
            <div v-if="activeTab === 'branding' && spec" class="space-y-3">
              <label class="grid gap-1 text-xs font-semibold text-[var(--agent-text-muted)]">
                品牌色
                <input
                  v-if="editable"
                  :value="spec.branding.primaryColor || ''"
                  type="text"
                  placeholder="#2563eb"
                  class="rounded-md border border-[var(--agent-border)] bg-transparent px-2 py-1.5 text-sm text-[var(--agent-text)]"
                  @input="updateBranding({ primaryColor: ($event.target as HTMLInputElement).value })"
                />
                <div v-else class="rounded-md border border-[var(--agent-border)] bg-[var(--agent-surface-muted)] px-2 py-1.5 text-sm text-[var(--agent-text)]">
                  {{ spec.branding.primaryColor || '默认' }}
                </div>
              </label>

              <label class="grid gap-1 text-xs font-semibold text-[var(--agent-text-muted)]">
                Logo URL
                <input
                  v-if="editable"
                  :value="spec.branding.logoUrl || ''"
                  type="url"
                  placeholder="https://…"
                  class="rounded-md border border-[var(--agent-border)] bg-transparent px-2 py-1.5 text-sm text-[var(--agent-text)]"
                  @input="updateBranding({ logoUrl: ($event.target as HTMLInputElement).value })"
                />
                <div v-else class="rounded-md border border-[var(--agent-border)] bg-[var(--agent-surface-muted)] px-2 py-1.5 text-sm text-[var(--agent-text)]">
                  {{ spec.branding.logoUrl || '无' }}
                </div>
              </label>

              <label class="grid gap-1 text-xs font-semibold text-[var(--agent-text-muted)]">
                标题字体
                <input
                  v-if="editable"
                  :value="spec.branding.titleFont || ''"
                  placeholder="Arial"
                  class="rounded-md border border-[var(--agent-border)] bg-transparent px-2 py-1.5 text-sm text-[var(--agent-text)]"
                  @input="updateBranding({ titleFont: ($event.target as HTMLInputElement).value })"
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
                  @input="updateBranding({ bodyFont: ($event.target as HTMLInputElement).value })"
                />
                <div v-else class="rounded-md border border-[var(--agent-border)] bg-[var(--agent-surface-muted)] px-2 py-1.5 text-sm text-[var(--agent-text)]">
                  {{ spec.branding.bodyFont || '默认' }}
                </div>
              </label>
            </div>

            <!-- Page Settings -->
            <div v-if="activeTab === 'page' && spec" class="space-y-3">
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
                    min="0"
                    class="rounded-md border border-[var(--agent-border)] bg-transparent px-2 py-1.5 text-sm text-[var(--agent-text)]"
                    @input="updatePageSettings({ marginTop: Number(($event.target as HTMLInputElement).value) })"
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
                    min="0"
                    class="rounded-md border border-[var(--agent-border)] bg-transparent px-2 py-1.5 text-sm text-[var(--agent-text)]"
                    @input="updatePageSettings({ marginBottom: Number(($event.target as HTMLInputElement).value) })"
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
                    min="0"
                    class="rounded-md border border-[var(--agent-border)] bg-transparent px-2 py-1.5 text-sm text-[var(--agent-text)]"
                    @input="updatePageSettings({ marginLeft: Number(($event.target as HTMLInputElement).value) })"
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
                    min="0"
                    class="rounded-md border border-[var(--agent-border)] bg-transparent px-2 py-1.5 text-sm text-[var(--agent-text)]"
                    @input="updatePageSettings({ marginRight: Number(($event.target as HTMLInputElement).value) })"
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
                  @input="updatePageSettings({ header: ($event.target as HTMLInputElement).value })"
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
                  @input="updatePageSettings({ footer: ($event.target as HTMLInputElement).value })"
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

            <!-- Assets -->
            <div v-if="activeTab === 'assets'" class="space-y-3">
              <p class="text-xs text-[var(--agent-text-muted)]">确认使用外部图片素材，需两步：先确认授权，再下载使用。</p>

              <label class="grid gap-1 text-xs font-semibold text-[var(--agent-text-muted)]">
                图片 URL
                <input
                  v-model="consentUrl"
                  type="url"
                  placeholder="仅允许 HTTPS 图片地址"
                  class="rounded-md border border-[var(--agent-border)] bg-transparent px-2 py-1.5 text-sm text-[var(--agent-text)]"
                  :disabled="!editable"
                />
              </label>

              <label class="grid gap-1 text-xs font-semibold text-[var(--agent-text-muted)]">
                来源 ID（可选）
                <input
                  v-model="consentSourceId"
                  type="text"
                  placeholder="例如：source_1"
                  class="rounded-md border border-[var(--agent-border)] bg-transparent px-2 py-1.5 text-sm text-[var(--agent-text)]"
                  :disabled="!editable"
                />
              </label>

              <button
                type="button"
                class="rounded-md bg-[var(--agent-selected-bg)] px-3 py-1.5 text-xs font-bold text-[var(--agent-selected-text)] transition-opacity hover:opacity-80 disabled:opacity-50"
                :disabled="!editable || consentBusy || !consentUrl.trim()"
                @click="confirmConsent"
              >
                {{ consentBusy ? '保存中…' : '确认使用授权' }}
              </button>

              <div v-if="imageConsents?.length" class="space-y-2 border-t border-[var(--agent-border)] pt-3">
                <p class="text-xs font-semibold text-[var(--agent-text-muted)]">已授权素材</p>
                <div v-for="consent in imageConsents" :key="consent.id" class="rounded-md border border-[var(--agent-border)] bg-[var(--agent-surface-muted)] p-2">
                  <p class="m-0 truncate text-xs text-[var(--agent-text)]">{{ consent.imageUrl }}</p>
                  <p v-if="consent.sourceId" class="m-0 mt-1 text-[10px] text-[var(--agent-text-muted)]">来源：{{ consent.sourceId }}</p>
                  <button
                    type="button"
                    class="mt-2 rounded border border-[var(--agent-border)] px-2 py-1 text-[10px] font-bold text-[var(--agent-text)] transition-colors hover:bg-[var(--agent-surface)] disabled:opacity-50"
                    :disabled="!editable || sourceImageBusy"
                    @click="emit('fetch-source-image')"
                  >
                    {{ sourceImageBusy ? '下载中…' : '下载并使用' }}
                  </button>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </DialogContent>
  </Dialog>
</template>
