# RAG 后端实现说明

## 目标

在现有 Express + AgentLoop 后端中实现 RAG v1，让 Agent 可以基于固定 `docs/` 目录中的 Markdown 文档进行资料检索，并把命中的片段作为 `sources` 返回给前端。

本阶段先做轻量版本：

- 后端启动时加载 `docs/`。
- 启动时完成 Markdown 分片。
- 使用内存索引保存 chunks。
- 先使用关键词评分，不接 embedding。
- 新增 `search_knowledge` tool。
- AgentLoop 最终返回 `sources`。

暂不做：数据库持久化、向量库、Embedding API、后台增量索引、SSE 流式事件。

## 当前相关代码

后端已有：

- `backend/src/agent/agentLoop.ts`：多轮 function calling AgentLoop。
- `backend/src/agent/types.ts`：AgentLoop 类型。
- `backend/src/tools/registry.ts`：工具注册表。
- `backend/src/tools/docsTool.ts`：当前 `search_docs` / `read_document` 工具。
- `backend/src/index.ts`：后端启动入口。
- `docs/`：固定 Markdown 文档目录。

当前 `/api/agent/chat` 返回：

```ts
{
  reply: string;
  toolCalls: ToolTrace[];
  trace: AgentTraceStep[];
}
```

RAG 后需要扩展为：

```ts
{
  reply: string;
  toolCalls: ToolTrace[];
  trace: AgentTraceStep[];
  sources: RagSource[];
}
```

## 新增目录结构

新增：

```text
backend/src/rag/
├── types.ts
├── documentLoader.ts
├── chunker.ts
├── scoring.ts
└── index.ts
```

## 类型设计

在 `backend/src/rag/types.ts` 中定义：

```ts
export type RagDocument = {
  file: string;
  title: string;
  content: string;
  lineCount: number;
};

export type DocumentChunk = {
  id: string;
  file: string;
  title: string;
  heading?: string;
  content: string;
  startLine: number;
  endLine: number;
};

export type RagSource = DocumentChunk & {
  score: number;
};
```

同时在 `backend/src/agent/types.ts` 的 `AgentLoopResult` 中新增：

```ts
sources: RagSource[];
```

注意：要从 `../rag/types.js` import `RagSource`。

## 文档加载器

在 `backend/src/rag/documentLoader.ts` 中实现：

```ts
export function loadMarkdownDocuments(): RagDocument[]
```

要求：

- 固定读取项目根目录的 `docs/`。
- 只读取 `.md` 文件。
- 支持子目录递归。
- 文件路径返回相对 `docs/` 的路径，例如 `backend-guide.md`。
- 如果 `docs/` 不存在，返回空数组，不要让服务启动失败。
- 标题优先取第一个 `# ` 标题，否则使用文件名。

路径解析可参考 `backend/src/tools/docsTool.ts` 当前的 `getDocsRoot()`。

## Markdown 分片

在 `backend/src/rag/chunker.ts` 中实现：

```ts
export function chunkMarkdownDocument(document: RagDocument): DocumentChunk[]
```

v1 分片规则：

- 按二级标题 `## ` 分片。
- 如果文档没有二级标题，则整篇作为一个 chunk。
- chunk 内容包含 heading 行和其后正文。
- 保留 `startLine` 和 `endLine`。
- 每个 chunk 的 `id` 使用 `${file}:${startLine}-${endLine}`。

示例：

```text
# 后端指南

## 开发启动
...

## API 结构
...
```

应切为：

```text
backend-guide.md:3-11  开发启动
backend-guide.md:13-23 API 结构
backend-guide.md:25-29 数据库
```

## 关键词评分

在 `backend/src/rag/scoring.ts` 中实现：

```ts
export function scoreChunk(query: string, chunk: DocumentChunk): number
```

v1 评分策略：

- 将 query 按空白切分关键词。
- 中文连续文本没有空格时，可以额外使用整句 query。
- 对 chunk 的 `title + heading + content` 做 lowercase 匹配。
- 命中标题加权高于正文。
- 分数范围不强制归一化，但建议保留 0-1 或简单 number。
- 没命中的 chunk 返回 0。

建议简单实现：

```ts
const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
```

如果 terms 只有一个，也直接用它。

对于类似 `后端 启动`，应该能命中包含 `启动后端` 的 chunk，因为两个 term 都出现即可加分。

## 内存索引

在 `backend/src/rag/index.ts` 中实现：

```ts
export function initRagIndex(): void;
export function searchKnowledge(args: unknown): { query: string; results: RagSource[] };
export function getRagSourcesFromToolTraces(toolCalls: ToolTrace[]): RagSource[];
```

内部维护：

```ts
let chunks: DocumentChunk[] = [];
```

`initRagIndex()`：

- 调用 `loadMarkdownDocuments()`。
- 对每篇文档调用 `chunkMarkdownDocument()`。
- 把结果放入内存 `chunks`。
- 可以 `console.log` 输出加载文档数和 chunk 数。

`searchKnowledge(args)` 参数：

```ts
{
  query: string;
  limit?: number;
}
```

校验：

- `query` 必须是非空字符串。
- `limit` 默认 5，最大 10。

返回：

```ts
{
  query,
  results: RagSource[]
}
```

`results`：

- 对所有 chunks 计算 score。
- 过滤 `score > 0`。
- 按 score 降序。
- 截取 limit。

## 启动时初始化

修改 `backend/src/index.ts`：

```ts
import { initRagIndex } from './rag/index.js';

initDb();
initRagIndex();
```

顺序放在 `app.listen()` 前。

## 新增 search_knowledge tool

修改 `backend/src/tools/registry.ts`：

新增 import：

```ts
import { searchKnowledge } from '../rag/index.js';
```

新增工具：

```ts
search_knowledge: {
  definition: {
    type: 'function',
    function: {
      name: 'search_knowledge',
      description: 'Search the indexed Markdown knowledge base and return relevant source chunks.',
      parameters: {
        type: 'object',
        properties: {
          query: {
            type: 'string',
            description: 'Question or search query.'
          },
          limit: {
            type: 'integer',
            minimum: 1,
            maximum: 10,
            description: 'Maximum number of source chunks to return. Defaults to 5.'
          }
        },
        required: ['query']
      }
    }
  },
  execute: searchKnowledge
}
```

可以保留旧的 `search_docs`，但 system prompt 应优先引导使用 `search_knowledge`。

## AgentLoop 返回 sources

修改 `backend/src/agent/agentLoop.ts`：

- 在 loop 结束返回前，从 `toolTraces` 中提取所有 `search_knowledge` 的结果。
- 合并去重后返回 `sources`。

建议在 `backend/src/rag/index.ts` 实现：

```ts
export function getRagSourcesFromToolTraces(toolCalls: ToolTrace[]): RagSource[]
```

规则：

- 只处理 `toolCall.name === 'search_knowledge'`。
- 只处理 `toolCall.result` 中有 `results` 数组的情况。
- 按 `id` 去重。

然后在 AgentLoop 所有 return 处返回：

```ts
return {
  reply,
  toolCalls: toolTraces,
  trace,
  sources: getRagSourcesFromToolTraces(toolTraces)
};
```

达到最大轮数时也要返回 sources。

## System Prompt 调整

修改 `backend/src/routes/agent.ts` 的 `AGENT_SYSTEM_PROMPT`：

建议加入：

```text
- For knowledge base or documentation questions, call search_knowledge first.
- Use read_document only when search_knowledge snippets are not enough.
- When answering from retrieved sources, mention the relevant document name when useful.
```

可保留 `search_docs` 作为 fallback，但优先 `search_knowledge`。

## 验收标准

完成后验证：

```bash
pnpm --filter backend typecheck
pnpm --filter backend build
```

启动后端后，在前端 Agent 页面提问：

```text
后端怎么启动？
```

期望：

- Agent 调用 `search_knowledge`。
- 返回 `backend-guide.md` 相关 chunk。
- `/api/agent/chat` 的 `data.sources` 非空。
- 最终回答包含 `pnpm --filter backend dev`。

再提问：

```text
Agent 当前有哪些工具？
```

期望：

- 命中 `agent-tools.md`。
- `sources` 中包含工具说明片段。
