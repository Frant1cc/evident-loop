# 内置 MCP 一键启用技术方案

## 1. 背景与结论

当前 `frontend/src/mcp/presets.ts` 中的 Context7 和 Memory 只是前端表单预置。用户点击后仍要手动完成“保存 → 测试 → 启用”，而且预置使用 `cmd /c npx`，只能直接适配 Windows。它们不是后端已注册的工具，因此模型不能开箱即用。

本方案把目标体验调整为：

```text
首次使用：用户确认一次 → 系统自动准备、测试、启用 → 工具可用
后续启动：后端自动恢复连接 → Research/Task 可直接使用
```

核心原则：

1. 核心、稳定、由本项目维护的能力优先实现为原生 `ToolModule`。
2. 第三方能力继续使用 MCP，但提供后端托管的“一键启用”流程。
3. 不在首次启动时静默下载或执行第三方程序；首次启用必须有一次明确确认。
4. 不削弱现有 ToolPolicy、Snapshot、ApprovalManager 和 ToolRuntime 门禁。

## 2. 范围

### 2.1 本期范围

- 将 Context7 和 Memory 从“前端表单模板”升级为“后端托管 MCP 预置”。
- 提供跨平台的一键启用、失败恢复、状态展示和重复操作幂等性。
- 启用成功后沿用当前 MCP Manager 的连接恢复、工具发现、LKG、tombstone 和重连机制。
- 保留高级自定义 MCP Server 的现有手动配置流程。
- 为托管预置增加本地审批策略，不直接信任远端 `readOnlyHint`。

### 2.2 非目标

- 不让旧 `/api/agent/chat` 获得 MCP 访问能力。
- 不在本期引入多用户或租户隔离。
- 不自动批准可能产生副作用的工具。
- 不在应用启动时自动安装从未被用户确认过的第三方包。
- 不在本期强制把 Memory 重写为原生工具；先完成一键启用，后续单独评估迁移。

## 3. 产品行为

### 3.1 首次启用

MCP 管理页为每个托管预置显示一个主按钮：

```text
未安装     → “启用”
准备中     → “正在准备…”
需要授权   → “继续授权”
已连接     → “已启用”
失败       → “重试”
已停用     → “重新启用”
```

首次点击“启用”时展示确认信息：

- 将启动的服务名称和发布者；
- 是否需要下载第三方包；
- 包名与固定版本；
- 传输方式；
- 可能发送给该服务的数据类型；
- 工具调用是否需要人工审批。

用户确认后，后端自动执行：

1. 解析当前平台的启动配置；
2. 创建或复用预置对应的停用 Server；
3. 建立测试连接并刷新工具清单；
4. 测试成功后启用长期连接；
5. 返回最终服务器状态和已发现工具。

测试失败时保留停用草稿、错误信息和已经存在的 LKG，不留下“配置已启用但不可用”的假成功状态。

### 3.2 后续启动

用户成功启用一次后，继续使用现有持久化配置。应用启动时 `McpManager.start()` 自动连接，成功后刷新工具目录；连接失败时保留 LKG 并按现有退避策略重连。

后续启动不再次弹出确认，以下情况除外：

- 预置升级改变了包来源、主版本、权限或数据边界；
- 预置从只读变为允许写操作；
- 本地记录的确认版本低于预置要求的确认版本。

### 3.3 模型可见性

“连接已启用”和“模型有权使用”是两层独立状态：

- `toolPolicy: all`：下一模型轮次自动看到新工具；
- `toolPolicy: selected`：只有被选择的稳定模型名可见；
- `toolPolicy: none`：工具不可见；
- 旧 `/api/agent/chat`：继续使用剔除 MCP 的兼容 Runtime。

连接或工具清单变化只影响下一轮 Snapshot，不能修改正在执行的一轮模型上下文。

## 4. 架构设计

### 4.1 预置定义改为后端单一来源

新增后端预置目录，建议结构：

```text
backend/src/mcp/presets/
├── contracts.ts
├── catalog.ts
├── platform.ts
└── index.ts
```

前端不再保存可执行命令，只消费后端返回的安全公开信息。避免前后端各维护一份命令，也避免浏览器决定服务器要执行什么程序。

建议的内部定义：

```ts
type ManagedMcpPreset = {
  id: string;
  version: number;
  consentVersion: number;
  name: string;
  description: string;
  publisher: string;
  package: {
    name: string;
    version: string;
  };
  resolveDraft(platform: NodeJS.Platform): McpServerDraft;
  approvalPolicy: ManagedMcpApprovalPolicy;
};
```

公开 DTO 不返回任意 `command`、环境变量或秘密，只返回展示所需的包名、固定版本、发布者、风险说明、当前状态和关联 Server ID。

### 4.2 跨平台启动

禁止继续使用：

```text
cmd /c npx -y <latest-package>
```

第一阶段可以使用无 shell 的平台解析：

```ts
const command = process.platform === 'win32' ? 'npx.cmd' : 'npx';
const args = ['--yes', `${packageName}@${pinnedVersion}`];
```

要求：

- 不使用 `shell: true`；
- 包版本必须固定，不能隐式使用 `latest`；
- `command` 和 `args` 只能来自后端受控 catalog；
- 用户输入不得拼接进命令行；
- 沿用 stdio 仅允许回环部署的限制；
- 测试应覆盖 Windows、macOS 和 Linux 的解析结果。

更稳妥的后续方案是把经过审核的 MCP Server 作为项目锁定依赖安装，直接解析工作区本地可执行文件，避免每台机器首次运行时由 `npx` 动态解析版本。该优化不阻塞第一阶段。

### 4.3 预置持久化身份

给 MCP Server 增加可选元数据：

```ts
type McpManagedMetadata = {
  presetId: string;
  presetVersion: number;
  consentVersion: number;
  consentedAt: string;
};
```

元数据随服务器配置持久化，但不属于远端连接凭证。`presetId` 必须唯一，保证重复点击“一键启用”不会创建多个 Context7 或 Memory 实例。

更新规则：

- 仅名称变化：保留测试状态和连接；
- 包版本或启动配置变化：停用、断开、清除验证时间，要求重新测试；
- `consentVersion` 增加：先要求用户重新确认，再允许升级；
- 用户将托管预置改为自定义配置：解除 `presetId` 关联，后续按普通 Server 管理。

### 4.4 Manager 用例

在中立 MCP Manager 契约上增加预置用例，路由不直接编排多个底层操作：

```ts
listPresets(): McpPresetPublic[];
enablePreset(id: string, consentVersion: number): Promise<McpPublicServer>;
disablePreset(id: string): Promise<McpPublicServer>;
```

`enablePreset()` 内部流程：

```text
校验预置与确认版本
  → 解析平台配置
  → 查找/创建唯一 Server 草稿
  → testServer
  → 验证发现结果
  → setEnabled(true)
  → 等待连接进入 connected 或明确失败
```

该用例必须是幂等的：

- 已连接时直接返回当前状态；
- 正在启用时复用同一个单飞 Promise；
- 已存在停用草稿时复用原 ID；
- 测试失败时保持 `enabled: false`；
- 请求取消时停止等待，但不破坏已经成功持久化的状态。

### 4.5 API

建议新增：

| 操作 | 路由 |
| --- | --- |
| 列出托管预置及状态 | `GET /api/mcp/presets` |
| 一键启用 | `POST /api/mcp/presets/:presetId/enable` |
| 停用 | `POST /api/mcp/presets/:presetId/disable` |

启用请求：

```json
{
  "consentVersion": 1
}
```

响应继续使用现有安全公开的 `McpPublicServer`，并附带预置状态。错误不得包含环境变量、headers、OAuth Token、完整命令输出或敏感 URL 参数。

第一阶段允许请求等待测试完成。若实际环境中第三方包准备经常超过反向代理超时，再将该接口升级为 `202 + operationId`；不要在没有需求前引入新的任务系统。

### 4.6 审批策略

当前实现将远端 `annotations.readOnlyHint === true` 直接视为免审批。对于托管预置，不应把远端自报的 hint 当作最终授权依据。

增加本地策略：

```ts
type ManagedMcpApprovalPolicy = {
  default: 'require_approval' | 'allow_readonly';
  tools?: Record<string, 'require_approval' | 'allow'>;
};
```

决策顺序：

1. 本地工具级策略明确要求审批：必须审批；
2. 本地工具级策略明确允许：按允许执行；
3. 预置允许只读且远端声明只读：免审批；
4. 其他情况：默认审批。

普通自定义 MCP Server 仍可暂时沿用现状，但 UI 应明确提示 `readOnlyHint` 来自远端。后续可为所有 Server 增加本地覆盖策略。

### 4.7 核心能力原生化

如果 Memory 被确定为产品核心能力，后续应迁移为原生 `ToolModule`：

```text
tools/catalog/memory.ts
  → Zod 输入 Schema
  → 项目自己的 Memory Store/Repository
  → defineTool()
  → ToolRuntime
```

收益：

- 无子进程和 `npx` 依赖；
- 使用内置 Zod 单一 Schema；
- 生命周期、数据目录和备份由项目控制；
- 可以实现真正的默认可用；
- 不需要把核心数据交给第三方 MCP Server。

Context7 属于外部文档能力，继续采用托管 MCP 更合适。

## 5. 前端改造

### 5.1 组件职责

`McpManagementView.vue` 从后端加载预置，不再 import 含命令的本地 catalog。预置卡片负责：

- 展示公开元数据；
- 发起首次确认；
- 调用一键启用/停用 API；
- 展示准备、测试、授权、连接和失败状态；
- 成功后跳转或展开关联 Server 的工具列表。

`McpSettingsPanel.vue` 继续负责高级自定义连接和已存在 Server 的管理，不再承担预置表单填充。

### 5.2 状态反馈

一键启用期间至少展示：

```text
正在准备运行环境
正在测试连接
正在读取工具清单
正在启用连接
已连接，可在下一轮对话中使用
```

失败信息要给出可执行建议，例如：

- 未安装 Node/npm；
- 包下载失败；
- 当前网络不可达；
- MCP Server 未在超时内启动；
- stdio 在非回环部署中被禁止；
- OAuth 仍需完成授权。

不要把 stdout/stderr 原文直接展示给普通 UI；后端先生成脱敏摘要。

## 6. 安全边界

一键启用不得扩大当前项目的部署安全边界：

- 继续通过 `/api` 的 Host/Origin 中间件；
- 继续要求本机或受信网络运行，不能视为多用户生产认证；
- stdio 仍只允许后端绑定 loopback；
- 第三方包固定版本并随代码审查升级；
- 不使用 shell 字符串拼接；
- secrets 只允许进入加密的 env/header/OAuth 字段；
- 禁止把 token 放入 args 或 URL；
- 预置描述、工具描述和工具返回值都视为不可信外部输入；
- MCP 结果继续受模型上下文长度限制，后续应改进为有界序列化，避免先完整 `JSON.stringify` 超大 `structuredContent`。

首次确认只代表允许启动该服务，不代表批准每一次有副作用的工具调用。

## 7. 失败与恢复

| 场景 | 预期行为 |
| --- | --- |
| 包准备失败 | 保持停用，记录脱敏错误，可重试 |
| 测试连接失败 | 保持停用，保留已有 LKG |
| OAuth 未完成 | 状态为 `authorization_required`，展示继续授权 |
| 启用后断线 | 保留工具目录但标记 unavailable，自动重连 |
| 工具 Schema 变化 | 下一轮获取新 Snapshot；旧 Snapshot 拒绝执行 |
| 工具被远端删除 | 保存 tombstone，不允许执行 |
| 预置升级失败 | 保留上一个可用配置和 Schema，不自动覆盖为坏版本 |
| 应用重启 | 恢复已确认、已启用的连接，不重复安装确认 |

异步启动、启用和重连调用必须显式处理 Promise rejection。特别是 OAuth 进入 `authorization_required` 时，应更新状态而不能形成未处理 rejection 或导致进程退出。

## 8. 实施步骤

### Phase 1：后端托管预置

1. 新增后端 preset catalog、公开 DTO 和平台解析。
2. 为 Server 增加托管预置元数据和唯一性约束。
3. 实现 `listPresets`、幂等 `enablePreset`、`disablePreset`。
4. 新增 preset API。
5. 修复所有 fire-and-forget 连接调用的 rejection 收口。

### Phase 2：一键启用 UI

1. 前端改为从 API 获取预置。
2. 增加首次确认弹窗和启用进度。
3. 移除前端可执行命令预置。
4. 保留高级自定义 MCP 编辑器。
5. 启用成功后明确提示“下一模型轮次生效”。

### Phase 3：策略与加固

1. 加入托管预置本地审批策略。
2. 固定和审计第三方包版本。
3. 对 MCP 输出实施有界归一化和序列化。
4. 增加升级重新确认机制。

### Phase 4：Memory 原生化评估

根据实际使用决定是否将 Memory 改成原生 `ToolModule`。若迁移，需要另写数据格式、兼容读取、备份和回滚方案，不与一键启用改造绑在同一个提交中。

## 9. 测试计划

### 9.1 单元测试

- 三个平台生成正确的无 shell 命令和固定版本参数；
- 未知预置、错误确认版本和非回环 stdio 被拒绝；
- 重复启用不会创建重复 Server；
- 并发启用复用单飞 Promise；
- 测试失败后 Server 必须保持停用；
- 预置升级正确使旧验证失效；
- 本地审批策略优先于远端 `readOnlyHint`；
- 对外 DTO 不含 command secrets、env、header 或 OAuth 值。

### 9.2 集成测试

- 一键启用后工具进入动态 Runtime；
- `toolPolicy: all/selected/none` 行为正确；
- Research 和 Task 可以调用，legacy chat 不可调用；
- 写工具等待审批，只读工具按本地策略执行；
- Schema 漂移、连接漂移和审批期间停用均阻止远端调用；
- 重启恢复已启用预置及 LKG；
- OAuth 待授权不会产生未处理 Promise rejection；
- 删除或解除托管后 Runtime 和 Store 状态一致。

### 9.3 手工验收矩阵

至少验证：

- macOS + Node 20；
- Windows + Node 20；
- Linux + Node 20；
- 无网络首次启用；
- 无 `npx` 环境；
- 应用重启和 MCP 子进程异常退出；
- Context7 与 Memory 分别启用、停用、重试和删除。

完成后运行：

```bash
pnpm typecheck
pnpm test
pnpm --filter backend runtime:verify
pnpm build
```

## 10. 验收标准

本方案完成需同时满足：

1. 用户首次只需一次确认和一次点击，不再手动保存、测试、启用。
2. macOS、Windows、Linux 不依赖平台专属 shell 命令。
3. 第三方包有固定版本，且不会在未确认时执行。
4. 成功状态意味着工具已经被发现并且连接可用。
5. 重启后自动恢复，无需重复配置。
6. ToolPolicy、Snapshot、审批和 Runtime 最终门禁保持有效。
7. 写操作不会因远端伪造 `readOnlyHint` 绕过本地策略。
8. 失败不会清空 LKG，也不会留下重复或错误启用的连接。
9. legacy chat 继续与 MCP 隔离。
10. 管理 API 和 UI 不暴露凭证或原始敏感错误。

## 11. 推荐决策

- 立即实施：Context7、Memory 后端托管预置 + 一键启用。
- 默认行为：首次明确确认，后续自动恢复。
- 启动方式：无 shell、跨平台解析、固定包版本。
- 权限行为：本地审批策略优先，未知工具默认要求审批。
- 后续演进：Context7 保持 MCP；Memory 在产品需求稳定后评估原生 `ToolModule`。
