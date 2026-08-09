# RAG 检索测评

`pnpm rag:eval` 使用真实的 `docs/knowledge` 文档，走生产检索链路完成端到端测评：SQLite 知识文档、Markdown chunking、Embedding、Qdrant 和 `searchKnowledge()`。

黄金问题位于 `backend/src/rag/eval/fixtures.ts`，当前共 119 条（109 条可回答 + 10 条不可答），覆盖精确检索、语义改写、干扰项、多文档和不可答五类。

## 三级相关性判定

报告（`schemaVersion: 4`）按三个粒度分别计算宏平均 `Recall@3` 与 `MRR@3`：

1. **文件级**：命中 `expectedFiles` 中的期望文档。阈值判定（当前 `0.90` / `0.80`）仍作用于该级别，保持与历史运行可比。
2. **章节级（chunk 级）**：命中 `expectedHeadings` 指定的期望章节；匹配范围包含 `## / ###` 标题路径及相邻合并上下文中的章节。
3. **证据级**：命中的 chunk 内容包含 `expectedAnchors` 中的原文锚点（逐字子串）。`expectedEvidence` 是人类可读答案要点，不参与自动判定。

不可答用例（`answerable: false`）不参与 Recall/MRR/通过率，仅记录 top1 相似度分布（均值与最大值），为后续检索置信度门控的阈值选择提供参照。

修改知识库或检索策略时，应同步维护问题集并运行：

```bash
pnpm rag:eval:validate   # 校验用例：文件、章节、锚点必须真实存在（锚点逐字比对 chunk 内容）
pnpm rag:eval:smoke      # 离线冒烟：朴素 bigram 检索器驱动完整评测流程，不需要 Embedding/Qdrant
```

## 本地运行

先启动固定版本的 Qdrant：

```bash
pnpm qdrant:up
```

再使用隔离的 SQLite 数据库和 Qdrant collection 运行评测：

```bash
EMBEDDING_API_KEY=your_embedding_key \
SQLITE_DB_PATH=.rag-eval/knowledge.sqlite \
QDRANT_COLLECTION=rag_eval \
pnpm rag:eval
```

可选环境变量：

- `EMBEDDING_BASE_URL`、`EMBEDDING_MODEL`：覆盖默认 Embedding 服务配置。
- `QDRANT_URL`：默认 `http://localhost:6333`。
- `RAG_EVAL_REPORT_PATH`：JSON 报告位置，默认 `.rag-eval/report.json`。
- `RAG_HYBRID=on`：启用 Dense + FTS5 Hybrid 检索。
- `RAG_QUERY_REWRITE=on`：启用 P3 置信度驱动的查询改写；需要配置当前 LLM Provider 的 API Key。
- `RAG_QUERY_REWRITE_MODEL`：可单独覆盖改写模型；留空时跟随当前 Provider 的模型。

关闭 Query Rewrite 时，测评不使用文本模型。启用 P3 后会调用当前 LLM Provider 生成检索查询，但仍不生成最终 Agent 回答。

评测拒绝使用默认生产 collection `knowledge_chunks` 或默认生产数据库 `backend/data/evident-loop.sqlite`，以避免覆盖本地工作数据。

## 检索策略 A/B（Dense vs Hybrid）

每次评测可指定检索策略，策略会记录进运行 config，保证可复现：

- 前端：「配置」面板 → 「检索策略」选择 Dense（纯向量）或 Hybrid（Dense Top20 + FTS5 Top20 → RRF(k=60) → 相邻合并最多 4 chunks / 900 tokens → 同文档限流每篇 ≤2）。
- CLI：`RAG_HYBRID=on pnpm rag:eval` 以 Hybrid 运行；不设该变量默认 Dense。
- Agent 运行时（`searchKnowledge` 工具）同样由 `RAG_HYBRID` 环境变量控制，评测与运行时走同一条 `retrieveKnowledge()` 链路。

A/B 流程：以 dense-baseline 为基线 → 用 Hybrid 再跑一次 → 在「基线对比」面板查看指标差值与逐案例翻转。预期 Hybrid 主要提升 exact / multi_document 类；若某类明显退步，先看该类翻转案例再决定是否调整候选规模或限流参数。

## P3 Query Rewrite A/B

Query Rewrite 默认只在首轮检索为 `weak`，或只有偏低语义信号且无关键词证据时触发。`empty` 不改写；最多调用模型一次、生成 2 个改写查询，总查询数不超过 3。

```bash
LLM_PROVIDER=deepseek DEEPSEEK_API_KEY=your_deepseek_key \
RAG_HYBRID=on \
RAG_QUERY_REWRITE=on \
pnpm rag:eval
```

Schema v4 新增 `metrics.queryRewrite`：触发案例数/比例、总查询数、平均/最大查询数、平均改写耗时。每条 case 还保存 `originalVerdict`、`retrievalQueries`、`queryCount`、`rewriteTriggered`、`rewriteDurationMs` 和 `rewriteModel`，用于定位具体改写是否有效。

当前 P2 → P3 真实 A/B：文件 Recall@3 96.3% → 97.2%，通过率 103/109 → 104/109；触发率 17.6%，平均 1.32 次查询、最大 3 次；拒答召回 7/10、误拒 2/109 均保持不变。

## Baseline 与历史对比

前端「RAG 评测」页支持选择任意两次已完成的运行做对比：五项指标差值（文件 Recall/MRR、通过率、章节 Recall、锚点 Recall）以及逐案例的退步/改进清单。

建议在改动检索策略（Hybrid、Rerank、分块调整）之前，先跑一次评测并命名为 `dense-baseline` 存档，之后每次改动都与该基线对比，用数据决定是否保留改动。
