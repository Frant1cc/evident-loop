<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue';

import {
  createResearchArtifactDraft,
  cancelResearchArtifact,
  confirmResearchArtifactImageUse,
  fetchResearchArtifactSourceImage,
  deleteResearchArtifactGeneration,
  getResearchArtifactGeneration,
  listResearchArtifactGenerations,
  renderResearchArtifact,
  retryResearchArtifactOutput,
  updateResearchArtifactDraft
} from '../../api/artifacts';
import type { ResearchArtifactGeneration } from '../../types/artifacts';
import type { ResearchMessage } from '../../types/research';
import { ARTIFACT_FORMATS, formatLabels, inferArtifactFormats, type ArtifactFormat } from '../../lib/artifactFormats';
import {
  createGenerationDraftRevision,
  hasUnpersistedDraftChanges,
  markGenerationDraftPersisted,
  observeGenerationDraftRevision,
  type GenerationDraftRevision
} from './draftRevision';
import {
  createArtifactSessionToken,
  shouldApplyArtifactSessionResponse,
  type ArtifactSessionToken
} from './sessionEpoch';

const props = defineProps<{
  conversationId?: string;
  messages: ResearchMessage[];
  enabled: boolean;
}>();

const generations = ref<ResearchArtifactGeneration[]>([]);
const selectedId = ref<string>();
const busy = ref(false);
const saving = ref(false);
const error = ref('');
type RevisionRecord = GenerationDraftRevision & { pendingSave?: Promise<boolean> };
const revisionRecords = new Map<string, RevisionRecord>();
let pollTimer: ReturnType<typeof window.setInterval> | undefined;
const consentUrl = ref('');
const consentSourceId = ref('');
const consentId = ref('');
const consentImageUrl = ref('');
const consentBusy = ref(false);
const sourceImageBusy = ref(false);
const createFormats = ref<ArtifactFormat[]>([]);
let sessionEpoch = 0;

const selected = computed(() => generations.value.find((generation) => generation.id === selectedId.value));
const editable = computed(() => selected.value?.status === 'awaiting_confirmation' && !selected.value.stale);
const canCreate = computed(() => props.enabled && Boolean(props.conversationId) && props.messages.some((message) => message.status === 'complete'));
const selectedFormats = computed(() => selected.value?.spec.formats?.length ? selected.value.spec.formats : [...ARTIFACT_FORMATS]);
const confirmLabel = computed(() => `确认并生成 ${formatLabels(selectedFormats.value)}`);

watch(() => props.conversationId, () => {
  createFormats.value = inferArtifactFormats(latestUserText()) ?? [];
}, { immediate: true });

function latestUserText() {
  return [...props.messages].reverse().find((message) => message.role === 'user' && message.status === 'complete')?.content ?? '';
}

function toggleCreateFormat(format: ArtifactFormat) {
  createFormats.value = ARTIFACT_FORMATS.filter((item) => item === format
    ? !createFormats.value.includes(item)
    : createFormats.value.includes(item));
}

function includesSelectedFormat(format: ArtifactFormat) {
  return selectedFormats.value.includes(format);
}

function toggleSelectedFormat(format: ArtifactFormat) {
  const spec = selected.value?.spec;
  if (!spec || !editable.value) return;
  const next = ARTIFACT_FORMATS.filter((item) => item === format
    ? !selectedFormats.value.includes(item)
    : selectedFormats.value.includes(item));
  if (!next.length) return;
  spec.formats = next;
  void saveDraft();
}

function outputStatusText(output: { status: string; error?: string; progress?: string }): string {
  if (output.status === 'completed') return '可下载';
  if (output.status === 'failed') return output.error ?? '失败';
  const label = ({ pending: '等待中', rendering: '渲染中', validating: '质检中', cancelled: '已取消' } as Record<string, string>)[output.status] ?? output.status;
  return output.progress ? `${label} · ${output.progress}` : label;
}
const statusLabel = computed(() => {
  const status = selected.value?.status;
  return ({
    planning: '规划中',
    awaiting_confirmation: '等待确认大纲',
    rendering: '渲染中',
    validating: '质量检查中',
    repairing: '自动修复版式',
    completed: '已完成',
    partial: '部分完成',
    failed: '失败',
    cancelled: '已取消',
    superseded: '已确认（历史草稿）'
  } as Record<string, string>)[status ?? ''] ?? '';
});

watch(() => [props.conversationId, props.enabled] as const, () => {
  const conversationId = props.conversationId;
  const epoch = ++sessionEpoch;
  stopPolling();
  generations.value = [];
  revisionRecords.clear();
  selectedId.value = undefined;
  busy.value = false;
  saving.value = false;
  consentId.value = '';
  consentImageUrl.value = '';
  consentSourceId.value = '';
  consentUrl.value = '';
  consentBusy.value = false;
  sourceImageBusy.value = false;
  resetRevisionBaseline(undefined);
  error.value = '';
  if (conversationId && props.enabled) void load(conversationId, epoch);
}, { immediate: true });

watch(() => selected.value?.spec, syncDraftRevision, { deep: true });
watch(selectedId, () => syncConsentForGeneration(selected.value));

onBeforeUnmount(stopPolling);

function currentSessionToken(): ArtifactSessionToken {
  return createArtifactSessionToken(props.conversationId, sessionEpoch);
}

function isCurrentSession(token: ArtifactSessionToken) {
  return shouldApplyArtifactSessionResponse(token, currentSessionToken(), props.enabled);
}

async function load(conversationId: string, epoch: number) {
  const request = createArtifactSessionToken(conversationId, epoch);
  try {
    const result = await listResearchArtifactGenerations(conversationId);
    if (!isCurrentSession(request)) return;
    generations.value = result.generations;
    selectedId.value = result.generations.find((generation) => generation.status === 'awaiting_confirmation')?.id
      ?? result.generations[0]?.id;
    resetRevisionBaseline(selected.value);
    syncConsentForGeneration(selected.value);
    refreshPolling();
  } catch {
    // The generation panel is an optional enhancement and should not block research chat.
  }
}

async function createDraft() {
  const conversationId = props.conversationId;
  const request = currentSessionToken();
  if (!conversationId || busy.value) return;
  const formats = createFormats.value.length ? createFormats.value : inferArtifactFormats(latestUserText());
  if (!formats?.length) {
    error.value = '请先选择要生成 PPTX、PDF，或在对话里说明需要哪种文件';
    return;
  }
  busy.value = true;
  error.value = '';
  try {
    const result = await createResearchArtifactDraft(conversationId, { formats });
    if (!isCurrentSession(request)) return;
    generations.value = [result.generation, ...generations.value];
    selectedId.value = result.generation.id;
    resetRevisionBaseline(result.generation);
  } catch (cause) {
    if (isCurrentSession(request)) error.value = cause instanceof Error ? cause.message : '无法创建产物草稿';
  } finally {
    if (isCurrentSession(request)) busy.value = false;
  }
}

function saveDraft(): Promise<boolean> {
  syncDraftRevision();
  const generation = selected.value;
  if (!generation || !editable.value) return Promise.resolve(false);
  const request = currentSessionToken();
  if (!props.enabled || !props.conversationId) return Promise.resolve(false);
  const generationId = generation.id;
  const record = revisionRecords.get(generationId) ?? resetRevisionBaseline(generation);
  if (!record) return Promise.resolve(false);
  if (record.pendingSave) return record.pendingSave;
  const pending = (async () => {
    while (true) {
      if (!isCurrentSession(request)) return false;
      const current = generations.value.find((item) => item.id === generationId);
      const currentRecord = revisionRecords.get(generationId);
      if (!current || !currentRecord || current.status !== 'awaiting_confirmation' || current.stale) return false;
      const targetRevision = currentRecord.draftRevision;
      const targetSpec = cloneSpec(current.spec);
      if (selectedId.value === generationId) saving.value = true;
      error.value = '';
      try {
        const result = await updateResearchArtifactDraft(generationId, targetSpec);
        if (!isCurrentSession(request)) return false;
        const latest = generations.value.find((item) => item.id === generationId);
        const latestRecord = revisionRecords.get(generationId);
        const changedDuringSave = Boolean(latestRecord && latestRecord.draftRevision !== targetRevision);
        const localSpec = latest?.spec ?? current.spec;
        replaceGeneration(
          changedDuringSave ? { ...result.generation, spec: localSpec } : result.generation,
          changedDuringSave,
          false
        );
        if (latestRecord) {
          revisionRecords.set(generationId, {
            ...markGenerationDraftPersisted(latestRecord, targetRevision, JSON.stringify(targetSpec)),
            pendingSave: latestRecord.pendingSave
          });
        }
        if (!changedDuringSave) return true;
      } catch (cause) {
        if (isCurrentSession(request) && selectedId.value === generationId) {
          error.value = cause instanceof Error ? cause.message : '保存产物大纲失败';
        }
        return false;
      } finally {
        if (isCurrentSession(request) && selectedId.value === generationId) saving.value = false;
      }
    }
  })().finally(() => {
    if (!isCurrentSession(request)) return;
    const latest = revisionRecords.get(generationId);
    if (latest?.pendingSave === pending) revisionRecords.set(generationId, { ...latest, pendingSave: undefined });
  });
  revisionRecords.set(generationId, { ...record, pendingSave: pending });
  return pending;
}

async function confirmRender() {
  const generation = selected.value;
  const request = currentSessionToken();
  if (!generation || !editable.value || busy.value || saving.value || sourceImageBusy.value || consentBusy.value) return;
  if (!window.confirm(`确认当前大纲并生成 ${formatLabels(selectedFormats.value)}？确认后将创建不可变版本。`)) return;
  if (!await saveDraft()) return;
  if (!isCurrentSession(request)) return;
  if (selectedId.value !== generation.id) {
    error.value = '版本已切换，请在当前版本保存后再确认生成';
    return;
  }
  syncDraftRevision();
  const revision = revisionRecords.get(generation.id);
  if (!revision || hasUnpersistedDraftChanges(revision)) {
    error.value = '大纲仍有未保存修改，请保存成功后再确认生成';
    return;
  }
  busy.value = true;
  error.value = '';
  try {
    const result = await renderResearchArtifact(generation.id);
    if (!isCurrentSession(request)) return;
    generations.value = [result.generation, ...generations.value.filter((item) => item.id !== result.generation.id)];
    selectedId.value = result.generation.id;
    refreshPolling();
  } catch (cause) {
    if (isCurrentSession(request)) error.value = cause instanceof Error ? cause.message : '启动渲染失败';
  } finally {
    if (isCurrentSession(request)) busy.value = false;
  }
}

async function refresh() {
  const id = selectedId.value;
  const request = currentSessionToken();
  if (!id) return;
  try {
    const result = await getResearchArtifactGeneration(id);
    if (!isCurrentSession(request)) return;
    replaceGeneration(result.generation);
    refreshPolling();
  } catch {
    if (isCurrentSession(request)) stopPolling();
  }
}

async function retry(outputId: string) {
  if (busy.value) return;
  const request = currentSessionToken();
  busy.value = true;
  try {
    const result = await retryResearchArtifactOutput(outputId);
    if (!isCurrentSession(request)) return;
    replaceGeneration(result.generation);
    refreshPolling();
  } catch (cause) {
    if (isCurrentSession(request)) error.value = cause instanceof Error ? cause.message : '重试产物失败';
  } finally {
    if (isCurrentSession(request)) busy.value = false;
  }
}

async function cancel() {
  const generation = selected.value;
  if (!generation || busy.value) return;
  const request = currentSessionToken();
  busy.value = true;
  error.value = '';
  try {
    const result = await cancelResearchArtifact(generation.id);
    if (!isCurrentSession(request)) return;
    replaceGeneration(result.generation);
    stopPolling();
  } catch (cause) {
    if (isCurrentSession(request)) error.value = cause instanceof Error ? cause.message : '取消产物生成失败';
  } finally {
    if (isCurrentSession(request)) busy.value = false;
  }
}

async function removeGeneration() {
  const generation = selected.value;
  if (!generation || busy.value || !window.confirm('确认物理删除此不可变产物版本及其 PPT/PDF、预览和素材？')) return;
  const request = currentSessionToken();
  busy.value = true;
  error.value = '';
  try {
    await deleteResearchArtifactGeneration(generation.id);
    if (!isCurrentSession(request)) return;
    generations.value = generations.value.filter((item) => item.id !== generation.id);
    selectedId.value = generations.value[0]?.id;
    stopPolling();
  } catch (cause) {
    if (isCurrentSession(request)) error.value = cause instanceof Error ? cause.message : '删除产物版本失败';
  } finally {
    if (isCurrentSession(request)) busy.value = false;
  }
}

function replaceGeneration(
  generation: ResearchArtifactGeneration,
  preserveLocalSpec = false,
  resetRevision = true
) {
  const index = generations.value.findIndex((item) => item.id === generation.id);
  if (preserveLocalSpec && index >= 0) generation = { ...generation, spec: generations.value[index].spec };
  if (index < 0) generations.value.unshift(generation);
  else generations.value[index] = generation;
  if (resetRevision && !preserveLocalSpec && generation.id === selectedId.value) resetRevisionBaseline(generation);
}

function cloneSpec(spec: ResearchArtifactGeneration['spec']) {
  return JSON.parse(JSON.stringify(spec)) as ResearchArtifactGeneration['spec'];
}

function resetRevisionBaseline(generation: ResearchArtifactGeneration | undefined): RevisionRecord | undefined {
  if (!generation) return undefined;
  const json = JSON.stringify(generation.spec);
  const record = createGenerationDraftRevision(generation.id, json);
  revisionRecords.set(generation.id, record);
  return record;
}

function syncDraftRevision() {
  const generation = selected.value;
  if (!generation) return;
  const json = JSON.stringify(generation.spec);
  const record = revisionRecords.get(generation.id) ?? resetRevisionBaseline(generation);
  if (!record) return;
  revisionRecords.set(generation.id, observeGenerationDraftRevision(record, json));
}

function refreshPolling() {
  const status = selected.value?.status;
  const active = status === 'rendering' || status === 'validating' || status === 'repairing';
  if (!active) {
    stopPolling();
    return;
  }
  if (pollTimer === undefined) pollTimer = window.setInterval(() => void refresh(), 1_000);
}

function stopPolling() {
  if (pollTimer !== undefined) {
    window.clearInterval(pollTimer);
    pollTimer = undefined;
  }
}

function setSlideBullets(slide: { bullets: string[] }, value: string) {
  slide.bullets = value.split(/\r?\n/).map((item) => item.trim()).filter(Boolean).slice(0, 8);
}

function parseLines(value: string, max: number) {
  return value.split(/\r?\n/).map((item) => item.trim()).filter(Boolean).slice(0, max);
}

function setPdfParagraphs(section: { paragraphs: string[] }, value: string) {
  section.paragraphs = parseLines(value, 12);
}

function setPdfBullets(section: { bullets: string[] }, value: string) {
  section.bullets = parseLines(value, 20);
}

async function confirmImageConsent() {
  const generation = selected.value;
  const imageUrl = consentUrl.value.trim();
  if (!generation || !imageUrl || consentBusy.value) return;
  const request = currentSessionToken();
  consentBusy.value = true;
  error.value = '';
  try {
    const result = await confirmResearchArtifactImageUse(generation.id, imageUrl, consentSourceId.value.trim() || undefined);
    if (!isCurrentSession(request)) return;
    consentId.value = result.consent.id;
    consentImageUrl.value = result.consent.imageUrl;
    consentUrl.value = '';
  } catch (cause) {
    if (isCurrentSession(request)) error.value = cause instanceof Error ? cause.message : '无法保存图片使用授权';
  } finally {
    if (isCurrentSession(request)) consentBusy.value = false;
  }
}

async function fetchAuthorizedSourceImage() {
  const generation = selected.value;
  const imageUrl = (consentImageUrl.value || consentUrl.value).trim();
  if (!generation || !consentId.value || !imageUrl || sourceImageBusy.value) return;
  const request = currentSessionToken();
  sourceImageBusy.value = true;
  error.value = '';
  try {
    await fetchResearchArtifactSourceImage({
      generationId: generation.id,
      imageUrl,
      consentId: consentId.value,
      ...(consentSourceId.value.trim() ? { sourceId: consentSourceId.value.trim() } : {})
    });
  } catch (cause) {
    if (isCurrentSession(request)) error.value = cause instanceof Error ? cause.message : '无法下载已授权来源图片';
  } finally {
    if (isCurrentSession(request)) sourceImageBusy.value = false;
  }
}

function syncConsentForGeneration(generation: ResearchArtifactGeneration | undefined) {
  const consent = generation?.imageConsents?.[0];
  consentId.value = consent?.id ?? '';
  consentImageUrl.value = consent?.imageUrl ?? '';
  consentSourceId.value = consent?.sourceId ?? '';
}

</script>

<template>
  <section v-if="canCreate || generations.length" class="grid w-full gap-3 rounded-2xl border border-border bg-card p-3.5 text-card-foreground shadow-xs dark:border-white/[0.06] dark:bg-card/75 dark:shadow-none" aria-label="研究产物生成">
    <header class="flex flex-wrap items-center justify-between gap-2">
      <div>
        <p class="m-0 text-sm font-bold text-[var(--agent-text)]">按需 Artifact Agent</p>
        <p class="m-0 mt-1 text-xs text-[var(--agent-text-muted)]">按用户请求只生成 PPT 或 PDF，不必两种都出</p>
      </div>
      <div v-if="canCreate" class="flex flex-wrap items-center gap-2">
        <label class="flex items-center gap-1 text-xs text-[var(--agent-text-muted)]">
          <input type="checkbox" :checked="createFormats.includes('pptx')" @change="toggleCreateFormat('pptx')" />
          PPTX
        </label>
        <label class="flex items-center gap-1 text-xs text-[var(--agent-text-muted)]">
          <input type="checkbox" :checked="createFormats.includes('pdf')" @change="toggleCreateFormat('pdf')" />
          PDF
        </label>
        <button type="button" class="rounded-md bg-[var(--agent-selected-bg)] px-3 py-1.5 text-xs font-bold text-[var(--agent-selected-text)] disabled:opacity-50" :disabled="busy" @click="createDraft">
          {{ busy ? '处理中…' : '生成大纲' }}
        </button>
      </div>
    </header>

    <p v-if="error" class="m-0 rounded-md bg-destructive/5 px-2.5 py-1.5 text-xs text-destructive" role="alert">{{ error }}</p>

    <div v-if="generations.length" class="grid min-w-0 gap-2">
        <div class="flex flex-wrap items-center gap-2">
        <label class="text-xs font-semibold text-[var(--agent-text-muted)]" for="artifact-version">版本</label>
        <select id="artifact-version" v-model="selectedId" class="min-w-0 flex-1 rounded-md border border-[var(--agent-border)] bg-[var(--agent-surface)] px-2 py-1.5 text-xs text-[var(--agent-text)]">
        <option v-for="generation in generations" :key="generation.id" :value="generation.id">v{{ generation.version }} · {{ generation.spec.title }} · {{ ({ awaiting_confirmation: '待确认', rendering: '渲染中', completed: '完成', partial: '部分完成', failed: '失败', cancelled: '取消', superseded: '已确认' } as Record<string, string>)[generation.status] ?? generation.status }}</option>
        </select>
          <span class="rounded-full bg-[var(--agent-surface)] px-2 py-1 text-[10px] font-bold text-[var(--agent-text-muted)]">{{ statusLabel }}</span>
          <button v-if="selected && ['rendering', 'validating', 'repairing'].includes(selected.status)" type="button" class="rounded border border-[var(--agent-border)] px-2 py-1 text-[10px] font-bold text-[var(--agent-text)]" :disabled="busy" @click="cancel">取消生成</button>
          <button v-if="selected" type="button" class="rounded border border-destructive/30 px-2 py-1 text-[10px] font-bold text-destructive" :disabled="busy" @click="removeGeneration">删除版本</button>
      </div>

      <div v-if="selected?.stale" class="rounded-md border border-amber-500/30 bg-amber-500/10 px-2.5 py-2 text-xs text-amber-800 dark:text-amber-200">研究会话已经变化，此草稿已失效。请重新生成大纲。</div>

      <div v-if="selected && editable" class="grid gap-2 rounded-lg border border-[var(--agent-border)] bg-[var(--agent-surface)] p-3">
        <div class="grid gap-2 md:grid-cols-3">
          <label class="grid gap-1 text-xs font-semibold text-[var(--agent-text-muted)]">标题<input v-model="selected.spec.title" class="rounded-md border border-[var(--agent-border)] bg-transparent px-2 py-1.5 text-sm text-[var(--agent-text)]" @blur="saveDraft" /></label>
          <label class="grid gap-1 text-xs font-semibold text-[var(--agent-text-muted)]">受众<input v-model="selected.spec.audience" class="rounded-md border border-[var(--agent-border)] bg-transparent px-2 py-1.5 text-sm text-[var(--agent-text)]" @blur="saveDraft" /></label>
          <label class="grid gap-1 text-xs font-semibold text-[var(--agent-text-muted)]">主题<select v-model="selected.spec.theme" class="rounded-md border border-[var(--agent-border)] bg-transparent px-2 py-1.5 text-sm text-[var(--agent-text)]" @change="saveDraft"><option value="research">研究汇报</option><option value="technical">技术方案</option><option value="business">商业汇报</option></select></label>
        </div>
        <div class="flex flex-wrap gap-3 text-xs text-[var(--agent-text-muted)]">
          <span class="font-semibold">生成格式</span>
          <label class="flex items-center gap-1">
            <input type="checkbox" :checked="includesSelectedFormat('pptx')" @change="toggleSelectedFormat('pptx')" />
            PPTX
          </label>
          <label class="flex items-center gap-1">
            <input type="checkbox" :checked="includesSelectedFormat('pdf')" @change="toggleSelectedFormat('pdf')" />
            PDF
          </label>
        </div>
        <div class="grid gap-2 md:grid-cols-2">
          <label v-if="includesSelectedFormat('pptx')" class="grid gap-1 text-xs font-semibold text-[var(--agent-text-muted)]">目标幻灯片数
            <input v-model.number="selected.spec.presentation.targetSlideCount" type="number" min="8" max="15" class="rounded-md border border-[var(--agent-border)] bg-transparent px-2 py-1.5 text-sm text-[var(--agent-text)]" @change="saveDraft" />
          </label>
          <label v-if="includesSelectedFormat('pdf')" class="grid gap-1 text-xs font-semibold text-[var(--agent-text-muted)]">目标 PDF 页数
            <input v-model.number="selected.spec.pdf.targetPageCount" type="number" min="6" max="20" class="rounded-md border border-[var(--agent-border)] bg-transparent px-2 py-1.5 text-sm text-[var(--agent-text)]" @change="saveDraft" />
          </label>
        </div>
        <div class="grid gap-2 rounded-md border border-[var(--agent-border)] p-2">
          <p class="m-0 text-xs font-bold text-[var(--agent-text)]">品牌与字体</p>
          <div class="grid gap-2 md:grid-cols-4">
            <label class="grid gap-1 text-[11px] font-semibold text-[var(--agent-text-muted)]">品牌色
              <input v-model="selected.spec.branding.primaryColor" type="text" placeholder="#2563eb" class="rounded border border-[var(--agent-border)] bg-transparent px-2 py-1 text-xs text-[var(--agent-text)]" @blur="saveDraft" />
            </label>
            <label class="grid gap-1 text-[11px] font-semibold text-[var(--agent-text-muted)]">Logo HTTPS URL
              <input v-model="selected.spec.branding.logoUrl" type="url" placeholder="https://…" class="rounded border border-[var(--agent-border)] bg-transparent px-2 py-1 text-xs text-[var(--agent-text)]" @blur="saveDraft" />
            </label>
            <label class="grid gap-1 text-[11px] font-semibold text-[var(--agent-text-muted)]">标题字体
              <input v-model="selected.spec.branding.titleFont" placeholder="Arial" class="rounded border border-[var(--agent-border)] bg-transparent px-2 py-1 text-xs text-[var(--agent-text)]" @blur="saveDraft" />
            </label>
            <label class="grid gap-1 text-[11px] font-semibold text-[var(--agent-text-muted)]">正文字体
              <input v-model="selected.spec.branding.bodyFont" placeholder="Arial" class="rounded border border-[var(--agent-border)] bg-transparent px-2 py-1 text-xs text-[var(--agent-text)]" @blur="saveDraft" />
            </label>
          </div>
        </div>
        <label class="grid gap-1 text-xs font-semibold text-[var(--agent-text-muted)]">摘要<textarea v-model="selected.spec.brief.executiveSummary" rows="3" class="rounded-md border border-[var(--agent-border)] bg-transparent px-2 py-1.5 text-sm text-[var(--agent-text)]" @blur="saveDraft" /></label>
        <div class="grid gap-2 md:grid-cols-2">
          <label class="grid gap-1 text-xs font-semibold text-[var(--agent-text-muted)]">关键发现（每行一项）
            <textarea :value="selected.spec.brief.keyFindings.join('\n')" rows="4" class="rounded-md border border-[var(--agent-border)] bg-transparent px-2 py-1.5 text-xs text-[var(--agent-text)]" @change="selected.spec.brief.keyFindings = parseLines(($event.target as HTMLTextAreaElement).value, 20); saveDraft()" />
          </label>
          <label class="grid gap-1 text-xs font-semibold text-[var(--agent-text-muted)]">建议（每行一项）
            <textarea :value="selected.spec.brief.recommendations.join('\n')" rows="4" class="rounded-md border border-[var(--agent-border)] bg-transparent px-2 py-1.5 text-xs text-[var(--agent-text)]" @change="selected.spec.brief.recommendations = parseLines(($event.target as HTMLTextAreaElement).value, 20); saveDraft()" />
          </label>
        </div>
        <details v-if="includesSelectedFormat('pptx')">
          <summary class="cursor-pointer text-xs font-semibold text-[var(--agent-text-muted)]">编辑幻灯片大纲（{{ selected.spec.presentation.slides.length }} 页）</summary>
          <div class="mt-2 grid gap-2">
            <div v-for="slide in selected.spec.presentation.slides" :key="slide.id" class="grid gap-1 rounded-md border border-[var(--agent-border)] p-2">
              <input v-model="slide.title" class="rounded border border-[var(--agent-border)] bg-transparent px-2 py-1 text-xs font-bold text-[var(--agent-text)]" @blur="saveDraft" />
              <textarea :value="slide.bullets.join('\n')" rows="3" class="rounded border border-[var(--agent-border)] bg-transparent px-2 py-1 text-xs text-[var(--agent-text)]" @change="setSlideBullets(slide, ($event.target as HTMLTextAreaElement).value); saveDraft()" />
            </div>
          </div>
        </details>
        <details v-if="includesSelectedFormat('pdf')">
          <summary class="cursor-pointer text-xs font-semibold text-[var(--agent-text-muted)]">编辑 PDF 长篇章节（{{ selected.spec.pdf.sections.length }} 节）</summary>
          <div class="mt-2 grid gap-2">
            <div v-for="section in selected.spec.pdf.sections" :key="section.id" class="grid gap-1 rounded-md border border-[var(--agent-border)] p-2">
              <input v-model="section.title" class="rounded border border-[var(--agent-border)] bg-transparent px-2 py-1 text-xs font-bold text-[var(--agent-text)]" @blur="saveDraft" />
              <label class="grid gap-1 text-[11px] text-[var(--agent-text-muted)]">段落（每行一段）
                <textarea :value="section.paragraphs.join('\n')" rows="3" class="rounded border border-[var(--agent-border)] bg-transparent px-2 py-1 text-xs text-[var(--agent-text)]" @change="setPdfParagraphs(section, ($event.target as HTMLTextAreaElement).value); saveDraft()" />
              </label>
              <label class="grid gap-1 text-[11px] text-[var(--agent-text-muted)]">要点（每行一项）
                <textarea :value="section.bullets.join('\n')" rows="3" class="rounded border border-[var(--agent-border)] bg-transparent px-2 py-1 text-xs text-[var(--agent-text)]" @change="setPdfBullets(section, ($event.target as HTMLTextAreaElement).value); saveDraft()" />
              </label>
            </div>
          </div>
        </details>
        <details>
          <summary class="cursor-pointer text-xs font-semibold text-[var(--agent-text-muted)]">来源图片使用确认</summary>
          <div class="mt-2 grid gap-2 md:grid-cols-[1fr_auto_auto]">
            <input v-model="consentUrl" type="url" placeholder="仅允许 HTTPS 图片地址" class="rounded border border-[var(--agent-border)] bg-transparent px-2 py-1.5 text-xs text-[var(--agent-text)]" />
            <input v-model="consentSourceId" placeholder="来源 ID（可选）" class="rounded border border-[var(--agent-border)] bg-transparent px-2 py-1.5 text-xs text-[var(--agent-text)]" />
            <button type="button" class="rounded border border-[var(--agent-border)] px-2 py-1 text-xs font-bold text-[var(--agent-text)]" :disabled="consentBusy || !consentUrl.trim()" @click="confirmImageConsent">{{ consentBusy ? '保存中…' : '确认使用' }}</button>
          </div>
          <div v-if="consentId" class="flex flex-wrap items-center gap-2 text-[11px] text-[var(--agent-text-muted)]">
            <span>授权已保存（{{ consentId.slice(0, 8) }}…）</span>
            <button type="button" class="rounded border border-[var(--agent-border)] px-2 py-1 font-bold text-[var(--agent-text)]" :disabled="sourceImageBusy" @click="fetchAuthorizedSourceImage">{{ sourceImageBusy ? '下载中…' : '下载并使用来源图片' }}</button>
          </div>
        </details>
        <div class="flex justify-end gap-2">
          <button type="button" class="rounded-md border border-[var(--agent-border)] px-3 py-1.5 text-xs font-bold text-[var(--agent-text)]" :disabled="saving || busy" @click="saveDraft">{{ saving ? '保存中…' : '保存大纲' }}</button>
          <button type="button" class="rounded-md bg-[var(--agent-selected-bg)] px-3 py-1.5 text-xs font-bold text-[var(--agent-selected-text)]" :disabled="saving || busy || sourceImageBusy || consentBusy" @click="confirmRender">{{ confirmLabel }}</button>
        </div>
      </div>

      <div v-if="selected" class="grid gap-2">
        <div v-for="output in selected.outputs" :key="output.id" class="grid gap-2">
          <div class="flex flex-wrap items-center gap-2 rounded-md border border-[var(--agent-border)] bg-[var(--agent-surface)] px-2.5 py-2 text-xs">
            <span class="font-bold uppercase text-[var(--agent-text)]">{{ output.format }}</span>
            <span class="text-[var(--agent-text-muted)]">{{ outputStatusText(output) }}</span>
            <span v-if="output.provenance?.length" class="text-[10px] text-[var(--agent-text-muted)]">{{ output.provenance.map((item) => item.kind === 'authorized_source_asset' ? '授权来源图' : '内置形状').join(' / ') }}</span>
            <span v-if="output.renderedSpec" class="text-[10px] text-[var(--agent-text-muted)]">有效 {{ output.format === 'pptx' ? output.renderedSpec.presentation.targetSlideCount + ' 页' : output.renderedSpec.pdf.targetPageCount + ' 页' }}</span>
            <a v-if="output.downloadUrl" :href="output.downloadUrl" class="ml-auto font-bold text-[var(--agent-selected-text)] no-underline">下载</a>
            <a v-if="output.format === 'pdf' && output.previewUrl" :href="output.previewUrl" target="_blank" rel="noreferrer" class="font-bold text-[var(--agent-selected-text)] no-underline">预览 PDF</a>
            <button v-if="output.status === 'failed' || output.status === 'cancelled'" type="button" class="rounded border border-[var(--agent-border)] px-2 py-1 font-bold text-[var(--agent-text)]" :disabled="busy" @click="retry(output.id)">重试</button>
          </div>
          <p v-if="output.diagnostics?.length" class="m-0 rounded-md border border-amber-500/30 bg-amber-500/10 px-2.5 py-2 text-[11px] leading-5 text-amber-800 dark:text-amber-200">{{ output.diagnostics.join(' · ') }}</p>
          <details v-if="output.renderedSpec" class="rounded-md border border-[var(--agent-border)] bg-[var(--agent-surface)] px-2.5 py-2 text-[11px] text-[var(--agent-text-muted)]">
            <summary class="cursor-pointer font-semibold">查看本次有效 rendered spec{{ output.renderedSpecDigest ? `（${output.renderedSpecDigest.slice(0, 12)}…）` : '' }}</summary>
            <pre class="mt-2 max-h-64 overflow-auto whitespace-pre-wrap break-words text-[10px]">{{ JSON.stringify(output.renderedSpec, null, 2) }}</pre>
          </details>
          <iframe v-if="output.format === 'pdf' && output.status === 'completed' && output.previewUrl" :src="output.previewUrl" title="PDF 预览" class="h-[min(70vh,720px)] w-full rounded-md border border-[var(--agent-border)] bg-white" />
          <img v-if="output.format === 'pptx' && output.status === 'completed' && output.previewUrl" :src="output.previewUrl" alt="PPTX 全页联系预览" class="max-h-[28rem] w-full rounded-md border border-[var(--agent-border)] bg-white object-contain" />
        </div>
      </div>
    </div>
  </section>
</template>
