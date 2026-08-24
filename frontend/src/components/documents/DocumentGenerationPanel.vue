<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue';
import {
  cancelResearchArtifact,
  confirmResearchArtifactImageUse,
  createResearchArtifactDraft,
  deleteResearchArtifactGeneration,
  fetchResearchArtifactSourceImage,
  getResearchArtifactGeneration,
  listResearchArtifactGenerations,
  renderResearchArtifact,
  retryResearchArtifactOutput,
  updateResearchArtifactDraft,
  type ArtifactDraftPreferences
} from '../../api/artifacts';
import type { ArtifactOutput, ArtifactSpec, ResearchArtifactGeneration } from '../../types/artifacts';
import type { ResearchMessage } from '../../types/research';
import { inferArtifactFormats } from '../../lib/artifactFormats';
import { useDocumentEditor } from './documentEditor';
import {
  createArtifactSessionToken,
  shouldApplyArtifactSessionResponse,
  type ArtifactSessionToken
} from '../artifacts/sessionEpoch';
import DocumentStatusCard from './DocumentStatusCard.vue';
import DocumentConfirmDialog from './DocumentConfirmDialog.vue';
import DocumentPreviewDialog from './DocumentPreviewDialog.vue';
import DocumentWorkbench from './DocumentWorkbench.vue';

const props = defineProps<{
  conversationId?: string;
  messages: ResearchMessage[];
  enabled: boolean;
}>();

const generations = ref<ResearchArtifactGeneration[]>([]);
const selectedId = ref<string>();
const showWorkbench = ref(false);
const showGenerateConfirm = ref(false);
const error = ref('');
const consentBusy = ref(false);
const sourceImageBusy = ref(false);
const previewOutput = ref<ArtifactOutput>();
let sessionEpoch = 0;
let pollTimer: ReturnType<typeof window.setInterval> | undefined;

const editor = useDocumentEditor(
  () => props.conversationId,
  () => props.enabled,
  () => sessionEpoch
);

const selected = computed(() => generations.value.find(g => g.id === selectedId.value));
const canCreate = computed(() => props.enabled && Boolean(props.conversationId) && props.messages.some(m => m.status === 'complete'));

function currentSessionToken(): ArtifactSessionToken {
  return createArtifactSessionToken(props.conversationId, sessionEpoch);
}

function isCurrentSession(token: ArtifactSessionToken) {
  return shouldApplyArtifactSessionResponse(token, currentSessionToken(), props.enabled);
}

watch(() => [props.conversationId, props.enabled] as const, () => {
  const conversationId = props.conversationId;
  const epoch = ++sessionEpoch;
  stopPolling();
  generations.value = [];
  selectedId.value = undefined;
  editor.clearRevisions();
  error.value = '';
  consentBusy.value = false;
  sourceImageBusy.value = false;
  if (conversationId && props.enabled) void load(conversationId, epoch);
}, { immediate: true });

watch(selected, (gen) => {
  if (gen) {
    editor.resetRevisionBaseline(gen);
    editor.syncDraftRevision(gen);
  }
}, { deep: true });

onBeforeUnmount(stopPolling);

async function load(conversationId: string, epoch: number) {
  const request = createArtifactSessionToken(conversationId, epoch);
  try {
    const result = await listResearchArtifactGenerations(conversationId);
    if (!isCurrentSession(request)) return;
    generations.value = result.generations;
    selectedId.value = result.generations.find(g => g.status === 'awaiting_confirmation')?.id
      ?? result.generations[0]?.id;
    if (selected.value) editor.resetRevisionBaseline(selected.value);
    refreshPolling();
  } catch {
    // Generation panel is optional, should not block research chat
  }
}

async function createDraft() {
  const conversationId = props.conversationId;
  const request = currentSessionToken();
  if (!conversationId || editor.busy.value) return;

  const latestUserText = [...props.messages].reverse().find(m => m.role === 'user' && m.status === 'complete')?.content ?? '';
  const formats = inferArtifactFormats(latestUserText);
  if (!formats?.length) {
    error.value = '请在对话中说明需要生成 PPTX、PDF 或 DOCX';
    return;
  }

  editor.setBusy(true);
  error.value = '';
  try {
    const preferences: ArtifactDraftPreferences = { formats };
    const result = await createResearchArtifactDraft(conversationId, preferences);
    if (!isCurrentSession(request)) return;
    generations.value = [result.generation, ...generations.value];
    selectedId.value = result.generation.id;
    editor.resetRevisionBaseline(result.generation);
  } catch (cause) {
    if (isCurrentSession(request)) error.value = cause instanceof Error ? cause.message : '创建文稿草稿失败';
  } finally {
    if (isCurrentSession(request)) editor.setBusy(false);
  }
}

async function saveDraft(): Promise<boolean> {
  const generation = selected.value;
  if (!generation || generation.status !== 'awaiting_confirmation' || generation.stale) return false;
  if (!props.enabled || !props.conversationId) return false;

  const request = currentSessionToken();
  const generationId = generation.id;
  const record = editor.revisionRecords.get(generationId);
  if (!record) return false;

  if (record.pendingSave) return await record.pendingSave;

  const pending = (async () => {
    while (true) {
      if (!isCurrentSession(request)) return false;
      const current = generations.value.find(g => g.id === generationId);
      const currentRecord = editor.revisionRecords.get(generationId);
      if (!current || !currentRecord || current.status !== 'awaiting_confirmation' || current.stale) return false;

      const targetRevision = currentRecord.draftRevision;
      const targetSpec = JSON.parse(JSON.stringify(current.spec)) as ArtifactSpec;

      if (selectedId.value === generationId) editor.setSaveState('saving');
      error.value = '';

      try {
        const result = await updateResearchArtifactDraft(generationId, targetSpec);
        if (!isCurrentSession(request)) return false;

        const latest = generations.value.find(g => g.id === generationId);
        const latestRecord = editor.revisionRecords.get(generationId);
        const changedDuringSave = Boolean(latestRecord && latestRecord.draftRevision !== targetRevision);
        const localSpec = latest?.spec ?? current.spec;

        replaceGeneration(
          changedDuringSave ? { ...result.generation, spec: localSpec } : result.generation,
          changedDuringSave,
          false
        );

        if (latestRecord) {
          const updated = editor.revisionRecords.get(generationId);
          if (updated) {
            editor.revisionRecords.set(generationId, {
              ...updated,
              persistedRevision: targetRevision,
              persistedSpecJson: JSON.stringify(targetSpec)
            });
          }
        }

        if (!changedDuringSave) {
          if (isCurrentSession(request) && selectedId.value === generationId) {
            editor.setSaveState('saved');
          }
          return true;
        }
      } catch (cause) {
        if (isCurrentSession(request)) {
          if (selectedId.value === generationId) {
            error.value = cause instanceof Error ? cause.message : '保存文稿失败';
            editor.setSaveState('error');
          }
        }
        return false;
      }
    }
  })().finally(() => {
    if (!isCurrentSession(request)) return;
    const latest = editor.revisionRecords.get(generationId);
    if (latest?.pendingSave === pending) {
      editor.revisionRecords.set(generationId, { ...latest, pendingSave: undefined });
    }
  });

  const record2 = editor.revisionRecords.get(generationId);
  if (record2) {
    editor.revisionRecords.set(generationId, { ...record2, pendingSave: pending });
  }
  return pending;
}

function updateSpec(spec: ArtifactSpec) {
  if (!selected.value || selected.value.status !== 'awaiting_confirmation' || selected.value.stale) return;
  const index = generations.value.findIndex(g => g.id === selected.value!.id);
  if (index >= 0) {
    generations.value[index] = { ...generations.value[index], spec };
    editor.syncDraftRevision(generations.value[index]);
    editor.scheduleSave(() => saveDraft());
  }
}

async function confirmRender() {
  const generation = selected.value;
  const request = currentSessionToken();
  if (!generation || generation.status !== 'awaiting_confirmation' || generation.stale || editor.busy.value || editor.saveState.value === 'saving') return;

  const saved = await editor.flushSave(() => saveDraft());
  if (!saved) {
    error.value = '保存失败，请稍后重试';
    return;
  }

  if (!isCurrentSession(request)) return;
  if (selectedId.value !== generation.id) {
    error.value = '版本已切换';
    return;
  }

  editor.setBusy(true);
  error.value = '';
  try {
    const result = await renderResearchArtifact(generation.id);
    if (!isCurrentSession(request)) return;
    generations.value = [result.generation, ...generations.value.filter(g => g.id !== result.generation.id)];
    selectedId.value = result.generation.id;
    showGenerateConfirm.value = false;
    refreshPolling();
  } catch (cause) {
    if (isCurrentSession(request)) error.value = cause instanceof Error ? cause.message : '启动渲染失败';
  } finally {
    if (isCurrentSession(request)) editor.setBusy(false);
  }
}

function requestRender() {
  const generation = selected.value;
  if (!generation || generation.status !== 'awaiting_confirmation' || generation.stale) return;
  showGenerateConfirm.value = true;
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

async function retryOutput(outputId: string) {
  if (editor.busy.value) return;
  const request = currentSessionToken();
  editor.setBusy(true);
  try {
    const result = await retryResearchArtifactOutput(outputId);
    if (!isCurrentSession(request)) return;
    replaceGeneration(result.generation);
    refreshPolling();
  } catch (cause) {
    if (isCurrentSession(request)) error.value = cause instanceof Error ? cause.message : '重试失败';
  } finally {
    if (isCurrentSession(request)) editor.setBusy(false);
  }
}

async function cancelGeneration() {
  const generation = selected.value;
  if (!generation || editor.busy.value) return;
  const request = currentSessionToken();
  editor.setBusy(true);
  error.value = '';
  try {
    const result = await cancelResearchArtifact(generation.id);
    if (!isCurrentSession(request)) return;
    replaceGeneration(result.generation);
    stopPolling();
  } catch (cause) {
    if (isCurrentSession(request)) error.value = cause instanceof Error ? cause.message : '取消失败';
  } finally {
    if (isCurrentSession(request)) editor.setBusy(false);
  }
}

async function deleteGeneration(id: string) {
  if (editor.busy.value) return;
  const request = currentSessionToken();
  editor.setBusy(true);
  error.value = '';
  try {
    await deleteResearchArtifactGeneration(id);
    if (!isCurrentSession(request)) return;
    generations.value = generations.value.filter(g => g.id !== id);
    if (selectedId.value === id) {
      selectedId.value = generations.value[0]?.id;
    }
    stopPolling();
  } catch (cause) {
    if (isCurrentSession(request)) error.value = cause instanceof Error ? cause.message : '删除失败';
  } finally {
    if (isCurrentSession(request)) editor.setBusy(false);
  }
}

function replaceGeneration(
  generation: ResearchArtifactGeneration,
  preserveLocalSpec = false,
  resetRevision = true
) {
  const index = generations.value.findIndex(g => g.id === generation.id);
  if (preserveLocalSpec && index >= 0) {
    generation = { ...generation, spec: generations.value[index].spec };
  }
  if (index < 0) {
    generations.value.unshift(generation);
  } else {
    generations.value[index] = generation;
  }
  if (resetRevision && !preserveLocalSpec && generation.id === selectedId.value) {
    editor.resetRevisionBaseline(generation);
  }
}

function refreshPolling() {
  const status = selected.value?.status;
  const active = status === 'rendering' || status === 'validating' || status === 'repairing';
  if (!active) {
    stopPolling();
    return;
  }
  if (pollTimer === undefined) {
    pollTimer = window.setInterval(() => void refresh(), 1_000);
  }
}

function stopPolling() {
  if (pollTimer !== undefined) {
    window.clearInterval(pollTimer);
    pollTimer = undefined;
  }
}

async function confirmImageConsent(imageUrl: string, sourceId?: string) {
  const generation = selected.value;
  if (!generation || consentBusy.value) return;
  const request = currentSessionToken();
  consentBusy.value = true;
  error.value = '';
  try {
    await confirmResearchArtifactImageUse(generation.id, imageUrl, sourceId);
    if (!isCurrentSession(request)) return;
    await refresh();
  } catch (cause) {
    if (isCurrentSession(request)) error.value = cause instanceof Error ? cause.message : '图片授权失败';
  } finally {
    if (isCurrentSession(request)) consentBusy.value = false;
  }
}

async function fetchSourceImage() {
  const generation = selected.value;
  const consent = generation?.imageConsents?.[0];
  if (!generation || !consent || sourceImageBusy.value) return;
  const request = currentSessionToken();
  sourceImageBusy.value = true;
  error.value = '';
  try {
    await fetchResearchArtifactSourceImage({
      generationId: generation.id,
      imageUrl: consent.imageUrl,
      consentId: consent.id,
      ...(consent.sourceId ? { sourceId: consent.sourceId } : {})
    });
  } catch (cause) {
    if (isCurrentSession(request)) error.value = cause instanceof Error ? cause.message : '下载图片失败';
  } finally {
    if (isCurrentSession(request)) sourceImageBusy.value = false;
  }
}
</script>

<template>
  <div v-if="canCreate || generations.length" class="space-y-3">
    <button
      v-if="canCreate && !generations.length"
      type="button"
      class="w-full rounded-xl border border-[var(--agent-border)] bg-[var(--agent-surface)] px-4 py-3 text-left transition-colors hover:bg-[var(--agent-surface-muted)]"
      :disabled="editor.busy.value"
      @click="createDraft"
    >
      <p class="m-0 text-sm font-semibold text-[var(--agent-text)]">
        {{ editor.busy.value ? '创建中…' : '创建文稿草稿' }}
      </p>
      <p class="m-0 mt-1 text-xs text-[var(--agent-text-muted)]">
        根据对话生成 PPTX、PDF 或 DOCX 文稿
      </p>
    </button>

    <p v-if="error" class="m-0 rounded-md bg-destructive/5 px-3 py-2 text-xs text-destructive" role="alert">
      {{ error }}
    </p>

    <DocumentStatusCard
      v-if="selected"
      :generation="selected"
      :busy="editor.busy.value"
      @open-workbench="showWorkbench = true"
      @preview="previewOutput = $event"
      @generate="requestRender"
      @cancel="cancelGeneration"
      @retry="retryOutput"
    />

    <DocumentWorkbench
      v-if="selected && showWorkbench"
      :generation="selected"
      :generations="generations"
      :save-state="editor.saveState.value"
      :busy="editor.busy.value"
      @close="showWorkbench = false"
      @update-spec="updateSpec"
      @generate="requestRender"
      @cancel="cancelGeneration"
      @retry-output="retryOutput"
      @preview-output="previewOutput = $event"
      @select-generation="selectedId = $event"
      @delete-generation="deleteGeneration"
      @confirm-consent="confirmImageConsent"
      @fetch-source-image="fetchSourceImage"
    />

    <DocumentPreviewDialog :output="previewOutput" @close="previewOutput = undefined" />

    <DocumentConfirmDialog
      :open="showGenerateConfirm"
      title="确认生成文档"
      description="系统会先保存当前草稿，再创建不可变版本并开始渲染。"
      :detail="selected ? `输出格式：${selected.spec.formats.map((format) => format.toUpperCase()).join('、')}` : undefined"
      confirm-label="确认生成"
      :busy="editor.busy.value"
      @update:open="showGenerateConfirm = $event"
      @confirm="confirmRender"
    />
  </div>
</template>
