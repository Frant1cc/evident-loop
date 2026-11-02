# 免注册公开试用

第一版只开放研究对话、会话笔记和部署者准备的公共示例知识检索。访客无须注册，各自使用独立的临时身份。文件上传、文稿生成和下载、独立 Agent 任务、联网检索、研究技能、MCP、评测和管理接口暂不开放。普通本地模式保持原有功能。

## 启用

后端设置 `PUBLIC_DEMO_ENABLED=true`，并使用专用数据库和公共示例知识库。不要直接使用含有私人知识资料的本地工作台数据库：试用模式的知识检索范围是该实例的共享知识库。

同机反向代理和 HTTPS 域名部署的环境示例（域名替换成实际值）：

```dotenv
PUBLIC_DEMO_ENABLED=true
HOST=127.0.0.1
APP_HOSTS=demo.example.com
APP_ORIGINS=https://demo.example.com
DEMO_COOKIE_SECURE=true
DEMO_TRUST_PROXY=loopback
SQLITE_DB_PATH=/data/demo/evident-loop.sqlite
KNOWLEDGE_FILES_DIR=/data/demo/knowledge-files
ARTIFACTS_DIR=/data/demo/artifacts
ARTIFACT_BINARY_DIR=/data/demo/artifact-binaries
```

上面是应用配置示例，部署时还需配置持久化挂载、前端静态服务、HTTPS 和 SSE 代理。容器部署时监听地址通常需要改为 `0.0.0.0`，代理信任范围填写实际代理地址，不能照抄同机回环配置。后端只接受代理的内部访问，不直接向公网开放。

前后端通过同一站点的 `/api` 访问。代理保留正确的 `Host`，设置 `X-Forwarded-Proto`，并使用可信的客户端地址覆盖 `X-Forwarded-For`；只有配置在 `DEMO_TRUST_PROXY` 内的代理可以提供客户端 IP。保持默认不信任代理时，伪造转发头不能绕过 IP 限额，但所有经过代理的访客可能共用该代理 IP 的额度。

本地 HTTP 验证时可暂设 `DEMO_COOKIE_SECURE=false`，`APP_HOSTS` 留空或填写回环地址，`APP_ORIGINS` 使用实际 Vite 来源。不要在公网 HTTP 下传输访客 Cookie。

## 身份和访问范围

- 服务端签发 32 字节随机访客令牌，数据库只存 SHA-256 摘要。Cookie 设置 HttpOnly、SameSite=Strict；HTTPS 使用带 Secure 的 `__Host-` Cookie，不设置 Domain。
- 身份有效期为 7 天；多个同站点标签页共享身份，隐私窗口或清除 Cookie 会建立新身份，无法找回旧会话。
- 新建会话原子绑定服务端识别的访客，列表、详情、笔记、运行查询、取消和 SSE 重放/订阅均核验归属。已有本地会话不自动归属任何访客，因此不可见。
- 敏感接口采用明确允许列表。未开放的功能即使绕过前端直接请求，也返回 403。跨访客资源返回 404。
- 写请求必须使用 JSON 及 `X-Requested-With: EvidentLoop`，并经过 Origin/Host 检查；试用 API 不启用跨站 CORS。
- 前端通过 `/api/demo` 初始化身份并显示剩余额度，先完成身份初始化才并发加载工作台数据，避免首次加载时多个请求建立不同身份。

## 默认额度

| 配置 | 默认值 |
| --- | --- |
| `DEMO_VISITOR_DAILY_LIMIT` | 每访客每天 10 次研究 |
| `DEMO_IP_DAILY_LIMIT` | 每 IP 每天 10 次研究 |
| `DEMO_GLOBAL_DAILY_LIMIT` | 全站每天 100 次研究 |
| `DEMO_GLOBAL_CONCURRENCY` | 全站同时 3 个研究任务 |
| 每访客并发 | 1 个后台任务 |
| `DEMO_MAX_MESSAGE_CHARS` | 每条消息最多 2000 字符 |
| `DEMO_MAX_RUN_SECONDS` | 每任务最多 120 秒，取消信号传至模型和检索 |
| `DEMO_MAX_LLM_CALLS` | 每任务最多 6 次主模型/上下文模型调用 |
| `DEMO_MAX_OUTPUT_TOKENS` | 每次模型调用最多 2048 输出 token，关闭推理、自动重试 |
| `DEMO_MAX_TOOL_CALLS` | 每任务最多 4 次工具调用，最多 3 轮工具决策 |
| 会话内容预算 | 每次模型请求的消息和工具定义总计不超过 40000 字符 |
| 存储边界 | 每访客最多保留 10 个会话，每会话最多 20 条笔记 |

每日额度按北京时间零点重置。次数表示获准启动的研究尝试；执行失败、超时和取消仍消耗次数。校验失败及并发拒绝不会消耗研究次数。部分后续应用校验失败的已获准启动请求也计次。

额度检查、计次和占用并发名额在一个 SQLite 事务内完成。HTTP 返回 202 后，后台研究仍占用名额；点击取消不会提前释放，直到执行真正结束。重启会回收中断任务的并发名额，但保留当日计次。会话清理或删除不会重置用量。

另外限制每 IP 每分钟 120 个 API 请求、全站每分钟 1200 个；每天每 IP 最多建立 20 个新身份、全站最多 1000 个。IP 使用数据库内随机密钥做 HMAC 后保存，不存原始地址。匿名身份可以被重置，IP 也不是可靠的个人标识，因此 IP 和全站额度共同限制滥用。

这是调用次数与执行规模的上限，并非精确的人民币预算或账单结算。知识检索会调用 Embedding 服务，其现有每次查询最多 4 次请求尝试也受到工具次数和取消信号约束。试用模式关闭额外的 RAG 查询改写和联网 Provider 回退，减少旁路消耗。上线后仍需观察服务商账单并配置服务商侧额度。

## 数据与运行

公开试用模式自动启用[每 24 小时清理](./demo-data-retention.md)，删除闲置满 24 小时的会话、任务及关联数据；运行中内容跳过。访客身份有效期独立于内容保留期，身份 Cookie 仍有效并不表示会话会长期保存。

用量及不含正文的任务占用记录独立保存 7 天后清理。过期且不再拥有会话的访客身份也会清理。公共知识库、配置、日志和外部备份的保留策略独立管理。

当前面向单后端进程、单 SQLite 实例。不要用多进程或多副本启动方式部署：启动恢复会回收本进程部署前留下的任务占用；多实例需要独立的任务租约和协调机制。

## 验证

```bash
pnpm --filter backend exec tsx --test src/publicDemo.test.ts src/dataCleanup.test.ts src/rag/embeddingClient.test.ts
pnpm typecheck
pnpm test
pnpm build
```

用普通窗口和隐私窗口分别创建会话，验证双方列表独立，复制对方会话或运行 ID 无法读写、订阅或取消。发送到每日上限后应显示剩余 0 次；删除会话、重新打开页面和重启后端不能恢复额度。达到 IP/全站额度时，新访客也应被拒绝。
