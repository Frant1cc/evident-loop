<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';
import { PhTrash } from '@phosphor-icons/vue';

import {
  cancelResearchRun,
  createResearchConversation,
  createResearchNote,
  deleteResearchConversation,
  deleteResearchNote,
  getResearchConversation,
  listResearchConversations,
  listResearchSkills,
  listResearchTools,
  startResearchMessage,
  streamResearchRun,
  type ResearchSkillInfo,
  type ResearchStreamEvent,
  type ResearchToolGroupInfo,
  type ResearchToolInfo
} from '../api/research';
import {
  cancelResearchArtifact,
  confirmResearchArtifactImageUse,
  deleteResearchArtifactGeneration,
  fetchResearchArtifactSourceImage,
  getResearchArtifactGeneration,
  listResearchArtifactGenerations,
  renderResearchArtifact,
  retryResearchArtifactOutput,
  updateResearchArtifactDraft
} from '../api/artifacts';
import { ApprovalApiError, decideToolApproval } from '../api/approvals';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import PanelResizeHandle from '../components/common/PanelResizeHandle.vue';
import WorkspaceSidebarLayout from '../components/layout/WorkspaceSidebarLayout.vue';
import { useResizablePanel, type PanelWidthBounds } from '../composables/useResizablePanel';
import { useCollapsiblePanel } from '../composables/useResizablePanel';
import ResearchConversationSidebar from '../components/research/ResearchConversationSidebar.vue';
import ResearchMainPanel from '../components/research/ResearchMainPanel.vue';
import ResearchInspector from '../components/research/ResearchInspector.vue';
import DocumentConfirmDialog from '../components/documents/DocumentConfirmDialog.vue';
import DocumentPreviewDialog from '../components/documents/DocumentPreviewDialog.vue';
import DocumentWorkbench from '../components/documents/DocumentWorkbench.vue';
import { useStreamingMessageRenderer } from '../composables/useStreamingMessageRenderer';
import { useDocumentEditor } from '../components/documents/documentEditor';
import type { ArtifactOutput, ArtifactSpec, LongformBlock, ResearchArtifactGeneration } from '../types/artifacts';
import type {
  ResearchConversation,
  ResearchConversationDetail,
  ResearchMessage,
  ResearchNote,
  ResearchPromptPreview,
  ResearchRun,
  ResearchSource,
  ResearchStep
} from '../types/research';
import type { StreamConnectionState } from '../types/streaming';
import { buildAuxiliaryState, type AuxiliaryState } from '../lib/auxiliaryState';
import { buildSelectedToolPolicy, requiredGroupIds, standaloneTools } from '../tools/selection';
import type { ToolApproval, ToolApprovalDecision } from '../types/approvals';
import type { ToolPolicy } from '../types/tasks';
import { upsertToolApproval } from '../types/approvals';

defineOptions({ name: 'ResearchWorkbench' });

const conversations = ref<ResearchConversation[]>([]);
const activeConversationId = ref<string>();
const messages = ref<ResearchMessage[]>([]);
const messageRenderer = useStreamingMessageRenderer(messages);
const steps = ref<ResearchStep[]>([]);
const sources = ref<ResearchSource[]>([]);
const notes = ref<ResearchNote[]>([]);
const promptPreview = ref<ResearchPromptPreview>({ historyMessageCount: 0, currentMessage: '' });
const input = ref('');
const loading = ref(false);
const stopping = ref(false);
const activeRun = ref<ResearchRun>();
const error = ref('');
const collapsed = useCollapsiblePanel('research:sidebar-collapsed');
const inspectorCollapsed = useCollapsiblePanel('research:inspector-collapsed', true);
const selectedSourceId = ref<string>();
const selectedStep = ref<ResearchStep>();
const activeRailTab = ref<'timeline' | 'sources' | 'details'>('timeline');
const activeDetailsTab = ref<'notes' | 'memory' | 'tool' | 'prompt'>('notes');
const deleteTarget = ref<ResearchConversation>();
const deleteArtifactCount = ref<number>();
const deleting = ref(false);
const availableTools = ref<ResearchToolInfo[]>([]);
const availableToolGroups = ref<ResearchToolGroupInfo[]>([]);
const enabledToolGroups = ref<Record<string, boolean>>({});
const enabledStandaloneTools = ref<Record<string, boolean>>({});
const availableSkills = ref<ResearchSkillInfo[]>([]);
const selectedSkillId = ref<string>();
const activeWorkbenchGeneration = ref<ResearchArtifactGeneration>();
const generationConfirmTarget = ref<ResearchArtifactGeneration>();
const previewOutput = ref<ArtifactOutput>();
const generations = ref<ResearchArtifactGeneration[]>([]);
const workbenchBusy = ref(false);
const documentSessionEpoch = ref(0);
const documentEditor = useDocumentEditor(
  () => activeConversationId.value,
  () => Boolean(activeConversationId.value),
  () => documentSessionEpoch.value
);
const approvals = ref<ToolApproval[]>([]);
const approvalBusyId = ref<string>();
let requestController: AbortController | undefined;
let subscriptionSequence = 0;
let artifactPollTimer: number | undefined;

// §5.5: low-noise connection status. Reconnects under 1s stay silent; a longer
// recovery shows a hint, and a successful recovery briefly shows "已恢复".
const connectionState = ref<StreamConnectionState>('open');
const reconnectingSince = ref<number>();
const recovered = ref(false);
const showReconnecting = ref(false);
let reconnectHintTimer: number | undefined;
let recoveredTimer: number | undefined;

const connectionHint = computed(() => {
  if (connectionState.value === 'failed') return '连接中断，可重新连接';
  if (showReconnecting.value) return '正在恢复连接…';
  if (recovered.value) return '已恢复';
  return '';
});

const sidebarBounds: PanelWidthBounds = { defaultWidth: 248, min: 60, max: 420 };
const inspectorBounds: PanelWidthBounds = { defaultWidth: 360, min: 280, max: 640 };
const sidebarWidth = useResizablePanel('research:sidebar-width', sidebarBounds);
const inspectorWidth = useResizablePanel('research:inspector-width', inspectorBounds);
const inspectorTrack = computed(() => (inspectorCollapsed.value ? '52px' : `${inspectorWidth.value}px`));

const sidebarCompact = computed(() => collapsed.value || sidebarWidth.value < 128);

const activeConversation = computed(() => conversations.value.find((item) => item.id === activeConversationId.value));

const standaloneToolList = computed(() => standaloneTools(availableTools.value, availableToolGroups.value));

const generationsByMessageId = computed(() => {
  const map = new Map<string, ResearchArtifactGeneration[]>();
  const assigned = new Set<string>();
  let documentHostMessageId: string | undefined;

  for (const step of [...steps.value].reverse()) {
    if (step.type !== 'tool' || step.title !== 'start_document_generation' || step.status !== 'complete') {
      continue;
    }
    if (!documentHostMessageId && messages.value.some((message) => message.id === step.messageId)) {
      documentHostMessageId = step.messageId;
    }
    const toolOutput = step.output;
    if (typeof toolOutput !== 'object' || !toolOutput || !('generationId' in toolOutput)) continue;

    const generation = generations.value.find(g => g.id === toolOutput.generationId);
    if (!generation) continue;

    const messageGenerations = map.get(step.messageId) ?? [];
    if (!messageGenerations.some((item) => item.id === generation.id)) {
      messageGenerations.push(generation);
      map.set(step.messageId, messageGenerations);
      assigned.add(generation.id);
    }
  }

  const latestGeneration = generations.value.find((generation) => !assigned.has(generation.id));
  const fallbackMessageId = documentHostMessageId
    ?? [...messages.value].reverse().find((message) => message.role === 'assistant')?.id;
  if (latestGeneration && fallbackMessageId) map.set(fallbackMessageId, [latestGeneration]);

  return map;
});

const auxiliaryStateByMessageId = computed(() =>
  buildAuxiliaryState(steps.value, generationsByMessageId.value)
);

onMounted(async () => {
  await Promise.all([loadConversations(), loadTools(), loadSkills()]);
  if (conversations.value[0]) await selectConversation(conversations.value[0].id);
  else await createConversation();
});

async function loadTools() {
  try {
    const { tools, groups } = await listResearchTools();
    availableTools.value = tools;
    availableToolGroups.value = groups;
    // Every conversation starts with all tools OFF so the first turn is a quick chat (§4.1, §7).
    enabledToolGroups.value = Object.fromEntries(groups.map((group) => [group.id, false]));
    enabledStandaloneTools.value = Object.fromEntries(standaloneTools(tools, groups).map((tool) => [tool.name, false]));
  } catch {
    // Tool toggles are an enhancement; a failed load leaves the workbench in quick-chat mode.
  }
}

async function loadSkills() {
  try {
    const { skills } = await listResearchSkills();
    availableSkills.value = skills;
  } catch {
    // Skills are optional; a failed load leaves the next turn without a selected skill.
    availableSkills.value = [];
    selectedSkillId.value = undefined;
  }
}

const selectedSkill = computed(() => availableSkills.value.find((skill) => skill.id === selectedSkillId.value));
const lockedToolGroupIds = computed(() => requiredGroupIds(
  availableToolGroups.value,
  selectedSkill.value?.requiredTools ?? []
));

function selectSkill(id: string | undefined) {
  if (loading.value) return;
  selectedSkillId.value = id;
  // Selecting a skill auto-enables its required tools; the toggle count updates visibly (§4.4, §12.3).
  const skill = availableSkills.value.find((item) => item.id === id);
  for (const name of skill?.requiredTools ?? []) {
    const group = availableToolGroups.value.find((item) => item.toolNames.includes(name));
    if (group) enabledToolGroups.value[group.id] = true;
    else if (name in enabledStandaloneTools.value) enabledStandaloneTools.value[name] = true;
  }
}

function toggleToolGroup(id: string) {
  if (lockedToolGroupIds.value.has(id)) return;
  enabledToolGroups.value[id] = !enabledToolGroups.value[id];
}

function toggleStandaloneTool(name: string) {
  if (selectedSkill.value?.requiredTools.includes(name)) return;
  enabledStandaloneTools.value[name] = !enabledStandaloneTools.value[name];
}

onBeforeUnmount(() => {
  disconnectResearchStream();
  stopArtifactPolling();
  documentEditor.clearRevisions();
});

async function loadConversations() {
  const data = await listResearchConversations();
  conversations.value = data.conversations;
}

async function createConversation() {
  disconnectResearchStream();
  const { conversation } = await createResearchConversation();
  conversations.value = [conversation, ...conversations.value];
  await selectConversation(conversation.id);
}

// §4.1/§7: each conversation opens with no skill and all tools off. Skill/tools belong to the
// Run, not the conversation, so there is no carry-over between conversations.
function resetTurnDefaults() {
  selectedSkillId.value = undefined;
  for (const id of Object.keys(enabledToolGroups.value)) enabledToolGroups.value[id] = false;
  for (const name of Object.keys(enabledStandaloneTools.value)) enabledStandaloneTools.value[name] = false;
}

async function selectConversation(id: string) {
  if (id === activeConversationId.value) return;
  if (!await closeWorkbench()) return;
  disconnectResearchStream();
  stopArtifactPolling();
  documentSessionEpoch.value += 1;
  documentEditor.clearRevisions();
  loading.value = false;
  stopping.value = false;
  activeRun.value = undefined;
  resetTurnDefaults();
  const detail = await getResearchConversation(id);
  activeConversationId.value = id;
  applyConversationDetail(detail);
  await loadGenerations(id);
  selectedSourceId.value = undefined;
  selectedStep.value = undefined;
  activeRailTab.value = 'timeline';
  activeDetailsTab.value = 'notes';
  error.value = '';
  if (detail.activeRun) connectToRun(detail.activeRun);
}

async function send() {
  const content = input.value.trim();
  const conversationId = activeConversationId.value;
  if (!content || !conversationId || loading.value) return;

  input.value = '';
  error.value = '';
  loading.value = true;
  activeRailTab.value = 'timeline';

  try {
    const toolPolicy = withExplicitArtifactTool(
      content,
      buildSelectedToolPolicy(
        availableToolGroups.value,
        enabledToolGroups.value,
        enabledStandaloneTools.value
      )
    );
    const started = await startResearchMessage(conversationId, content, toolPolicy, selectedSkillId.value);
    messageRenderer.upsert(started.userMessage);
    messageRenderer.upsert(started.assistantMessage);
    promptPreview.value = started.promptPreview;
    connectToRun(started.run);
    await loadConversations();
  } catch (err) {
    error.value = err instanceof Error ? err.message : '请求失败';
    await reloadActiveConversation();
    if (!activeRun.value) loading.value = false;
  }
}

function connectToRun(run: ResearchRun) {
  disconnectResearchStream();
  applyRun(run);
  if (!loading.value) return;

  const controller = new AbortController();
  const sequence = ++subscriptionSequence;
  requestController = controller;
  resetConnectionHint();
  void streamResearchRun(run.id, handleStreamEvent, controller.signal, (state) => {
    if (sequence === subscriptionSequence) handleConnectionStatus(state);
  })
    .catch(async (err) => {
      if ((err as Error).name === 'AbortError' || sequence !== subscriptionSequence) return;
      error.value = err instanceof Error ? `${err.message}，任务仍在后台运行。` : '生成进度连接已断开，任务仍在后台运行。';
      await reloadActiveConversation();
    })
    .finally(() => {
      if (sequence !== subscriptionSequence) return;
      requestController = undefined;
      if (!activeRun.value || isTerminal(activeRun.value)) loading.value = false;
    });
}

function handleConnectionStatus(state: StreamConnectionState) {
  connectionState.value = state;

  if (state === 'reconnecting') {
    if (reconnectingSince.value === undefined) reconnectingSince.value = Date.now();
    recovered.value = false;
    if (reconnectHintTimer === undefined) {
      // Only surface a hint if the outage lasts longer than 1s (§5.5).
      reconnectHintTimer = window.setTimeout(() => {
        if (connectionState.value === 'reconnecting' || connectionState.value === 'connecting') {
          showReconnecting.value = true;
        }
      }, 1_000);
    }
    return;
  }

  if (state === 'open' || state === 'completed') {
    const wasRecovering = reconnectingSince.value !== undefined || showReconnecting.value;
    clearReconnectHintTimer();
    reconnectingSince.value = undefined;
    if (wasRecovering && showReconnecting.value) {
      showReconnecting.value = false;
      recovered.value = true;
      if (recoveredTimer !== undefined) window.clearTimeout(recoveredTimer);
      recoveredTimer = window.setTimeout(() => (recovered.value = false), 1_500);
    } else {
      showReconnecting.value = false;
    }
  }
}

function resetConnectionHint() {
  connectionState.value = 'connecting';
  reconnectingSince.value = undefined;
  showReconnecting.value = false;
  recovered.value = false;
  clearReconnectHintTimer();
  if (recoveredTimer !== undefined) {
    window.clearTimeout(recoveredTimer);
    recoveredTimer = undefined;
  }
}

function clearReconnectHintTimer() {
  if (reconnectHintTimer !== undefined) {
    window.clearTimeout(reconnectHintTimer);
    reconnectHintTimer = undefined;
  }
}

function disconnectResearchStream() {
  subscriptionSequence += 1;
  requestController?.abort();
  requestController = undefined;
  messageRenderer.flush();
  resetConnectionHint();
  connectionState.value = 'open';
}

function handleStreamEvent(event: ResearchStreamEvent) {
  if (event.type === 'snapshot') {
    applyConversationDetail(event.detail);
    applyRun(event.run);
  }
  if (event.type === 'research_step' || event.type === 'tool_call_started' || event.type === 'tool_call_completed') upsert(steps, event.step);
  if (event.type === 'research_source_found') upsert(sources, event.source);
  if (event.type === 'assistant_delta') messageRenderer.append(event.messageId, event.content);
  if (event.type === 'research_message_completed') {
    messageRenderer.upsert(event.message);
    event.sources.forEach((source) => upsert(sources, source));
    promptPreview.value = event.promptPreview;
    applyRun(event.run);
  }
  if (event.type === 'run_updated' || event.type === 'done') applyRun(event.run);
  if (event.type === 'tool_approval_requested' || event.type === 'tool_approval_resolved') {
    approvals.value = upsertToolApproval(approvals.value, event.approval);
  }
  if (event.type === 'tool_call_completed' && event.step.title === 'start_document_generation' && activeConversationId.value) {
    void loadGenerations(activeConversationId.value);
  }
  if (event.type === 'done') {
    void loadConversations();
    if (activeConversationId.value) void loadGenerations(activeConversationId.value);
  }
  if (event.type === 'error') {
    if (event.assistantMessage) messageRenderer.upsert(event.assistantMessage);
    applyRun(event.run);
    error.value = event.run.status === 'cancelled' ? '' : event.message;
    void loadConversations();
  }
}

async function stopResearch() {
  const run = activeRun.value;
  if (!run || stopping.value || isTerminal(run)) return;
  stopping.value = true;
  error.value = '';
  try {
    const result = await cancelResearchRun(run.id);
    applyRun(result.run);
    await reloadActiveConversation();
  } catch (err) {
    error.value = err instanceof Error ? err.message : '停止生成失败';
  } finally {
    stopping.value = false;
  }
}

async function reloadActiveConversation() {
  if (!activeConversationId.value) return;

  try {
    const detail = await getResearchConversation(activeConversationId.value);
    applyConversationDetail(detail);
    if (detail.activeRun) applyRun(detail.activeRun);
    else {
      activeRun.value = undefined;
      loading.value = false;
    }
  } catch {
    // Preserve already-rendered stream state when recovery cannot load the conversation.
  }
}

async function decideApproval(approval: ToolApproval, decision: ToolApprovalDecision) {
  if (approvalBusyId.value || approval.status !== 'pending') return;
  approvalBusyId.value = approval.id;
  error.value = '';
  try {
    const result = await decideToolApproval(approval.id, decision);
    approvals.value = upsertToolApproval(approvals.value, result.approval);
  } catch (err) {
    if (err instanceof ApprovalApiError && err.status === 409) {
      // Another tab/operator may have decided it. The server snapshot is authoritative.
      await reloadActiveConversation();
      error.value = '审批状态已变化，已重新同步。';
    } else {
      error.value = err instanceof Error ? err.message : '审批操作失败';
    }
  } finally {
    approvalBusyId.value = undefined;
  }
}

async function addNote(content: string) {
  if (!activeConversationId.value) return;
  const { note } = await createResearchNote(activeConversationId.value, content);
  notes.value.unshift(note);
}

async function removeNote(note: ResearchNote) {
  await deleteResearchNote(note.id);
  notes.value = notes.value.filter((item) => item.id !== note.id);
}

async function confirmDeleteConversation() {
  const conversation = deleteTarget.value;
  if (!conversation || deleting.value) return;

  deleting.value = true;
  error.value = '';

  try {
    await deleteResearchConversation(conversation.id);
    conversations.value = conversations.value.filter((item) => item.id !== conversation.id);
    deleteTarget.value = undefined;
    deleteArtifactCount.value = undefined;

    if (activeConversationId.value !== conversation.id) return;

    clearConversationDetail();
    const nextConversation = conversations.value[0];
    if (nextConversation) await selectConversation(nextConversation.id);
    else await createConversation();
  } catch (err) {
    error.value = err instanceof Error ? err.message : '删除会话失败';
  } finally {
    deleting.value = false;
  }
}

function withExplicitArtifactTool(content: string, policy: ToolPolicy): ToolPolicy {
  if (!isExplicitDocumentRequest(content) || !availableTools.value.some((tool) => tool.name === 'start_document_generation')) {
    return policy;
  }
  if (policy.mode === 'all') return policy;
  const names = policy.mode === 'selected' ? [...policy.names] : [];
  if (!names.includes('start_document_generation')) names.push('start_document_generation');
  return { mode: 'selected', names };
}

function isExplicitDocumentRequest(content: string) {
  const normalized = content.toLowerCase();
  const mentionsFormat = /\b(?:pptx?|pdf|docx?)\b|幻灯片|演示文稿|长篇报告|文档|word/.test(normalized);
  const asksToCreate = /生成|创建|制作|导出|下载|转换|做成|产出/.test(normalized);
  return mentionsFormat && asksToCreate;
}

async function prepareDeleteTarget(conversation: ResearchConversation) {
  deleteTarget.value = conversation;
  deleteArtifactCount.value = undefined;
  try {
    const result = await listResearchArtifactGenerations(conversation.id);
    if (deleteTarget.value?.id === conversation.id) deleteArtifactCount.value = result.generations.length;
  } catch {
    // The delete API remains authoritative; an unavailable history request
    // should not prevent the user from explicitly confirming deletion.
  }
}

function clearConversationDetail() {
  disconnectResearchStream();
  activeConversationId.value = undefined;
  messageRenderer.replaceAll([]);
  steps.value = [];
  sources.value = [];
  notes.value = [];
  promptPreview.value = { historyMessageCount: 0, currentMessage: '' };
  selectedSourceId.value = undefined;
  selectedStep.value = undefined;
  activeRailTab.value = 'timeline';
  activeDetailsTab.value = 'notes';
  activeRun.value = undefined;
  approvals.value = [];
  approvalBusyId.value = undefined;
  loading.value = false;
  stopping.value = false;
  generations.value = [];
  activeWorkbenchGeneration.value = undefined;
  generationConfirmTarget.value = undefined;
  previewOutput.value = undefined;
  stopArtifactPolling();
  documentSessionEpoch.value += 1;
  documentEditor.clearRevisions();
}

function applyConversationDetail(detail: ResearchConversationDetail) {
  messageRenderer.replaceAll(detail.messages);
  steps.value = detail.steps;
  sources.value = detail.sources;
  notes.value = detail.notes;
  promptPreview.value = detail.promptPreview;
  approvals.value = detail.approvals ? [...detail.approvals] : [];
}

function applyRun(run: ResearchRun) {
  activeRun.value = run;
  loading.value = run.status === 'queued' || run.status === 'running';
  if (!loading.value) stopping.value = false;
}

function isTerminal(run: ResearchRun) {
  return run.status === 'completed' || run.status === 'failed' || run.status === 'cancelled';
}

function selectCitation(key: string) {
  selectedSourceId.value = sources.value.find((source) => source.citationKey === key)?.id;
  activeRailTab.value = 'sources';
}

function selectStep(step: ResearchStep) {
  selectedStep.value = step;
  activeDetailsTab.value = 'tool';
  activeRailTab.value = 'details';
}

function upsert<T extends { id: string }>(items: { value: T[] }, item: T) {
  const index = items.value.findIndex((current) => current.id === item.id);
  if (index === -1) items.value.push(item);
  else items.value[index] = item;
}

async function loadGenerations(conversationId: string) {
  try {
    const result = await listResearchArtifactGenerations(conversationId);
    const active = activeWorkbenchGeneration.value;
    const preserveLocalDraft = active && documentEditor.saveState.value !== 'saved';
    generations.value = result.generations.map((generation) => {
      const normalized = normalizeGeneration(generation);
      return preserveLocalDraft && normalized.id === active.id
        ? { ...normalized, spec: active.spec }
        : normalized;
    });
    if (active) {
      const refreshed = generations.value.find((generation) => generation.id === active.id);
      if (refreshed) activeWorkbenchGeneration.value = refreshed;
    }
    syncArtifactPolling();
  } catch {
    if (!generations.value.length) generations.value = [];
  }
}

function openWorkbench(generation: ResearchArtifactGeneration) {
  const current = generations.value.find((item) => item.id === generation.id) ?? generation;
  activeWorkbenchGeneration.value = current;
  documentEditor.resetRevisionBaseline(current);
}

function workbenchUpdateSpec(spec: ArtifactSpec) {
  const generation = activeWorkbenchGeneration.value;
  if (!generation || generation.status !== 'awaiting_confirmation' || generation.stale) return;

  const updated = { ...generation, spec };
  activeWorkbenchGeneration.value = updated;
  upsert({ value: generations.value }, updated);
  documentEditor.syncDraftRevision(updated);
  documentEditor.scheduleSave(() => saveWorkbenchDraft(generation.id));
}

async function saveWorkbenchDraft(generationId: string): Promise<boolean> {
  const record = documentEditor.revisionRecords.get(generationId);
  if (!record) return false;
  if (record.pendingSave) return await record.pendingSave;

  const request = documentEditor.currentSessionToken();
  const pending = (async () => {
    while (true) {
      const current = generations.value.find((item) => item.id === generationId);
      const currentRecord = documentEditor.revisionRecords.get(generationId);
      if (!current || !currentRecord || current.status !== 'awaiting_confirmation' || current.stale) return false;

      const targetRevision = currentRecord.draftRevision;
      const targetSpec = JSON.parse(JSON.stringify(current.spec)) as ArtifactSpec;
      documentEditor.setSaveState('saving');
      error.value = '';

      try {
        const result = await updateResearchArtifactDraft(generationId, targetSpec);
        if (!documentEditor.isCurrentSession(request)) return false;

        const latest = generations.value.find((item) => item.id === generationId);
        const latestRecord = documentEditor.revisionRecords.get(generationId);
        const changedDuringSave = Boolean(latestRecord && latestRecord.draftRevision !== targetRevision);
        const normalized = normalizeGeneration(result.generation);
        const merged = changedDuringSave && latest
          ? { ...normalized, spec: latest.spec }
          : normalized;
        upsert({ value: generations.value }, merged);
        if (activeWorkbenchGeneration.value?.id === generationId) activeWorkbenchGeneration.value = merged;

        const revision = documentEditor.revisionRecords.get(generationId);
        if (revision) {
          documentEditor.revisionRecords.set(generationId, {
            ...revision,
            persistedRevision: targetRevision,
            persistedSpecJson: JSON.stringify(targetSpec)
          });
        }

        if (!changedDuringSave) {
          documentEditor.setSaveState('saved');
          return true;
        }
      } catch (cause) {
        if (documentEditor.isCurrentSession(request)) {
          error.value = cause instanceof Error ? cause.message : '保存文稿失败';
          documentEditor.setSaveState('error');
        }
        return false;
      }
    }
  })().finally(() => {
    const latest = documentEditor.revisionRecords.get(generationId);
    if (latest?.pendingSave === pending) {
      documentEditor.revisionRecords.set(generationId, { ...latest, pendingSave: undefined });
    }
  });

  documentEditor.revisionRecords.set(generationId, { ...record, pendingSave: pending });
  return pending;
}

async function closeWorkbench(): Promise<boolean> {
  const generation = activeWorkbenchGeneration.value;
  if (generation && documentEditor.saveState.value !== 'saved') {
    const saved = await documentEditor.flushSave(() => saveWorkbenchDraft(generation.id));
    if (!saved) return false;
  }
  activeWorkbenchGeneration.value = undefined;
  return true;
}

function workbenchGenerate(generation: ResearchArtifactGeneration) {
  if (generation.status !== 'awaiting_confirmation' || generation.stale) return;
  generationConfirmTarget.value = generation;
}

async function confirmWorkbenchGenerate() {
  const generation = generationConfirmTarget.value;
  if (!generation || workbenchBusy.value) return;

  if (activeWorkbenchGeneration.value?.id === generation.id) {
    const saved = await documentEditor.flushSave(() => saveWorkbenchDraft(generation.id));
    if (!saved) {
      error.value = '草稿保存失败，请重试后再生成';
      return;
    }
  }

  workbenchBusy.value = true;
  error.value = '';
  try {
    const rendered = await renderResearchArtifact(generation.id);
    const generationResult = normalizeGeneration(rendered.generation);
    upsert({ value: generations.value }, generationResult);
    if (activeWorkbenchGeneration.value?.id === generation.id) {
      activeWorkbenchGeneration.value = generationResult;
    }
    syncArtifactPolling();
    generationConfirmTarget.value = undefined;
  } catch (err) {
    error.value = err instanceof Error ? err.message : '生成失败';
  } finally {
    workbenchBusy.value = false;
  }
}

async function workbenchCancel(generation: ResearchArtifactGeneration) {
  workbenchBusy.value = true;
  error.value = '';
  try {
    const cancelled = await cancelResearchArtifact(generation.id);
    const generationResult = normalizeGeneration(cancelled.generation);
    upsert({ value: generations.value }, generationResult);
    if (activeWorkbenchGeneration.value?.id === generation.id) {
      activeWorkbenchGeneration.value = generationResult;
    }
    syncArtifactPolling();
  } catch (err) {
    error.value = err instanceof Error ? err.message : '取消失败';
  } finally {
    workbenchBusy.value = false;
  }
}

async function workbenchRetryOutput(generation: ResearchArtifactGeneration, outputId: string) {
  workbenchBusy.value = true;
  error.value = '';
  try {
    const updated = await retryResearchArtifactOutput(outputId);
    const generationResult = normalizeGeneration(updated.generation);
    upsert({ value: generations.value }, generationResult);
    if (activeWorkbenchGeneration.value?.id === generation.id) {
      activeWorkbenchGeneration.value = generationResult;
    }
    syncArtifactPolling();
  } catch (err) {
    error.value = err instanceof Error ? err.message : '重试失败';
  } finally {
    workbenchBusy.value = false;
  }
}

async function workbenchSelectGeneration(id: string) {
  try {
    const current = activeWorkbenchGeneration.value;
    if (current && current.id !== id && documentEditor.saveState.value !== 'saved') {
      const saved = await documentEditor.flushSave(() => saveWorkbenchDraft(current.id));
      if (!saved) return;
    }
    const result = await getResearchArtifactGeneration(id);
    const generation = normalizeGeneration(result.generation);
    activeWorkbenchGeneration.value = generation;
    documentEditor.resetRevisionBaseline(generation);
  } catch (err) {
    error.value = err instanceof Error ? err.message : '加载版本失败';
  }
}

async function workbenchDeleteGeneration(id: string) {
  workbenchBusy.value = true;
  error.value = '';
  try {
    await deleteResearchArtifactGeneration(id);
    generations.value = generations.value.filter(g => g.id !== id);
    if (activeWorkbenchGeneration.value?.id === id) {
      activeWorkbenchGeneration.value = generations.value[0];
    }
  } catch (err) {
    error.value = err instanceof Error ? err.message : '删除失败';
  } finally {
    workbenchBusy.value = false;
  }
}

async function workbenchConfirmConsent(imageUrl: string, sourceId?: string) {
  const generation = activeWorkbenchGeneration.value;
  if (!generation) return;

  try {
    await confirmResearchArtifactImageUse(generation.id, imageUrl, sourceId);
    const updated = await getResearchArtifactGeneration(generation.id);
    const generationResult = normalizeGeneration(updated.generation);
    upsert({ value: generations.value }, generationResult);
    activeWorkbenchGeneration.value = generationResult;
  } catch (err) {
    error.value = err instanceof Error ? err.message : '确认失败';
  }
}

async function workbenchFetchSourceImage() {
  const generation = activeWorkbenchGeneration.value;
  const consent = generation?.imageConsents?.[0];
  if (!generation || !consent) {
    error.value = '请先确认图片来源和使用权限';
    return;
  }

  try {
    await fetchResearchArtifactSourceImage({
      generationId: generation.id,
      imageUrl: consent.imageUrl,
      consentId: consent.id,
      ...(consent.sourceId ? { sourceId: consent.sourceId } : {})
    });
    error.value = '';
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : '获取来源图片失败';
  }
}

function syncArtifactPolling() {
  const shouldPoll = generations.value.some((generation) =>
    generation.status === 'rendering'
    || generation.status === 'validating'
    || generation.status === 'repairing'
  );
  if (!shouldPoll) {
    stopArtifactPolling();
    return;
  }
  if (artifactPollTimer !== undefined) return;
  artifactPollTimer = window.setTimeout(async () => {
    artifactPollTimer = undefined;
    if (activeConversationId.value) await loadGenerations(activeConversationId.value);
  }, 1_000);
}

function stopArtifactPolling() {
  if (artifactPollTimer !== undefined) {
    window.clearTimeout(artifactPollTimer);
    artifactPollTimer = undefined;
  }
}

function normalizeGeneration(generation: ResearchArtifactGeneration): ResearchArtifactGeneration {
  if (generation.spec.longform?.blocks) return generation;

  const blocks: LongformBlock[] = generation.spec.pdf.sections.flatMap((section) => [
    {
      id: `heading-${section.id}`,
      type: 'heading' as const,
      level: 1 as const,
      text: section.title,
      citations: [...section.citations]
    },
    ...section.paragraphs.map((text, index): LongformBlock => ({
      id: `paragraph-${section.id}-${index}`,
      type: 'paragraph',
      text,
      citations: [...section.citations]
    })),
    ...(section.bullets.length
      ? [{
          id: `bullets-${section.id}`,
          type: 'bulletList' as const,
          items: [...section.bullets],
          citations: [...section.citations]
        }]
      : [])
  ]);

  return {
    ...generation,
    spec: {
      ...generation.spec,
      longform: {
        blocks,
        pageSettings: {
          size: 'A4',
          orientation: 'portrait',
          marginTop: 25.4,
          marginBottom: 25.4,
          marginLeft: 25.4,
          marginRight: 25.4,
          pageNumbers: true
        }
      }
    }
  };
}

const workbenchSaveState = documentEditor.saveState;
const allGenerations = computed(() => generations.value);
</script>

<template>
  <section
    class="relative grid h-full min-h-0 grid-cols-[minmax(0,1fr)_var(--inspector-width)] grid-rows-[minmax(0,1fr)] overflow-hidden max-md:grid-cols-1 max-md:grid-rows-[minmax(380px,1fr)_auto] max-md:overflow-y-auto"
    :style="{ '--inspector-width': inspectorTrack }"
  >
    <WorkspaceSidebarLayout
      v-model:width="sidebarWidth"
      :collapsed="collapsed"
      :collapsed-width="60"
      :min-width="sidebarBounds.min"
      :max-width="sidebarBounds.max"
      :default-width="sidebarBounds.defaultWidth"
      resize-label="调整会话栏宽度"
      class="min-w-0"
    >
      <template #sidebar>
        <ResearchConversationSidebar
          :conversations="conversations"
          :active-conversation-id="activeConversationId"
          :collapsed="sidebarCompact"
          :busy="deleting"
          @create="createConversation"
          @select="selectConversation"
          @delete="prepareDeleteTarget"
          @toggle="collapsed = !collapsed"
        />
      </template>

      <ResearchMainPanel
        v-model:input="input"
        :title="activeConversation?.title"
        :conversation-id="activeConversationId"
        :messages="messages"
        :generations-by-message-id="generationsByMessageId"
        :auxiliary-state-by-message-id="auxiliaryStateByMessageId"
        :loading="loading"
        :stopping="stopping"
        :error="error"
        :connection-hint="connectionHint"
        :connection-state="connectionState"
        :tool-groups="availableToolGroups"
        :standalone-tools="standaloneToolList"
        :enabled-tool-groups="enabledToolGroups"
        :enabled-standalone-tools="enabledStandaloneTools"
        :locked-tool-group-ids="lockedToolGroupIds"
        :skills="availableSkills"
        :selected-skill-id="selectedSkillId"
        :approvals="approvals"
        :approval-busy-id="approvalBusyId"
        @send="send"
        @stop="stopResearch"
        @toggle-tool-group="toggleToolGroup"
        @toggle-standalone-tool="toggleStandaloneTool"
        @select-skill="selectSkill"
        @citation="selectCitation"
        @open-workbench="openWorkbench"
        @preview-output="previewOutput = $event"
        @generate="workbenchGenerate"
        @cancel="workbenchCancel"
        @retry-output="workbenchRetryOutput"
        @approval-decision="decideApproval"
      />
    </WorkspaceSidebarLayout>

    <PanelResizeHandle
      v-if="!inspectorCollapsed"
      v-model:width="inspectorWidth"
      edge="right"
      :min="inspectorBounds.min"
      :max="inspectorBounds.max"
      :default-width="inspectorBounds.defaultWidth"
      label="调整研究检查器宽度"
      class="max-md:hidden"
    />

    <ResearchInspector
      v-model:active-tab="activeRailTab"
      v-model:active-details-tab="activeDetailsTab"
      :collapsed="inspectorCollapsed"
      :steps="steps"
      :sources="sources"
      :notes="notes"
      :prompt-preview="promptPreview"
      :selected-step="selectedStep"
      :selected-source-id="selectedSourceId"
      @toggle="inspectorCollapsed = !inspectorCollapsed"
      @select-step="selectStep"
      @create-note="addNote"
      @delete-note="removeNote"
    />

    <Dialog :open="Boolean(deleteTarget)" @update:open="deleteTarget = $event ? deleteTarget : undefined">
      <DialogContent class="sm:max-w-md">
        <DialogHeader>
          <div class="mb-1 flex size-10 items-center justify-center rounded-lg bg-destructive/10 text-destructive">
            <PhTrash :size="19" weight="bold" aria-hidden="true" />
          </div>
          <DialogTitle>删除研究会话</DialogTitle>
          <DialogDescription>
            “{{ deleteTarget?.title }}”及其消息、来源、笔记和 {{ deleteArtifactCount ?? '正在读取' }} 个关联产物版本将被永久删除；对应的二进制、预览和中间素材也会物理删除，此操作无法撤销。
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="outline" :disabled="deleting" @click="deleteTarget = undefined">取消</Button>
          <Button variant="destructive" :disabled="deleting" @click="confirmDeleteConversation">
            <PhTrash :size="16" weight="bold" aria-hidden="true" />
            {{ deleting ? '删除中' : '确认删除' }}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>

    <DocumentConfirmDialog
      :open="Boolean(generationConfirmTarget)"
      title="确认生成文档"
      description="系统会先保存当前草稿，再创建不可变版本并开始渲染。生成后仍可从版本历史查看和下载。"
      :detail="generationConfirmTarget
        ? `输出格式：${generationConfirmTarget.spec.formats.map((format) => format.toUpperCase()).join('、')}`
        : undefined"
      confirm-label="确认生成"
      :busy="workbenchBusy"
      @update:open="generationConfirmTarget = $event ? generationConfirmTarget : undefined"
      @confirm="confirmWorkbenchGenerate"
    />

    <DocumentWorkbench
      v-if="activeWorkbenchGeneration"
      :generation="activeWorkbenchGeneration"
      :generations="allGenerations"
      :save-state="workbenchSaveState"
      :busy="workbenchBusy"
      @close="closeWorkbench"
      @update-spec="workbenchUpdateSpec"
      @generate="workbenchGenerate(activeWorkbenchGeneration)"
      @cancel="workbenchCancel(activeWorkbenchGeneration)"
      @retry-output="workbenchRetryOutput(activeWorkbenchGeneration, $event)"
      @preview-output="previewOutput = $event"
      @select-generation="workbenchSelectGeneration"
      @delete-generation="workbenchDeleteGeneration"
      @confirm-consent="workbenchConfirmConsent"
      @fetch-source-image="workbenchFetchSourceImage"
    />

    <DocumentPreviewDialog :output="previewOutput" @close="previewOutput = undefined" />
  </section>
</template>
