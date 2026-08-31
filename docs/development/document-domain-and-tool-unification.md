# 文稿领域模型与单一工具实施方案

## 1. 阶段目标

建立统一文稿领域模型和唯一模型工具，为后续 DOCX 持久化和统一工作台提供稳定契约。

本阶段完成后：

- 后端使用 `DocumentGenerationSpec`。
- planner 只规划用户要求的稿件类型。
- 模型侧只暴露 `start_document_generation`。
- Word 请求创建 longform DOCX 草稿，不立即渲染。
- PPTX/PDF 请求也进入同一 draft application。
- 旧 `generate_word_document` 和 `start_artifact_generation` 被删除。

本阶段不负责完成 DOCX renderer 和新前端工作台。未接通的格式应返回明确的“renderer 尚未接入”状态，不得退回旧临时 Word 生成路径。

## 2. 现有代码

主要文件：

- `backend/src/artifacts/generation/types.ts`
- `backend/src/artifacts/generation/schema.ts`
- `backend/src/artifacts/generation/agent.ts`
- `backend/src/artifacts/generation/service.ts`
- `backend/src/tools/artifactGenerationTool.ts`
- `backend/src/tools/catalog/documents.ts`
- `backend/src/tools/wordDocumentTool.ts`
- `backend/src/research/service.ts`
- `backend/src/routes/agent.ts`
- `backend/src/agent/agentLoop.ts`
- `backend/src/app.ts`
- `frontend/src/lib/auxiliaryState.ts`
- `frontend/src/views/ResearchWorkbench.vue`

当前问题：

- `ArtifactSpec` 始终包含 presentation 和 pdf 两份计划。
- Word 的工具直接接收完整 Markdown 并渲染临时文件。
- PPTX/PDF 与 Word 使用两个工具名称和两套提示词。
- “PPT + PDF”语义混淆了演示文稿 PDF 与长篇报告 PDF。

## 3. 目标类型

### 3.1 公共类型

```ts
export type DocumentType = 'presentation' | 'longform';
export type DocumentOutputFormat = 'pptx' | 'docx' | 'pdf';
export type DocumentTheme = 'research' | 'technical' | 'business';

export type DocumentBranding = {
  primaryColor?: string;
  logoUrl?: string;
  titleFont?: string;
  bodyFont?: string;
};
```

### 3.2 演示文稿

```ts
export type PresentationDeliverable = {
  id: string;
  documentType: 'presentation';
  formats: ['pptx'];
  targetSlideCount: number;
  slides: PresentationSlide[];
};
```

沿用当前 `PresentationSlide`：

- `id`
- `title`
- `kind`
- `bullets`
- `speakerNotes`
- `citations`
- `visual`

### 3.3 长篇 block

```ts
export type LongformBlock =
  | {
      id: string;
      type: 'heading';
      level: 1 | 2 | 3;
      text: string;
      citations: string[];
    }
  | {
      id: string;
      type: 'paragraph';
      text: string;
      alignment?: 'left' | 'center' | 'right' | 'justify';
      citations: string[];
    }
  | {
      id: string;
      type: 'bulletList' | 'numberedList';
      items: string[];
      citations: string[];
    }
  | {
      id: string;
      type: 'table';
      headers: string[];
      rows: string[][];
      citations: string[];
    }
  | {
      id: string;
      type: 'pageBreak';
      citations: [];
    };
```

### 3.4 长篇文档

```ts
export type LongformDeliverable = {
  id: string;
  documentType: 'longform';
  formats: Array<'docx' | 'pdf'>;
  subtitle?: string;
  author?: string;
  targetPageCount: number;
  page: {
    size: 'A4' | 'LETTER';
    orientation: 'portrait' | 'landscape';
    margins: {
      top: number;
      right: number;
      bottom: number;
      left: number;
    };
    showHeader: boolean;
    headerText?: string;
    footerText?: string;
    showPageNumber: boolean;
  };
  blocks: LongformBlock[];
};
```

### 3.5 Generation spec

```ts
export type DocumentGenerationSpec = {
  title: string;
  audience: string;
  theme: DocumentTheme;
  branding: DocumentBranding;
  brief: ResearchBrief;
  deliverables: Array<PresentationDeliverable | LongformDeliverable>;
};
```

一个 generation 最多包含一个 presentation 和一个 longform。

## 4. Schema 规则

在 `backend/src/artifacts/generation/schema.ts` 中建立严格 discriminated union：

- deliverables 最少 1 项，最多 2 项。
- 同一 `documentType` 不得重复。
- presentation formats 必须严格为 `['pptx']`。
- longform formats 只能包含 docx/pdf，至少 1 项且去重。
- deliverable ID 唯一。
- block ID 在 generation 内唯一。
- presentation slides 至少 8，最多 30。
- slide bullets 最多 8。
- longform 至少一个非 pageBreak block。
- list 至少一个非空 item。
- table 行列数量匹配。
- 品牌色和 HTTPS Logo 规则保持不变。
- 所有必填字符串 trim 后不能为空。

删除旧 `artifactSpecSchema` 的“双计划固定结构”。不要保留运行时双 schema 分支。

## 5. Planner 改造

planner 输入包含用户请求的 deliverable preferences，只规划请求内容：

```text
ResearchSnapshot
      ↓
ResearchBrief
      ↓
RequestedDeliverables
├── presentation -> slides
└── longform -> blocks
```

要求：

- 只请求 Word 时不规划 slides。
- 只请求 PPTX 时不规划 longform blocks。
- DOCX/PDF 同时请求时只规划一次 longform。
- PPT + 正式报告时规划两个 deliverable。
- citations 必须落到 slide 或 block。
- planner 不得创建空白 filler 页面或 block。

更新 planner prompt、JSON 解析恢复逻辑和相关测试。

## 6. 唯一工具

### 6.1 工具定义

新增：

```text
start_document_generation
```

输入 schema：

```ts
type StartDocumentGenerationInput = {
  title?: string;
  audience?: string;
  theme?: DocumentTheme;
  branding?: DocumentBranding;
  deliverables: Array<
    | {
        documentType: 'presentation';
        formats: ['pptx'];
        targetSlideCount?: number;
      }
    | {
        documentType: 'longform';
        formats: Array<'docx' | 'pdf'>;
        targetPageCount?: number;
      }
  >;
};
```

工具只调用 draft application，返回：

```ts
{
  generationId: string;
  status: 'awaiting_confirmation';
  version: number;
  deliverables: Array<{
    documentType: 'presentation' | 'longform';
    formats: DocumentOutputFormat[];
    itemCount: number;
  }>;
  requiresConfirmation: true;
}
```

不得从工具中直接调用 renderer。

### 6.2 意图规则

| 用户表达 | deliverables |
| --- | --- |
| Word、DOCX | longform/docx |
| PDF 报告、长篇 PDF | longform/pdf |
| Word 和 PDF | longform/docx+pdf |
| PPT、PPTX、演示文稿 | presentation/pptx |
| PPT 和正式报告 | presentation/pptx + longform/明确格式 |
| PPT 导出 PDF | 不支持，询问或说明 |

格式不明确时询问用户，不默认全部选择。

### 6.3 删除旧工具

不做兼容，直接移除：

- `generate_word_document`
- `start_artifact_generation`

同时更新：

- tool catalog。
- production runtime registration。
- legacy runtime filter。
- Agent system prompt。
- required tool 判断。
- malformed tool-call retry 文案。
- 显式文稿意图检测。
- 前端工具标签和辅助状态。
- 所有引用旧工具名的测试。

不要留下两个旧工具作为隐藏 alias。

## 7. 无兼容切换规则

- 不解析旧 `ArtifactSpec`。
- 不迁移旧 generation 的 spec JSON。
- 不支持旧 generation 在新工作台编辑。
- 不迁移旧 Word tool output。
- 不在启动时静默删除旧记录。

若本地旧记录导致开发验证失败，报告准确表名和记录数量，由用户显式决定是否清理。

## 8. 测试

至少覆盖：

- presentation 只允许 PPTX。
- longform 只允许 DOCX/PDF。
- deliverable 类型不能重复。
- block ID 唯一。
- DOCX/PDF 共享同一 blocks。
- Word 请求创建 longform DOCX 草稿。
- Word 请求不会调用旧 renderer。
- Word + PDF 只规划一次 longform。
- PPT 只规划 presentation。
- PPT + 正式报告规划两个 deliverable。
- PPT 导出 PDF 不会被错误映射成长篇报告。
- 新工具始终返回 `requiresConfirmation: true`。
- 工具列表只包含一个用户可见的文稿工具。

## 9. 完成标准

- 新类型和 schema 成为唯一可写模型。
- planner 只规划请求的 deliverable。
- `start_document_generation` 是唯一文稿工具。
- Word 请求只创建草稿。
- 旧工具和相关提示词分支被删除。
- 聚焦测试、backend typecheck 和 backend build 通过。

验证：

```bash
pnpm --filter backend typecheck
pnpm --filter backend test
pnpm --filter backend build
pnpm --filter backend runtime:verify
```

