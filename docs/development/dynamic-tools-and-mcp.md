# 动态工具与 MCP

本文描述当前已经实现的动态 ToolRuntime 与 MCP 集成。它是进程内动态目录，不是每个模型轮次都向远端 MCP 重新发现工具的代理层。

## 目录、Snapshot 与执行

生产组合根是 `backend/src/app.ts` 的 `createProductionApp()`：初始化 SQLite 后创建一个动态 `ToolRuntime`、`McpManager` 和 `ApprovalManager`，并把同一 Runtime 注入 Research Workbench、Durable Agent Task 和 MCP 管理路由。旧的 `/api/agent/chat` 使用只含内置工具的兼容 Runtime，不接入 MCP。

内置工具在 `tools/catalog/` 用 `defineTool()` 定义。输入 Zod Schema 同时生成模型可见 JSON Schema，并在执行前解析参数。MCP 工具由 Manager 适配成同一个 `ToolModule` 契约。每个模型工具轮调用 `getSnapshot(policy, scope)` 取得当前内存 Registry 的不可变定义、工具名和 definition hash；每轮只读内存，不会联网调用 MCP `tools/list`。

`ToolRuntime.execute(snapshot, call)` 是执行硬门禁：调用必须得到该 Snapshot 授权，当前目录仍有工具，定义 hash 未变化，工具仍可用，参数通过 Schema，然后才进入执行器。`unauthorized`、`unavailable`、`schema_changed`、`invalid_arguments` 等失败以结构化 `ToolExecutionError` 返回。`listCatalog()`/`listModules()` 用于管理和组合根，不能替代轮次 Snapshot。

## 发现、刷新与生命周期

MCP 工具清单只在以下时机通过网络刷新：

- 启动时：从 SQLite 恢复配置和上次工具 Schema；对已启用服务器异步连接并执行分页 `tools/list`，不阻塞 HTTP 启动。
- 服务器发送 `tools/list_changed` 时：SDK 回调触发默认 250ms 防抖；同一服务器已有刷新时复用单飞 Promise。
- 管理员手动调用 `POST /api/mcp/servers/:id/test` 或 `POST /api/mcp/servers/:id/refresh` 时。测试成功后会断开测试连接并保持停用，必须显式启用。
- OAuth 授权完成（浏览器 callback 或 UI 提交 code/state）后：Manager 重新连接并刷新工具清单。
- 连接关闭或出错后：启用服务器按退避策略重连，重连成功再刷新。

模型轮次绝不会触发远端 `tools/list`。刷新或连接变化只更新内存 Registry，后续轮次自然取得新 Snapshot。服务器状态包括 `disabled`、`connecting`、`connected`、`unavailable`、`authorization_required`、`credential_unavailable` 和 `error`；禁用、断线、待授权或凭证不可用时，已发现工具仍保留在目录中，但调用返回 `unavailable`。

## LKG、tombstone、稳定名称与顺序

`mcp_servers` 和 `mcp_tools` 存在 SQLite 中。刷新失败不会清空 Last-Known-Good（LKG）Schema；成功刷新后，如果远端清单不再包含某个已知 remote name，则记录为 `tombstone`，保留模型定义、Schema、ordinal 和历史展示，但调用返回 `unavailable`。无效的新 Schema 不会覆盖原有有效 LKG。只有明确 `DELETE /api/mcp/servers/:id` 才会删除服务器配置、工具记录和 Runtime 模块。

首次发现的工具会获得稳定模型名：`mcp__<server-id-prefix>__<sanitized-remote-name>__<hash>`（最多 64 个字符）。同一服务器的 remote name 后续刷新继续使用原模型名；ordinal 也保持不变。目录先按服务器创建时间/ID，再按工具 ordinal/remote name 排序，因而模型看到的工具顺序稳定。

## Transport、认证与 OAuth

- `stdio`：配置 `command`、可选 `args`/`cwd`/`env`，启动本机 MCP 子进程。后端 `HOST` 必须是 `localhost`、`127.0.0.1` 或 `::1`；非回环部署会拒绝 stdio 测试、启用和连接。
- `http`：使用 MCP Streamable HTTP。可选 `authMode: none`、`headers` 或 `oauth`；带静态 headers 的 `none` 会规范化为 `headers`。OAuth 模式禁止手工配置 `Authorization` header。
- OAuth：使用 SDK 的 PKCE 流程，支持动态客户端注册（DCR）、启动时 refresh token 刷新、授权回调和断线后的重新连接。回调优先使用服务器 `oauth.redirectUri`，其次是 `MCP_OAUTH_REDIRECT_URI`，否则默认 `http://127.0.0.1:<PORT>/api/mcp/oauth/callback`；授权完成可由浏览器回调或 UI 的 code/state 兜底表单提交。

OAuth DCR 对严格互操作场景已验证：当 DCR 同时返回非空 `client_secret`、明确 `method=none`，且授权服务器元数据明确支持 `client_secret_post` 时，adapter 只向 SDK 派生 `client_secret_post` 视图；原始 DCR 响应仍加密并原样持久化。其他组合不猜测、不覆盖。

MCP `env`、静态 header 和 OAuth 客户端/Token 状态由 `MCP_CREDENTIALS_KEY` 保护，使用 AES-256-GCM；该变量必须是 32 字节密钥的 Base64。HTTP API 永不返回凭证值，只返回 `hasCredentials`、header 名称等非敏感信息，并对 URL 中的认证信息和敏感查询参数做脱敏。缺少、格式错误或无法解密时，应用继续启动，相关服务器进入 `credential_unavailable`/不可用状态；没有有效密钥时保存带凭证的配置会被拒绝。

## 审批与结果

MCP 工具的 `annotations.readOnlyHint === true` 自动执行；为 `false` 或缺失时，每次调用都要人工审批。审批只适用于 Research Workbench 和 Durable Agent Task，作用域分别是 `research_run` 与 `agent_task`。审批记录存入 SQLite，状态可为等待、批准、拒绝、过期、取消或失效；请求取消、进程重启、连接/可用性变化、Schema 或 definition hash 变化都会使等待中的审批不能绕过最终 Runtime 门禁。批准后仍会在实际执行前再次校验 Snapshot。

调用结果由 Manager 归一化：文本块合并为 `text`，保留 `structuredContent`，image/audio/resource/resource_link 变为非敏感 `metadata`，其他未知块放入 `unsupported` 摘要；远端 `isError` 转为 `tool_rejected`。连接、授权或非结构化执行失败会更新服务器状态并返回结构化不可用/执行失败结果。审批 API 返回的参数已经脱敏。

## 用户边界与当前限制

当前 MCP 配置、工具 Registry、SQLite LKG 和审批记录都是进程/实例级资源；`ToolScope` 只把调用上下文传给快照和审批，不能提供用户认证或租户隔离。项目当前 API 没有认证、用户隔离或限流，因此仅适合本机/受信网络开发，不应公开部署。多用户生产化还需要外部身份认证、租户级配置与凭证隔离、授权策略和审计边界；这些不是当前实现。

## 管理 API 与 UI

生产 API 挂载在 `/api/mcp`：

| 操作 | 路由 |
| --- | --- |
| 列出/创建 | `GET /servers`、`POST /servers` |
| 编辑 | `PUT /servers/:id` |
| 测试连接 | `POST /servers/:id/test` |
| 启用/停用 | `PATCH /servers/:id/enabled`，body 为 `{ "enabled": boolean }` |
| 手动刷新 | `POST /servers/:id/refresh` |
| OAuth code | `POST /servers/:id/authorize` |
| OAuth callback | `GET /oauth/callback?serverId=...&code=...&state=...`（也可用 state 查找服务器） |
| 删除 | `DELETE /servers/:id` |

前端入口是“设置 → MCP 服务器”。新连接先保存为停用草稿，测试成功后才可启用；页面展示连接状态、工具 Schema/历史 tombstone、只读提示和授权状态，但不会回显凭证。Research Workbench 与 Task Console 通过 SSE/任务详情展示审批请求，并可批准或拒绝；通用审批 API 为 `GET /api/tool-approvals`、`GET /api/tool-approvals/:approvalId` 和 `POST /api/tool-approvals/:approvalId/decision`。

## 配置与本地安全

从 `backend/.env.example` 复制配置。MCP 相关环境变量为：

```dotenv
HOST=127.0.0.1
APP_ORIGINS=http://localhost:5173,http://127.0.0.1:5173
MCP_CREDENTIALS_KEY=<32-byte-base64-secret>
MCP_OAUTH_REDIRECT_URI=
```

默认后端和 Vite 监听回环地址。`/api` 共享 Host/Origin 校验：`APP_ORIGINS` 非空时只接受列出的浏览器 Origin；为空时使用本地 Vite Origin 和请求 Host 的同源默认值。不要提交 `.env`、数据库、MCP 配置中的凭证、日志或截图中的 Token；在本机文件权限和受信网络范围内运行。当前服务没有认证/限流，不能直接暴露公网。

## 验证

文档和实现变更后可运行：

```bash
pnpm typecheck
pnpm test
pnpm --filter backend runtime:verify
pnpm build
```

涉及 MCP 时，后端测试命令会包含 `backend/src/mcp/*.test.ts`、工具 Runtime 和审批测试；手工验证可启动 `pnpm dev`，在设置页新增一个停用连接，依次测试、刷新、启用，再观察状态、历史工具和审批行为。
