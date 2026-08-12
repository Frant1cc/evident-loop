<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';
import { PhTrash } from '@phosphor-icons/vue';

import {
  createChatConversation,
  deleteChatConversation,
  getChatConversation,
  listChatConversations,
  streamChatMessage,
  type ChatStreamEvent
} from '../api/chat';
import ChatPanel from '../components/chat/ChatPanel.vue';
import ChatSidebar from '../components/chat/ChatSidebar.vue';
import ChatTabs from '../components/chat/ChatTabs.vue';
import KnowledgeBasePanel from '../components/chat/KnowledgeBasePanel.vue';
import { useStreamingMessageRenderer } from '../composables/useStreamingMessageRenderer';
import ResearchWorkbench from './ResearchWorkbench.vue';
import EvaluationHubView from './EvaluationHubView.vue';
import SettingsView from './SettingsView.vue';
import TaskConsoleView from './TaskConsoleView.vue';
import type { ChatConversation, ChatMessage } from '../types/chat';
import {
  loadTabVisibility,
  saveTabVisibility,
  type AppTabKey,
  type ConfigurableTabKey,
  type TabVisibility
} from '../types/navigation';

const input = ref('');
const loading = ref(false);
const error = ref('');
const tabVisibility = ref(loadTabVisibility());
const activeTab = ref<AppTabKey>(tabVisibility.value.tasks ? 'tasks' : 'settings');
const sidebarCollapsed = ref(false);
const conversations = ref<ChatConversation[]>([]);
const activeConversationId = ref<string>();
const messages = ref<ChatMessage[]>([]);
const messageRenderer = useStreamingMessageRenderer(messages);
const deleteTarget = ref<ChatConversation>();
const deleting = ref(false);
let requestController: AbortController | undefined;
let streamingAssistantMessageId: string | undefined;

const activeConversation = computed(() => conversations.value.find((conversation) => conversation.id === activeConversationId.value));

onMounted(async () => {
  try {
    await loadConversations();
    if (conversations.value[0]) await selectConversation(conversations.value[0].id);
    else await createConversation();
  } catch (err) {
    error.value = err instanceof Error ? err.message : '加载会话失败';
  }
});

onBeforeUnmount(() => {
  requestController?.abort();
});

async function loadConversations() {
  const data = await listChatConversations();
  conversations.value = data.conversations;
}

async function createConversation() {
  if (loading.value) return;
  resetStreamingMessage();
  error.value = '';

  try {
    const { conversation } = await createChatConversation();
    conversations.value = [conversation, ...conversations.value];
    activeConversationId.value = conversation.id;
    messageRenderer.replaceAll([]);
    input.value = '';
  } catch (err) {
    error.value = err instanceof Error ? err.message : '创建会话失败';
  }
}

async function selectConversation(conversationId: string) {
  if (loading.value || conversationId === activeConversationId.value) return;
  resetStreamingMessage();
  error.value = '';

  try {
    const detail = await getChatConversation(conversationId);
    activeConversationId.value = detail.conversation.id;
    messageRenderer.replaceAll(detail.messages);
    updateConversation(detail.conversation);
    input.value = '';
  } catch (err) {
    error.value = err instanceof Error ? err.message : '加载会话失败';
  }
}

async function sendMessage() {
  const content = input.value.trim();
  const conversationId = activeConversationId.value;
  if (!content || !conversationId || loading.value) return;

  input.value = '';
  error.value = '';
  loading.value = true;
  requestController = new AbortController();

  try {
    await streamChatMessage(conversationId, content, handleStreamEvent, requestController.signal);
    await loadConversations();
  } catch (err) {
    if ((err as Error).name !== 'AbortError') error.value = err instanceof Error ? err.message : '请求失败';
    await reloadActiveConversation();
  } finally {
    messageRenderer.flush();
    loading.value = false;
    requestController = undefined;
  }
}

async function confirmDeleteConversation() {
  const conversation = deleteTarget.value;
  if (!conversation || deleting.value || loading.value) return;

  deleting.value = true;
  error.value = '';

  try {
    await deleteChatConversation(conversation.id);
    conversations.value = conversations.value.filter((item) => item.id !== conversation.id);
    deleteTarget.value = undefined;

    if (activeConversationId.value !== conversation.id) return;

    activeConversationId.value = undefined;
    resetStreamingMessage();
    messageRenderer.replaceAll([]);
    input.value = '';
    const nextConversation = conversations.value[0];
    if (nextConversation) await selectConversation(nextConversation.id);
    else await createConversation();
  } catch (err) {
    error.value = err instanceof Error ? err.message : '删除会话失败';
  } finally {
    deleting.value = false;
  }
}

function handleStreamEvent(event: ChatStreamEvent) {
  if (event.type === 'chat_message_started') {
    messageRenderer.upsert(event.userMessage);
    messageRenderer.upsert(event.message);
    streamingAssistantMessageId = event.message.id;
    return;
  }

  if (event.type === 'message' && streamingAssistantMessageId) {
    messageRenderer.append(streamingAssistantMessageId, event.content);
  }
  if (event.type === 'done') {
    messageRenderer.upsert(event.message);
    streamingAssistantMessageId = undefined;
  }
  if (event.type === 'error') {
    error.value = event.message;
    if (event.assistantMessage) messageRenderer.upsert(event.assistantMessage);
    streamingAssistantMessageId = undefined;
  }
}

function resetStreamingMessage() {
  streamingAssistantMessageId = undefined;
  messageRenderer.reset();
}

async function reloadActiveConversation() {
  const conversationId = activeConversationId.value;
  if (!conversationId) return;

  try {
    const detail = await getChatConversation(conversationId);
    messageRenderer.replaceAll(detail.messages);
    updateConversation(detail.conversation);
  } catch {
    // Preserve the streaming state when the recovery request also fails.
  }
}

function updateConversation(conversation: ChatConversation) {
  const index = conversations.value.findIndex((item) => item.id === conversation.id);
  if (index === -1) conversations.value.unshift(conversation);
  else conversations.value[index] = conversation;
}

function changeTab(tab: AppTabKey) {
  activeTab.value = tab;
}

function updateTabVisibility(visibility: TabVisibility) {
  tabVisibility.value = visibility;
  saveTabVisibility(visibility);

  if (activeTab.value !== 'settings' && !visibility[activeTab.value as ConfigurableTabKey]) {
    activeTab.value = 'settings';
  }
}
</script>

<template>
  <main class="grid min-h-screen bg-[var(--agent-bg)] text-[var(--agent-text)]">
    <section class="grid h-screen w-full grid-rows-[auto_minmax(0,1fr)] overflow-hidden bg-[var(--agent-surface)]" aria-label="EvidentLoop">
      <div class="border-b border-[var(--agent-border)] px-5 pb-4 pt-4 md:px-7">
        <ChatTabs :active-tab="activeTab" :tab-visibility="tabVisibility" @change="changeTab" />
      </div>
      <TaskConsoleView v-if="activeTab === 'tasks'" />
      <div v-else-if="activeTab === 'chat'" class="grid min-h-0 max-md:grid-cols-1 max-md:grid-rows-[auto_minmax(0,1fr)]" :class="sidebarCollapsed ? 'grid-cols-[52px_minmax(0,1fr)]' : 'grid-cols-[220px_minmax(0,1fr)]'">
        <ChatSidebar :sessions="conversations" :active-session-id="activeConversationId" :collapsed="sidebarCollapsed" :busy="loading || deleting" @create="createConversation" @select="selectConversation" @delete="deleteTarget = $event" @toggle-collapse="sidebarCollapsed = !sidebarCollapsed" />
        <ChatPanel v-model="input" :conversation-id="activeConversationId" :messages="messages" :loading="loading" :error="error" @send="sendMessage" />
      </div>
      <ResearchWorkbench v-else-if="activeTab === 'research'" />
      <EvaluationHubView v-else-if="activeTab === 'evaluations'" />
      <KnowledgeBasePanel v-else-if="activeTab === 'knowledge'" />
      <SettingsView v-else :tab-visibility="tabVisibility" @update:tab-visibility="updateTabVisibility" />
    </section>

    <div v-if="deleteTarget" class="fixed inset-0 z-20 grid place-items-center bg-black/20 p-5" role="dialog" aria-modal="true" aria-label="删除会话确认">
      <div class="grid w-full max-w-md gap-4 rounded-lg border border-[var(--agent-border)] bg-[var(--agent-surface)] p-5 shadow-lg">
        <div class="flex items-start gap-3">
          <span class="grid size-9 shrink-0 place-items-center rounded-md bg-[var(--agent-error-bg)] text-[var(--agent-error-text)]"><PhTrash :size="18" weight="bold" aria-hidden="true" /></span>
          <div>
            <h2 class="m-0 text-base font-bold text-[var(--agent-text)]">删除会话</h2>
            <p class="m-0 mt-1 text-sm leading-5 text-[var(--agent-text-muted)]">“{{ deleteTarget.title }}”及其所有消息将被永久删除。</p>
          </div>
        </div>
        <div class="flex justify-end gap-2">
          <button type="button" class="inline-flex h-9 cursor-pointer items-center rounded-md border border-[var(--agent-border)] px-3 text-sm font-semibold text-[var(--agent-text)] hover:bg-[var(--agent-surface-muted)]" :disabled="deleting" @click="deleteTarget = undefined">取消</button>
          <button type="button" class="inline-flex h-9 cursor-pointer items-center gap-2 rounded-md bg-[var(--agent-error-text)] px-3 text-sm font-semibold text-white hover:opacity-90 disabled:cursor-wait disabled:opacity-60" :disabled="deleting" @click="confirmDeleteConversation"><PhTrash :size="16" weight="bold" aria-hidden="true" />{{ deleting ? '删除中' : '删除' }}</button>
        </div>
      </div>
    </div>
  </main>
</template>
