# 模块化架构约定

EvidentLoop 采用模块化单体。模块边界用于降低并行开发的共享修改面，不代表需要拆成独立服务。

## 依赖方向

```text
HTTP/SSE Adapter → Module Application API → Domain/Runtime → Ports
                                                    ↑
                                  Infrastructure Adapters

app.ts → applications + provider/tool adapters（唯一组合根）
```

规则：

1. `routes/` 只处理协议解析、状态码和序列化，通过 `modules/*` 调用用例。
2. `modules/*/application.ts` 是模块公开的用例入口，负责组合模块内部服务。
3. Runtime、RAG、Research、Agent 不依赖具体模型厂商，只依赖 `llm/contracts.ts`。
4. 工具实现依赖 `tools/contracts.ts`，不能反向导入 `tools/registry.ts`。
5. `app.ts` 是 Provider、Tool Catalog、Tool Runtime、MCP Manager、Approval Manager、Application 和 Router 的生产组合根。生产启动先初始化 SQLite，再由 `createProductionApp()` 把同一个动态 `ToolRuntime` 注入 Research、Task 和 MCP 路由；旧 `/api/agent/chat` 使用只含内置工具的兼容 Runtime。
6. 跨模块调用必须通过模块的 `index.ts` 公开入口，不能访问对方 Store。
7. `approvals/` 是一个窄的应用边界：Research/Task 只依赖 `ApprovalManager` 契约来等待、通知和取消审批，不读审批表，也不理解 MCP SDK。`ToolRuntime` 仍是执行前最后一道授权、Schema 和可用性硬门禁。

`modules/boundaries.test.ts` 会对关键边界做自动检查。

## 主要目录

```text
backend/src/
├── app.ts                    # 组合根
├── llm/
│   ├── contracts.ts          # LlmProvider 端口和中立消息契约
│   ├── deepseekProvider.ts   # DeepSeek 适配器
│   └── provider.ts           # 兼容期 Provider 解析
├── modules/
│   ├── tasks/                # Durable Task 应用层入口
│   └── research/             # Research 应用层入口
├── routes/                   # Express/SSE 适配器
├── tools/
│   ├── contracts.ts          # Tool 端口
│   ├── catalog/              # 按能力维护的工具模块
│   ├── registry.ts           # 工具目录组合
│   ├── defineTool.ts         # Zod Schema → JSON Schema + 执行输入校验
│   └── runtime.ts            # snapshot、策略过滤与执行硬门禁
├── approvals/                # Research/Task 的 MCP 调用审批边界
├── mcp/
│   ├── contracts.ts           # 中立 MCP Manager/Adapter/Store 契约
│   ├── adapters/sdk.ts        # stdio/Streamable HTTP/OAuth SDK 适配器
│   ├── manager.ts             # 连接生命周期、工具刷新与动态注册
│   └── routes.ts              # 管理 API 与 Host/Origin 安全边界
├── runtime/                  # Durable Runtime 内部实现
├── research/                 # Research 内部实现
└── rag/                      # 检索内部实现
```

## 新增工具

1. 在 `tools/catalog/` 对应能力文件中为输入定义一个 Zod Schema，并用 `defineTool()` 绑定名称、描述、UI 标签和执行器。
2. `defineTool()` 从同一个 Zod Schema 生成模型可见 JSON Schema；`ToolRuntime` 在执行前再次用该 Schema 解析参数，禁止模型定义与执行校验漂移。
3. 在 `tools/catalog/index.ts` 组合新的能力集合，生产组合根用 `createToolRuntime()` 创建 Runtime。
4. 不要在业务模块中直接修改或读取具体注册表对象；动态 Provider 通过 `ToolRuntime` 的 `upsert`/`unregister` 契约进入目录。

任务和研究请求使用显式 Tool Policy：`all` 表示全部已注册工具，`selected` 表示指定工具集合，`none` 表示禁止工具。空数组只用于读取旧数据时兼容，不能作为新代码中的权限语义。

## ToolRuntime 深模块接口

`backend/src/tools/contracts.ts` 的 `ToolRuntime` 把“目录快照、模型定义和执行”收在一个窄接口内：

```text
listCatalog()/listModules()        → 当前内存模块（管理和组合根使用）
getSnapshot(policy, scope)         → 一个模型工具轮的不可变 definitions + hashes
getDefinitions(policy)             → 兼容的模型定义读取
execute(snapshot, toolCall, ctx)   → 使用同一快照执行并返回结果
```

每一轮 Agent 只从内存 Registry 获取 snapshot，不因模型轮次向 MCP 做网络 `tools/list`。Snapshot 保存暴露工具、策略、Scope、定义 Hash 和只读模块视图。执行时必须依次通过：snapshot 授权、当前目录仍存在、定义 Hash 未变化、工具 availability、参数 Schema；任一门禁失败都返回结构化 `ToolExecutionError`（例如 `unauthorized`、`unavailable`、`schema_changed`、`invalid_arguments`），不会执行猜测或过期工具。

内置工具使用 Zod 单一来源；MCP 工具在 MCP 边界用 JSON Schema/Ajv 校验并以同样的 Runtime 门禁执行。审批不是 Runtime 的替代品：Research Workbench 和 Durable Agent Task 在调用 MCP 非只读工具前通过 `ApprovalManager` 等待用户决定，随后仍要经过 Runtime 的最终快照校验。

## MCP 适配器边界

`mcp/adapters/sdk.ts` 是唯一接触 MCP SDK 的地方，向 `mcp/manager.ts` 只暴露中立的连接、分页工具描述、调用结果和生命周期回调。Manager 负责启动/重连、`tools/list` 刷新、防抖单飞、LKG Schema、tombstone、稳定模型名和动态 Runtime 模块；它不把 SDK 类型泄漏到模块或路由。MCP 连接管理、凭证存储和工具目录状态属于基础设施能力，Research/Task 只接收 `ToolRuntime` 与 `ApprovalManager` 契约。

## 新增模型 Provider

实现 `LlmProvider.complete()`，然后在 `app.ts` 注入。业务代码不能判断 Provider 名称，也不能读取厂商专用环境变量。

## 后续迁移

- 为 Runtime Store 和 Research Store 建立 Repository 端口，移除对全局 SQLite 的直接引用。
- 将 Knowledge、Chat 和 RAG Evaluation 路由迁移到相同的应用层边界。
- 把前后端重复 DTO 收敛到独立 contracts workspace。
- 把数据库初始化拆为追加式 migration 文件，避免所有模块修改同一个 SQL 块。
