# 统一文稿生成实施总览

## 1. 目标

将 Word、PPTX 和 PDF 统一为一个用户可见的“文稿”工具，并统一接入：

- 研究快照规划。
- 可编辑草稿。
- 自动保存。
- 用户确认生成。
- 不可变版本。
- 渲染、质检、重试、预览和下载。

统一后的产品模型：

```text
文稿
├── 演示文稿
│   └── PPTX
└── 长篇文档
    ├── DOCX
    └── PDF
```

DOCX 和 PDF 从同一份长篇文档草稿渲染。PPTX 使用独立的演示文稿模型，但共享文稿的草稿、确认、版本和输出生命周期。

Word 默认先创建草稿，用户点击“生成 DOCX”后才渲染。新生成的 Word 必须持久化保存，不再默认使用 24 小时过期的临时文件存储。

## 2. 执行文档

本任务拆为三份可独立执行的技术文档：

| 顺序 | 文档 | 负责范围 |
| --- | --- | --- |
| 1 | [文稿领域模型与单一工具](./document-domain-and-tool-unification.md) | 新 spec、Schema、planner、单一工具和意图路由 |
| 2 | [长篇文档渲染与 DOCX 持久化](./longform-docx-pdf-persistence.md) | DOCX/PDF 共用 blocks、renderer、数据库 output、质检和下载 |
| 3 | [统一文稿工作台前端](./document-workbench-frontend.md) | 状态卡、全屏工作台、编辑器、自动保存、确认、预览 |

必须按顺序执行。后续文档可以提前阅读，但不得在前置类型和接口尚未确定时自行复制一套临时模型。

## 3. 不做历史兼容

当前生成文档数量少，本次采用直接切换策略：

- 不实现旧 `ArtifactSpec` 到新 spec 的运行时兼容转换。
- 不保留 `generate_word_document` 和 `start_artifact_generation` 的兼容适配器。
- 不迁移历史 Word 临时 artifact。
- 不保证旧 PPTX/PDF generation 能被新工作台继续编辑或重新渲染。
- 不为历史 tool step 输出保留新的前端展示分支。

旧的下载文件在代码清理前可能仍可访问，但不属于验收范围。

不处理兼容不等于允许应用启动时静默删除数据。实现不得自动清空数据库或文件目录。需要清理本地开发数据时：

1. 在实施说明中列出明确目标。
2. 由用户或运维显式执行。
3. 不使用宽泛目录或未解析变量作为删除目标。

数据库结构迁移仍需正确、幂等。只是不需要对旧 spec 内容做语义转换。

## 4. 固定产品决策

### 4.1 一个工具

模型侧只暴露：

```text
start_document_generation
```

旧工具完成切换后直接删除：

- `generate_word_document`
- `start_artifact_generation`

### 4.2 两种稿件类型

| 类型 | 输出 |
| --- | --- |
| `presentation` | 仅 `pptx` |
| `longform` | `docx`、`pdf` 或两者 |

“PPT + 正式报告”创建两个 deliverable。“将 PPT 导出 PDF”当前不支持，不得静默生成长篇报告 PDF。

### 4.3 Word 也确认生成

统一流程：

```text
创建草稿
  ↓
用户编辑
  ↓
自动保存
  ↓
用户确认目标格式
  ↓
创建不可变版本
  ↓
渲染和质检
  ↓
持久化、预览、下载
```

第一版不支持跳过确认直接生成。

### 4.4 一个长篇内容源

DOCX/PDF 共享一个 block 数组。不得分别维护 Word Markdown 和 PDF sections。

### 4.5 三个 renderer

统一工具和生命周期不意味着合并 renderer：

- PPTX renderer 消费 presentation。
- DOCX renderer 消费 longform。
- PDF renderer消费同一个 longform。

## 5. 公共完成标准

全部阶段完成后必须满足：

- 用户只看到一个“文稿”工具。
- Word、PDF、PPTX 都先创建草稿。
- Word 默认需要确认后才生成。
- DOCX/PDF 共用一份 longform blocks。
- 新 DOCX 写入 generation output 和持久化 binary store。
- 刷新或重新进入会话后仍能找到新 DOCX。
- 三种格式共享版本、状态、取消、重试、删除和下载语义。
- 聊天中只显示轻量状态卡。
- 用户可以进入全屏文稿工作台。
- 自动保存和生成前 revision 检查适用于三种格式。
- 用户界面不再出现“Artifact Agent”。

## 6. 全局非目标

- 不实现 PowerPoint 级自由画布。
- 不实现幻灯片导出 PDF。
- 不实现多人实时协作。
- 不实现模板市场。
- 不新增 AI 局部改写。
- 不实现 DOCX 像素级版式质检。
- 不重命名现有数据库表和 HTTP `/artifacts` 路径。
- 不迁移历史生成记录。
- 不默认允许跳过确认。

## 7. 最终验证

```bash
pnpm --filter frontend typecheck
pnpm --filter frontend test
pnpm --filter frontend build
pnpm --filter backend typecheck
pnpm --filter backend test
pnpm --filter backend build
pnpm --filter backend runtime:verify
pnpm typecheck
pnpm test
pnpm build
```

每个阶段先运行聚焦测试，再运行仓库级验证。不得为了通过验证删除或跳过既有测试。

