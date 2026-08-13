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
import KnowledgeBasePanel from '../components/chat/KnowledgeBasePanel.vue';
import AppShell from '../components/layout/AppShell.vue';
import WorkspaceSidebarLayout from '../components/layout/WorkspaceSidebarLayout.vue';
import AppTopNavigation from '../components/navigation/AppTopNavigation.vue';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '@/components/ui/dialog';
import { useStreamingMessageRenderer } from '../composables/useStreamingMessageRenderer';
import { useResizablePanel, type PanelWidthBounds } from '../composables/useResizablePanel';
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
const activeTab = ref<AppTabKey>(tabVisibility.value.chat ? 'chat' : 'settings');
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
const chatSidebarBounds: PanelWidthBounds = { defaultWidth: 264, min: 60, max: 440 };
const chatSidebarWidth = useResizablePanel('chat:sidebar-width', chatSidebarBounds);
const chatSidebarCompact = computed(() => sidebarCollapsed.value || chatSidebarWidth.value < 128);

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
  messageRenderer.beginStream();
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
    messageRenderer.markTerminal();
    messageRenderer.upsert(event.message);
    streamingAssistantMessageId = undefined;
  }
  if (event.type === 'error') {
    messageRenderer.markTerminal();
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

function toggleChatSidebar() {
  if (sidebarCollapsed.value) {
    sidebarCollapsed.value = false;
    if (chatSidebarWidth.value < 128) chatSidebarWidth.value = chatSidebarBounds.defaultWidth;
    return;
  }

  if (chatSidebarWidth.value < 128) {
    chatSidebarWidth.value = chatSidebarBounds.defaultWidth;
    return;
  }

  sidebarCollapsed.value = true;
}
</script>

<template>
  <AppShell>
    <template #navigation>
      <AppTopNavigation :active-tab="activeTab" :tab-visibility="tabVisibility" @change="changeTab" />
    </template>

      <KeepAlive>
        <TaskConsoleView v-if="activeTab === 'tasks'" key="tasks" />
        <WorkspaceSidebarLayout
          v-else-if="activeTab === 'chat'"
          key="chat"
          v-model:width="chatSidebarWidth"
          :collapsed="sidebarCollapsed"
          :collapsed-width="60"
          :min-width="chatSidebarBounds.min"
          :max-width="chatSidebarBounds.max"
          :default-width="chatSidebarBounds.defaultWidth"
          resize-label="调整会话栏宽度"
        >
          <template #sidebar>
            <ChatSidebar :sessions="conversations" :active-session-id="activeConversationId" :collapsed="chatSidebarCompact" :busy="loading || deleting" @create="createConversation" @select="selectConversation" @delete="deleteTarget = $event" @toggle-collapse="toggleChatSidebar" />
          </template>
          <ChatPanel v-model="input" :conversation-id="activeConversationId" :conversation-title="activeConversation?.title" :messages="messages" :loading="loading" :error="error" @send="sendMessage" />
        </WorkspaceSidebarLayout>
        <ResearchWorkbench v-else-if="activeTab === 'research'" key="research" />
        <EvaluationHubView v-else-if="activeTab === 'evaluations'" key="evaluations" />
        <KnowledgeBasePanel v-else-if="activeTab === 'knowledge'" key="knowledge" />
        <SettingsView v-else-if="activeTab === 'settings'" key="settings" :tab-visibility="tabVisibility" @update:tab-visibility="updateTabVisibility" />
      </KeepAlive>
    <Dialog :open="Boolean(deleteTarget)" @update:open="deleteTarget = $event ? deleteTarget : undefined">
      <DialogContent class="sm:max-w-md">
        <DialogHeader>
          <div class="mb-1 flex size-10 items-center justify-center rounded-lg bg-destructive/10 text-destructive">
            <PhTrash :size="19" weight="bold" aria-hidden="true" />
          </div>
          <DialogTitle>删除会话</DialogTitle>
          <DialogDescription>
            “{{ deleteTarget?.title }}”及其所有消息将被永久删除，此操作无法撤销。
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
  </AppShell>
</template>
