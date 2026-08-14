# 研究工作台官方技能系统 V1 实施方案

## 1. 执行目标

在 EvidentLoop 研究工作台中加入第一版官方技能系统。技能由 TypeScript 代码声明并随应用发布，不支持用户安装或编辑。

用户在研究输入框底部、现有“工具”按钮旁边看到“技能”按钮。每次发送消息时，可以选择一个官方技能或使用“通用研究”。选中的技能影响本次 Research Run 的系统指令，并与本轮工具权限一起持久化。

本任务必须交付一个真实可用的端到端闭环，而不是只增加空 UI。

## 2. 当前基础与约束

当前分支已经包含以下基础改造，执行者必须保留并复用，不得回退：

- 统一的 `ToolRuntime`，负责模型工具定义与实际工具执行。
- 显式 `ToolPolicy`：`all`、`selected`、`none`。
- Research Run 已把 `toolPolicy` 保存在 `ResearchRunInput` 中。
- `app.ts` 是 Tool Runtime、Application 和 Router 的生产组合根。

开始实现前先执行 `git status --short` 和 `git diff`，确认并保留用户已有改动。不要覆盖或重写与本任务无关的变更。

相关现有文件：

- `backend/src/tools/contracts.ts`
- `backend/src/tools/runtime.ts`
- `backend/src/tools/policy.ts`
- `backend/src/research/service.ts`
- `backend/src/research/types.ts`
- `backend/src/modules/research/application.ts`
- `backend/src/routes/research.ts`
- `frontend/src/views/ResearchWorkbench.vue`
- `frontend/src/components/research/ResearchComposer.vue`
- `frontend/src/api/research.ts`
- `frontend/src/types/research.ts`

## 3. V1 范围

### 3.1 必须实现

- 官方技能写在 TypeScript 代码中。
- 每个 Research Run 最多选择一个技能。
- 用户手动选择技能，不做自动识别。
- 提供“通用研究”选项，表示不启用技能。
- 提供第一个官方技能：“技术方案对比”。
- 技能只增加受信任的系统指令，不替换基础系统 Prompt。
- 技能声明推荐工具和必需工具权限。
- 技能选择随 Research Run 持久化。
- 后台执行、断线重连和历史 Run 不因技能系统回退。
- 前端“技能”按钮与“工具”按钮并排。
- 后端提供技能列表 API。
- 对技能注册、解析、权限、Prompt 组合和持久化增加测试。

### 3.2 明确不做

- 不解析 `SKILL.md`。
- 不扫描文件系统。
- 不支持上传、安装、删除或编辑技能。
- 不支持用户级、租户级技能。
- 不支持脚本、资源文件、模板或动态依赖。
- 不支持技能注册任意执行回调。
- 不支持多技能组合。
- 不支持 LLM 自动选择技能。
- 不接入 Durable Task。
- 不新增通用插件系统。

## 4. 核心设计原则

### 4.1 技能是声明式研究方法，不是工具

- Tool 执行原子能力，例如知识库检索或联网检索。
- Skill 提供研究流程、输出结构和质量要求。
- Skill 不直接执行代码，不绕过 `ToolRuntime`。

### 4.2 基础系统约束不可被技能覆盖

基础 `AGENT_SYSTEM_PROMPT` 中的证据规则、引用规则、工具调用协议和失败处理始终保留。技能内容只能作为独立、受信任的附加区块追加。

### 4.3 只把选中的技能放进模型上下文

技能列表 API 只返回 metadata。未启用技能时，不把任何技能 instructions 放进 Prompt。启用技能时，只注入该技能的 instructions。

### 4.4 技能不能扩大用户工具权限

用户的 `ToolPolicy` 仍是最终权限边界。技能可以要求某些工具必须已获授权，但不能静默打开用户关闭的工具。

前端在用户选择技能时可以显式自动启用该技能的必需工具；这次 UI 状态变化必须对用户可见。后端仍需再次验证，不能信任前端。

## 5. 后端数据结构

### 5.1 技能定义

在 `backend/src/skills/contracts.ts` 中新增：

```ts
export type OfficialResearchSkill = {
  id: string;
  version: string;
  label: string;
  description: string;
  instructions: string;
  tools: {
    recommended: string[];
    required: string[];
  };
};

export type ResearchSkillSnapshot = {
  id: string;
  version: string;
  digest: string;
};

export type ResearchSkillInfo = {
  id: string;
  version: string;
  label: string;
  description: string;
  recommendedTools: string[];
  requiredTools: string[];
};
```

约束：

- `id` 使用小写字母、数字和连字符。
- `version` 使用明确的不可变版本字符串，例如 `1.0.0`。
- `instructions` 必须简洁，建议限制在 4,000 字符以内。
- `required` 必须是 `recommended` 的子集，或者将字段改名为 `available` 后明确其集合关系；实现中必须选择一种无歧义语义并测试。
- 所有工具名必须存在于当前 `ToolRuntime` 的模型可见工具中。

### 5.2 Run Input

修改 `backend/src/research/types.ts`：

```ts
export type ResearchRunInput = {
  content: string;
  contextMessages: ChatMessage[];
  promptPreview: ResearchPromptPreview;
  toolPolicy: ToolPolicy;
  skill?: ResearchSkillSnapshot;
};
```

技能选择按 Run 持久化，不按 Conversation 持久化。当前 Run Input 已经保存为 JSON，因此不需要新增技能数据库表，也不应为 V1 创建 `skills` 表。

旧 Run Input 没有 `skill` 时必须解释为“通用研究”。

## 6. 技能目录和 Runtime

新增：

```text
backend/src/skills/
├── contracts.ts
├── registry.ts
├── runtime.ts
└── catalog/
    ├── index.ts
    └── technologyComparison.ts
```

### 6.1 Registry

`registry.ts` 负责：

- 注册所有官方技能版本。
- 检查重复的 `id + version`。
- 为每个定义计算稳定 SHA-256 digest。
- 按 ID 返回当前版本。
- 按 `id + version` 返回准确历史版本。

已发布版本不可原地修改。更新技能时新增版本，并保留旧版本定义，使运行中的旧 Research Run 可以恢复。

建议内部 key：

```text
technology-comparison@1.0.0
```

### 6.2 Skill Runtime

`runtime.ts` 至少提供：

```ts
type ResearchSkillRuntime = {
  list: () => ResearchSkillInfo[];
  resolveLatest: (id: string) => ResolvedResearchSkill;
  resolveSnapshot: (snapshot: ResearchSkillSnapshot) => ResolvedResearchSkill;
  createSnapshot: (id: string) => ResearchSkillSnapshot;
};
```

`resolveSnapshot` 必须验证 digest。一旦版本缺失或 digest 不一致，应明确失败，不能静默使用最新版本。

Skill Runtime 在 `app.ts` 中创建并注入 `ResearchApplication` / Research Service，测试可以注入自定义 Registry。业务逻辑不要直接导入全局 Registry。

## 7. 第一个官方技能

文件：`backend/src/skills/catalog/technologyComparison.ts`

建议定义：

```ts
export const technologyComparisonV1: OfficialResearchSkill = {
  id: 'technology-comparison',
  version: '1.0.0',
  label: '技术方案对比',
  description: '从统一维度比较多个技术方案，并给出有证据边界的选型建议。',
  tools: {
    recommended: [
      'search_knowledge',
      'read_document',
      'retrieve_web_evidence'
    ],
    required: ['search_knowledge']
  },
  instructions: `
先识别比较对象、使用场景、硬约束和评价维度。
使用相同维度比较所有候选方案，避免为不同候选使用不同标准。
优先收集一手资料和可追溯证据。
明确区分事实、推断、建议和证据缺口。
没有直接证据支持的优缺点不得写成确定事实。
最终回答包含：结论摘要、比较维度、候选分析、关键取舍、风险、适用条件和证据限制。
`.trim()
};
```

不要把基础系统 Prompt 中已经存在的工具协议、引用协议和失败处理复制进技能 instructions。

## 8. Prompt 组合

在 Research Service 附近新增独立且可测试的函数：

```ts
export function composeResearchSystemPrompt(
  basePrompt: string,
  skill?: OfficialResearchSkill
) {
  if (!skill) return basePrompt;

  return `${basePrompt}\n\n<official_research_skill id="${skill.id}" version="${skill.version}">\n${skill.instructions}\n</official_research_skill>`;
}
```

后台执行 Run 时：

1. 从持久化的 `ResearchRunInput.skill` 读取 snapshot。
2. 使用 Skill Runtime 解析准确版本并验证 digest。
3. 组合基础 Prompt 与技能 instructions。
4. 把组合后的 Prompt 传给 `runAgentLoop()`。
5. 没有 skill 时保持当前 Prompt 完全不变。

禁止把技能 instructions 拼进 user message 或 conversation history。

## 9. 工具权限行为

### 9.1 创建 Run 时

服务端必须：

1. 规范化用户 `ToolPolicy`。
2. 获取该 Policy 实际允许的已注册工具名。
3. 校验技能 `required` 中的每个工具都已获用户授权。
4. 若缺少权限，返回明确的 400 或 409 错误，例如：

```text
技能“技术方案对比”需要启用工具：知识库检索
```

### 9.2 不做隐式扩权

后端不得因为启用了 skill 而把工具追加到用户 Tool Policy。

前端选择技能时，可以自动打开 required 工具并同步更新可见的工具计数。recommended 工具可以高亮或提示，但不要求自动全部打开。

### 9.3 `all / selected / none`

- `all`：所有模型可见工具均视为已授权。
- `selected`：只有 `names` 中的已注册工具视为已授权。
- `none`：任何有 required 工具的技能都不能运行。

为以上三种情况分别增加单元测试。

## 10. 后端 API

### 10.1 获取官方技能

新增：

```http
GET /api/research/skills
```

响应示例：

```json
{
  "code": 1,
  "data": {
    "skills": [
      {
        "id": "technology-comparison",
        "version": "1.0.0",
        "label": "技术方案对比",
        "description": "从统一维度比较多个技术方案，并给出有证据边界的选型建议。",
        "recommendedTools": [
          "search_knowledge",
          "read_document",
          "retrieve_web_evidence"
        ],
        "requiredTools": ["search_knowledge"]
      }
    ]
  }
}
```

不得向前端返回 `instructions`。

### 10.2 发送研究消息

扩展现有接口：

```http
POST /api/research/conversations/:conversationId/messages
```

请求：

```json
{
  "content": "比较 LangGraph 和 Mastra",
  "skillId": "technology-comparison",
  "toolPolicy": {
    "mode": "selected",
    "names": ["search_knowledge", "retrieve_web_evidence"]
  }
}
```

`skillId` 可省略。省略表示“通用研究”。未知 skill ID 返回 400，不允许静默回退。

Router 只做协议解析；技能解析、工具权限验证和 snapshot 创建放在 Research Application 用例边界内。

## 11. Research Service 改动

修改 `createAndStartResearchRun()` 的输入，使其接收已经解析的 `ResearchSkillSnapshot | undefined`，并把 snapshot 写入 `runInput`。

修改 `executePersistedResearchRun()`：

- 注入 Skill Runtime。
- 从 Run Input 恢复 skill。
- 组合系统 Prompt。
- 保持 `toolPolicy` 与 `toolRuntime` 原有行为。
- 在第一个 LLM timeline step 的 input 中加入公开 skill metadata 或 snapshot，便于审计，例如：

```json
{
  "model": "...",
  "tools": ["..."],
  "skill": {
    "id": "technology-comparison",
    "version": "1.0.0",
    "digest": "..."
  }
}
```

不要把 instructions 写入事件、SSE payload 或前端响应。

## 12. 前端交互

### 12.1 Composer 布局

修改 `frontend/src/components/research/ResearchComposer.vue`。

输入框底部左侧必须呈现：

```text
[ 技能：通用研究 ▾ ] [ 工具 5/5 ▾ ]                 [发送]
```

启用技能后：

```text
[ 技能：技术方案对比 ▾ ] [ 工具 5/5 ▾ ]             [发送]
```

“技能”按钮必须位于“工具”按钮旁边，不要放入 Inspector、侧边栏或独立设置页面。

建议使用 Phosphor 图标 `PhSparkle` 或语义接近的图标；工具继续使用 `PhWrench`。

### 12.2 Skill 下拉菜单

菜单包含：

- 通用研究
- 技术方案对比

每项显示：

- label
- 一行简短 description
- 当前选中状态

运行期间禁用切换。

### 12.3 Tool 联动

选择技能时：

- 自动启用 required 工具。
- recommended 工具可用轻量文字提示或视觉标记。
- required 工具在该技能启用时不得被关闭，或在关闭时先清除 skill；选择一种一致行为。
- 推荐采用“required 工具不可关闭，并在菜单中标记为技能必需”。

取消技能后恢复普通工具切换，不必恢复选择技能前的工具状态。

### 12.4 前端状态

`ResearchWorkbench.vue` 增加：

```ts
const availableSkills = ref<ResearchSkillInfo[]>([]);
const selectedSkillId = ref<string>();
```

挂载时并行加载 conversations、tools、skills。技能列表加载失败时：

- 不影响研究工作台使用。
- 回退为“通用研究”。
- 工具选择继续工作。

发送时把 `selectedSkillId` 作为 `skillId` 传入 `startResearchMessage()`。

首版 skill 是按 Run 选择。发送完成后可以保留当前选择，便于连续使用；页面刷新后默认回到“通用研究”是可接受的，但进行中的 Run 必须仍按持久化 snapshot 执行。

## 13. 前端类型和 API

在 `frontend/src/api/research.ts` 或 `frontend/src/types/research.ts` 中增加：

```ts
export type ResearchSkillInfo = {
  id: string;
  version: string;
  label: string;
  description: string;
  recommendedTools: string[];
  requiredTools: string[];
};
```

新增：

```ts
listResearchSkills(): Promise<{ skills: ResearchSkillInfo[] }>
```

修改：

```ts
startResearchMessage(
  conversationId: string,
  content: string,
  toolPolicy: ToolPolicy,
  skillId?: string
)
```

## 14. 测试要求

### 14.1 Skill Registry / Runtime 单元测试

- 重复 `id + version` 被拒绝。
- 非法 ID 被拒绝。
- 空 label、description、instructions 被拒绝。
- instructions 超过限制被拒绝。
- 未注册工具名被拒绝。
- required 与 recommended 的集合约束正确。
- digest 对相同定义稳定。
- 定义发生变化后 digest 变化。
- 能按准确版本恢复。
- digest 不匹配时拒绝恢复。

### 14.2 Research Application / Router 测试

- `/api/research/skills` 不暴露 instructions。
- 未传 skillId 时正常运行。
- 未知 skillId 返回 400。
- `none` Policy 无法运行有 required 工具的 skill。
- `selected` 缺少 required 工具时拒绝。
- `all` Policy 可以运行。

### 14.3 Research Service 测试

- Run Input 保存 skill snapshot。
- 无 skill 时系统 Prompt 与当前版本完全一致。
- 有 skill 时只追加选中技能 instructions。
- instructions 不进入 user message、context messages、事件或前端 metadata。
- 后台排队后执行仍解析同一版本。
- 旧 Run Input 没有 skill 时仍可执行。
- 工具执行仍使用注入的同一个 Tool Runtime。

### 14.4 前端验证

- “技能”和“工具”按钮并排。
- 菜单可选择“通用研究”和“技术方案对比”。
- 选择技能后按钮显示技能名称。
- required 工具自动启用且不能被关闭。
- 发送请求包含 skillId。
- 运行期间不能切换技能。
- 技能列表加载失败不阻塞普通研究。

## 15. 验收标准

- [ ] 研究工作台输入框旁出现可用的“技能”按钮。
- [ ] “技能”按钮紧邻“工具”按钮。
- [ ] 可以选择“通用研究”或“技术方案对比”。
- [ ] 选择结果实际影响后端系统 Prompt。
- [ ] 选择结果随 Research Run Input 持久化。
- [ ] 后台任务和断线重连不丢失技能版本。
- [ ] Skill instructions 不通过技能列表 API 泄漏。
- [ ] Skill 不会扩大用户 Tool Policy。
- [ ] 缺少必需工具时前后端均有清晰反馈。
- [ ] 无 skill 的现有研究行为保持兼容。
- [ ] 不修改 Durable Task。
- [ ] 不引入文件系统 skill loader 或插件机制。
- [ ] 类型检查、后端测试、Runtime 验证和生产构建通过。

## 16. 验证命令

至少执行：

```bash
pnpm typecheck
pnpm test
pnpm --filter backend runtime:verify
pnpm build
git diff --check
```

如果测试运行器因沙箱无法创建本地 IPC 管道，应按环境要求申请权限后重新运行，不能把沙箱失败误报为代码失败。

## 17. 交付说明要求

最终回复应包含：

- 实现了哪些行为。
- 新增的官方技能名称。
- API 与持久化变化。
- 工具权限如何处理。
- 测试和构建结果。
- 已知限制。
- 未提交时明确说明尚未提交。

不要把 V1 未实现的自动技能识别、用户安装、多技能组合或脚本执行描述为已完成。
