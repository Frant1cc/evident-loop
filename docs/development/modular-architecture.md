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
5. `app.ts` 是 Provider、Tool Catalog、Tool Runtime、Application 和 Router 的唯一生产组合根。同一个 `ToolRuntime` 必须同时负责模型工具定义与实际工具执行。
6. 跨模块调用必须通过模块的 `index.ts` 公开入口，不能访问对方 Store。

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
│   └── runtime.ts            # 工具定义、策略过滤与执行端口
├── runtime/                  # Durable Runtime 内部实现
├── research/                 # Research 内部实现
└── rag/                      # 检索内部实现
```

## 新增工具

1. 在 `tools/catalog/` 对应能力文件中声明 Tool Module。
2. 工具模块同时包含模型定义、UI 标签和执行器绑定。
3. 在 `tools/catalog/index.ts` 组合新的能力集合。
4. 不要在业务模块中直接修改或读取具体注册表对象。

任务和研究请求使用显式 Tool Policy：`all` 表示全部已注册工具，`selected` 表示指定工具集合，`none` 表示禁止工具。空数组只用于读取旧数据时兼容，不能作为新代码中的权限语义。

## 新增模型 Provider

实现 `LlmProvider.complete()`，然后在 `app.ts` 注入。业务代码不能判断 Provider 名称，也不能读取厂商专用环境变量。

## 后续迁移

- 为 Runtime Store 和 Research Store 建立 Repository 端口，移除对全局 SQLite 的直接引用。
- 将 Knowledge、Chat 和 RAG Evaluation 路由迁移到相同的应用层边界。
- 把前后端重复 DTO 收敛到独立 contracts workspace。
- 把数据库初始化拆为追加式 migration 文件，避免所有模块修改同一个 SQL 块。
