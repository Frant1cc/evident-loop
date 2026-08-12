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
  listResearchTools,
  startResearchMessage,
  streamResearchRun,
  type ResearchStreamEvent,
  type ResearchToolInfo
} from '../api/research';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import PanelResizeHandle from '../components/common/PanelResizeHandle.vue';
import WorkspaceSidebarLayout from '../components/layout/WorkspaceSidebarLayout.vue';
import { useResizablePanel, type PanelWidthBounds } from '../composables/useResizablePanel';
import { useCollapsiblePanel } from '../composables/useResizablePanel';
import ResearchConversationSidebar from '../components/research/ResearchConversationSidebar.vue';
import ResearchMainPanel from '../components/research/ResearchMainPanel.vue';
import ResearchInspector from '../components/research/ResearchInspector.vue';
import WordPreviewDialog from '../components/documents/WordPreviewDialog.vue';
import { useStreamingMessageRenderer } from '../composables/useStreamingMessageRenderer';
import { parseWordArtifact, type WordArtifact } from '../types/artifacts';
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
const inspectorCollapsed = useCollapsiblePanel('research:inspector-collapsed');
const selectedSourceId = ref<string>();
const selectedStep = ref<ResearchStep>();
const activeRailTab = ref<'timeline' | 'sources' | 'details'>('timeline');
const activeDetailsTab = ref<'notes' | 'memory' | 'tool' | 'prompt'>('notes');
const deleteTarget = ref<ResearchConversation>();
const deleting = ref(false);
const availableTools = ref<ResearchToolInfo[]>([]);
const enabledTools = ref<Record<string, boolean>>({});
const previewArtifact = ref<WordArtifact>();
let requestController: AbortController | undefined;
let subscriptionSequence = 0;

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

const enabledToolNames = computed(() =>
  availableTools.value.filter((tool) => enabledTools.value[tool.name]).map((tool) => tool.name)
);

const artifactsByMessageId = computed(() => {
  const artifacts = new Map<string, WordArtifact[]>();

  for (const step of steps.value) {
    if (step.type !== 'tool' || step.title !== 'generate_word_document' || step.status !== 'complete') {
      continue;
    }
    const artifact = parseWordArtifact(step.output);
    if (!artifact) continue;
    const messageArtifacts = artifacts.get(step.messageId) ?? [];
    if (!messageArtifacts.some((item) => item.artifactId === artifact.artifactId)) {
      messageArtifacts.push(artifact);
      artifacts.set(step.messageId, messageArtifacts);
    }
  }

  return artifacts;
});

onMounted(async () => {
  await Promise.all([loadConversations(), loadTools()]);
  if (conversations.value[0]) await selectConversation(conversations.value[0].id);
  else await createConversation();
});

async function loadTools() {
  try {
    const { tools } = await listResearchTools();
    availableTools.value = tools;
    enabledTools.value = Object.fromEntries(tools.map((tool) => [tool.name, true]));
  } catch {
    // Tool toggles are an enhancement; the workbench still works with all tools when the list fails to load.
  }
}

function toggleTool(name: string) {
  enabledTools.value[name] = !enabledTools.value[name];
}

onBeforeUnmount(disconnectResearchStream);

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

async function selectConversation(id: string) {
  if (id === activeConversationId.value) return;
  disconnectResearchStream();
  loading.value = false;
  stopping.value = false;
  activeRun.value = undefined;
  const detail = await getResearchConversation(id);
  activeConversationId.value = id;
  applyConversationDetail(detail);
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
    // Send the restriction only when the user turned something off; undefined = all tools.
    const allowedTools =
      availableTools.value.length && enabledToolNames.value.length < availableTools.value.length
        ? enabledToolNames.value
        : undefined;
    const started = await startResearchMessage(conversationId, content, allowedTools);
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
      error.value = err instanceof Error ? `${err.message}，任务仍在后台运行。` : '研究进度连接已断开，任务仍在后台运行。';
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
  if (event.type === 'done') void loadConversations();
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
    error.value = err instanceof Error ? err.message : '停止研究失败';
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
  loading.value = false;
  stopping.value = false;
}

function applyConversationDetail(detail: ResearchConversationDetail) {
  messageRenderer.replaceAll(detail.messages);
  steps.value = detail.steps;
  sources.value = detail.sources;
  notes.value = detail.notes;
  promptPreview.value = detail.promptPreview;
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
          @delete="deleteTarget = $event"
          @toggle="collapsed = !collapsed"
        />
      </template>

      <ResearchMainPanel
        v-model:input="input"
        :title="activeConversation?.title"
        :conversation-id="activeConversationId"
        :messages="messages"
        :artifacts-by-message-id="artifactsByMessageId"
        :loading="loading"
        :stopping="stopping"
        :error="error"
        :connection-hint="connectionHint"
        :connection-state="connectionState"
        :tools="availableTools"
        :enabled-tools="enabledTools"
        @send="send"
        @stop="stopResearch"
        @toggle-tool="toggleTool"
        @citation="selectCitation"
        @preview="previewArtifact = $event"
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
            “{{ deleteTarget?.title }}”及其消息、来源和笔记将被永久删除，此操作无法撤销。
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

    <WordPreviewDialog :artifact="previewArtifact" @close="previewArtifact = undefined" />
  </section>
</template>
