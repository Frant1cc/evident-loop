<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';
import {
  PhArrowClockwise,
  PhCheck,
  PhCircleNotch,
  PhCloudArrowDown,
  PhGearSix,
  PhGlobe,
  PhKey,
  PhLink,
  PhLockKeyOpen,
  PhPlus,
  PhTerminalWindow,
  PhTrash,
  PhWrench,
  PhX
} from '@phosphor-icons/vue';

import {
  authorizeMcpServer,
  createMcpServer,
  deleteMcpServer,
  listMcpServers,
  McpApiError,
  refreshMcpServer,
  setMcpServerEnabled,
  testMcpServer,
  updateMcpServer
} from '../../api/mcp';
import type { McpAuthMode, McpServer, McpServerDraft, McpServerStatus, McpTransport } from '../../types/mcp';
import { isMcpToolReadOnly } from '../../types/mcp';
import { getMcpOAuthPollMessage, getMcpOAuthPollState, getMcpSaveNotice } from '../../lib/mcpPresentation';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Switch } from '@/components/ui/switch';

type CredentialRow = { key: string; value: string; saved?: boolean };
type FormState = {
  id?: string;
  name: string;
  transport: McpTransport;
  command: string;
  argsText: string;
  cwd: string;
  env: CredentialRow[];
  envTouched: boolean;
  url: string;
  authMode: McpAuthMode;
  headers: CredentialRow[];
  headersTouched: boolean;
  oauthClientId: string;
  oauthClientSecret: string;
  oauthScope: string;
  oauthRedirectUri: string;
};

const servers = ref<McpServer[]>([]);
const editing = ref(false);
const form = ref<FormState>(createForm());
const error = ref('');
const notice = ref('');
const busy = ref('');
const oauthServerId = ref<string>();
const oauthCode = ref('');
const oauthState = ref('');
const advancedOAuthOpen = ref(false);
let oauthPollTimer: ReturnType<typeof window.setInterval> | undefined;
let oauthPollInFlight = false;
let oauthPollGeneration = 0;

const editingServerSnapshot = computed(() => servers.value.find((server) => server.id === form.value.id));
const editingServer = computed(() => {
  const server = editingServerSnapshot.value;
  if (!server) return undefined;
  if (server.transport !== form.value.transport) return undefined;
  if (server.transport === 'http' && server.authMode !== form.value.authMode) return undefined;
  return server;
});
const formTitle = computed(() => form.value.id ? '编辑 MCP 连接' : '新增 MCP 连接');
const oauthServer = computed(() => servers.value.find((server) => server.id === oauthServerId.value));

onMounted(loadServers);
onBeforeUnmount(stopOAuthPolling);

function createForm(server?: McpServer): FormState {
  return {
    id: server?.id,
    name: server?.name ?? '',
    transport: server?.transport ?? 'http',
    command: server?.command ?? '',
    argsText: server?.args?.join('\n') ?? '',
    cwd: server?.cwd ?? '',
    env: [],
    envTouched: false,
    url: server?.url ?? '',
    authMode: server?.authMode ?? 'none',
    headers: (server?.headerNames ?? []).map((key) => ({ key, value: '', saved: true })),
    headersTouched: false,
    oauthClientId: '',
    oauthClientSecret: '',
    oauthScope: '',
    oauthRedirectUri: ''
  };
}

async function loadServers() {
  try {
    const data = await listMcpServers();
    servers.value = data.servers;
  } catch (err) {
    error.value = getErrorMessage(err, '无法加载 MCP 服务器');
  }
}

function openNew() {
  editing.value = true;
  form.value = createForm();
  error.value = '';
  notice.value = '';
  advancedOAuthOpen.value = false;
}

function openEdit(server: McpServer) {
  editing.value = true;
  form.value = createForm(server);
  error.value = '';
  notice.value = '';
  advancedOAuthOpen.value = false;
}

function closeEditor() {
  if (busy.value.startsWith('save')) return;
  editing.value = false;
  error.value = '';
  notice.value = '';
}

function addRow(kind: 'env' | 'headers') {
  form.value[kind].push({ key: '', value: '' });
  form.value[kind === 'env' ? 'envTouched' : 'headersTouched'] = true;
}

function removeRow(kind: 'env' | 'headers', index: number) {
  form.value[kind].splice(index, 1);
  form.value[kind === 'env' ? 'envTouched' : 'headersTouched'] = true;
}

function touch(kind: 'env' | 'headers') {
  form.value[kind === 'env' ? 'envTouched' : 'headersTouched'] = true;
}

function handleAuthModeChange() {
  if (form.value.authMode === 'none') {
    form.value.headers = [];
    form.value.headersTouched = true;
    notice.value = '已切换为无认证；保存后旧 headers 不再发送。请保存后重新测试。';
  } else if (form.value.authMode === 'oauth') {
    // Static headers are deliberately discarded when entering OAuth mode so
    // Authorization can never be submitted alongside OAuth credentials.
    form.value.headers = [];
    form.value.headersTouched = true;
    notice.value = 'OAuth 模式不会提交静态 headers；保存后请重新测试并按授权链接完成流程。';
  } else {
    notice.value = '静态 headers 模式只会发送你重新填写的值；已保存值不会回显。';
  }
}

function handleTransportChange() {
  if (form.value.transport === 'stdio') {
    form.value.authMode = 'none';
    form.value.headers = [];
    form.value.headersTouched = true;
    notice.value = '已切换为 stdio；HTTP URL/headers/OAuth 不会提交。保存后请重新测试。';
  } else {
    notice.value = '已切换为 Streamable HTTP；保存后请重新测试连接。';
  }
}

function mapRows(rows: CredentialRow[]) {
  return Object.fromEntries(
    rows
      .map((row) => [row.key.trim(), row.value])
      .filter(([key, value]) => Boolean(key) && Boolean(value))
  );
}

function buildDraft(): McpServerDraft {
  const current = form.value;
  const draft: McpServerDraft = {
    ...(current.id ? { id: current.id } : {}),
    name: current.name.trim(),
    transport: current.transport,
    ...(current.id ? {} : { enabled: false }),
    authMode: current.transport === 'http' ? current.authMode : 'none'
  };

  if (current.transport === 'stdio') {
    draft.command = current.command.trim();
    draft.args = current.argsText.split(/\r?\n/).map((arg) => arg.trim()).filter(Boolean);
    if (current.cwd.trim()) draft.cwd = current.cwd.trim();
    if (current.envTouched) draft.env = mapRows(current.env);
  } else {
    draft.url = current.url.trim();
    if (current.authMode === 'headers' && current.headersTouched) draft.headers = mapRows(current.headers);
    if (current.authMode === 'oauth') {
      const oauth = {
        ...(current.oauthClientId.trim() ? { clientId: current.oauthClientId.trim() } : {}),
        ...(current.oauthClientSecret ? { clientSecret: current.oauthClientSecret } : {}),
        ...(current.oauthScope.trim() ? { scope: current.oauthScope.trim() } : {}),
        ...(current.oauthRedirectUri.trim() ? { redirectUri: current.oauthRedirectUri.trim() } : {})
      };
      if (Object.keys(oauth).length) draft.oauth = oauth;
    }
  }
  return draft;
}

function validateForm() {
  const current = form.value;
  if (!current.name.trim()) return '请填写连接名称';
  if (current.transport === 'stdio' && !current.command.trim()) return 'stdio 连接需要 command';
  if (current.transport === 'http' && !current.url.trim()) return 'Streamable HTTP 连接需要 URL';
  if (current.authMode === 'oauth' && current.headers.some((row) => row.key.trim().toLowerCase() === 'authorization')) {
    return 'OAuth 连接不能配置 Authorization 自定义 header';
  }
  const duplicate = current.headers.filter((row, index) => row.key.trim() && current.headers.findIndex((candidate) => candidate.key.trim().toLowerCase() === row.key.trim().toLowerCase()) !== index);
  if (duplicate.length) return 'header 名称不能重复';
  return undefined;
}

async function save() {
  const validationError = validateForm();
  if (validationError) {
    error.value = validationError;
    return;
  }
  busy.value = 'save';
  error.value = '';
  notice.value = '';
  try {
    const before = form.value.id ? editingServerSnapshot.value : undefined;
    const draft = buildDraft();
    const data = form.value.id
      ? await updateMcpServer(form.value.id, draft)
      : await createMcpServer(draft);
    const saveNotice = getMcpSaveNotice(before, data.server);
    upsertServer(data.server);
    form.value = createForm(data.server);
    editing.value = false;
    notice.value = saveNotice === 'created'
      ? '草稿已保存。请先测试连接，成功后再启用。'
      : saveNotice === 'changed'
        ? '配置已变更，请重新测试后再启用。'
        : saveNotice === 'renamed'
          ? before?.lastRefreshedAt ? '名称已更新，当前连接验证仍然有效。' : '名称已更新，仍需测试连接。'
          : before?.lastRefreshedAt ? '连接设置已保存，当前连接验证仍然有效。' : '连接设置已保存，仍需测试连接。';
  } catch (err) {
    error.value = getErrorMessage(err, '保存 MCP 连接失败');
  } finally {
    busy.value = '';
  }
}

async function test(server: McpServer) {
  busy.value = `test:${server.id}`;
  error.value = '';
  notice.value = '';
  try {
    const data = await testMcpServer(server.id);
    upsertServer(data.server);
    notice.value = data.server.status === 'authorization_required'
      ? '需要 OAuth 授权。'
      : data.server.status === 'connected'
        ? '连接测试通过，工具清单已更新。'
        : data.server.status === 'disabled' && data.server.lastRefreshedAt
          ? '连接测试通过，可启用。工具清单已更新。'
          : '测试已完成，请查看服务器状态。';
    if (data.server.status === 'authorization_required' && data.server.authorizationUrl) startOAuth(data.server);
  } catch (err) {
    error.value = getErrorMessage(err, 'MCP 连接测试失败');
    await loadServers();
  } finally {
    busy.value = '';
  }
}

async function toggle(server: McpServer, enabled: boolean) {
  busy.value = `toggle:${server.id}`;
  error.value = '';
  try {
    const data = await setMcpServerEnabled(server.id, enabled);
    upsertServer(data.server);
  } catch (err) {
    error.value = getErrorMessage(err, '更新 MCP 开关失败');
  } finally {
    busy.value = '';
  }
}

async function refresh(server: McpServer) {
  busy.value = `refresh:${server.id}`;
  error.value = '';
  try {
    const data = await refreshMcpServer(server.id);
    upsertServer(data.server);
  } catch (err) {
    error.value = getErrorMessage(err, '刷新工具清单失败');
    await loadServers();
  } finally {
    busy.value = '';
  }
}

async function remove(server: McpServer) {
  if (!window.confirm(`确定删除 MCP 连接“${server.name}”？工具清单和连接配置也会删除。`)) return;
  busy.value = `delete:${server.id}`;
  error.value = '';
  try {
    await deleteMcpServer(server.id);
    servers.value = servers.value.filter((item) => item.id !== server.id);
    if (form.value.id === server.id) closeEditor();
    if (oauthServerId.value === server.id) stopOAuthPolling();
  } catch (err) {
    error.value = getErrorMessage(err, '删除 MCP 连接失败');
  } finally {
    busy.value = '';
  }
}

function startOAuth(server: McpServer) {
  stopOAuthPolling();
  oauthServerId.value = server.id;
  oauthCode.value = '';
  oauthState.value = '';
  if (!server.authorizationUrl) {
    error.value = '服务器没有返回授权地址，可展开高级兜底输入授权 code。';
    advancedOAuthOpen.value = true;
    return;
  }
  advancedOAuthOpen.value = false;
  const popup = window.open(server.authorizationUrl, '_blank', 'noopener,noreferrer');
  notice.value = popup ? '授权页已在新窗口打开。完成后点击“我已完成授权”检查连接。' : '浏览器阻止了新窗口，请允许弹窗后再次点击“继续授权”。';
  oauthServerId.value = server.id;
  const generation = oauthPollGeneration;
  oauthPollTimer = window.setInterval(() => void pollOAuthStatus(generation), 2_000);
}

function stopOAuthPolling() {
  oauthPollGeneration += 1;
  if (oauthPollTimer !== undefined) window.clearInterval(oauthPollTimer);
  oauthPollTimer = undefined;
  oauthServerId.value = undefined;
}

async function pollOAuthStatus(generation = oauthPollGeneration) {
  const id = oauthServerId.value;
  if (!id || generation !== oauthPollGeneration || oauthPollInFlight) return undefined;
  oauthPollInFlight = true;
  try {
    const data = await listMcpServers();
    if (generation !== oauthPollGeneration || oauthServerId.value !== id) return undefined;
    servers.value = data.servers;
    const server = data.servers.find((item) => item.id === id);
    const pollState = server ? getMcpOAuthPollState(server) : undefined;
    if (server && pollState && pollState !== 'pending') {
      stopOAuthPolling();
      notice.value = getMcpOAuthPollMessage(pollState);
    }
    return server;
  } catch {
    // The manual check remains available when a background poll is interrupted.
    return undefined;
  } finally {
    oauthPollInFlight = false;
  }
}

async function checkOAuth() {
  const server = await pollOAuthStatus();
  notice.value = server ? getMcpOAuthPollMessage(getMcpOAuthPollState(server)) : '已重新检查服务器状态。';
}

async function authorizeAdvanced() {
  const id = form.value.id || oauthServerId.value;
  if (!id || !oauthCode.value.trim()) {
    error.value = '请输入授权 code';
    return;
  }
  busy.value = `authorize:${id}`;
  error.value = '';
  try {
    const data = await authorizeMcpServer(id, oauthCode.value.trim(), oauthState.value.trim() || undefined);
    upsertServer(data.server);
    oauthCode.value = '';
    oauthState.value = '';
    const pollState = getMcpOAuthPollState(data.server);
    notice.value = pollState === 'pending' ? '授权 code 已提交。' : getMcpOAuthPollMessage(pollState);
    if (pollState !== 'pending') stopOAuthPolling();
  } catch (err) {
    error.value = getErrorMessage(err, '提交授权 code 失败');
  } finally {
    busy.value = '';
  }
}

function upsertServer(server: McpServer) {
  const index = servers.value.findIndex((item) => item.id === server.id);
  if (index === -1) servers.value.unshift(server);
  else servers.value[index] = server;
}

function statusLabel(status: McpServerStatus) {
  return ({
    disabled: '已停用',
    connecting: '连接中',
    connected: '已连接',
    unavailable: '离线',
    authorization_required: '需要授权',
    credential_unavailable: '凭证不可用',
    error: '错误'
  } satisfies Record<McpServerStatus, string>)[status];
}

function statusClass(status: McpServerStatus) {
  if (status === 'connected') return 'border-emerald-500/25 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300';
  if (status === 'connecting') return 'border-sky-500/25 bg-sky-500/10 text-sky-700 dark:text-sky-300';
  if (status === 'authorization_required') return 'border-amber-500/25 bg-amber-500/10 text-amber-700 dark:text-amber-300';
  if (status === 'error' || status === 'credential_unavailable') return 'border-destructive/25 bg-destructive/10 text-destructive';
  return 'border-border bg-muted text-muted-foreground';
}

function formatDate(value?: string) {
  if (!value) return '尚未刷新';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '时间未知' : new Intl.DateTimeFormat('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }).format(date);
}

function getErrorMessage(value: unknown, fallback: string) {
  if (value instanceof McpApiError && value.status === 400 && value.message.includes('MCP_CREDENTIALS_KEY')) {
    return '后端未配置 MCP_CREDENTIALS_KEY，出于安全原因拒绝保存凭证。';
  }
  return value instanceof Error ? value.message : fallback;
}
</script>

<template>
  <section class="grid gap-6" aria-labelledby="mcp-settings-title">
    <header class="flex flex-col justify-between gap-4 border-b border-border pb-5 sm:flex-row sm:items-end">
      <div class="max-w-3xl">
        <p class="m-0 flex items-center gap-2 font-mono text-[10px] font-semibold uppercase tracking-[0.16em] text-muted-foreground"><PhLink :size="13" weight="bold" aria-hidden="true" /> Connection registry</p>
        <h2 id="mcp-settings-title" class="m-0 mt-1.5 text-xl font-semibold tracking-[-0.03em]">MCP 服务器</h2>
        <p class="m-0 mt-1.5 text-sm leading-6 text-muted-foreground">集中管理外部工具连接。新连接默认停用，必须通过测试后才能启用。</p>
      </div>
      <Button type="button" class="self-start sm:self-auto" @click="openNew"><PhPlus :size="16" weight="bold" aria-hidden="true" />新增连接</Button>
    </header>

    <p v-if="error" class="m-0 rounded-lg border border-destructive/20 bg-destructive/10 px-3 py-2.5 text-sm font-medium leading-5 text-destructive" role="alert">{{ error }}</p>
    <p v-if="notice" class="m-0 rounded-lg border border-emerald-500/20 bg-emerald-500/5 px-3 py-2.5 text-sm font-medium leading-5 text-emerald-800 dark:text-emerald-200" role="status">{{ notice }}</p>

    <div class="grid gap-4">
      <article v-for="server in servers" :key="server.id" class="overflow-hidden rounded-xl border border-border bg-card">
        <header class="flex flex-col gap-3 border-b border-border px-4 py-4 sm:flex-row sm:items-start sm:justify-between md:px-5">
          <div class="flex min-w-0 items-start gap-3">
            <span class="grid size-10 shrink-0 place-items-center rounded-lg border border-border bg-muted text-muted-foreground" aria-hidden="true"><PhTerminalWindow v-if="server.transport === 'stdio'" :size="19" weight="bold" /><PhGlobe v-else :size="19" weight="bold" /></span>
            <div class="min-w-0">
              <div class="flex flex-wrap items-center gap-2"><h3 class="m-0 truncate text-base font-semibold">{{ server.name }}</h3><Badge variant="secondary" class="font-mono text-[10px] uppercase">{{ server.transport }}</Badge><span class="rounded border px-1.5 py-0.5 font-mono text-[10px] font-semibold" :class="statusClass(server.status)">{{ statusLabel(server.status) }}</span></div>
              <p class="m-0 mt-1 break-all font-mono text-[10px] leading-4 text-muted-foreground">{{ server.transport === 'stdio' ? server.command : server.url }}</p>
              <p v-if="server.lastError" class="m-0 mt-2 text-xs leading-5 text-destructive">{{ server.lastError }}</p>
            </div>
          </div>
          <div class="flex shrink-0 items-center gap-3 sm:pt-0.5"><span class="text-xs text-muted-foreground">{{ server.enabled ? '已启用' : '已停用' }}</span><Switch :model-value="server.enabled" :disabled="busy !== ''" :aria-label="`${server.name}服务器总开关`" @update:model-value="toggle(server, $event)" /></div>
        </header>

        <div class="grid gap-4 px-4 py-4 md:grid-cols-[minmax(0,1fr)_minmax(260px,0.8fr)] md:px-5">
          <div class="grid gap-2">
            <div class="flex flex-wrap items-center justify-between gap-2"><h4 class="m-0 text-xs font-semibold">工具清单 · {{ server.tools.length }}</h4><span class="font-mono text-[10px] text-muted-foreground">最近刷新 {{ formatDate(server.lastRefreshedAt) }}</span></div>
            <div v-if="server.tools.length" class="grid gap-2">
              <div v-for="tool in server.tools" :key="`${tool.remoteName}-${tool.ordinal}`" class="rounded-lg border border-border/80 bg-muted/30 px-3 py-2.5">
                <div class="flex items-start justify-between gap-3"><div class="min-w-0"><p class="m-0 break-all font-mono text-xs font-semibold">{{ tool.remoteName }}</p><p class="m-0 mt-0.5 break-all font-mono text-[10px] text-muted-foreground">{{ tool.modelName }}</p></div><span class="shrink-0 rounded border px-1.5 py-0.5 text-[10px] font-semibold" :class="tool.tombstone ? 'border-border bg-muted text-muted-foreground' : isMcpToolReadOnly(tool) ? 'border-sky-500/20 bg-sky-500/10 text-sky-700 dark:text-sky-300' : 'border-amber-500/20 bg-amber-500/10 text-amber-700 dark:text-amber-300'">{{ tool.tombstone ? '历史工具' : isMcpToolReadOnly(tool) ? '在线 · 只读' : '在线 · 有副作用 · 逐次审批' }}</span></div>
                <p v-if="tool.description" class="m-0 mt-2 line-clamp-2 text-xs leading-5 text-muted-foreground">{{ tool.description }}</p>
              </div>
            </div>
            <p v-else class="m-0 rounded-lg border border-dashed border-border px-3 py-5 text-center text-xs leading-5 text-muted-foreground">测试或刷新后，服务器返回的工具会显示在这里。</p>
          </div>

          <aside class="grid content-start gap-3 rounded-lg border border-border/80 bg-muted/20 p-3.5">
            <div class="flex items-center justify-between gap-3"><span class="text-xs font-semibold">连接状态</span><span class="font-mono text-[10px] text-muted-foreground">{{ formatDate(server.lastRefreshedAt) }}</span></div>
            <p class="m-0 text-xs leading-5 text-muted-foreground">{{ server.hasCredentials ? '已保存凭证（不会在浏览器中回显）' : server.authMode === 'oauth' ? '等待 OAuth 授权' : '未配置凭证' }}</p>
            <div class="flex flex-wrap gap-2"><Button type="button" variant="outline" size="sm" :disabled="busy !== ''" @click="test(server)"><PhCircleNotch v-if="busy === `test:${server.id}`" class="animate-spin motion-reduce:animate-none" :size="14" aria-hidden="true" /><PhWrench v-else :size="14" weight="bold" aria-hidden="true" />测试</Button><Button type="button" variant="outline" size="sm" :disabled="busy !== ''" @click="refresh(server)"><PhCircleNotch v-if="busy === `refresh:${server.id}`" class="animate-spin motion-reduce:animate-none" :size="14" aria-hidden="true" /><PhArrowClockwise v-else :size="14" weight="bold" aria-hidden="true" />刷新</Button><Button v-if="server.status === 'authorization_required'" type="button" variant="outline" size="sm" :disabled="busy !== ''" @click="startOAuth(server)"><PhLockKeyOpen :size="14" weight="bold" aria-hidden="true" />继续授权</Button></div>
            <div v-if="server.authorizationUrl" class="rounded-md border border-amber-500/20 bg-amber-500/5 px-2.5 py-2 text-[11px] leading-5 text-amber-800 dark:text-amber-200">授权链接已就绪。主流程会打开新窗口，不需要粘贴 token。</div>
            <div class="flex flex-wrap gap-x-3 gap-y-1 text-[10px] text-muted-foreground"><span>{{ server.tools.filter((tool) => tool.tombstone).length }} 个历史工具</span><span v-if="server.headerNames?.length">{{ server.headerNames.length }} 个已保存 header</span></div>
          </aside>
        </div>

        <footer class="flex flex-wrap items-center justify-end gap-2 border-t border-border bg-muted/20 px-4 py-3 md:px-5"><Button type="button" variant="ghost" size="sm" :disabled="busy !== ''" @click="openEdit(server)"><PhGearSix :size="14" weight="bold" aria-hidden="true" />编辑</Button><Button type="button" variant="ghost" size="sm" class="text-destructive hover:text-destructive" :disabled="busy !== ''" @click="remove(server)"><PhTrash :size="14" weight="bold" aria-hidden="true" />删除</Button></footer>
      </article>
      <div v-if="!servers.length" class="grid justify-items-center gap-3 rounded-xl border border-dashed border-border px-5 py-12 text-center"><span class="grid size-11 place-items-center rounded-xl bg-muted text-muted-foreground"><PhLink :size="20" weight="bold" aria-hidden="true" /></span><div><h3 class="m-0 text-sm font-semibold">还没有 MCP 连接</h3><p class="m-0 mt-1 text-sm leading-6 text-muted-foreground">添加一个停用草稿，测试通过后再将工具接入研究和 Agent 运行时。</p></div><Button type="button" variant="outline" @click="openNew"><PhPlus :size="15" weight="bold" aria-hidden="true" />新增连接</Button></div>
    </div>

    <section v-if="editing" class="overflow-hidden rounded-xl border border-border bg-card" aria-labelledby="mcp-editor-title">
      <header class="flex items-start justify-between gap-4 border-b border-border px-4 py-4 md:px-5"><div><p class="m-0 font-mono text-[10px] font-semibold uppercase tracking-[0.12em] text-muted-foreground">Draft configuration</p><h2 id="mcp-editor-title" class="m-0 mt-1 text-base font-semibold">{{ formTitle }}</h2></div><Button type="button" variant="ghost" size="icon" aria-label="关闭编辑器" @click="closeEditor"><PhX :size="17" aria-hidden="true" /></Button></header>
      <form class="grid gap-5 p-4 md:p-5" @submit.prevent="save">
        <div class="grid gap-4 md:grid-cols-2"><label class="grid gap-1.5 text-xs font-semibold">连接名称<input v-model="form.name" class="h-10 rounded-lg border border-input bg-background px-3 text-sm font-normal outline-none focus-visible:ring-3 focus-visible:ring-ring/50" autocomplete="off" placeholder="例如：团队知识 MCP" /></label><label class="grid gap-1.5 text-xs font-semibold">传输方式<select v-model="form.transport" class="h-10 rounded-lg border border-input bg-background px-3 text-sm font-normal outline-none focus-visible:ring-3 focus-visible:ring-ring/50" @change="handleTransportChange"><option value="stdio">stdio（本机进程）</option><option value="http">Streamable HTTP</option></select></label></div>
        <div v-if="form.transport === 'stdio'" class="grid gap-4 rounded-lg border border-border/80 bg-muted/20 p-4 md:grid-cols-2"><label class="grid gap-1.5 text-xs font-semibold">command<input v-model="form.command" class="h-10 rounded-lg border border-input bg-background px-3 text-sm font-normal outline-none focus-visible:ring-3 focus-visible:ring-ring/50" autocomplete="off" placeholder="例如：npx" /></label><label class="grid gap-1.5 text-xs font-semibold">cwd（可选）<input v-model="form.cwd" class="h-10 rounded-lg border border-input bg-background px-3 text-sm font-normal outline-none focus-visible:ring-3 focus-visible:ring-ring/50" autocomplete="off" placeholder="工作目录" /></label><label class="grid gap-1.5 text-xs font-semibold md:col-span-2">args（每行一个参数）<textarea v-model="form.argsText" rows="3" class="rounded-lg border border-input bg-background px-3 py-2 text-sm font-normal outline-none focus-visible:ring-3 focus-visible:ring-ring/50" placeholder="-y&#10;@acme/mcp-server" /></label><div class="grid gap-2 md:col-span-2"><div class="flex items-center justify-between gap-2"><span class="text-xs font-semibold">环境变量（仅在本次编辑中暂存）</span><Button type="button" variant="ghost" size="sm" @click="addRow('env')"><PhPlus :size="13" weight="bold" aria-hidden="true" />添加</Button></div><div v-for="(row, index) in form.env" :key="index" class="grid grid-cols-[minmax(0,1fr)_minmax(0,1fr)_auto] gap-2"><input v-model="row.key" class="h-9 min-w-0 rounded-md border border-input bg-background px-2.5 text-xs outline-none focus-visible:ring-3 focus-visible:ring-ring/50" placeholder="KEY" @input="touch('env')" /><input v-model="row.value" type="password" class="h-9 min-w-0 rounded-md border border-input bg-background px-2.5 text-xs outline-none focus-visible:ring-3 focus-visible:ring-ring/50" placeholder="值（不会回显）" autocomplete="new-password" @input="touch('env')" /><Button type="button" variant="ghost" size="icon-sm" aria-label="删除环境变量" @click="removeRow('env', index)"><PhTrash :size="13" aria-hidden="true" /></Button></div><p v-if="editingServer?.hasCredentials" class="m-0 text-[11px] leading-5 text-muted-foreground"><PhKey :size="12" class="mr-1 inline" aria-hidden="true" />已有凭证不会回显；如需替换，请重新填写对应键值。未配置 MCP_CREDENTIALS_KEY 时后端会拒绝保存凭证。</p></div></div>

        <div v-else class="grid gap-4 rounded-lg border border-border/80 bg-muted/20 p-4"><label class="grid gap-1.5 text-xs font-semibold">Streamable HTTP URL<input v-model="form.url" type="url" class="h-10 rounded-lg border border-input bg-background px-3 text-sm font-normal outline-none focus-visible:ring-3 focus-visible:ring-ring/50" autocomplete="off" placeholder="https://example.com/mcp" /></label><label class="grid gap-1.5 text-xs font-semibold">认证方式<select v-model="form.authMode" class="h-10 rounded-lg border border-input bg-background px-3 text-sm font-normal outline-none focus-visible:ring-3 focus-visible:ring-ring/50" @change="handleAuthModeChange"><option value="none">无认证</option><option value="headers">静态 headers</option><option value="oauth">OAuth 2.0</option></select></label><p v-if="form.authMode === 'none'" class="m-0 rounded-md border border-border/80 bg-background/60 px-3 py-2 text-[11px] leading-5 text-muted-foreground">无认证模式不会发送旧 headers；保存后需要重新测试连接。</p>
          <div v-if="form.authMode === 'headers'" class="grid gap-2"><div class="flex items-center justify-between gap-2"><span class="text-xs font-semibold">静态 headers</span><Button type="button" variant="ghost" size="sm" @click="addRow('headers')"><PhPlus :size="13" weight="bold" aria-hidden="true" />添加</Button></div><div v-for="(row, index) in form.headers" :key="index" class="grid grid-cols-[minmax(0,1fr)_minmax(0,1fr)_auto] gap-2"><input v-model="row.key" class="h-9 min-w-0 rounded-md border border-input bg-background px-2.5 text-xs outline-none focus-visible:ring-3 focus-visible:ring-ring/50" placeholder="Header-Name" @input="touch('headers')" /><input v-model="row.value" type="password" class="h-9 min-w-0 rounded-md border border-input bg-background px-2.5 text-xs outline-none focus-visible:ring-3 focus-visible:ring-ring/50" :placeholder="row.saved ? '已保存值（不回显）' : '值（不会回显）'" autocomplete="new-password" @input="touch('headers')" /><Button type="button" variant="ghost" size="icon-sm" aria-label="删除 header" @click="removeRow('headers', index)"><PhTrash :size="13" aria-hidden="true" /></Button></div><p v-if="editingServer?.headerNames?.length" class="m-0 text-[11px] leading-5 text-muted-foreground"><PhKey :size="12" class="mr-1 inline" aria-hidden="true" />已保存的 header 名称：{{ editingServer.headerNames.join('、') }}；值不会回传。更改后请重新填写需要保留的值。</p></div>
          <div v-if="form.authMode === 'oauth'" class="grid gap-4 rounded-lg border border-amber-500/20 bg-amber-500/5 p-3.5"><p class="m-0 flex items-start gap-2 text-xs leading-5 text-amber-800 dark:text-amber-200"><PhLockKeyOpen :size="15" class="mt-0.5 shrink-0" aria-hidden="true" />OAuth 会在测试时返回授权地址。浏览器将打开新窗口，不需要复制 token；回调当前以 JSON 响应结束。</p><div class="grid gap-4 md:grid-cols-2"><label class="grid gap-1.5 text-xs font-semibold">Client ID<input v-model="form.oauthClientId" class="h-9 rounded-md border border-input bg-background px-2.5 text-xs font-normal outline-none focus-visible:ring-3 focus-visible:ring-ring/50" autocomplete="off" /></label><label class="grid gap-1.5 text-xs font-semibold">Client Secret<input v-model="form.oauthClientSecret" type="password" class="h-9 rounded-md border border-input bg-background px-2.5 text-xs font-normal outline-none focus-visible:ring-3 focus-visible:ring-ring/50" autocomplete="new-password" placeholder="不会回显" /></label><label class="grid gap-1.5 text-xs font-semibold">Scope<input v-model="form.oauthScope" class="h-9 rounded-md border border-input bg-background px-2.5 text-xs font-normal outline-none focus-visible:ring-3 focus-visible:ring-ring/50" placeholder="可选" /></label><label class="grid gap-1.5 text-xs font-semibold">Redirect URI<input v-model="form.oauthRedirectUri" type="url" class="h-9 rounded-md border border-input bg-background px-2.5 text-xs font-normal outline-none focus-visible:ring-3 focus-visible:ring-ring/50" placeholder="可选，需与 provider 一致" /></label></div><p v-if="editingServer?.hasCredentials" class="m-0 text-[11px] leading-5 text-muted-foreground">已有 OAuth 凭证已保存但不会回显。留空表示不替换已保存值。</p></div>
        </div>

        <div class="grid gap-2 rounded-lg border border-border/80 bg-muted/20 px-3.5 py-3 text-xs leading-5 text-muted-foreground"><p class="m-0 flex items-start gap-2"><PhCloudArrowDown :size="14" class="mt-0.5 shrink-0" aria-hidden="true" />新建连接始终以“已停用”草稿保存。测试成功后，回到服务器卡片打开总开关。</p><p v-if="form.transport === 'stdio'" class="m-0 flex items-start gap-2"><PhTerminalWindow :size="14" class="mt-0.5 shrink-0" aria-hidden="true" />stdio 只允许回环部署；非回环后端会拒绝启用并返回明确错误。</p></div>
        <footer class="flex flex-wrap items-center justify-end gap-2"><Button type="button" variant="outline" :disabled="busy === 'save'" @click="closeEditor">取消</Button><Button type="submit" :disabled="busy === 'save'"><PhCircleNotch v-if="busy === 'save'" class="animate-spin motion-reduce:animate-none" :size="15" aria-hidden="true" /><PhCheck v-else :size="15" weight="bold" aria-hidden="true" />{{ busy === 'save' ? '保存中' : '保存停用草稿' }}</Button></footer>
      </form>
    </section>

    <section v-if="oauthServerId && oauthServer" class="grid gap-3 rounded-xl border border-amber-500/25 bg-amber-500/[0.035] p-4" aria-live="polite" aria-label="OAuth 授权状态"><div class="flex flex-wrap items-start justify-between gap-3"><div><p class="m-0 text-[11px] font-semibold uppercase tracking-[0.12em] text-amber-800 dark:text-amber-200">OAuth authorization</p><h2 class="m-0 mt-1 text-base font-semibold">{{ oauthServer.name }} 正在等待授权</h2><p class="m-0 mt-1 text-xs leading-5 text-muted-foreground">后台会轻量轮询状态；如果已完成授权，可手动重新检查。</p></div><Button type="button" variant="outline" size="sm" @click="stopOAuthPolling">取消轮询</Button></div><div class="flex flex-wrap gap-2"><Button type="button" size="sm" @click="checkOAuth"><PhArrowClockwise :size="14" weight="bold" aria-hidden="true" />我已完成授权 · 重新检查</Button><Button type="button" variant="outline" size="sm" @click="startOAuth(oauthServer)"><PhLockKeyOpen :size="14" weight="bold" aria-hidden="true" />重新打开授权页</Button></div><details :open="advancedOAuthOpen" class="rounded-lg border border-border/80 bg-background/60 p-3"><summary class="cursor-pointer text-xs font-semibold text-muted-foreground">高级兜底：手动提交 authorization code / state</summary><div class="mt-3 grid gap-3 md:grid-cols-2"><label class="grid gap-1.5 text-xs font-semibold">Code<input v-model="oauthCode" type="password" class="h-9 rounded-md border border-input bg-background px-2.5 text-xs font-normal outline-none focus-visible:ring-3 focus-visible:ring-ring/50" autocomplete="off" /></label><label class="grid gap-1.5 text-xs font-semibold">State（可选）<input v-model="oauthState" class="h-9 rounded-md border border-input bg-background px-2.5 text-xs font-normal outline-none focus-visible:ring-3 focus-visible:ring-ring/50" autocomplete="off" /></label><Button type="button" class="w-fit" size="sm" :disabled="busy === `authorize:${oauthServer.id}`" @click="authorizeAdvanced"><PhCircleNotch v-if="busy === `authorize:${oauthServer.id}`" class="animate-spin" :size="14" aria-hidden="true" /><PhCheck v-else :size="14" weight="bold" aria-hidden="true" />提交授权 code</Button></div></details></section>
  </section>
</template>
