<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';
import { PhCaretDoubleLeft, PhCaretDoubleRight, PhCircleNotch, PhStopCircle, PhTrash } from '@phosphor-icons/vue';

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
import AgentMessage from '../components/agent/AgentMessage.vue';
import PanelResizeHandle from '../components/common/PanelResizeHandle.vue';
import { useMessageAutoScroll } from '../composables/useMessageAutoScroll';
import { useStreamingMessageRenderer } from '../composables/useStreamingMessageRenderer';
import { useCollapsiblePanel, useResizablePanel, type PanelWidthBounds } from '../composables/useResizablePanel';
import ResearchConversationSidebar from '../components/research/ResearchConversationSidebar.vue';
import ResearchDetailsPanel from '../components/research/ResearchDetailsPanel.vue';
import ResearchSourcesPanel from '../components/research/ResearchSourcesPanel.vue';
import ResearchTimeline from '../components/research/ResearchTimeline.vue';
import WordArtifactCard from '../components/documents/WordArtifactCard.vue';
import WordPreviewDialog from '../components/documents/WordPreviewDialog.vue';
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

const sidebarBounds: PanelWidthBounds = { defaultWidth: 220, min: 168, max: 420 };
const inspectorBounds: PanelWidthBounds = { defaultWidth: 400, min: 280, max: 720 };
const sidebarWidth = useResizablePanel('research:sidebar-width', sidebarBounds);
const inspectorWidth = useResizablePanel('research:inspector-width', inspectorBounds);
const sidebarTrack = computed(() => (collapsed.value ? '52px' : `${sidebarWidth.value}px`));
const inspectorTrack = computed(() => (inspectorCollapsed.value ? '48px' : `${inspectorWidth.value}px`));

const activeConversation = computed(() => conversations.value.find((item) => item.id === activeConversationId.value));
const messageSignature = computed(() => {
  const lastMessage = messages.value[messages.value.length - 1];
  return lastMessage
    ? `${messages.value.length}:${lastMessage.id}:${lastMessage.content.length}:${lastMessage.status}`
    : 'empty';
});
const { handleScroll: handleMessageScroll, scrollContainer: messageScrollContainer } = useMessageAutoScroll(
  () => activeConversationId.value,
  () => messageSignature.value
);

const enabledToolNames = computed(() =>
  availableTools.value.filter((tool) => enabledTools.value[tool.name]).map((tool) => tool.name)
);
const toolStepCount = computed(() => steps.value.filter((step) => step.type === 'tool').length);

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
  void streamResearchRun(run.id, handleStreamEvent, controller.signal)
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

function disconnectResearchStream() {
  subscriptionSequence += 1;
  requestController?.abort();
  requestController = undefined;
  messageRenderer.flush();
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
    class="relative grid min-h-0 h-full grid-cols-[var(--sidebar-width)_minmax(0,1fr)_var(--inspector-width)] max-md:grid-cols-1 max-md:grid-rows-[auto_minmax(380px,1fr)_auto]"
    :style="{ '--sidebar-width': sidebarTrack, '--inspector-width': inspectorTrack }"
  >
    <ResearchConversationSidebar :conversations="conversations" :active-conversation-id="activeConversationId" :collapsed="collapsed" :busy="deleting" @create="createConversation" @select="selectConversation" @delete="deleteTarget = $event" @toggle="collapsed = !collapsed" />

    <PanelResizeHandle
      v-if="!collapsed"
      v-model:width="sidebarWidth"
      edge="left"
      :min="sidebarBounds.min"
      :max="sidebarBounds.max"
      :default-width="sidebarBounds.defaultWidth"
      label="调整会话栏宽度"
      class="max-md:hidden"
    />

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

    <main class="grid min-h-0 grid-rows-[minmax(0,1fr)_auto] bg-[var(--agent-surface)]">
      <div ref="messageScrollContainer" class="grid content-start gap-6 overflow-auto px-5 py-6" aria-live="polite" @scroll="handleMessageScroll">
        <AgentMessage v-for="message in messages" :key="message.id" :message="message" streaming-placeholder="正在整理研究结果..." @citation="selectCitation">
          <WordArtifactCard
            v-for="artifact in artifactsByMessageId.get(message.id) ?? []"
            :key="artifact.artifactId"
            :artifact="artifact"
            @preview="previewArtifact = $event"
          />
        </AgentMessage>
        <p v-if="!messages.length" class="m-0 max-w-xl text-sm leading-7 text-[var(--agent-text-muted)]">围绕知识库提出问题。工作台会保存对话、工具过程和资料来源，便于持续研究。</p>
      </div>
      <footer class="border-t border-[var(--agent-border)] p-4">
        <p v-if="error" class="m-0 mb-2 text-sm font-semibold text-[var(--agent-error-text)]">{{ error }}</p>
        <div v-if="loading" class="mb-3 flex items-center justify-between gap-3 rounded-md border border-[var(--agent-selected-border)] bg-[var(--agent-selected-bg)] px-3 py-2 text-[var(--agent-selected-text)]">
          <span class="inline-flex min-w-0 items-center gap-2 text-xs font-semibold"><PhCircleNotch class="shrink-0 animate-spin" :size="15" /><span class="truncate">后台研究中 · 离开页面不会中断</span></span>
          <button type="button" class="inline-flex h-7 shrink-0 items-center gap-1.5 rounded-md border border-[var(--agent-error-text)]/30 bg-[var(--agent-surface)] px-2.5 text-xs font-bold text-[var(--agent-error-text)] hover:bg-[var(--agent-error-bg)] disabled:cursor-wait disabled:opacity-60" :disabled="stopping" @click="stopResearch"><PhCircleNotch v-if="stopping" class="animate-spin" :size="14" /><PhStopCircle v-else :size="14" weight="fill" />{{ stopping ? '停止中' : '停止研究' }}</button>
        </div>
        <div v-if="availableTools.length" class="mb-2.5 flex flex-wrap items-center gap-1.5">
          <span class="mr-1 font-mono text-[10px] font-bold uppercase tracking-[0.08em] text-[var(--agent-text-muted)]">Tools</span>
          <button
            v-for="tool in availableTools"
            :key="tool.name"
            type="button"
            class="h-7 cursor-pointer rounded-full border px-2.5 font-mono text-[11px] font-semibold transition-colors disabled:cursor-not-allowed"
            :class="enabledTools[tool.name]
              ? 'border-[var(--agent-selected-border)] bg-[var(--agent-selected-bg)] text-[var(--agent-selected-text)]'
              : 'border-[var(--agent-border)] bg-[var(--agent-surface-muted)] text-[var(--agent-text-muted)] line-through opacity-70'"
            :title="`${tool.name} — ${tool.description}`"
            :aria-pressed="Boolean(enabledTools[tool.name])"
            :disabled="loading"
            @click="toggleTool(tool.name)"
          >{{ tool.label || tool.name }}</button>
          <span v-if="!enabledToolNames.length" class="text-[11px] font-semibold text-[var(--agent-error-text)]">已关闭全部工具，本轮将仅凭模型自身知识回答</span>
        </div>
        <form class="flex gap-2" @submit.prevent="send">
          <input v-model="input" class="min-w-0 flex-1 rounded-md border border-[var(--agent-border)] bg-[var(--agent-surface-muted)] px-3 py-2.5 text-sm text-[var(--agent-text)] outline-none focus:border-[var(--agent-selected-border)]" placeholder="输入研究问题..." :disabled="loading" />
          <button type="submit" class="rounded-md bg-[var(--agent-selected-bg)] px-4 text-sm font-bold text-[var(--agent-selected-text)] disabled:opacity-50" :disabled="loading">{{ loading ? '后台运行中' : '发送' }}</button>
        </form>
      </footer>
    </main>

    <aside v-if="inspectorCollapsed" class="grid min-h-0 min-w-0 content-start justify-items-center gap-3 border-l border-[var(--agent-border)] bg-[var(--agent-surface-muted)] p-2 max-md:h-[min(40vh,360px)] max-md:border-l-0 max-md:border-t">
      <button type="button" class="grid h-8 w-8 place-items-center rounded-md text-[var(--agent-text-muted)] hover:bg-[var(--agent-surface)] hover:text-[var(--agent-text)]" aria-label="展开研究检查器" title="展开研究检查器" @click="inspectorCollapsed = false">
        <PhCaretDoubleLeft :size="17" />
      </button>
    </aside>

    <aside v-else class="grid min-h-0 min-w-0 grid-rows-[auto_minmax(0,1fr)] border-l border-[var(--agent-border)] bg-[var(--agent-surface-muted)] max-md:h-[min(40vh,360px)] max-md:border-l-0 max-md:border-t">
      <header class="border-b border-[var(--agent-border)] px-4 py-3">
        <div class="flex items-center justify-between gap-2">
          <p class="m-0 text-sm font-bold text-[var(--agent-text)]">研究检查器</p>
          <button type="button" class="grid h-7 w-7 shrink-0 place-items-center rounded-md text-[var(--agent-text-muted)] hover:bg-[var(--agent-surface)] hover:text-[var(--agent-text)]" aria-label="收起研究检查器" title="收起研究检查器" @click="inspectorCollapsed = true">
            <PhCaretDoubleRight :size="16" />
          </button>
        </div>
        <div class="mt-3 grid grid-cols-3 rounded-md border border-[var(--agent-border)] bg-[var(--agent-surface)] p-1">
          <button type="button" class="flex h-8 items-center justify-center gap-1.5 rounded-md px-2 text-xs font-bold transition-colors" :class="activeRailTab === 'timeline' ? 'bg-[var(--agent-selected-bg)] text-[var(--agent-selected-text)]' : 'text-[var(--agent-text-muted)] hover:bg-[var(--agent-surface-muted)] hover:text-[var(--agent-text)]'" @click="activeRailTab = 'timeline'">过程 <span class="font-mono text-[10px] opacity-70">{{ steps.length }} · 工具 {{ toolStepCount }}</span></button>
          <button type="button" class="flex h-8 items-center justify-center gap-1.5 rounded-md px-2 text-xs font-bold transition-colors" :class="activeRailTab === 'sources' ? 'bg-[var(--agent-selected-bg)] text-[var(--agent-selected-text)]' : 'text-[var(--agent-text-muted)] hover:bg-[var(--agent-surface-muted)] hover:text-[var(--agent-text)]'" @click="activeRailTab = 'sources'">来源 <span class="font-mono text-[10px] opacity-70">{{ sources.length }}</span></button>
          <button type="button" class="h-8 rounded-md px-2 text-xs font-bold transition-colors" :class="activeRailTab === 'details' ? 'bg-[var(--agent-selected-bg)] text-[var(--agent-selected-text)]' : 'text-[var(--agent-text-muted)] hover:bg-[var(--agent-surface-muted)] hover:text-[var(--agent-text)]'" @click="activeRailTab = 'details'">详情</button>
        </div>
      </header>
      <div class="min-h-0 overflow-hidden">
        <ResearchTimeline v-show="activeRailTab === 'timeline'" class="h-full" :steps="steps" :selected-step-id="selectedStep?.id" @select="selectStep" />
        <ResearchSourcesPanel v-show="activeRailTab === 'sources'" class="h-full" :sources="sources" :selected-source-id="selectedSourceId" />
        <ResearchDetailsPanel v-show="activeRailTab === 'details'" class="h-full" :active-tab="activeDetailsTab" :notes="notes" :prompt-preview="promptPreview" :selected-step="selectedStep" @change-tab="activeDetailsTab = $event" @create-note="addNote" @delete-note="removeNote" />
      </div>
    </aside>

    <div v-if="deleteTarget" class="fixed inset-0 z-20 grid place-items-center bg-black/20 p-5" role="dialog" aria-modal="true" aria-label="删除研究会话确认">
      <div class="grid w-full max-w-md gap-4 rounded-lg border border-[var(--agent-border)] bg-[var(--agent-surface)] p-5 shadow-lg">
        <div class="flex items-start gap-3">
          <span class="grid size-9 shrink-0 place-items-center rounded-md bg-[var(--agent-error-bg)] text-[var(--agent-error-text)]"><PhTrash :size="18" weight="bold" aria-hidden="true" /></span>
          <div>
            <h2 class="m-0 text-base font-bold text-[var(--agent-text)]">删除研究会话</h2>
            <p class="m-0 mt-1 text-sm leading-5 text-[var(--agent-text-muted)]">“{{ deleteTarget.title }}”及其消息、来源和笔记将被永久删除。</p>
          </div>
        </div>
        <div class="flex justify-end gap-2">
          <button type="button" class="inline-flex h-9 cursor-pointer items-center rounded-md border border-[var(--agent-border)] px-3 text-sm font-semibold text-[var(--agent-text)] hover:bg-[var(--agent-surface-muted)]" :disabled="deleting" @click="deleteTarget = undefined">取消</button>
          <button type="button" class="inline-flex h-9 cursor-pointer items-center gap-2 rounded-md bg-[var(--agent-error-text)] px-3 text-sm font-semibold text-white hover:opacity-90 disabled:cursor-wait disabled:opacity-60" :disabled="deleting" @click="confirmDeleteConversation"><PhTrash :size="16" weight="bold" aria-hidden="true" />{{ deleting ? '删除中' : '删除' }}</button>
        </div>
      </div>
    </div>

    <WordPreviewDialog :artifact="previewArtifact" @close="previewArtifact = undefined" />
  </section>
</template>
