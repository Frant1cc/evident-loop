# 统一文稿工作台前端实施方案

## 1. 前置条件

必须先完成：

1. [文稿领域模型与单一工具](./document-domain-and-tool-unification.md)
2. [长篇文档渲染与 DOCX 持久化](./longform-docx-pdf-persistence.md)

前端只消费统一 generation、deliverables 和 outputs，不为旧 Word tool result 或旧 ArtifactSpec 增加兼容分支。

## 2. 阶段目标

将聊天消息中的 PPTX/PDF 长表单和独立 Word 卡统一为：

- 聊天内轻量文稿状态卡。
- 全屏文稿工作台。
- 演示文稿单页编辑器。
- DOCX/PDF 共用的长篇 block 编辑器。
- 统一自动保存和确认生成。
- DOCX/PDF/PPTX 输出预览和下载。

## 3. 用户命名

| 内部概念 | 用户文案 |
| --- | --- |
| document generation | 文稿 |
| workbench | 文稿工作台 |
| presentation | 演示文稿 |
| longform | 长篇文档 |
| docx output | 生成 DOCX |
| pdf output | 生成 PDF |
| pptx output | 生成 PPTX |

用户界面不显示“Artifact Agent”“按需 Artifact Agent”“生成 Word 文档”作为独立工具名。

## 4. 聊天状态卡

聊天中不再显示完整编辑表单。

示例：

```text
文稿草稿已创建
《2026 市场趋势分析》

演示文稿 · 12 页 · PPTX
长篇文档 · 18 个内容块 · DOCX、PDF

[打开文稿工作台]
```

状态卡显示：

- 标题和版本。
- deliverable 类型、数量和目标格式。
- generation/output 状态。
- 打开工作台。
- 根据状态显示生成、取消、重试、预览和下载。

状态卡不显示：

- 全部编辑字段。
- 版本删除。
- 素材授权。
- rendered spec JSON。
- 品牌和页面设置。

## 5. 全屏工作台

### 5.1 打开方式

第一阶段使用现有 Dialog/Teleport 打开全屏工作台，不新增路由。

要求：

- 使用 `100dvh`。
- 锁定背景滚动。
- 正确管理焦点。
- Escape 和关闭按钮可关闭。
- 关闭前 flush 自动保存。
- 关闭后焦点返回打开按钮。
- 生成轮询不因关闭工作台停止。

### 5.2 桌面布局

```text
┌──────────────────────────────────────────────────────────────┐
│ 关闭  文稿标题  v2  已保存        版本  设置  生成格式      │
├───────────────┬──────────────────────────┬───────────────────┤
│ 稿件/结构导航 │ 结构预览                 │ 当前内容编辑器    │
│               │                          │                   │
│ 演示文稿      │ 当前幻灯片               │ 标题、要点、图表  │
│ 长篇文档      │ 或长篇阅读预览           │ blocks、引用      │
└───────────────┴──────────────────────────┴───────────────────┘
```

建议尺寸：

- 顶栏 56-64px。
- 左栏 220-280px。
- 中间 `minmax(360px, 1fr)`。
- 右栏 300-380px。

### 5.3 移动端

小于 768px 使用“目录、预览、编辑”Tab，不压缩为三列。默认打开“编辑”。

## 6. 演示文稿编辑器

一次只编辑当前幻灯片。

支持：

- 选择。
- 添加。
- 复制。
- 删除。
- 上移和下移。
- 标题。
- kind。
- 独立 bullet 行。
- speaker notes。
- citations。
- table/bar visual 基础编辑或只读摘要。

限制：

- 至少 8 页。
- 每页最多 8 个 bullet。
- 达到下限时禁用删除并说明原因。

不要使用换行 textarea 维护 `bullets[]`。

结构预览使用 16:9 画布，并明确标注“结构预览，最终版式以生成结果为准”。

## 7. 长篇文档编辑器

DOCX/PDF 使用同一个 `LongformEditor` 和同一 blocks 数组。

支持添加和编辑：

- heading。
- paragraph。
- bulletList。
- numberedList。
- table。
- pageBreak。

每个 block 支持：

- 选择。
- 独立编辑。
- 删除。
- 上移和下移。
- citations。

不得：

- 使用一个 textarea 通过换行解析全部段落。
- 切换 DOCX/PDF 时复制 blocks。
- 为 DOCX 和 PDF 保存不同正文。

长篇结构预览使用连续纸张阅读视图，不承诺 DOCX/PDF 分页完全一致。

## 8. 设置、素材和版本

### 8.1 设置

放入设置 Dialog：

- 标题。
- 受众。
- 主题。
- 品牌色。
- Logo URL。
- 标题字体和正文字体。
- longform 页面大小、方向、边距、页眉、页脚、页码。
- 输出格式。

presentation 只能选择 PPTX。longform 至少选择 DOCX/PDF 之一。

### 8.2 素材

图片授权放入设置的“素材”Tab。保留现有 consent 两步流程，不自动下载未经确认的外部图片。

### 8.3 版本

版本历史使用独立 Dialog：

- 版本号。
- 创建时间。
- 状态。
- deliverables。
- outputs。
- 下载。
- 删除。

删除放在更多菜单并二次确认，不常驻主工具栏。

历史不可变版本和 stale 草稿均只读。

## 9. 自动保存

保留并扩展：

- `frontend/src/components/artifacts/draftRevision.ts`
- `frontend/src/components/artifacts/sessionEpoch.ts`
- 当前保存期间再次编辑会继续保存最新 revision 的循环语义。

所有字段和结构操作调用 500-800ms debounce 的 `scheduleSave()`。

必须立即 flush：

- 关闭工作台。
- 切换会话。
- 切换版本。
- 点击生成。

统一状态：

```ts
type DraftSaveState = 'saved' | 'dirty' | 'saving' | 'error';
```

显示：

- 已保存。
- 有未保存修改。
- 保存中。
- 保存失败，重试。

移除常驻“保存大纲”按钮。保存失败时保留本地内容，不得用服务端响应覆盖。

## 10. 确认生成

DOCX、PDF 和 PPTX 使用同一规则：

1. flush debounce。
2. 等待 pending save。
3. 确认 revision 已持久化。
4. 展示目标格式。
5. 用户确认。
6. 调用 render。

一次点击最多出现一个确认 Dialog。

longform 同时选择 DOCX/PDF 时，一次确认生成两个 outputs。允许一个成功、一个失败，并分别提供下载或重试。

Word 不得在草稿创建后自动生成。

## 11. 输出预览

- DOCX：复用现有 `docx-preview`。
- PDF：复用 iframe。
- PPTX：复用联系图。

统一输出卡显示：

- 格式。
- 状态和进度。
- 文件大小。
- diagnostics。
- 预览。
- 下载。
- 重试。

不要在普通界面直接显示完整 rendered spec JSON。放入默认折叠的“技术详情”。

## 12. 组件拆分

建议：

```text
frontend/src/components/documents/
  DocumentGenerationPanel.vue
  DocumentStatusCard.vue
  DocumentWorkbench.vue
  DocumentWorkbenchHeader.vue
  DocumentDeliverableNavigation.vue
  PresentationEditor.vue
  PresentationPreview.vue
  LongformEditor.vue
  LongformPreview.vue
  DocumentSettingsDialog.vue
  DocumentVersionDialog.vue
  DocumentOutputCard.vue
  documentEditor.ts
  documentEditor.test.ts
```

迁移时允许 `ArtifactGenerationPanel.vue` 临时包装新组件，但最终应删除旧长表单。

不要重新形成一个同时包含请求、轮询、保存和完整模板的 600 行以上单文件组件。

## 13. 状态要求

必须覆盖：

- planning skeleton。
- awaiting confirmation。
- dirty/saving/saved/error。
- rendering。
- validating。
- repairing。
- completed。
- partial。
- failed。
- cancelled。
- stale。
- immutable history。
- empty deliverable。

错误显示在相关操作附近，字段错误显示在字段下方。

## 14. 可访问性

- Dialog 正确管理焦点。
- 图标按钮有 aria-label 和 Tooltip。
- 当前结构项有 aria-current。
- 添加、删除和移动可用键盘完成。
- error 使用 role=alert。
- save/progress 使用 role=status。
- 不只依赖颜色表达状态。
- 遵守 prefers-reduced-motion。
- label 位于输入上方，不用 placeholder 替代。

## 15. 测试

至少覆盖：

- 添加、复制、删除和移动幻灯片。
- 幻灯片最小数量限制。
- 添加、删除和移动 longform block。
- 切换 DOCX/PDF 不复制或丢失 blocks。
- debounce 只触发一次延迟保存。
- 保存期间再次编辑会保存最新 revision。
- 生成等待保存完成。
- 会话切换后旧响应不覆盖新状态。
- stale 和历史版本只读。
- DOCX/PDF partial 输出显示。
- DOCX preview、PDF iframe、PPTX 联系图入口。
- 移动端 Tab。

保留现有 `draftRevision.test.ts` 和 `sessionEpoch.test.ts`。

## 16. 手工验收

1. 请求 Word 后出现草稿卡，不立即产生下载文件。
2. 打开工作台编辑 Word，刷新后内容仍存在。
3. 点击“生成 DOCX”后才开始生成。
4. 同一长篇草稿可以同时生成 DOCX/PDF。
5. DOCX/PDF 切换不改变正文。
6. PPTX 单页编辑可用。
7. PPT + 正式报告显示两个 deliverable。
8. 三种真实输出预览可用。
9. 失败 output 可以独立重试。
10. 深色模式、移动端和键盘操作可用。

## 17. 完成标准

- 聊天中不再出现旧长表单或独立新 Word 卡。
- 统一状态卡和全屏工作台可用。
- 演示文稿和长篇文档编辑器可用。
- Word 必须确认后生成。
- 自动保存和 revision 保护覆盖三种格式。
- DOCX/PDF/PPTX 预览、下载和重试可用。
- frontend typecheck、测试和 build 通过。

验证：

```bash
pnpm --filter frontend typecheck
pnpm --filter frontend test
pnpm --filter frontend build
```

