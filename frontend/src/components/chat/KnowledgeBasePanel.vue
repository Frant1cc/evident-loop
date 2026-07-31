<script setup lang="ts">
import {
  PhArrowClockwise,
  PhCheckCircle,
  PhDatabase,
  PhEye,
  PhFilePlus,
  PhFileText,
  PhFloppyDisk,
  PhMagnifyingGlass,
  PhPlus,
  PhStack,
  PhTrash,
  PhUploadSimple,
  PhWarningCircle,
  PhX
} from '@phosphor-icons/vue';
import { computed, onMounted, ref } from 'vue';
import {
  createKnowledgeDocument,
  deleteKnowledgeDocument,
  listKnowledgeDocuments,
  previewKnowledgeChunks,
  readKnowledgeDocument,
  syncKnowledgeBase,
  updateKnowledgeDocument,
  vectorizeKnowledgeDocument,
  type KnowledgeChunk,
  type KnowledgeDocumentDetail,
  type KnowledgeDocumentSummary,
  type KnowledgeIndexResult
} from '../../api/knowledge';

type EditorMode = 'create' | 'edit' | 'view';

const searchQuery = ref('');
const documents = ref<KnowledgeDocumentSummary[]>([]);
const summary = ref({ documentCount: 0, indexedDocumentCount: 0, chunkCount: 0, indexedChunkCount: 0 });
const selectedPath = ref<string>();
const selectedDocument = ref<KnowledgeDocumentDetail>();
const editorMode = ref<EditorMode>('view');
const draftPath = ref('');
const draftContent = ref('');
const autoIndex = ref(true);
const chunks = ref<KnowledgeChunk[]>([]);
const chunkPath = ref<string>();
const loadingChunks = ref(false);
const loading = ref(false);
const loadingDocument = ref(false);
const saving = ref(false);
const syncing = ref(false);
const vectorizingPath = ref<string>();
const deleteTarget = ref<KnowledgeDocumentSummary>();
const deleting = ref(false);
const error = ref('');
const notice = ref('');
const lastSync = ref('');
const indexResult = ref<KnowledgeIndexResult>();
const fileInput = ref<HTMLInputElement>();
const maxUploadBytes = 1_000_000;

const filteredDocuments = computed(() => {
  const query = searchQuery.value.trim().toLocaleLowerCase();

  if (!query) return documents.value;

  return documents.value.filter((document) =>
    document.path.toLocaleLowerCase().includes(query) || document.title.toLocaleLowerCase().includes(query)
  );
});

const statusLabel: Record<KnowledgeDocumentSummary['indexStatus'], string> = {
  indexed: '已索引',
  pending: '待向量化',
  outdated: '需更新',
  unavailable: '索引不可用'
};

onMounted(loadDocuments);

async function loadDocuments() {
  loading.value = true;
  error.value = '';

  try {
    const result = await listKnowledgeDocuments();
    documents.value = result.documents;
    summary.value = result.summary;
  } catch (err) {
    error.value = getErrorMessage(err);
  } finally {
    loading.value = false;
  }
}

async function selectDocument(path: string) {
  if (selectedPath.value === path && selectedDocument.value) return;

  selectedPath.value = path;
  selectedDocument.value = undefined;
  editorMode.value = 'view';
  chunks.value = [];
  chunkPath.value = undefined;
  indexResult.value = undefined;
  error.value = '';
  loadingDocument.value = true;

  try {
    const document = await readKnowledgeDocument(path);
    selectedDocument.value = document;
    draftPath.value = document.path;
    draftContent.value = document.content;
  } catch (err) {
    error.value = getErrorMessage(err);
  } finally {
    loadingDocument.value = false;
  }
}

function startCreating() {
  selectedPath.value = undefined;
  selectedDocument.value = undefined;
  draftPath.value = 'untitled.md';
  draftContent.value = '# 新文档\n\n';
  autoIndex.value = true;
  chunks.value = [];
  chunkPath.value = undefined;
  indexResult.value = undefined;
  editorMode.value = 'create';
  error.value = '';
  notice.value = '';
}

function openFilePicker() {
  fileInput.value?.click();
}

async function uploadMarkdownFile(event: Event) {
  const input = event.target as HTMLInputElement;
  const file = input.files?.[0];
  input.value = '';

  if (!file) return;

  if (!file.name.toLowerCase().endsWith('.md')) {
    error.value = '只能上传 .md 文件。';
    return;
  }

  if (file.size > maxUploadBytes) {
    error.value = 'Markdown 文件不能超过 1 MB。';
    return;
  }

  try {
    const content = await file.text();

    if (!content.trim()) {
      error.value = 'Markdown 文件内容不能为空。';
      return;
    }

    selectedPath.value = undefined;
    selectedDocument.value = undefined;
    draftPath.value = file.name;
    draftContent.value = content;
    autoIndex.value = true;
    chunks.value = [];
    chunkPath.value = undefined;
    indexResult.value = undefined;
    editorMode.value = 'create';
    error.value = '';
    notice.value = '文件内容已载入，请确认后保存。';
  } catch (err) {
    error.value = getErrorMessage(err);
  }
}

function startEditing() {
  if (!selectedDocument.value) return;

  draftPath.value = selectedDocument.value.path;
  draftContent.value = selectedDocument.value.content;
  autoIndex.value = true;
  chunks.value = [];
  chunkPath.value = undefined;
  indexResult.value = undefined;
  editorMode.value = 'edit';
  error.value = '';
  notice.value = '';
}

function cancelEditing() {
  if (editorMode.value === 'create') {
    selectedPath.value = undefined;
    selectedDocument.value = undefined;
    draftPath.value = '';
    draftContent.value = '';
  } else if (selectedDocument.value) {
    draftPath.value = selectedDocument.value.path;
    draftContent.value = selectedDocument.value.content;
  }

  editorMode.value = 'view';
  error.value = '';
}

async function saveDocument() {
  const path = draftPath.value.trim();
  const content = draftContent.value;

  if (!path.endsWith('.md')) {
    error.value = '文档路径必须以 .md 结尾。';
    return;
  }

  if (!content.trim()) {
    error.value = '文档内容不能为空。';
    return;
  }

  saving.value = true;
  error.value = '';
  notice.value = '';

  try {
    const result = editorMode.value === 'create'
      ? await createKnowledgeDocument({ path, content, autoIndex: autoIndex.value })
      : await updateKnowledgeDocument({ path, content, autoIndex: autoIndex.value });

    selectedPath.value = result.document.path;
    selectedDocument.value = result.document;
    draftPath.value = result.document.path;
    draftContent.value = result.document.content;
    indexResult.value = result.indexResult;
    editorMode.value = 'view';
    notice.value = autoIndex.value ? '文档已保存并完成索引处理。' : '文档已保存，等待手动向量化。';
    await loadDocuments();
  } catch (err) {
    error.value = getErrorMessage(err);
  } finally {
    saving.value = false;
  }
}

async function showChunks(path = selectedPath.value) {
  if (!path || loadingChunks.value) return;

  if (chunkPath.value === path) {
    chunkPath.value = undefined;
    return;
  }

  loadingChunks.value = true;
  error.value = '';
  notice.value = '';

  try {
    const result = await previewKnowledgeChunks(path);
    chunks.value = result.chunks;
    chunkPath.value = result.path;
  } catch (err) {
    error.value = getErrorMessage(err);
  } finally {
    loadingChunks.value = false;
  }
}

async function vectorizeDocument(path = selectedPath.value) {
  if (!path || vectorizingPath.value) return;

  vectorizingPath.value = path;
  error.value = '';
  notice.value = '';

  try {
    indexResult.value = await vectorizeKnowledgeDocument(path);
    notice.value = '文档已完成向量化。';
    await loadDocuments();
  } catch (err) {
    error.value = getErrorMessage(err);
  } finally {
    vectorizingPath.value = undefined;
  }
}

async function syncKnowledge() {
  if (syncing.value) return;

  syncing.value = true;
  error.value = '';
  notice.value = '';

  try {
    const result = await syncKnowledgeBase();
    lastSync.value = `已同步 ${result.documents} 篇文档，更新 ${result.upserted} 个片段`;
    notice.value = '知识库索引已同步。';
    await loadDocuments();
  } catch (err) {
    error.value = getErrorMessage(err);
  } finally {
    syncing.value = false;
  }
}

async function confirmDelete() {
  const target = deleteTarget.value;
  if (!target || deleting.value) return;

  deleting.value = true;
  error.value = '';

  try {
    await deleteKnowledgeDocument(target.path, autoIndex.value);

    if (selectedPath.value === target.path) {
      selectedPath.value = undefined;
      selectedDocument.value = undefined;
      chunks.value = [];
      chunkPath.value = undefined;
      editorMode.value = 'view';
    }

    deleteTarget.value = undefined;
    notice.value = '文档已删除。';
    await loadDocuments();
  } catch (err) {
    error.value = getErrorMessage(err);
    deleteTarget.value = undefined;
  } finally {
    deleting.value = false;
  }
}

function formatDate(value?: string) {
  if (!value) return '尚未索引';

  return new Intl.DateTimeFormat('zh-CN', {
    month: 'numeric',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit'
  }).format(new Date(value));
}

function getErrorMessage(error: unknown) {
  return error instanceof Error ? error.message : '请求失败，请稍后重试。';
}
</script>

<template>
  <section class="min-h-0 overflow-auto bg-[var(--agent-surface)]" aria-label="知识库管理">
    <div class="mx-auto grid w-full max-w-7xl gap-6 px-5 py-7 md:px-8 md:py-9">
      <header class="flex flex-wrap items-end justify-between gap-5 border-b border-[var(--agent-border)] pb-6">
        <div>
          <p class="m-0 font-mono text-[11px] font-semibold uppercase tracking-[0.12em] text-[var(--agent-text-muted)]">Knowledge Base</p>
          <h1 class="m-0 mt-2 text-2xl font-bold leading-tight text-[var(--agent-text)]">知识库</h1>
          <p class="m-0 mt-2 text-sm leading-6 text-[var(--agent-text-muted)]">管理智能体用于检索的 Markdown 文档与索引。</p>
        </div>

        <div class="flex flex-wrap items-center gap-2">
          <button
            type="button"
            class="inline-flex h-9 cursor-pointer items-center gap-2 rounded-md border border-[var(--agent-border)] bg-[var(--agent-surface)] px-3 text-sm font-semibold text-[var(--agent-text)] transition-colors hover:bg-[var(--agent-surface-muted)] disabled:cursor-wait disabled:opacity-60"
            :disabled="syncing"
            @click="syncKnowledge"
          >
            <PhArrowClockwise :size="16" weight="bold" :class="syncing ? 'animate-spin' : ''" aria-hidden="true" />
            {{ syncing ? '同步中' : '同步索引' }}
          </button>
          <button type="button" class="inline-flex h-9 cursor-pointer items-center gap-2 rounded-md border border-[var(--agent-border)] bg-[var(--agent-surface)] px-3 text-sm font-semibold text-[var(--agent-text)] transition-colors hover:bg-[var(--agent-surface-muted)]" @click="openFilePicker">
            <PhUploadSimple :size="16" weight="bold" aria-hidden="true" />
            上传 Markdown
          </button>
          <button type="button" class="inline-flex h-9 cursor-pointer items-center gap-2 rounded-md bg-[var(--agent-primary)] px-3 text-sm font-semibold text-[var(--agent-primary-text)] transition-colors hover:bg-[var(--agent-primary-hover)]" @click="startCreating">
            <PhPlus :size="16" weight="bold" aria-hidden="true" />
            添加文档
          </button>
          <input ref="fileInput" class="sr-only" type="file" accept=".md,text/markdown,text/plain" @change="uploadMarkdownFile" />
        </div>
      </header>

      <p v-if="error" role="alert" class="m-0 rounded-md border border-[var(--agent-error-text)] bg-[var(--agent-error-bg)] px-4 py-3 text-sm font-medium text-[var(--agent-error-text)]">{{ error }}</p>
      <p v-else-if="notice" class="m-0 rounded-md border border-[var(--agent-border)] bg-[var(--agent-surface-muted)] px-4 py-3 text-sm font-medium text-[var(--agent-text)]">{{ notice }}</p>

      <section class="grid gap-px overflow-hidden rounded-lg border border-[var(--agent-border)] bg-[var(--agent-border)] sm:grid-cols-3" aria-label="知识库概况">
        <div class="bg-[var(--agent-surface)] px-5 py-4">
          <p class="m-0 font-mono text-[10px] font-bold uppercase tracking-[0.1em] text-[var(--agent-text-muted)]">文档</p>
          <p class="m-0 mt-2 text-2xl font-bold text-[var(--agent-text)]">{{ summary.documentCount }}</p>
          <p class="m-0 mt-1 text-xs font-medium text-[var(--agent-text-muted)]">{{ summary.indexedDocumentCount }} 个已建立索引</p>
        </div>
        <div class="bg-[var(--agent-surface)] px-5 py-4">
          <p class="m-0 font-mono text-[10px] font-bold uppercase tracking-[0.1em] text-[var(--agent-text-muted)]">知识片段</p>
          <p class="m-0 mt-2 text-2xl font-bold text-[var(--agent-text)]">{{ summary.indexedChunkCount }} / {{ summary.chunkCount }}</p>
          <p class="m-0 mt-1 text-xs font-medium text-[var(--agent-text-muted)]">已索引 / 当前切片</p>
        </div>
        <div class="bg-[var(--agent-surface)] px-5 py-4">
          <p class="m-0 font-mono text-[10px] font-bold uppercase tracking-[0.1em] text-[var(--agent-text-muted)]">最近同步</p>
          <p class="m-0 mt-2 truncate text-sm font-bold text-[var(--agent-text)]">{{ lastSync || '尚未执行' }}</p>
          <p class="m-0 mt-1 text-xs font-medium text-[var(--agent-text-muted)]">同步后会刷新索引状态</p>
        </div>
      </section>

      <section class="grid min-h-0 gap-5 xl:grid-cols-[minmax(0,0.92fr)_minmax(0,1.08fr)]">
        <div class="grid min-h-0 content-start gap-4">
          <div class="flex flex-wrap items-center justify-between gap-3">
            <div>
              <h2 class="m-0 text-base font-bold text-[var(--agent-text)]">来源文档</h2>
              <p class="m-0 mt-1 text-sm text-[var(--agent-text-muted)]">正文安全存储在 SQLite，向量索引存储在 Qdrant。</p>
            </div>
            <label class="relative block w-full sm:w-56">
              <PhMagnifyingGlass class="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-[var(--agent-text-muted)]" :size="16" weight="bold" aria-hidden="true" />
              <input v-model="searchQuery" type="search" placeholder="搜索文档" class="h-9 w-full rounded-md border border-[var(--agent-border)] bg-[var(--agent-surface)] py-2 pl-9 pr-3 text-sm text-[var(--agent-text)] outline-none placeholder:text-[var(--agent-text-muted)] focus:border-[var(--agent-selected-border)] focus:ring-4 focus:ring-[var(--agent-focus-ring)]" />
            </label>
          </div>

          <div class="overflow-hidden rounded-lg border border-[var(--agent-border)]">
            <div class="hidden grid-cols-[minmax(0,1fr)_92px_96px] gap-3 border-b border-[var(--agent-border)] bg-[var(--agent-surface-muted)] px-4 py-2.5 font-mono text-[10px] font-bold uppercase tracking-[0.08em] text-[var(--agent-text-muted)] md:grid">
              <span>文件</span>
              <span>更新</span>
              <span>索引</span>
            </div>

            <div v-if="loading" class="grid place-items-center px-4 py-12 text-sm font-medium text-[var(--agent-text-muted)]">正在加载文档…</div>
            <ul v-else class="m-0 list-none divide-y divide-[var(--agent-border)] p-0">
              <li v-for="document in filteredDocuments" :key="document.path">
                <button type="button" class="grid w-full cursor-pointer gap-2 px-4 py-3.5 text-left transition-colors hover:bg-[var(--agent-surface-muted)] md:grid-cols-[minmax(0,1fr)_92px_96px] md:items-center md:gap-3" :class="selectedPath === document.path ? 'bg-[var(--agent-selected-bg)]' : ''" @click="selectDocument(document.path)">
                  <span class="flex min-w-0 items-center gap-3">
                    <span class="grid size-8 shrink-0 place-items-center rounded-md bg-[var(--agent-primary-soft)] text-[var(--agent-text-muted)]">
                      <PhFileText :size="17" weight="bold" aria-hidden="true" />
                    </span>
                    <span class="min-w-0">
                      <span class="block truncate text-sm font-semibold text-[var(--agent-text)]">{{ document.title }}</span>
                      <span class="mt-0.5 block truncate font-mono text-[11px] text-[var(--agent-text-muted)]">{{ document.path }}</span>
                    </span>
                  </span>
                  <span class="text-xs font-medium text-[var(--agent-text-muted)]">{{ formatDate(document.updatedAt) }}</span>
                  <span class="flex items-center gap-1.5 text-xs font-semibold text-[var(--agent-text-muted)]">
                    <PhCheckCircle v-if="document.indexStatus === 'indexed'" :size="15" weight="fill" class="text-[var(--agent-text)]" aria-hidden="true" />
                    <PhWarningCircle v-else-if="document.indexStatus === 'outdated'" :size="15" weight="fill" aria-hidden="true" />
                    <PhDatabase v-else-if="document.indexStatus === 'unavailable'" :size="15" weight="bold" aria-hidden="true" />
                    <PhStack v-else :size="15" weight="bold" aria-hidden="true" />
                    <span>{{ document.indexedChunkCount }}/{{ document.chunkCount }} · {{ statusLabel[document.indexStatus] }}</span>
                  </span>
                </button>
              </li>
              <li v-if="!filteredDocuments.length" class="px-4 py-10 text-center text-sm font-medium text-[var(--agent-text-muted)]">{{ documents.length ? '没有匹配的文档。' : '知识库中还没有文档。' }}</li>
            </ul>
          </div>
        </div>

        <aside class="min-h-0 rounded-lg border border-[var(--agent-border)] bg-[var(--agent-surface)]" aria-label="文档详情">
          <div v-if="loadingDocument" class="grid min-h-72 place-items-center p-6 text-sm font-medium text-[var(--agent-text-muted)]">正在读取文档…</div>
          <div v-else-if="editorMode === 'create' || editorMode === 'edit'" class="grid gap-4 p-5">
            <div class="flex items-center justify-between gap-3 border-b border-[var(--agent-border)] pb-4">
              <div class="min-w-0">
                <p class="m-0 font-mono text-[10px] font-bold uppercase tracking-[0.08em] text-[var(--agent-text-muted)]">{{ editorMode === 'create' ? 'New document' : 'Edit document' }}</p>
                <h2 class="m-0 mt-1 text-base font-bold text-[var(--agent-text)]">{{ editorMode === 'create' ? '添加 Markdown 文档' : selectedDocument?.title }}</h2>
              </div>
              <button type="button" class="icon-tooltip grid size-8 cursor-pointer place-items-center rounded-md text-[var(--agent-text-muted)] hover:bg-[var(--agent-surface-muted)] hover:text-[var(--agent-text)]" aria-label="取消编辑" title="取消编辑" data-tooltip="取消编辑" @click="cancelEditing"><PhX :size="18" weight="bold" aria-hidden="true" /></button>
            </div>

            <label class="grid gap-1.5 text-sm font-semibold text-[var(--agent-text)]">
              文件路径
              <input v-model="draftPath" :readonly="editorMode === 'edit'" type="text" placeholder="guides/getting-started.md" class="h-9 rounded-md border border-[var(--agent-border)] bg-[var(--agent-surface)] px-3 text-sm font-mono font-medium text-[var(--agent-text)] outline-none focus:border-[var(--agent-selected-border)] focus:ring-4 focus:ring-[var(--agent-focus-ring)] read-only:bg-[var(--agent-surface-muted)]" />
            </label>
            <label class="grid gap-1.5 text-sm font-semibold text-[var(--agent-text)]">
              Markdown 内容
              <textarea v-model="draftContent" rows="16" class="min-h-64 resize-y rounded-md border border-[var(--agent-border)] bg-[var(--agent-surface)] p-3 font-mono text-xs leading-5 text-[var(--agent-text)] outline-none focus:border-[var(--agent-selected-border)] focus:ring-4 focus:ring-[var(--agent-focus-ring)]" />
            </label>
            <label class="flex cursor-pointer items-center justify-between gap-4 rounded-md border border-[var(--agent-border)] bg-[var(--agent-surface-muted)] px-3 py-2.5">
              <span><span class="block text-sm font-semibold text-[var(--agent-text)]">保存后自动向量化</span><span class="mt-0.5 block text-xs text-[var(--agent-text-muted)]">关闭后可通过文档操作单独处理。</span></span>
              <input v-model="autoIndex" type="checkbox" class="size-4 accent-[var(--agent-primary)]" />
            </label>
            <div class="flex flex-wrap justify-end gap-2">
              <button type="button" class="inline-flex h-9 cursor-pointer items-center gap-2 rounded-md border border-[var(--agent-border)] px-3 text-sm font-semibold text-[var(--agent-text)] hover:bg-[var(--agent-surface-muted)]" :disabled="saving" @click="cancelEditing">取消</button>
              <button type="button" class="inline-flex h-9 cursor-pointer items-center gap-2 rounded-md bg-[var(--agent-primary)] px-3 text-sm font-semibold text-[var(--agent-primary-text)] hover:bg-[var(--agent-primary-hover)] disabled:cursor-wait disabled:opacity-60" :disabled="saving" @click="saveDocument"><PhFloppyDisk :size="16" weight="bold" aria-hidden="true" />{{ saving ? '保存中' : '保存文档' }}</button>
            </div>
          </div>

          <div v-else-if="selectedDocument" class="grid min-h-0 gap-4 p-5">
            <div class="flex flex-wrap items-start justify-between gap-3 border-b border-[var(--agent-border)] pb-4">
              <div class="min-w-0">
                <p class="m-0 truncate font-mono text-[11px] font-semibold text-[var(--agent-text-muted)]">{{ selectedDocument.path }}</p>
                <h2 class="m-0 mt-1 truncate text-lg font-bold text-[var(--agent-text)]">{{ selectedDocument.title }}</h2>
                <p class="m-0 mt-1 text-xs text-[var(--agent-text-muted)]">{{ selectedDocument.lineCount }} 行 · 更新于 {{ formatDate(selectedDocument.updatedAt) }}</p>
              </div>
              <div class="flex items-center gap-1">
                <button type="button" class="icon-tooltip grid size-8 cursor-pointer place-items-center rounded-md text-[var(--agent-text-muted)] hover:bg-[var(--agent-surface-muted)] hover:text-[var(--agent-text)] disabled:cursor-wait disabled:opacity-60" :disabled="loadingChunks" aria-label="预览切片" title="预览切片" data-tooltip="预览切片" @click="showChunks()"><PhEye :size="18" weight="bold" :class="loadingChunks ? 'animate-pulse' : ''" aria-hidden="true" /></button>
                <button type="button" class="icon-tooltip grid size-8 cursor-pointer place-items-center rounded-md text-[var(--agent-text-muted)] hover:bg-[var(--agent-surface-muted)] hover:text-[var(--agent-text)] disabled:cursor-wait disabled:opacity-60" :disabled="Boolean(vectorizingPath)" aria-label="向量化文档" title="向量化文档" data-tooltip="向量化文档" @click="vectorizeDocument()"><PhStack :size="18" weight="bold" :class="vectorizingPath === selectedPath ? 'animate-pulse' : ''" aria-hidden="true" /></button>
                <button type="button" class="icon-tooltip grid size-8 cursor-pointer place-items-center rounded-md text-[var(--agent-text-muted)] hover:bg-[var(--agent-surface-muted)] hover:text-[var(--agent-text)]" aria-label="编辑文档" title="编辑文档" data-tooltip="编辑文档" @click="startEditing"><PhFileText :size="18" weight="bold" aria-hidden="true" /></button>
                <button type="button" class="icon-tooltip grid size-8 cursor-pointer place-items-center rounded-md text-[var(--agent-error-text)] hover:bg-[var(--agent-error-bg)]" aria-label="删除文档" title="删除文档" data-tooltip="删除文档" @click="deleteTarget = documents.find((document) => document.path === selectedPath)"><PhTrash :size="18" weight="bold" aria-hidden="true" /></button>
              </div>
            </div>

            <pre class="m-0 max-h-80 overflow-auto rounded-md border border-[var(--agent-border)] bg-[var(--agent-surface-muted)] p-3 whitespace-pre-wrap break-words font-mono text-xs leading-5 text-[var(--agent-text)]">{{ selectedDocument.content }}</pre>

            <section v-if="indexResult" class="rounded-md border border-[var(--agent-border)] bg-[var(--agent-surface-muted)] p-3">
              <p class="m-0 text-sm font-bold text-[var(--agent-text)]">最近一次向量化</p>
              <p class="m-0 mt-1 text-xs leading-5 text-[var(--agent-text-muted)]">{{ indexResult.chunkCount }} 个切片，{{ indexResult.upserted }} 个更新，{{ indexResult.unchanged }} 个保持不变，{{ indexResult.deleted }} 个已清理。</p>
            </section>

            <section v-if="chunkPath === selectedPath" class="grid gap-2 border-t border-[var(--agent-border)] pt-4">
              <div class="flex items-center justify-between gap-3"><h3 class="m-0 text-sm font-bold text-[var(--agent-text)]">切片预览</h3><span class="font-mono text-xs text-[var(--agent-text-muted)]">{{ chunks.length }} 段</span></div>
              <p v-if="!chunks.length" class="m-0 rounded-md border border-[var(--agent-border)] bg-[var(--agent-surface-muted)] px-3 py-2 text-xs text-[var(--agent-text-muted)]">当前文档没有可展示的切片。</p>
              <div v-else class="grid max-h-80 gap-2 overflow-auto">
                <article v-for="chunk in chunks" :key="chunk.id" class="rounded-md border border-[var(--agent-border)] p-3">
                  <p class="m-0 text-xs font-bold text-[var(--agent-text)]">{{ chunk.headingPath?.join(' › ') || chunk.heading || '文档内容' }}</p>
                  <p class="m-0 mt-0.5 font-mono text-[10px] text-[var(--agent-text-muted)]">第 {{ chunk.startLine }}–{{ chunk.endLine }} 行 · {{ chunk.tokenCount ?? '—' }} tokens · {{ chunk.contentType ?? 'text' }}</p>
                  <pre class="m-0 mt-2 whitespace-pre-wrap break-words font-mono text-[11px] leading-5 text-[var(--agent-text-muted)]">{{ chunk.content }}</pre>
                </article>
              </div>
            </section>
          </div>

          <div v-else class="grid min-h-72 place-items-center p-6 text-center">
            <div class="grid justify-items-center gap-3 text-[var(--agent-text-muted)]"><span class="grid size-10 place-items-center rounded-md bg-[var(--agent-primary-soft)]"><PhFilePlus :size="21" weight="bold" aria-hidden="true" /></span><p class="m-0 text-sm font-medium">选择一篇文档以查看和管理内容。</p></div>
          </div>
        </aside>
      </section>
    </div>

    <div v-if="deleteTarget" class="fixed inset-0 z-20 grid place-items-center bg-black/20 p-5" role="dialog" aria-modal="true" aria-label="删除文档确认">
      <div class="grid w-full max-w-md gap-4 rounded-lg border border-[var(--agent-border)] bg-[var(--agent-surface)] p-5 shadow-lg">
        <div class="flex items-start gap-3"><span class="grid size-9 shrink-0 place-items-center rounded-md bg-[var(--agent-error-bg)] text-[var(--agent-error-text)]"><PhTrash :size="18" weight="bold" aria-hidden="true" /></span><div><h2 class="m-0 text-base font-bold text-[var(--agent-text)]">删除文档</h2><p class="m-0 mt-1 break-all font-mono text-xs leading-5 text-[var(--agent-text-muted)]">{{ deleteTarget.path }}</p></div></div>
        <label class="flex cursor-pointer items-center justify-between gap-4 rounded-md border border-[var(--agent-border)] bg-[var(--agent-surface-muted)] px-3 py-2.5"><span><span class="block text-sm font-semibold text-[var(--agent-text)]">同时清理向量</span><span class="mt-0.5 block text-xs text-[var(--agent-text-muted)]">默认移除该文档的 Qdrant 索引。</span></span><input v-model="autoIndex" type="checkbox" class="size-4 accent-[var(--agent-primary)]" /></label>
        <div class="flex justify-end gap-2"><button type="button" class="inline-flex h-9 cursor-pointer items-center rounded-md border border-[var(--agent-border)] px-3 text-sm font-semibold text-[var(--agent-text)] hover:bg-[var(--agent-surface-muted)]" :disabled="deleting" @click="deleteTarget = undefined">取消</button><button type="button" class="inline-flex h-9 cursor-pointer items-center gap-2 rounded-md bg-[var(--agent-error-text)] px-3 text-sm font-semibold text-white hover:opacity-90 disabled:cursor-wait disabled:opacity-60" :disabled="deleting" @click="confirmDelete"><PhTrash :size="16" weight="bold" aria-hidden="true" />{{ deleting ? '删除中' : '删除' }}</button></div>
      </div>
    </div>
  </section>
</template>
