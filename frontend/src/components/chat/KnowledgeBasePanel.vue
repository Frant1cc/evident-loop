<script setup lang="ts">
import {
  PhArrowClockwise,
  PhCheckCircle,
  PhCircleNotch,
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
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '@/components/ui/dialog';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Skeleton } from '@/components/ui/skeleton';
import { Switch } from '@/components/ui/switch';
import { Textarea } from '@/components/ui/textarea';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
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

const selectedSummary = computed(() => documents.value.find((document) => document.path === selectedPath.value));

const statusLabel: Record<KnowledgeDocumentSummary['indexStatus'], string> = {
  indexed: '已索引',
  pending: '待向量化',
  outdated: '需更新',
  unavailable: '索引不可用'
};

function statusClass(status: KnowledgeDocumentSummary['indexStatus']) {
  if (status === 'indexed') return 'border-emerald-500/25 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300';
  if (status === 'outdated') return 'border-amber-500/25 bg-amber-500/10 text-amber-700 dark:text-amber-300';
  if (status === 'unavailable') return 'border-destructive/25 bg-destructive/10 text-destructive';
  return 'border-border bg-muted text-muted-foreground';
}

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
  <section class="h-full min-h-0 overflow-auto bg-background" aria-label="知识库管理">
    <div class="mx-auto flex min-h-full w-full max-w-[1500px] flex-col gap-5 px-5 py-6 md:px-8 md:py-8">
      <header class="flex flex-wrap items-end justify-between gap-5 border-b border-border pb-5">
        <div class="min-w-0">
          <p class="m-0 font-mono text-[10px] font-semibold uppercase tracking-[0.16em] text-muted-foreground">Knowledge base</p>
          <h1 class="m-0 mt-1.5 text-2xl font-semibold tracking-[-0.035em] text-foreground">知识库</h1>
          <p class="m-0 mt-1.5 text-sm leading-6 text-muted-foreground">维护 Agent 可检索的 Markdown 来源，并掌握每篇文档的切片与索引状态。</p>
        </div>

        <div class="flex flex-wrap items-center gap-2">
          <Button variant="outline" :disabled="syncing" @click="syncKnowledge">
            <PhCircleNotch v-if="syncing" class="animate-spin" aria-hidden="true" />
            <PhArrowClockwise v-else aria-hidden="true" />
            {{ syncing ? '同步中' : '同步索引' }}
          </Button>
          <Button variant="outline" @click="openFilePicker"><PhUploadSimple aria-hidden="true" />上传 Markdown</Button>
          <Button @click="startCreating"><PhPlus aria-hidden="true" />添加文档</Button>
          <input ref="fileInput" class="sr-only" type="file" accept=".md,text/markdown,text/plain" @change="uploadMarkdownFile" />
        </div>
      </header>

      <div v-if="error" role="alert" class="flex items-center gap-2 rounded-lg border border-destructive/25 bg-destructive/10 px-4 py-3 text-sm font-medium text-destructive">
        <PhWarningCircle class="shrink-0" :size="17" weight="fill" aria-hidden="true" />{{ error }}
      </div>
      <div v-else-if="notice" class="flex items-center gap-2 rounded-lg border border-emerald-500/25 bg-emerald-500/10 px-4 py-3 text-sm font-medium text-emerald-700 dark:text-emerald-300">
        <PhCheckCircle class="shrink-0" :size="17" weight="fill" aria-hidden="true" />{{ notice }}
      </div>

      <section class="grid overflow-hidden rounded-xl border border-border bg-card sm:grid-cols-3 sm:divide-x sm:divide-border" aria-label="知识库概况">
        <div class="px-5 py-4">
          <p class="m-0 text-[10px] font-semibold uppercase tracking-[0.12em] text-muted-foreground">文档</p>
          <p class="m-0 mt-2 font-mono text-2xl font-semibold tabular-nums">{{ summary.documentCount }}</p>
          <p class="m-0 mt-1 text-xs text-muted-foreground">{{ summary.indexedDocumentCount }} 篇已建立索引</p>
        </div>
        <div class="border-t border-border px-5 py-4 sm:border-t-0">
          <p class="m-0 text-[10px] font-semibold uppercase tracking-[0.12em] text-muted-foreground">知识片段</p>
          <p class="m-0 mt-2 font-mono text-2xl font-semibold tabular-nums">{{ summary.indexedChunkCount }} <span class="text-sm font-normal text-muted-foreground">/ {{ summary.chunkCount }}</span></p>
          <p class="m-0 mt-1 text-xs text-muted-foreground">已索引 / 当前切片</p>
        </div>
        <div class="border-t border-border px-5 py-4 sm:border-t-0">
          <p class="m-0 text-[10px] font-semibold uppercase tracking-[0.12em] text-muted-foreground">最近同步</p>
          <p class="m-0 mt-2 truncate text-sm font-semibold">{{ lastSync || '本次打开后尚未执行' }}</p>
          <p class="m-0 mt-1 text-xs text-muted-foreground">同步会刷新全部文档状态</p>
        </div>
      </section>

      <section class="grid min-h-[540px] flex-1 overflow-hidden rounded-xl border border-border bg-card xl:grid-cols-[minmax(360px,0.82fr)_minmax(0,1.18fr)]">
        <div class="flex min-h-0 flex-col border-b border-border xl:border-b-0 xl:border-r">
          <div class="flex flex-wrap items-start justify-between gap-3 border-b border-border px-4 py-4">
            <div>
              <h2 class="m-0 text-sm font-semibold">来源文档</h2>
              <p class="m-0 mt-1 text-xs leading-5 text-muted-foreground">正文存储于 SQLite，向量写入 Qdrant。</p>
            </div>
            <span class="font-mono text-xs text-muted-foreground">{{ filteredDocuments.length }} / {{ documents.length }}</span>
          </div>

          <div class="border-b border-border p-3">
            <label class="relative block">
              <PhMagnifyingGlass class="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground" :size="16" aria-hidden="true" />
              <input v-model="searchQuery" type="search" placeholder="按标题或路径搜索" class="h-9 w-full rounded-lg border border-input bg-background py-2 pl-9 pr-3 text-sm text-foreground outline-none placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50" />
            </label>
          </div>

          <div v-if="loading" class="grid gap-3 p-4">
            <div v-for="index in 5" :key="index" class="flex items-center gap-3"><Skeleton class="size-9 rounded-lg" /><div class="grid flex-1 gap-2"><Skeleton class="h-3.5 w-2/3" /><Skeleton class="h-3 w-1/2" /></div></div>
          </div>
          <ScrollArea v-else class="min-h-[330px] flex-1 xl:h-0">
            <ul class="m-0 list-none divide-y divide-border p-0" aria-label="知识库文档">
              <li v-for="document in filteredDocuments" :key="document.path">
                <button type="button" class="group grid w-full cursor-pointer gap-2 px-4 py-3.5 text-left outline-none transition-colors hover:bg-muted/60 focus-visible:bg-muted focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring" :class="selectedPath === document.path ? 'bg-muted' : ''" @click="selectDocument(document.path)">
                  <span class="flex min-w-0 items-start gap-3">
                    <span class="mt-0.5 grid size-9 shrink-0 place-items-center rounded-lg border border-border bg-background text-muted-foreground"><PhFileText :size="18" weight="bold" aria-hidden="true" /></span>
                    <span class="min-w-0 flex-1">
                      <span class="flex min-w-0 items-center justify-between gap-2"><strong class="truncate text-sm font-semibold">{{ document.title }}</strong><Badge variant="outline" class="shrink-0 text-[10px]" :class="statusClass(document.indexStatus)">{{ statusLabel[document.indexStatus] }}</Badge></span>
                      <span class="mt-1 block truncate font-mono text-[10px] text-muted-foreground">{{ document.path }}</span>
                      <span class="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-muted-foreground"><span>{{ document.lineCount }} 行</span><span>{{ document.indexedChunkCount }}/{{ document.chunkCount }} 切片</span><span>{{ formatDate(document.updatedAt) }}</span></span>
                    </span>
                  </span>
                </button>
              </li>
              <li v-if="!filteredDocuments.length" class="grid min-h-56 place-items-center px-6 py-10 text-center"><div><PhDatabase class="mx-auto text-muted-foreground" :size="25" /><p class="m-0 mt-3 text-sm font-medium">{{ documents.length ? '没有匹配的文档' : '知识库中还没有文档' }}</p><p class="m-0 mt-1 text-xs text-muted-foreground">{{ documents.length ? '尝试调整搜索关键词。' : '上传 Markdown 或创建第一篇文档。' }}</p></div></li>
            </ul>
          </ScrollArea>
        </div>

        <aside class="min-h-0 bg-background/35" aria-label="文档详情">
          <div v-if="loadingDocument" class="grid min-h-[420px] place-items-center p-6 text-sm text-muted-foreground"><PhCircleNotch class="animate-spin" :size="22" aria-hidden="true" /></div>

          <div v-else-if="editorMode === 'create' || editorMode === 'edit'" class="flex min-h-full flex-col">
            <div class="flex items-center justify-between gap-3 border-b border-border px-5 py-4">
              <div class="min-w-0"><p class="m-0 text-[10px] font-semibold uppercase tracking-[0.12em] text-muted-foreground">{{ editorMode === 'create' ? 'New document' : 'Edit document' }}</p><h2 class="m-0 mt-1 truncate text-base font-semibold">{{ editorMode === 'create' ? '添加 Markdown 文档' : selectedDocument?.title }}</h2></div>
              <Button variant="ghost" size="icon" aria-label="取消编辑" @click="cancelEditing"><PhX aria-hidden="true" /></Button>
            </div>
            <div class="grid flex-1 content-start gap-5 p-5">
              <label class="grid gap-2 text-sm font-medium">文件路径<input v-model="draftPath" :readonly="editorMode === 'edit'" type="text" placeholder="guides/getting-started.md" class="h-10 rounded-lg border border-input bg-background px-3 font-mono text-sm text-foreground outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 read-only:bg-muted read-only:text-muted-foreground" /></label>
              <label class="grid gap-2 text-sm font-medium">Markdown 内容<Textarea v-model="draftContent" rows="18" class="min-h-80 resize-y font-mono text-xs leading-5" /></label>
              <div class="flex items-center justify-between gap-4 rounded-lg border border-border bg-muted/45 px-4 py-3">
                <div><p class="m-0 text-sm font-medium">保存后自动向量化</p><p class="m-0 mt-1 text-xs text-muted-foreground">关闭后仍可在文档工具栏单独处理。</p></div><Switch v-model="autoIndex" aria-label="保存后自动向量化" />
              </div>
              <div class="flex flex-wrap justify-end gap-2"><Button variant="outline" :disabled="saving" @click="cancelEditing">取消</Button><Button :disabled="saving" @click="saveDocument"><PhCircleNotch v-if="saving" class="animate-spin" aria-hidden="true" /><PhFloppyDisk v-else aria-hidden="true" />{{ saving ? '保存中' : '保存文档' }}</Button></div>
            </div>
          </div>

          <div v-else-if="selectedDocument" class="flex min-h-full flex-col">
            <div class="flex flex-wrap items-start justify-between gap-3 border-b border-border px-5 py-4">
              <div class="min-w-0 flex-1">
                <div class="flex flex-wrap items-center gap-2"><Badge v-if="selectedSummary" variant="outline" :class="statusClass(selectedSummary.indexStatus)">{{ statusLabel[selectedSummary.indexStatus] }}</Badge><span class="font-mono text-[10px] text-muted-foreground">{{ selectedDocument.path }}</span></div>
                <h2 class="m-0 mt-2 truncate text-lg font-semibold tracking-[-0.02em]">{{ selectedDocument.title }}</h2>
                <p class="m-0 mt-1 text-xs text-muted-foreground">{{ selectedDocument.lineCount }} 行 · 更新于 {{ formatDate(selectedDocument.updatedAt) }}</p>
              </div>
              <div class="flex items-center gap-1">
                <Tooltip><TooltipTrigger as-child><Button variant="ghost" size="icon" :disabled="loadingChunks" aria-label="预览切片" @click="showChunks()"><PhCircleNotch v-if="loadingChunks" class="animate-spin" aria-hidden="true" /><PhEye v-else aria-hidden="true" /></Button></TooltipTrigger><TooltipContent>预览切片</TooltipContent></Tooltip>
                <Tooltip><TooltipTrigger as-child><Button variant="ghost" size="icon" :disabled="Boolean(vectorizingPath)" aria-label="向量化文档" @click="vectorizeDocument()"><PhCircleNotch v-if="vectorizingPath === selectedPath" class="animate-spin" aria-hidden="true" /><PhStack v-else aria-hidden="true" /></Button></TooltipTrigger><TooltipContent>向量化文档</TooltipContent></Tooltip>
                <Tooltip><TooltipTrigger as-child><Button variant="ghost" size="icon" aria-label="编辑文档" @click="startEditing"><PhFileText aria-hidden="true" /></Button></TooltipTrigger><TooltipContent>编辑文档</TooltipContent></Tooltip>
                <Tooltip><TooltipTrigger as-child><Button variant="ghost" size="icon" class="text-destructive hover:bg-destructive/10 hover:text-destructive" aria-label="删除文档" @click="deleteTarget = documents.find((document) => document.path === selectedPath)"><PhTrash aria-hidden="true" /></Button></TooltipTrigger><TooltipContent>删除文档</TooltipContent></Tooltip>
              </div>
            </div>

            <div class="grid min-h-0 flex-1 content-start gap-4 p-5">
              <pre class="m-0 max-h-[430px] overflow-auto whitespace-pre-wrap break-words rounded-lg border border-border bg-muted/45 p-4 font-mono text-xs leading-6 text-foreground">{{ selectedDocument.content }}</pre>

              <section v-if="indexResult" class="rounded-lg border border-emerald-500/25 bg-emerald-500/10 p-4">
                <p class="m-0 text-sm font-semibold text-emerald-700 dark:text-emerald-300">最近一次向量化</p>
                <p class="m-0 mt-1 text-xs leading-5 text-muted-foreground">{{ indexResult.chunkCount }} 个切片，{{ indexResult.upserted }} 个更新，{{ indexResult.unchanged }} 个保持不变，{{ indexResult.deleted }} 个已清理。</p>
              </section>

              <section v-if="chunkPath === selectedPath" class="grid gap-3 border-t border-border pt-4">
                <div class="flex items-center justify-between gap-3"><div><h3 class="m-0 text-sm font-semibold">切片预览</h3><p class="m-0 mt-1 text-xs text-muted-foreground">检查实际进入向量索引的文本边界。</p></div><Badge variant="secondary" class="font-mono">{{ chunks.length }} 段</Badge></div>
                <p v-if="!chunks.length" class="m-0 rounded-lg border border-border bg-muted/45 px-4 py-3 text-xs text-muted-foreground">当前文档没有可展示的切片。</p>
                <div v-else class="grid max-h-[420px] gap-2 overflow-auto pr-1">
                  <article v-for="(chunk, index) in chunks" :key="chunk.id" class="rounded-lg border border-border bg-card p-4">
                    <div class="flex items-start justify-between gap-3"><p class="m-0 text-xs font-semibold">{{ chunk.headingPath?.join(' › ') || chunk.heading || '文档内容' }}</p><span class="font-mono text-[10px] text-muted-foreground">#{{ index + 1 }}</span></div>
                    <p class="m-0 mt-1 font-mono text-[10px] text-muted-foreground">第 {{ chunk.startLine }}–{{ chunk.endLine }} 行 · {{ chunk.tokenCount ?? '—' }} tokens · {{ chunk.contentType ?? 'text' }}</p>
                    <pre class="m-0 mt-3 whitespace-pre-wrap break-words font-mono text-[11px] leading-5 text-muted-foreground">{{ chunk.content }}</pre>
                  </article>
                </div>
              </section>
            </div>
          </div>

          <div v-else class="grid min-h-[420px] place-items-center p-8 text-center">
            <div class="max-w-xs"><span class="mx-auto grid size-11 place-items-center rounded-xl border border-border bg-muted text-muted-foreground"><PhFilePlus :size="22" weight="bold" aria-hidden="true" /></span><h2 class="m-0 mt-4 text-sm font-semibold">选择一篇文档</h2><p class="m-0 mt-1.5 text-xs leading-5 text-muted-foreground">在左侧查看文档内容、切片结果与索引状态，或创建新的 Markdown 来源。</p></div>
          </div>
        </aside>
      </section>
    </div>

    <Dialog :open="Boolean(deleteTarget)" @update:open="deleteTarget = $event ? deleteTarget : undefined">
      <DialogContent class="sm:max-w-md">
        <DialogHeader><div class="mb-1 flex size-10 items-center justify-center rounded-lg bg-destructive/10 text-destructive"><PhTrash :size="19" weight="bold" aria-hidden="true" /></div><DialogTitle>删除文档</DialogTitle><DialogDescription class="break-all">{{ deleteTarget?.path }} 将从知识库中永久删除，此操作无法撤销。</DialogDescription></DialogHeader>
        <div class="flex items-center justify-between gap-4 rounded-lg border border-border bg-muted/45 px-4 py-3"><div><p class="m-0 text-sm font-medium">同时清理向量</p><p class="m-0 mt-1 text-xs text-muted-foreground">移除该文档在 Qdrant 中的索引。</p></div><Switch v-model="autoIndex" aria-label="同时清理向量" /></div>
        <DialogFooter><Button variant="outline" :disabled="deleting" @click="deleteTarget = undefined">取消</Button><Button variant="destructive" :disabled="deleting" @click="confirmDelete"><PhCircleNotch v-if="deleting" class="animate-spin" aria-hidden="true" /><PhTrash v-else aria-hidden="true" />{{ deleting ? '删除中' : '确认删除' }}</Button></DialogFooter>
      </DialogContent>
    </Dialog>
  </section>
</template>
