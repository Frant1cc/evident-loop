# RAG 前端实现说明

## 目标

在现有 Agent 页面右侧面板中新增一个 tab，用来展示 RAG 检索到的引用来源。这个面板先命名为 `Sources` 或 `引用来源`。

当前右侧只有 Agent Trace 调用过程。RAG 后端会在 `/api/agent/chat` 返回中新增：

```ts
sources: RagSource[]
```

前端需要接收它，并在右侧面板新增 tab 展示。

## 当前相关代码

前端已有：

- `frontend/src/views/ChatView.vue`：Agent 页面主状态和接口请求。
- `frontend/src/components/chat/AgentThinkingPanel.vue`：右侧 Agent Trace 面板。
- `frontend/src/types/chat.ts`：聊天、工具 trace 类型。

当前 Agent 请求解析在 `ChatView.vue` 中：

```ts
const payload = (await response.json()) as {
  code: number;
  message?: string;
  data?: {
    reply?: string;
    toolCalls?: ToolCallTrace[];
    trace?: AgentTraceStep[];
  };
};
```

需要扩展为接收 `sources`。

## 新增类型

修改 `frontend/src/types/chat.ts`，新增：

```ts
export type RagSource = {
  id: string;
  file: string;
  title: string;
  heading?: string;
  content: string;
  startLine: number;
  endLine: number;
  score: number;
};
```

## ChatView 状态接入

修改 `frontend/src/views/ChatView.vue`。

import 类型：

```ts
import type { AgentTraceStep, ChatMessage, ChatSession, RagSource, ToolCallTrace } from '../types/chat';
```

新增状态：

```ts
const sources = ref<RagSource[]>([]);
```

发送消息前重置：

```ts
sources.value = [];
```

Agent 响应类型新增：

```ts
data?: {
  reply?: string;
  toolCalls?: ToolCallTrace[];
  trace?: AgentTraceStep[];
  sources?: RagSource[];
};
```

请求成功后赋值：

```ts
sources.value = payload.data?.sources ?? [];
```

传给右侧面板：

```vue
<AgentThinkingPanel
  :content="thinkingContent"
  :loading="loading"
  :tool-calls="toolCalls"
  :trace="agentTrace"
  :sources="sources"
/>
```

## 右侧面板新增 tab

可以继续使用 `AgentThinkingPanel.vue`，在里面加入两个内部 tab：

```text
Trace | Sources
```

不要新增页面级 tab，也不要改顶部 `ChatTabs`。

原因：

- `Trace` 和 `Sources` 都属于 Agent 运行检查面板。
- 放在右侧面板内部切换最轻量。
- 不影响现有 Chat / Agents / Runs / Settings 结构。

## AgentThinkingPanel Props

修改 `frontend/src/components/chat/AgentThinkingPanel.vue`：

```ts
import { ref } from 'vue';
import type { AgentTraceStep, RagSource, ToolCallTrace } from '../../types/chat';

const activeInspectorTab = ref<'trace' | 'sources'>('trace');

defineProps<{
  content: string;
  loading: boolean;
  toolCalls: ToolCallTrace[];
  trace: AgentTraceStep[];
  sources: RagSource[];
}>();
```

## 面板头部设计

当前头部是：

```vue
<p>Agent Trace</p>
<h2>调用过程</h2>
```

建议改成：

```vue
<header ...>
  <p class="...">Agent Inspector</p>
  <div class="...">
    <button @click="activeInspectorTab = 'trace'">调用过程</button>
    <button @click="activeInspectorTab = 'sources'">引用来源</button>
  </div>
</header>
```

按钮样式沿用现有 CSS 变量：

- `--agent-border`
- `--agent-surface`
- `--agent-surface-muted`
- `--agent-selected-bg`
- `--agent-selected-text`
- `--agent-text-muted`

不要引入新依赖。

## Trace tab 内容

现有 `trace` 展示逻辑整体保留，只包一层：

```vue
<template v-if="activeInspectorTab === 'trace'">
  <!-- 当前 trace/toolCalls/content 逻辑 -->
</template>
```

空状态仍然使用：

```text
等待智能体调用工具...
暂无调用过程。
```

## Sources tab 内容

新增：

```vue
<template v-else>
  <section v-if="sources.length" class="grid gap-3">
    <article v-for="source in sources" :key="source.id" ...>
      ...
    </article>
  </section>
  <p v-else ...>
    {{ loading ? '等待检索引用来源...' : '暂无引用来源。' }}
  </p>
</template>
```

每个 source card 展示：

```text
file
heading 或 title
Lines startLine-endLine
Score 0.82
content preview
```

推荐模板：

```vue
<article class="rounded-lg border border-[var(--agent-border)] bg-[var(--agent-surface)] p-3">
  <div class="flex items-start justify-between gap-3">
    <div class="min-w-0">
      <p class="m-0 truncate font-mono text-xs font-bold text-[var(--agent-text)]">{{ source.file }}</p>
      <h3 class="m-0 mt-1 text-sm font-bold leading-5 text-[var(--agent-text)]">
        {{ source.heading || source.title }}
      </h3>
    </div>
    <span class="rounded-md bg-[var(--agent-selected-bg)] px-2 py-1 font-mono text-[10px] font-bold text-[var(--agent-selected-text)]">
      {{ source.score.toFixed(2) }}
    </span>
  </div>

  <p class="m-0 mt-2 font-mono text-[10px] font-bold uppercase tracking-[0.08em] text-[var(--agent-text-muted)]">
    Lines {{ source.startLine }}-{{ source.endLine }}
  </p>

  <p class="m-0 mt-2 whitespace-pre-wrap break-words text-xs leading-6 text-[var(--agent-text-muted)]">
    {{ source.content }}
  </p>
</article>
```

如果 content 太长，建议限制高度：

```text
max-h-44 overflow-auto
```

## UI 行为

要求：

- 每次发送新消息时清空 `sources`。
- Agent 返回后显示 `sources`。
- 默认 tab 可以保持 `Trace`。
- 如果 `sources.length > 0`，可以选择自动切到 `Sources`，但不是必须。
- 不要把 Sources 做进聊天消息正文。
- 不要展示完整 raw tool result，Sources 只展示结构化 source。

## 后端响应兼容

后端 RAG 没完成前，`sources` 可能不存在。

前端必须兼容：

```ts
sources.value = payload.data?.sources ?? [];
```

不要因为没有 sources 报错。

## 验收标准

完成后运行：

```bash
pnpm --filter frontend typecheck
pnpm --filter frontend build
```

后端完成 RAG 后，在 Agent 页面提问：

```text
后端怎么启动？
```

期望：

- 右侧面板有 `调用过程` 和 `引用来源` 两个 tab。
- `调用过程` 仍能显示 AgentLoop trace。
- `引用来源` 能显示 `backend-guide.md`。
- source card 显示标题、行号、score 和 chunk 内容。
- 没有 sources 时显示空状态，不报错。

## 简历描述参考

实现后可以描述为：

```text
实现 RAG Sources Panel，展示检索命中文档、引用片段、行号和相似度分数，并与 AgentLoop Trace 面板并列呈现，提升 AI 回答的可追溯性和可调试性。
```
