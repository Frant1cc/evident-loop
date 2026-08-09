# EvidentLoop 运行指南

本文档用于比赛评审、开发调试和本地演示。所有命令均在项目根目录执行。

## 1. 环境要求

| 依赖 | 建议版本 | 用途 |
| --- | --- | --- |
| Node.js | 20 或更高 | 运行前后端与测试 |
| pnpm | 10 或更高 | 安装 workspace 依赖 |
| Docker | 24 或更高 | 运行 Qdrant |
| Docker Compose | v2 或更高 | 启停 Qdrant 服务 |

本项目已在 Node.js `20.19.5`、pnpm `10.11.0` 环境验证。

如未安装 pnpm，可使用 Corepack：

```bash
corepack enable
corepack prepare pnpm@10.11.0 --activate
```

## 2. 配置 API Key

复制环境变量模板：

```bash
cp backend/.env.example backend/.env
```

Windows PowerShell：

```powershell
Copy-Item backend/.env.example backend/.env
```

编辑 `backend/.env`：

```dotenv
PORT=3000

# 对话、研究工作台、Agent 规划/执行/审查/报告生成
LLM_PROVIDER=deepseek
DEEPSEEK_API_KEY=请填写真实密钥
DEEPSEEK_MODEL=deepseek-v4-flash
DEEPSEEK_REQUEST_TIMEOUT_MS=60000

# 知识库向量化、RAG 检索和 RAG 评测
EMBEDDING_BASE_URL=https://api.siliconflow.cn/v1
EMBEDDING_API_KEY=请填写真实密钥
EMBEDDING_MODEL=Qwen/Qwen3-Embedding-4B

# 本地 Docker Qdrant
QDRANT_URL=http://localhost:6333
QDRANT_COLLECTION=knowledge_chunks

RAG_HYBRID=on
RAG_QUERY_REWRITE=on
RAG_QUERY_REWRITE_MODEL=
```

使用 MiniMax 时，将文本模型部分替换为：

```dotenv
LLM_PROVIDER=minimax
MINIMAX_API_KEY=请填写真实密钥
MINIMAX_MODEL=MiniMax-M3
# 中国区；国际账号使用 https://api.minimax.io/v1
MINIMAX_BASE_URL=https://api.minimaxi.com/v1
MINIMAX_REQUEST_TIMEOUT_MS=90000
```

说明：

- `LLM_PROVIDER` 支持 `deepseek` 和 `minimax`；未填写时默认使用 DeepSeek，只有 MiniMax Key 时会自动选择 MiniMax。
- 所选 Provider 对应的 API Key 是对话和 Agent 功能的必需配置。
- `DEEPSEEK_REQUEST_TIMEOUT_MS`、`MINIMAX_REQUEST_TIMEOUT_MS` 只限制单次模型请求尝试；后台研究任务没有总时长硬限制。
- `EMBEDDING_API_KEY` 是知识库向量化和检索功能的必需配置。
- 本地 Qdrant 不需要 `QDRANT_API_KEY`；连接远程实例时再填写。
- `backend/.env` 含真实密钥，已被 `.gitignore` 忽略，禁止提交或截图公开。

## 3. 安装与启动

安装依赖：

```bash
pnpm install
```

先启动 Qdrant：

```bash
pnpm qdrant:up
```

确认容器状态：

```bash
docker compose ps
```

再启动前后端：

```bash
pnpm dev
```

服务地址：

| 服务 | 地址 |
| --- | --- |
| 前端 | http://localhost:5173 |
| 后端健康检查 | http://localhost:3000/api/health |
| Qdrant Dashboard | http://localhost:6333/dashboard |

健康检查的成功响应应包含：

```json
{
  "code": 1,
  "data": {
    "ok": true,
    "service": "evident-loop-backend"
  }
}
```

## 4. 首次初始化知识库

SQLite 数据库会在后端首次启动时自动创建，不需要手工建表。为方便评委体验 RAG：

1. 打开前端的“知识库”Tab。
2. 点击“上传文档”。
3. 从 `knowledge-samples/` 中选择 Markdown 文件。
4. 保持“保存后自动向量化”开启并保存。
5. 等待文档状态显示为“已索引”。

建议至少上传：

- `knowledge-samples/computer/agent-rag-engineering.md`
- `knowledge-samples/computer/database-internals.md`
- `knowledge-samples/finance/fixed-income-risk.md`

每次上传完成后会自动写入 SQLite 并同步到 Qdrant。已有多篇文档但索引状态异常时，可以在知识库页面执行“同步”，或运行：

```bash
pnpm rag:sync
```

## 5. 测试与构建

提交前建议依次执行：

```bash
pnpm typecheck
pnpm test
pnpm --filter backend runtime:verify
pnpm build
```

验收标准：

- 命令均以退出码 `0` 结束。
- `pnpm test` 无失败用例。
- `runtime:verify` 输出 `Durable Task Runtime verification passed`。
- 前端和后端均成功生成 `dist/`；`dist/` 只用于本地验证，不提交。

## 6. 停止服务

先在运行 `pnpm dev` 的终端按 `Ctrl+C`，再停止 Qdrant：

```bash
pnpm qdrant:down
```

该命令会保留 Qdrant Docker volume，下一次启动仍可使用已有索引。

## 7. 常见问题

### 后端启动时报 Qdrant 连接失败

确认 Qdrant 已启动：

```bash
pnpm qdrant:up
docker compose ps
```

并检查 `QDRANT_URL` 是否为 `http://localhost:6333`。

### 提示 API key is not configured

检查 `LLM_PROVIDER` 和对应的 `DEEPSEEK_API_KEY` 或 `MINIMAX_API_KEY` 是否写在 `backend/.env`，不要写在项目根目录的 `.env`。修改后重启后端。

### 提示 `EMBEDDING_API_KEY is not configured`

知识库向量化和检索需要 Embedding Key。填写后重新保存/向量化文档，或执行 `pnpm rag:sync`。

### 端口被占用

- 前端默认端口：`5173`
- 后端默认端口：`3000`
- Qdrant HTTP：`6333`
- Qdrant gRPC：`6334`

后端端口可通过 `backend/.env` 中的 `PORT` 修改；如修改后端端口，还需同步修改 `frontend/vite.config.ts` 的代理地址。

### `better-sqlite3` 安装或加载失败

优先使用 Node.js 20，然后重新安装：

```bash
pnpm install
pnpm rebuild better-sqlite3
```
