# 合并“对话”与“研究工作台”实施方案

## 1. 任务目标

移除顶部导航中的“对话”Tab，把普通对话能力合并进“研究工作台”，最终只保留一套会话列表、消息记录、输入框和后端会话模型。

合并后的研究工作台同时支持两种执行方式，但不增加额外的“模式”按钮：

- 未选择 Skill 且未启用任何工具时，执行快速对话。
- 选择任意 Skill 或启用任意工具时，执行研究 Agent。

用户只需要决定是否使用技能和工具，系统根据本轮配置推导执行方式。

空白会话页面采用当前普通“对话”页面的视觉和文案方向，而不是当前研究工作台以烧杯为中心的空白页面。

## 2. 当前代码基础

执行前先检查工作区：

```bash
git status --short
git diff
```

当前工作区包含尚未提交的 Tool Runtime、Tool Policy 和官方 Skill 系统改动。必须保留这些改动，不得回退或用旧版本文件整体覆盖。

当前两套功能相互独立：

### 2.1 普通对话

- 页面状态主要位于 `frontend/src/views/ChatView.vue`。
- 前端接口位于 `frontend/src/api/chat.ts`。
- 后端接口位于 `backend/src/routes/chat.ts`。
- 存储使用 `chat_conversations`、`chat_messages`。
- 每轮直接调用 LLM 流式接口。
- 不使用 Tool、Skill、Research Run、步骤和来源。

### 2.2 研究工作台

- 页面位于 `frontend/src/views/ResearchWorkbench.vue`。
- 输入区位于 `frontend/src/components/research/ResearchComposer.vue`。
- 后端入口位于 `backend/src/routes/research.ts`。
- 应用边界位于 `backend/src/modules/research/application.ts`。
- 执行逻辑位于 `backend/src/research/service.ts`。
- 存储使用 `research_conversations`、`research_messages`、`research_runs`、`research_steps`、`research_sources` 和 `research_notes`。
- 已支持 ToolPolicy、官方 Skill、后台 Run、SSE 恢复、取消、来源和过程记录。

这次合并应以研究工作台的数据与运行基础为主，不要再建立第三套会话模型。

## 3. 产品规则

### 3.1 执行方式推导

前端不显示“快速对话 / 深度研究”模式选择器。后端根据本轮最终配置推导：

```ts
type ResearchExecutionMode = 'quick' | 'research';

function resolveExecutionMode(
  skill: ResearchSkillSnapshot | undefined,
  toolPolicy: ToolPolicy
): ResearchExecutionMode {
  return !skill && toolPolicy.mode === 'none' ? 'quick' : 'research';
}
```

对应关系：

| Skill | ToolPolicy | 执行方式 |
| --- | --- | --- |
| 无 | `none` | 快速对话 |
| 无 | `selected` 或 `all` | 研究 Agent |
| 有 | 任意合法权限 | 研究 Agent |

Skill 的必需工具规则保持不变：选择 Skill 时，前端显式启用必需工具，后端再次验证权限。Skill 不得绕过或扩大 ToolPolicy。

### 3.2 默认状态

新打开研究工作台或创建新会话时：

- 默认不选择任何 Skill，前端状态必须是 `selectedSkillId = undefined`。
- 默认不选择任何工具；工具列表加载完成后，所有开关必须初始化为 `false`，最终策略是 `{ mode: 'none' }`。
- 第一轮默认走快速对话。
- 不在不同会话间隐式恢复上一个会话的 Skill 或工具选择。

“无 Skill”是未选择状态，不是一个名为“通用研究”的内置 Skill。技能列表加载完成后不得自动选择第一个技能，工具列表加载完成后也不得自动全选。

如果未来需要记住偏好，应作为单独需求实现，不纳入本次任务。

### 3.3 每轮独立配置

Skill、工具权限和执行方式都属于本轮 Research Run，不绑定整个 Conversation。同一个会话可以：

1. 先进行普通快速对话。
2. 用户打开工具或选择 Skill。
3. 后续某轮升级为研究 Agent。
4. 用户关闭所有工具并取消 Skill。
5. 下一轮恢复快速对话。

不要因为一次使用过研究能力，就永久改变整个会话的类型。

## 4. 空白会话设计

删除当前研究工作台空白页中的烧杯图标和“围绕知识库开始研究”表达，复用当前普通对话 `ChatMessages.vue` 的空白页构图：

- 使用 `PhSparkle` 图标。
- 标题使用“从一个问题开始”。
- 说明文字保持通用，不把工作台限定为知识库研究。
- 保留两张轻量示例卡片的两列布局，移动端变为一列。
- 保持当前 `max-w-xl`、居中布局、间距、边框和卡片视觉。

推荐文案：

```text
从一个问题开始

询问知识库内容、分析文档，或让 EvidentLoop 帮你整理一个复杂任务。

总结知识库中的关键结论
分析一段代码或技术方案
```

除空白页外，必须保留当前普通对话右侧的 `ChatHistoryRail` 历史定位条，并接入合并后的研究消息列表。它属于消息视口内的快速定位控件，不是研究检查面板的替代品。

历史定位条保持当前核心行为：

- 按“用户消息 + 紧随其后的助手消息”组成一个对话轮次。
- 对话超过一轮后显示；只有一轮或空白会话时隐藏。
- 根据消息视口中心位置高亮当前轮次。
- 悬停或键盘聚焦时，在横条左侧显示该轮用户问题与助手回复摘要。
- 点击横条后平滑滚动到对应消息。
- 快速对话轮和研究 Agent 轮使用同一条历史导航，不按执行方式拆分。
- 继续在小屏幕隐藏，保持当前 `md` 断点行为，避免占用移动端内容宽度。

建议把组件从 Chat 产品命名中解耦，例如移动或重命名为：

```text
frontend/src/components/conversation/ConversationHistoryRail.vue
```

组件只依赖消息共有字段 `id`、`role`、`content` 和 `status`，不要继续依赖即将删除的 `ChatMessage` 产品类型。可以定义轻量的共享消息接口，或让组件 props 使用结构类型。

相关文件：

- `frontend/src/components/chat/ChatMessages.vue`
- `frontend/src/components/research/ResearchMessages.vue`

## 5. 输入区与状态行为

### 5.1 输入区

继续使用 `ResearchComposer.vue` 作为唯一输入区：

```text
[技能 ▾] [工具 0/N ▾]                            [发送]
```

调整规则：

- 默认按钮显示“技能”，菜单中没有任何官方 Skill 处于选中状态。
- 选中 Skill 后，按钮显示该 Skill 名称。
- 菜单提供“清除技能”操作用于恢复未选择状态；未选择时不要把“通用研究”显示为一个带勾的伪 Skill。
- 工具初始计数为 `0/N`。
- 未选择 Skill、工具为零时，不额外显示“快速对话”标签。
- 选择 Skill 后，自动打开其必需工具，状态变化必须在工具计数中可见。
- 取消 Skill 时，不要自动关闭用户此前主动打开的工具。
- 关闭最后一个工具且没有 Skill 时，下一轮自然走快速对话。
- 运行期间继续禁用 Skill 选择和工具切换。

当前“已关闭全部工具，本轮仅凭模型自身知识回答”的红色警告应删除或改为普通弱提示。合并后全部工具关闭是默认快速对话状态，不是错误。

### 5.2 右侧检查面板

- 快速对话不产生工具步骤和来源。
- 新会话默认折叠右侧检查面板。
- 当研究轮产生步骤、来源或文档产物时，可以自动展开一次，或者保持用户当前折叠偏好；实现中选择一种稳定行为并测试。
- 笔记仍属于 Conversation，可在快速对话会话中继续使用。
- 不要因为当前轮是快速对话而删除历史研究轮的步骤和来源。

历史定位条与研究检查面板必须同时保留：

- 历史定位条定位在中间消息视口内部的右侧边缘。
- 研究检查面板继续作为工作台网格中的独立右侧列。
- 检查面板展开、折叠或调整宽度时，历史定位条仍相对消息视口定位，不得被面板遮挡。
- 定位条悬停预览向左展开，不覆盖右侧检查面板。
- 定位条的层级不得挡住输入框、来源弹层或检查面板的交互。

## 6. 后端执行设计

### 6.1 Run Input

在 `ResearchRunInput` 中增加内部字段：

```ts
type ResearchRunInput = {
  content: string;
  contextMessages: ChatMessage[];
  promptPreview: ResearchPromptPreview;
  toolPolicy: ToolPolicy;
  skill?: ResearchSkillSnapshot;
  executionMode?: 'quick' | 'research';
};
```

规则：

- API 不接受客户端直接提交 `executionMode`。
- Research Application 在完成 Skill 解析与 ToolPolicy 规范化后推导执行方式。
- 新 Run 必须把推导结果写入 `input_json`。
- 旧 Run 没有 `executionMode` 时按 `research` 解释，保持历史运行和恢复语义不变。
- 不要在恢复旧 Run 时根据今天的新规则重新推导执行方式。

显式保存推导结果可以防止未来规则调整导致历史 Run 改变行为。

### 6.2 快速对话执行器

快速对话仍通过 Research Application 创建 `research_messages` 和 `research_runs`，并复用现有后台 Run 与 SSE 事件基础，但不调用 `runAgentLoop`。

建议在研究服务内部增加明确的执行分支：

```ts
if (runInput.executionMode === 'quick') {
  await runQuickConversation(...);
} else {
  await runResearchAgent(...);
}
```

`runQuickConversation` 应做到：

- 使用普通、简洁的对话系统 Prompt。
- 使用当前研究会话的有效历史消息作为上下文。
- 只执行一次 LLM 流式生成。
- 不向模型提供工具定义。
- 不注入任何 Skill instructions。
- 持续发送现有 `assistant_delta` 事件。
- 完成时写入 assistant message，并发送 `research_message_completed`、`run_updated` 和 `done`。
- 失败和取消沿用 Research Run 的状态与错误事件。
- 客户端断开后，后台 Run 的生命周期遵循现有研究任务规则。

快速对话不应创建虚假的工具步骤或来源。是否记录单个 LLM step 由现有审计需求决定；若记录，前端默认不要把它展示成“研究过程”。

### 6.3 快速对话 Prompt

不要复用当前 evidence-first 研究 Agent Prompt。增加独立的简洁 Prompt，例如：

```text
You are EvidentLoop, a clear and helpful AI assistant.
Answer the user's request directly and accurately.
Do not claim to have searched tools, documents, or the web when no tools were provided.
If current external information is required, explain that the user can enable an appropriate tool.
```

Prompt 应保持短小。普通对话不需要工具协议、来源格式、Agent 循环停止条件或 Skill 说明。

### 6.4 研究执行器

研究模式继续沿用现有实现：

- `AGENT_SYSTEM_PROMPT`
- `composeResearchSystemPrompt`
- `runAgentLoop`
- ToolRuntime 与 ToolPolicy
- Skill snapshot 和 digest 校验
- steps、sources、artifacts、notes
- SSE 重放、恢复和取消

不要为了合并普通对话而削弱现有研究模式。

## 7. 前端结构调整

### 7.1 顶部导航

修改：

- 从 `AppTopNavigation.vue` 删除 `chat` Tab。
- 从 `AppTabKey`、`ConfigurableTabKey`、默认可见性和本地存储解析中删除 `chat`。
- 从设置页删除“对话”开关。
- 更新设置页底部固定顺序文案。
- 研究工作台应成为默认首页。

旧浏览器 localStorage 中保留的 `chat` 字段应被安全忽略，不能导致解析失败。

### 7.2 应用壳层

当前 `ChatView.vue` 同时承担应用 Tab 壳层和普通聊天业务状态，职责已经混合。执行时应拆分：

- 将应用导航、KeepAlive 和 Tab 可见性提升到中性的工作区壳组件，例如 `WorkspaceView.vue`。
- 删除壳层中的普通聊天会话、消息和流式请求状态。
- 根路由改为中性壳组件，默认激活 `research`。
- 保留研究、Agent 运行时、质量评测、知识库和设置页面。

不要让删除 Chat 功能后，根路由仍长期指向名为 `ChatView` 的组件。

### 7.3 研究工作台

修改 `ResearchWorkbench.vue`：

- `loadTools()` 成功后使用 `Object.fromEntries(tools.map((tool) => [tool.name, false]))`，不得沿用当前全部初始化为 `true` 的行为。
- `selectedSkillId` 默认并保持为 `undefined`，不得在 `loadSkills()` 后自动选择任何技能。
- 新会话和切换会话时确保发送配置无隐式污染。
- 继续按每轮请求提交 `toolPolicy` 与可选 `skillId`。
- 不从前端提交 execution mode。
- 快速轮和研究轮使用同一消息渲染器。

## 8. 历史数据迁移

不能只删除 Chat Tab，否则旧对话数据会变成不可访问数据。

实现一次性、幂等、事务化迁移：

- 把 `chat_conversations` 复制到 `research_conversations`。
- 把对应 `chat_messages` 复制到 `research_messages`。
- 保留标题、角色、内容、状态、创建时间和更新时间。
- 迁入的旧对话没有 Research Run、step、source 和 note，这是合法状态。
- 迁移重复执行不得产生重复会话或消息。
- ID 冲突时使用稳定、可重复计算的旧 Chat ID 映射，不得随机生成导致重复导入。
- 迁移必须在一个事务内完成。

建议在数据库迁移层记录明确的 migration key。不要仅通过“目标表里是否有数据”判断迁移是否完成。

第一版完成后：

- 停止挂载 `/api/chat` Router。
- 删除前端 Chat API 调用和独立 Chat 页面。
- 暂时保留旧 Chat 数据表一个兼容周期，避免不可恢复删除。
- 后续独立迁移再删除旧表，不在本任务中直接 DROP TABLE。

如果产品明确确认当前环境没有任何需要保留的 Chat 数据，也仍应写迁移测试，保证正式环境升级路径可靠。

## 9. 建议文件改动

### 9.1 前端

- `frontend/src/router/index.ts`
- `frontend/src/views/ChatView.vue`，建议重构或替换为 `WorkspaceView.vue`
- `frontend/src/views/ResearchWorkbench.vue`
- `frontend/src/views/SettingsView.vue`
- `frontend/src/components/navigation/AppTopNavigation.vue`
- `frontend/src/components/research/ResearchMessages.vue`
- `frontend/src/components/research/ResearchComposer.vue`
- `frontend/src/components/research/ResearchMainPanel.vue`
- `frontend/src/components/chat/ChatHistoryRail.vue`，保留行为并迁移为中性组件
- `frontend/src/types/navigation.ts`
- `frontend/src/api/research.ts`
- `frontend/src/types/research.ts`

完成迁移后可删除：

- `frontend/src/api/chat.ts`
- `frontend/src/types/chat.ts`
- 不再被复用的 `frontend/src/components/chat/*`

删除前先用 `rg` 确认引用。空白页视觉如果仍直接复用 Chat 组件，则先把它提取到中性公共组件，不要复制两份长期维护。`ChatHistoryRail` 不得随 Chat 模块一起删除；应先迁移到中性目录并改用研究消息或共享消息结构。

### 9.2 后端

- `backend/src/modules/research/application.ts`
- `backend/src/research/service.ts`
- `backend/src/research/types.ts`
- `backend/src/research/store.ts`
- `backend/src/routes/research.ts`
- `backend/src/app.ts`
- `backend/src/db.ts` 或现有数据库迁移模块

完成迁移后可删除：

- `backend/src/routes/chat.ts`
- `backend/src/chat/store.ts`
- `backend/src/chat/types.ts`

不要删除仍被 LLM 合约或 Agent 类型使用的通用 `ChatMessage` 类型；它们与 Chat 产品模块不是同一概念。

## 10. API 约束

研究消息接口保持现有形态：

```json
POST /api/research/conversations/:conversationId/messages
{
  "content": "用户问题",
  "toolPolicy": { "mode": "none" },
  "skillId": null
}
```

后端返回和 SSE 协议尽量保持兼容。可以在 Run 数据中公开只读的 `executionMode`，但前端不能用它控制后端执行。

以下输入必须得到稳定结果：

- `skillId` 缺失且 `toolPolicy=none`：快速对话。
- `skillId` 缺失且 `toolPolicy=selected/all`：研究模式。
- `skillId` 有值：研究模式，并验证必需工具。
- 未知 Skill：400。
- Skill 必需工具未授权：409。
- 旧请求传 `allowedTools`：继续经过现有兼容规范化；最终执行方式根据规范化后的 ToolPolicy 推导。

## 11. 测试要求

### 11.1 后端单元测试

- 无 Skill + `none` 推导为 `quick`。
- 无 Skill + 任意已选工具推导为 `research`。
- 有 Skill 推导为 `research`。
- 新 Run 持久化 `executionMode`。
- 旧 Run 缺少字段时按 `research` 恢复。
- 快速执行不调用 Agent Loop。
- 快速执行不传 tools，不注入 Skill Prompt。
- 快速执行能够正确流式完成、失败和取消。
- 研究执行仍调用 Agent Loop。
- Skill 权限和 digest 校验保持有效。

### 11.2 数据迁移测试

- 旧 Chat 会话及其消息完整迁入研究表。
- 标题、消息顺序、状态和时间不变。
- 重复运行迁移不会重复数据。
- ID 冲突映射稳定。
- 迁入会话没有 Run 时仍能被研究详情 API 正常读取。
- 迁移异常时事务回滚，不留下半套数据。

### 11.3 路由测试

- 根页面默认进入研究工作台。
- 导航不再显示“对话”。
- 设置页不再显示“对话”开关。
- 旧 localStorage 中含 `chat` 字段时页面仍正常加载。
- `/api/chat` 在完成迁移后不再挂载。

### 11.4 前端组件测试

- 新会话工具默认全部关闭。
- 新会话默认不选择 Skill。
- 工具和 Skill 列表加载完成后仍然保持全部未选择。
- Skill 菜单未选择时没有任何官方 Skill 带选中标记。
- 默认发送的请求包含 `toolPolicy: { mode: 'none' }` 且不包含 `skillId`。
- 全部工具关闭不是错误状态。
- 选择 Skill 自动启用必需工具。
- 取消 Skill 不关闭用户主动启用的工具。
- 空白页使用 Sparkle 图标、“从一个问题开始”和两张示例卡片。
- 两轮以上对话显示右侧历史定位条。
- 滚动消息时历史定位条正确高亮当前轮次。
- 悬停或聚焦定位条时显示问题与回答摘要。
- 点击定位条可以跳转到快速对话轮和研究轮。
- 展开、折叠及缩放研究检查面板时，历史定位条不被遮挡且仍可交互。
- 移动端不显示历史定位条。
- 快速轮不显示虚假的来源或工具步骤。
- 历史研究轮的来源和步骤不会在后续快速轮中丢失。

## 12. 实施顺序

建议按以下顺序完成，避免先删入口导致功能或数据暂时丢失：

1. 增加并测试执行方式推导函数。
2. 在 Research Run Input 中持久化 `executionMode`。
3. 实现快速对话执行分支，复用 Research Run 和 SSE。
4. 把研究工作台默认 ToolPolicy 改为 `none`。
5. 调整 Skill、工具提示和空白会话 UI，并把历史定位条迁移进研究消息视口。
6. 实现并测试旧 Chat 数据幂等迁移。
7. 把应用壳层从 Chat 业务中拆出。
8. 删除顶部“对话”Tab 和设置开关，默认进入研究工作台。
9. 停止挂载 Chat Router，删除不再使用的 Chat 前后端代码。
10. 运行全量验证并检查是否存在遗留引用。

## 13. 验收标准

只有同时满足以下条件才算完成：

- 顶部导航不再出现“对话”。
- 根页面默认显示研究工作台。
- 新会话默认没有任何 Skill 或工具处于选中状态。
- 默认发送只进行一次直接 LLM 对话，不进入 Agent Loop。
- 开启任意工具或选择 Skill 后进入现有研究 Agent。
- 同一会话可以混合快速轮和研究轮。
- 空白会话采用原普通对话页面的 Sparkle 视觉、标题和示例卡片布局。
- 普通对话原有的右侧历史定位条得到保留，支持高亮、摘要预览和点击跳转。
- 历史定位条同时覆盖快速对话轮与研究轮，并能与右侧研究检查面板正常共存。
- 旧 Chat 历史可以从研究工作台继续访问。
- ToolRuntime、ToolPolicy、Skill snapshot、后台恢复和 SSE 能力没有回退。
- 旧 Research Run 可以继续读取和恢复。
- 不存在两套仍可写入的 Chat/Research 会话接口。
- 不直接删除旧 Chat 数据表。
- 类型检查、测试、运行时校验、构建和 diff 检查全部通过。

## 14. 验证命令

```bash
pnpm typecheck
pnpm test
pnpm --filter backend runtime:verify
pnpm build
git diff --check
```

如果测试命令因本地沙箱或 IPC 权限失败，应在获得必要权限后重新运行；不能把环境权限失败误报成代码失败，也不能跳过其他可运行验证。

## 15. 明确不做

- 不增加显式“快速 / 研究”模式按钮。
- 不把快速对话实现成 Skill。
- 不让 LLM 自动选择 Skill。
- 不让 Skill 静默扩大工具权限。
- 不把对话迁入 Durable Task。
- 不重构 Agent 运行时、质量评测或知识库。
- 不在本次任务中删除旧 Chat 数据表。
- 不修改与合并目标无关的视觉系统和组件库。
