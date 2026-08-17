# 知识库工具收敛与工具组实施方案

## 1. 执行目标

把当前面向用户展示的三个知识库工具：

- `search_knowledge`：知识库检索
- `search_docs`：文档关键词搜索
- `read_document`：文档全文阅读

收敛为一个用户可见的“知识库”开关，同时保留两个职责清晰的模型工具：

- `search_knowledge`：发现相关文档与证据片段。
- `read_document`：读取已确定文档的指定范围。

删除独立模型工具 `search_docs`。它的关键词检索能力并入 `search_knowledge` 的底层检索链路。

最终用户界面：

```text
知识库  [开关]
```

打开后，前端提交的 ToolPolicy 展开为：

```json
{
  "mode": "selected",
  "names": ["search_knowledge", "read_document"]
}
```

这表示同时授权两个工具，不表示每轮强制同时调用两个工具。模型通常先检索，只有片段不足时才读取文档。

## 2. 开始前的工作区约束

开始实现前执行：

```bash
git status --short
git diff
```

当前项目可能包含用户或其他 Agent 尚未提交的改动。必须保留现有 ToolRuntime、ToolPolicy、Research Skill、快速对话和研究工作台合并相关实现，不得整体覆盖文件或回退无关变更。

本任务是工具目录和用户选择层的收敛，不得借机重构 LLM Provider、Durable Task 状态机或整个 RAG 系统。

## 3. 当前实现判断

### 3.1 `search_knowledge`

当前 `search_knowledge` 已经不是单纯向量检索。它内部包含：

- 查询 Embedding。
- Qdrant 向量召回。
- SQLite FTS 关键词召回。
- RRF 融合。
- 相邻片段上下文组装。
- 查询改写和多查询融合。
- `sufficient`、`weak`、`empty` 置信度判断。

因此“关键词搜索”已经是知识库检索的内部召回通道，不应继续作为同级用户工具暴露。

### 3.2 `search_docs`

当前实现遍历所有知识文档，对每一行执行大小写不敏感的字符串包含判断，返回：

```ts
{
  file: string;
  line: number;
  preview: string;
}
```

它存在以下问题：

- 与 `search_knowledge` 的 SQLite 关键词召回重复。
- 没有统一的检索置信度。
- 不进入 Research Source 的主要提取路径。
- Agent Prompt 必须额外解释何时才能调用它。
- 用户难以理解它和“知识库检索”的区别。
- 增加 ToolPolicy、Skill、去重、证据链和测试维护成本。

### 3.3 `read_document`

读取文档和发现文档是不同动作，应保留为独立模型工具。当前实现只返回文档开头最多 12,000 字符，需要增强定向读取能力，避免长文档后半部分永远不可达。

## 4. 核心设计

### 4.1 三层结构

实现后分为三层：

```text
用户选择层
└── knowledge 工具组：“知识库”
    ├── search_knowledge
    └── read_document

模型工具层
├── search_knowledge
└── read_document

检索实现层
└── search_knowledge
    ├── 向量召回
    ├── SQLite FTS 关键词召回
    ├── 查询改写
    ├── RRF 融合
    └── 上下文组装与置信度判断
```

### 4.2 工具组不是模型工具

`knowledge` 只用于前端展示、选择和权限展开：

- 不注册到 ToolRuntime。
- 不出现在传给模型的 tools 数组中。
- 不允许模型调用 `knowledge`。
- 不写入 ToolTrace。
- 不写入 ToolPolicy。
- 不取代 `search_knowledge` 和 `read_document` 的审计记录。

ToolPolicy 继续只保存真实、可执行的模型工具名。

### 4.3 不强制双调用

打开“知识库”后，典型运行流程：

```text
模型调用 search_knowledge
        ↓
片段和证据是否足够？
   ├── 是：直接回答
   └── 否：调用 read_document 读取相关范围后回答
```

禁止在工具组展开逻辑中自动执行两个工具。工具组只授权，不负责编排。

## 5. 工具组数据结构

在工具模块下新增中性的用户选择元数据，例如：

```text
backend/src/tools/groups.ts
```

建议定义：

```ts
export type ToolGroupDefinition = {
  id: string;
  label: string;
  description: string;
  toolNames: string[];
};

export const builtInToolGroups: ToolGroupDefinition[] = [
  {
    id: 'knowledge',
    label: '知识库',
    description: '检索知识库，并在需要时阅读相关文档。',
    toolNames: ['search_knowledge', 'read_document']
  }
];
```

启动时验证：

- `id` 只能包含小写字母、数字和连字符。
- `id` 不得重复。
- `toolNames` 不能为空且不得重复。
- 每个工具名必须存在于 ToolRuntime 的模型可见工具中。
- V1 中一个工具最多属于一个用户可见工具组，避免开关状态歧义。
- 内部工具不得出现在用户可见工具组中。

不要把分组字段直接塞进 `ToolModule`，除非实现者确认所有调用方都需要它。工具执行定义和用户展示分组是两个不同维度，单独 Registry 更清晰。

## 6. 工具列表 API

当前 `/api/research/tools` 返回扁平工具列表。扩展为：

```ts
type ResearchToolInfo = {
  name: string;
  label: string;
  description: string;
};

type ResearchToolGroupInfo = {
  id: string;
  label: string;
  description: string;
  toolNames: string[];
};
```

响应建议保持兼容：

```json
{
  "tools": [
    {
      "name": "search_knowledge",
      "label": "知识库检索",
      "description": "..."
    },
    {
      "name": "read_document",
      "label": "文档定向阅读",
      "description": "..."
    }
  ],
  "groups": [
    {
      "id": "knowledge",
      "label": "知识库",
      "description": "检索知识库，并在需要时阅读相关文档。",
      "toolNames": ["search_knowledge", "read_document"]
    }
  ]
}
```

规则：

- `tools` 继续返回模型可见工具 metadata，供兼容客户端和调试使用。
- `groups` 用于新版 Research Composer。
- 没有加入任何 group 的工具在前端继续作为单独开关显示。
- `search_docs` 不再出现在 `tools` 或 `groups` 中。
- API 不返回工具执行函数或内部实现配置。

## 7. 前端选择模型

### 7.1 状态

前端不要直接维护三个知识库工具的独立勾选状态。建议维护：

```ts
const enabledToolGroups = ref<Record<string, boolean>>({});
const enabledStandaloneTools = ref<Record<string, boolean>>({});
```

默认所有 group 和独立工具都为 `false`，保持“未选 Skill、未选工具即快速对话”的现有规则。

### 7.2 构建 ToolPolicy

发送前把已开启 group 展开为真实工具名，再与独立工具合并去重：

```ts
function expandSelectedTools(
  groups: ResearchToolGroupInfo[],
  enabledGroups: Record<string, boolean>,
  enabledStandalone: Record<string, boolean>
) {
  const names = new Set<string>();

  for (const group of groups) {
    if (!enabledGroups[group.id]) continue;
    for (const name of group.toolNames) names.add(name);
  }

  for (const [name, enabled] of Object.entries(enabledStandalone)) {
    if (enabled) names.add(name);
  }

  return [...names];
}
```

最终规则：

- 无任何选择：`{ mode: 'none' }`。
- 选中部分能力：`{ mode: 'selected', names }`。
- 不要因为所有 UI 项都打开就自动使用 `{ mode: 'all' }`；`all` 可能在未来包含未展示或新注册工具，显式 names 更安全、更可审计。

### 7.3 UI

工具菜单中显示：

```text
工具
✓ 知识库
  检索知识库，并在需要时阅读相关文档

□ 受控联网检索
□ Word 文档生成
...
```

不要在普通用户菜单中继续显示：

- 知识库检索
- 文档关键词搜索
- 文档全文阅读

开发调试页可以展示 group 展开后的底层工具，但必须明确标注“模型工具”。

工具计数按用户可见选择项计算，而不是按展开后的模型工具数计算。例如只打开知识库时显示 `工具 1/N`，而不是 `2/N`。

## 8. Skill 与工具组联动

官方 Skill 当前仍用真实工具名声明：

```ts
tools: {
  recommended: string[];
  required: string[];
}
```

V1 不修改 Skill 持久化格式，也不把 group id 写入 Skill 定义。原因：

- Skill 快照需要准确记录模型实际权限。
- ToolRuntime 只理解真实工具名。
- 历史版本不应依赖可变的 UI 分组。

前端接到 Skill 的 required tool names 后：

1. 找到包含任一 required tool 的用户工具组。
2. 启用整个工具组。
3. 锁定该工具组，直到 Skill 被清除。
4. 展开后的 ToolPolicy 包含组内全部工具。

例如 Skill 要求 `search_knowledge`，前端启用并锁定“知识库”组，因此本轮同时授权：

```ts
['search_knowledge', 'read_document']
```

后端仍按 Skill 定义验证 required 工具，不信任前端 group 状态。

推荐工具只用于提示或高亮，不应静默自动开启，除非产品已经有明确的自动启用规则。

## 9. 收敛 `search_docs`

### 9.1 从模型目录移除

从 `backend/src/tools/catalog/knowledge.ts` 删除 `search_docs` ToolModule，使其不再：

- 出现在模型 tool definitions 中。
- 出现在 Research 工具列表 API 中。
- 被新 ToolPolicy 选择。
- 被新 Skill 版本引用。

`docsTool.ts` 中旧 `searchDocs` 实现可以在兼容测试完成后删除，但不要先删再补回归用例。

### 9.2 保留关键词能力

不得简单删除 `search_docs` 而不验证搜索能力。为 `search_knowledge` 的关键词通道增加回归用例，至少覆盖：

- 中文短语。
- 英文单词。
- snake_case 标识符。
- kebab-case 标识符。
- API、类名和函数名。
- 文档标题与章节标题。
- 只存在于文档正文的一段精确文本。
- 大小写差异。

如果 SQLite FTS 对代码标识符或精确短语召回不足，应修复分词、查询构造或增加内部 exact-match 召回通道，然后继续在 `search_knowledge` 内融合。不要重新暴露第三个模型工具。

### 9.3 可选文件范围

增强 `search_knowledge` 参数：

```ts
{
  query: string;
  file?: string;
  limit?: number;
}
```

`file` 存在时：

- Qdrant 向量召回增加 file filter。
- SQLite FTS 关键词召回使用同一 file filter。
- 查询改写和融合仍遵守现有预算。
- 返回结果只能来自该文档。
- 未找到文件时返回明确、稳定的错误或 empty 结果，选择一种行为并测试。

这取代 Prompt 中“先检索，再用 search_docs 在已知文档里定位文本”的旧流程。

## 10. 增强 `read_document`

V1 建议保留内部名称 `read_document`，避免不必要的历史 ToolPolicy、Skill 和 ToolTrace 迁移。只调整用户标签为“文档定向阅读”。未来若确实需要统一命名，再单独迁移为 `read_knowledge_document`。

建议参数：

```ts
type ReadDocumentArgs = {
  file: string;
  startLine?: number;
  endLine?: number;
  maxChars?: number;
};
```

约束：

- `file` 必填，必须经过现有知识库相对路径校验。
- `startLine`、`endLine` 使用 1-based 行号。
- 两者同时存在时必须满足 `endLine >= startLine`。
- 没有范围时从文档开头读取，保持旧行为兼容。
- `maxChars` 继续限制单次上下文体积。
- 超出限制时返回明确的实际范围和继续读取位置。

建议返回：

```ts
{
  file: string;
  content: string;
  startLine: number;
  endLine: number;
  totalLines: number;
  truncated: boolean;
  nextStartLine?: number;
}
```

Agent 使用 `search_knowledge` 返回的 `startLine/endLine` 或 locator 决定读取范围。不要默认把整篇长文档送进上下文。

## 11. Prompt 更新

Research 和 Agent Prompt 删除所有 `search_docs` 规则，改为：

```text
- For knowledge-base questions, call search_knowledge first.
- search_knowledge already combines semantic and keyword retrieval; do not simulate a separate keyword-search step.
- Use the optional file filter when you need to search within a document already identified by retrieval.
- Use read_document only when the returned snippets are insufficient, and read the smallest relevant line range.
```

保留现有：

- `search_knowledge.verdict` 权威性。
- `empty` 结果不得被当作证据。
- 查询改写预算。
- 工具失败处理。
- 获得足够证据后停止调用工具。

不要让 `read_document` 绕过 `search_knowledge.empty`：模型不能因为全库检索为空就猜文件名并扫描所有文档。

## 12. 历史兼容

### 12.1 旧 ToolPolicy

数据库中的历史 Research Run、Durable Task 或客户端请求可能包含 `search_docs`。增加集中式工具别名规范化：

```ts
const legacyToolAliases: Record<string, string> = {
  search_docs: 'search_knowledge'
};
```

规范化顺序：

1. 解析旧数组或当前 ToolPolicy。
2. 把 legacy name 映射为当前 name。
3. 去重。
4. 再执行 registered tool restriction。

注意：旧空数组当前有既定兼容语义，不得在本任务中顺便修改。

如果映射后 `selected.names` 为空，不得留下非法的 `{ mode: 'selected', names: [] }`。应根据调用场景返回明确错误，或规范化为 `none`；选择一种统一规则并补测试。对于用户明确选择但全部工具已失效的请求，推荐返回错误，避免权限语义被静默改变。

### 12.2 历史 ToolTrace 与证据链

历史执行记录中仍可能存在 `toolName === 'search_docs'`。因此：

- 不要删除证据链构建器中读取历史 `search_docs` 结果的分支。
- 新运行不再生成这种 ToolTrace。
- 历史任务详情继续使用旧标签展示，或标注为“旧版文档关键词搜索”。
- 不要批量改写不可变审计记录。

### 12.3 运行中的旧任务

确认 Research Run 和 Durable Task 的重启策略。如果系统可能恢复并继续执行旧计划，旧计划中的 `search_docs` 必须在执行入口被别名映射到 `search_knowledge`。如果旧任务只读历史、不继续执行，也必须保证详情和证据链可读取。

## 13. Durable Task 与其他调用面

同步检查并更新：

- `TaskConsoleView.vue` 默认选择列表。
- Durable Task 的检索工具判断。
- 工具调用去重集合。
- Agent Router Prompt。
- Research Service Prompt。
- Runtime evidence chain builder。
- Skill Registry 校验和所有官方 Skill 版本。
- 评测固定工具列表。
- 文档和 runtime verify 脚本。

Durable Task 如果暂时仍展示底层工具，可以显示“知识库”工具组，但展开后仍保存真实工具名。不要把 `knowledge` group id 当作可执行工具交给 Runtime。

## 14. 建议文件改动

### 后端

- `backend/src/tools/groups.ts`：新增工具组定义与验证。
- `backend/src/tools/catalog/knowledge.ts`：移除 `search_docs`，增强两个保留工具的 schema。
- `backend/src/tools/docsTool.ts`：删除旧搜索，实现定向读取。
- `backend/src/tools/policy.ts`：增加 legacy tool alias 规范化。
- `backend/src/rag/index.ts`：支持可选 file filter。
- `backend/src/rag/vectorStore.ts`：支持 file filter。
- `backend/src/rag/keywordStore.ts`：支持 file filter，并补精确词回归。
- `backend/src/modules/research/application.ts`：返回工具组 metadata。
- `backend/src/routes/research.ts`：工具 API 返回 groups。
- `backend/src/research/service.ts`：更新 Prompt。
- `backend/src/routes/agent.ts`：更新 Prompt。
- `backend/src/agent/toolRound.ts`：移除新调用中的 `search_docs` 去重项。
- `backend/src/runtime/service.ts`：更新检索工具识别。
- `backend/src/runtime/evidenceChainBuilder.ts`：保留旧记录解析，增强新 read locator。
- `backend/src/skills/catalog/*.ts`：确认不再引用 `search_docs`。

### 前端

- `frontend/src/api/research.ts`：增加 `ResearchToolGroupInfo`。
- `frontend/src/views/ResearchWorkbench.vue`：按 group 维护选择并展开 ToolPolicy。
- `frontend/src/components/research/ResearchComposer.vue`：展示用户工具组。
- `frontend/src/components/research/ResearchMainPanel.vue`：传递 groups 与 group 状态。
- `frontend/src/views/TaskConsoleView.vue`：移除独立 `search_docs`，按产品范围接入 group。

删除或修改文件前使用 `rg` 查找全部引用，不得只处理 Research Workbench。

## 15. 测试要求

### 15.1 工具组

- `knowledge` 正确展开为 `search_knowledge` 和 `read_document`。
- group 中未知工具导致启动验证失败。
- 重复 group id 失败。
- 同一工具重复加入多个 V1 group 失败。
- group id 不出现在 ToolRuntime definitions 中。
- group id 不写入 ToolPolicy 和 ToolTrace。
- 未分组工具仍作为独立 UI 项返回。

### 15.2 前端

- 默认所有 group 未选中。
- 开启知识库后 ToolPolicy 包含两个底层工具。
- 关闭知识库后两个底层工具都不再授权。
- 工具计数把知识库算作一个用户项。
- Skill 要求 `search_knowledge` 时，整个知识库组启用并锁定。
- 清除 Skill 后恢复可切换状态，但不擅自关闭用户主动开启的 group。
- 不再显示“文档关键词搜索”。
- 未选择任何工具和 Skill 时仍进入快速对话。

### 15.3 检索

- 混合检索继续同时使用向量和关键词通道。
- `file` filter 对向量与关键词结果同时生效。
- 中文、英文、代码标识符和精确文本的关键词召回不低于移除前。
- `sufficient/weak/empty` 行为不回退。
- 查询改写预算不因 file filter 重置。
- 空结果不会被记录为可引用证据。

### 15.4 文档读取

- 无范围参数保持旧的开头读取行为。
- 指定行号返回准确内容与实际范围。
- 非法行号、反向范围和未知文件得到稳定错误。
- 超过 maxChars 时正确返回 `truncated` 和 `nextStartLine`。
- 路径穿越继续被拒绝。
- 证据链保存 file、startLine、endLine 和截断状态。

### 15.5 历史兼容

- 旧 ToolPolicy 中 `search_docs` 映射为 `search_knowledge`。
- 映射后工具名去重。
- 历史 `search_docs` ToolTrace 仍能生成证据链。
- 旧 Skill snapshot 可以解析。
- 旧 Task 和 Research Run 详情可以读取。
- 新模型 definitions 中不存在 `search_docs`。

## 16. 实施顺序

按以下顺序执行，避免先删除旧工具造成能力缺口：

1. 为现有关键词和精确文本行为增加回归测试。
2. 增加工具别名规范化及历史兼容测试。
3. 为 `search_knowledge` 增加可选 file filter。
4. 增强 `read_document` 的定向读取与 locator。
5. 增加 ToolGroup Registry、验证和 Research API metadata。
6. 修改 Research Workbench，以 group 生成 ToolPolicy。
7. 完成 Skill required tools 与 group 的联动。
8. 从模型目录移除 `search_docs`。
9. 更新 Prompt、去重、Durable Task、证据链和评测调用面。
10. 删除不再使用的 `searchDocs` 新调用代码，同时保留历史结果解析。
11. 运行全量验证并检查所有遗留引用。

## 17. 验收标准

只有同时满足以下条件才算完成：

- 用户工具菜单只显示一个“知识库”开关，不再显示三个知识库工具。
- 打开知识库后，本轮授权 `search_knowledge` 与 `read_document`。
- 模型仍看到两个职责明确的工具，而不是一个带 action 的大工具。
- 模型 definitions 中不存在 `search_docs`。
- `search_knowledge` 保留语义与关键词融合能力，并支持已知文档内检索。
- `read_document` 支持按范围读取长文档。
- 检索片段足够时不会强制调用文档读取。
- ToolPolicy 只保存真实工具名，不保存 group id。
- Skill 可以通过 required tool 自动启用并锁定知识库组。
- 默认没有任何工具组被选中。
- 旧 `search_docs` Policy、Trace、Task 和 Run 仍可兼容读取或执行。
- Research、Agent、Durable Task 和证据链没有遗留的新 `search_docs` 调用路径。
- 类型检查、测试、运行时校验、构建和 diff 检查全部通过。

## 18. 验证命令

```bash
pnpm typecheck
pnpm test
pnpm --filter backend runtime:verify
pnpm build
git diff --check
```

另外执行：

```bash
rg -n "search_docs" backend frontend docs
```

允许保留的结果仅限：

- legacy alias。
- 历史 ToolTrace / evidence chain 解析。
- 兼容测试。
- 明确标注为历史行为的迁移文档。

## 19. 明确不做

- 不把三个动作合并成一个带 `action` 参数的模型工具。
- 不把 `knowledge` group 注册成模型工具。
- 不让开启工具组自动执行全部组内工具。
- 不把 group id 写进 ToolPolicy、Skill snapshot 或 ToolTrace。
- 不删除历史 `search_docs` 审计记录。
- 不降低 `search_knowledge` 的置信度和查询预算约束。
- 不默认读取整篇长文档。
- 不修改“未选 Skill、未选工具即快速对话”的规则。

