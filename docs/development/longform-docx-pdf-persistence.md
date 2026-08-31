# 长篇文档渲染与 DOCX 持久化实施方案

## 1. 前置条件

先完成 [文稿领域模型与单一工具](./document-domain-and-tool-unification.md)。

本阶段以 `LongformDeliverable.blocks` 为唯一长篇正文来源，不重新引入 Word Markdown 或 PDF sections。

## 2. 阶段目标

完成后：

- DOCX/PDF 从同一份 longform blocks 渲染。
- DOCX 进入 generation output 状态机。
- DOCX metadata 存入 `research_artifact_outputs`。
- DOCX binary 存入 generation binary store。
- 新 DOCX 不使用 24 小时临时 ArtifactStore。
- DOCX 支持持久化查询、预览、下载、失败重试和随版本删除。
- DOCX/PDF 可一次确认并独立完成或失败。

## 3. Renderer 边界

按格式注册独立 renderer：

```ts
const renderers: Record<DocumentOutputFormat, DocumentRenderer> = {
  pptx: pptxRenderer,
  docx: docxRenderer,
  pdf: pdfRenderer
};
```

查找规则：

- PPTX 只能消费 presentation deliverable。
- DOCX/PDF 只能消费 longform deliverable。
- 找不到对应 deliverable 时立即返回明确错误。
- renderer 不得自行从另一种稿件类型推导内容。

## 4. DOCX renderer

### 4.1 复用现有能力

复用：

- `backend/src/documents/renderer.ts`
- `backend/src/documents/presets.ts`
- `backend/src/documents/types.ts` 中仍适用的排版类型

增加 adapter：

```ts
function longformToResolvedDocumentSpec(
  generation: DocumentGenerationSpec,
  deliverable: LongformDeliverable
): ResolvedDocumentSpec;
```

映射：

| LongformBlock | DOCX block |
| --- | --- |
| heading | heading |
| paragraph | paragraph |
| bulletList | bulletList |
| numberedList | numberedList |
| table | table |
| pageBreak | pageBreak |

标题、subtitle、author、页面大小、方向、边距、页眉、页脚、页码、字体和品牌色必须传递。

引用显示采用稳定规则。第一阶段可在 block 后增加小号“来源”段落，但 DOCX/PDF 必须使用同一 citation key 和顺序。

### 4.2 RendererResult

DOCX renderer 返回：

```ts
{
  buffer: Buffer;
  fileName: string;
  contentType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
  renderedSpec: DocumentGenerationSpec;
  diagnostics?: string[];
}
```

文件名沿用安全规范化，但不再由临时 ArtifactStore 强制限定存储方式。

## 5. PDF renderer

改造当前 Playwright PDF renderer，使其直接消费 longform blocks。

至少支持：

- 标题和文档元信息。
- heading 1-3。
- paragraph 和 alignment。
- bulletList。
- numberedList。
- table。
- pageBreak。
- block citations。
- 页眉、页脚和页码。
- 品牌色、标题字体和正文字体。

DOCX/PDF 必须保持：

- block 顺序相同。
- 列表 item 顺序相同。
- 表格行列相同。
- citation key 相同。
- 标题和元信息相同。

分页和字体度量可以不同，不能宣称像素一致。

## 6. 数据库持久化

### 6.1 Output format

将 output format 扩展为：

```ts
type DocumentOutputFormat = 'pptx' | 'docx' | 'pdf';
```

重建 SQLite `research_artifact_outputs` 的 CHECK：

```sql
format TEXT NOT NULL CHECK (format IN ('pptx', 'docx', 'pdf'))
```

要求：

- 迁移幂等。
- 保留表结构、外键、唯一约束和索引。
- 不自动删除旧 generation。
- 不转换旧 spec。
- 如果无法安全重建，启动失败并给出明确错误，不静默丢数据。

### 6.2 Output record

新 DOCX 必须写入：

- id。
- generation_id。
- version。
- format = docx。
- status。
- file_name。
- content_type。
- size。
- storage_key。
- rendered_spec_json。
- rendered_spec_digest。
- diagnostics。
- progress。
- attempts。
- created_at/updated_at。

### 6.3 Binary store

DOCX 使用与 PPTX/PDF 相同的 `ArtifactBinaryStore`：

```text
generation
└── output: docx
    ├── metadata -> SQLite
    └── binary   -> persistent binary store
```

不得继续调用：

```ts
artifactStore.create(...)
```

新 DOCX 没有默认 24 小时 TTL。删除 generation 时删除对应 binary；普通进程重启不删除。

## 7. 确认与多输出

longform formats 为 `['docx', 'pdf']` 时：

1. 用户一次确认。
2. 创建两个 output。
3. 两个 renderer 独立执行。
4. 单个 output 可独立重试。
5. 一个完成、一个失败时 generation 为 `partial`。
6. 两个都完成时 generation 为 `completed`。

取消 generation 时取消所有仍在运行的 output，但不得删除已经完成的文件。

## 8. DOCX 质检

新增基础质检，不宣称像素级排版检查：

- buffer 非空。
- 文件是 ZIP/OOXML。
- 包含 `[Content_Types].xml`。
- 包含 `word/document.xml`。
- document.xml 包含标题。
- 至少一个非空 longform block 被写入。
- 文件大小在配置上限内。
- rendered spec digest 存在并匹配。

质检失败时：

- output 标为 failed。
- 保存可读 diagnostics。
- 不提供下载 URL。
- 允许 retry。

## 9. 路由和预览

继续使用现有 output 路由：

```text
GET /api/artifact-files/:outputId/download
GET /api/artifact-files/:outputId/preview
POST /api/artifacts/outputs/:outputId/retry
```

DOCX：

- download 返回 attachment。
- preview 返回实际 DOCX binary 和正确 content type。
- 前端使用 `docx-preview` 渲染。
- 不要求后端转换成 PDF 或 PNG。

PDF/PPTX 当前预览能力不得回归。

## 10. 移除旧 Word 生成路径

领域工具阶段已经删除 `generate_word_document`。本阶段删除不再被使用的立即渲染协调代码，但保留可复用的 DOCX schema、preset 和 renderer。

历史临时 Word artifact 不迁移，也不属于验收范围。不要在此阶段主动扫描或删除旧临时文件。

## 11. 测试

至少覆盖：

- 每种 LongformBlock 到 DOCX 的映射。
- 每种 LongformBlock 到 PDF 的映射。
- DOCX/PDF block 顺序一致。
- table 行列一致。
- citations 一致。
- DOCX output 正确持久化。
- 进程重新创建 repository 后仍可查询 DOCX。
- DOCX preview/download content type 正确。
- DOCX retry 增加 attempts。
- 删除 generation 清理 DOCX binary。
- DOCX/PDF 多输出的 completed/partial/failed 状态。
- SQLite migration 接受 docx 且保持既有约束。
- DOCX 质检能拒绝无效 OOXML。

## 12. 完成标准

- 新 Word 请求可以生成持久化 DOCX。
- 刷新或重新进入会话后 DOCX 仍存在。
- DOCX/PDF 共用一份 longform blocks。
- Word 必须经过草稿确认。
- DOCX 支持质检、预览、下载、重试和删除。
- 新 DOCX 不写入临时 ArtifactStore。
- backend typecheck、测试、build 和 runtime verify 通过。

验证：

```bash
pnpm --filter backend typecheck
pnpm --filter backend test
pnpm --filter backend build
pnpm --filter backend runtime:verify
```

