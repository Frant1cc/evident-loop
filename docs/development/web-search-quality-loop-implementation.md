# EvidentLoop 联网搜索质量闭环优化说明

> 实现分支：`codex/web-search-quality-loop`  
> 基线分支：创建分支时的当前 `main`（`a8b6654 feat: run research tasks in background`）  
> 实现日期：2026-08-06

## 1. 优化目标

本次只聚焦联网搜索质量，不引入 Firecrawl、多搜索供应商、多 Agent 或浏览器渲染。底层继续使用现有的 Tavily Search 与 `fetch_page`，目标是把原来主要由模型自由决定的：

```text
web_search → fetch_page → 是否继续搜索
```

改造成由运行时代码控制的质量闭环：

```text
搜索 → 评分 → 选择不同域名页面 → 抓取 → 页面评分
  ↑                                            ↓
  └──────── 弱结果/无关页面 → 查询改写 ────────┘

达到质量阈值：sufficient
达到预算仍不足：exhausted
没有有效证据：empty
```

## 2. 参考设计

实现思路主要参考：

- Tavily 官方 Search API 与 Best Practices：使用返回的 relevance score、复杂查询聚焦、按需从 `basic` 升级到 `advanced`；
- LangGraph 官方 Custom RAG：检索后执行 grade，不相关则 rewrite，再重新检索；
- CRAG（Corrective Retrieval Augmented Generation）：使用独立检索评估器驱动纠正动作；
- Azure Agentic Retrieval：查询规划、语义重排、来源引用与活动日志。

本次没有直接引入上述框架，而是将其控制思想实现到现有 TypeScript 架构中。

## 3. 新的受控联网工具

新增模型可见工具：

```text
retrieve_web_evidence
```

工具输入：

```ts
{
  question: string;
  timeRange?: 'day' | 'week' | 'month' | 'year';
  includeDomains?: string[];
  excludeDomains?: string[];
}
```

工具输出包含：

- `verdict`：`sufficient`、`weak`、`empty` 或 `exhausted`；
- `score`：当前最佳页面证据分数；
- `retrievalQueries`：实际执行过的全部查询；
- `queryAttempts`：每次查询的搜索深度、结果数、最高分和选中 URL；
- `pageAttempts`：每次页面抓取的分数、状态、Chunk 数和错误；
- `sources`：可以进入研究来源面板和引用链的网页证据；
- `claims`：从问题中提取的待验证事实，以及每条 Claim 的支持分数和来源 URL；
- `coverageScore` / `coveredClaimCount` / `totalClaimCount`：问题覆盖情况；
- `uncoveredClaims`：仍未被网页证据支持的具体事实；
- `diagnostics`：查询数、抓取数、对应预算、具体耗尽项、独立域名数、耗时和停止原因。

原有 `web_search` 与 `fetch_page` 仍保留为可执行的内部能力，但默认不再暴露给模型和前端工具开关，避免模型绕过评分、重写和预算控制。

每个用户请求只完整执行一次 `retrieve_web_evidence`。首次执行后，外层 Agent 会从下一轮可用工具中移除它；执行层仍保留重复调用保护，防止模型换一组参数重新获得预算。查询改写和渐进式重试全部在这一次调用内部完成。

## 4. 渐进式搜索策略

默认预算：

```text
一般请求最多查询：3 次
一般请求最多抓取：5 个页面
明确限定单一域名：4 次查询、8 个页面
每轮选择：最多 2 个页面
```

搜索深度：

```text
首轮：basic
中间改写：basic
最后一次预算：advanced（带 chunks_per_source=3）
```

Tavily 请求现在支持：

- `search_depth`；
- `chunks_per_source`；
- `time_range`；
- `include_domains`；
- `exclude_domains`。

第一次证据不足时，控制器向 DeepSeek 请求一个结构化查询改写：

```json
{
  "question": "原始问题",
  "previousQueries": ["已经执行的查询"],
  "failureReason": "页面无关、不可读或证据偏弱"
}
```

如果模型改写不可用，会使用可预测的回退查询，例如中文问题追加“官方资料”或“最新 权威来源”。查询经过规范化去重，不能重复消耗预算。

## 5. 搜索结果评分

每条 Tavily 结果会计算：

```ts
finalScore =
  providerScore     * 0.55 +
  lexicalScore      * 0.35 +
  completenessScore * 0.10;
```

- `providerScore`：Tavily 返回的 relevance score；
- `lexicalScore`：问题与标题、摘要之间的英文词/CJK 双字词覆盖率；
- `completenessScore`：标题、URL、摘要完整度。

初始阈值：

```text
finalScore >= 0.68：sufficient search result
0.42 <= finalScore < 0.68：weak search result
finalScore < 0.42：empty/unusable result
```

阈值集中定义在 `backend/src/web/quality.ts`，后续可通过评测集统一校准。

## 6. URL 规范化与来源多样性

新增 URL 规范化：

- 去掉 URL fragment；
- 主机名转小写；
- 删除 `utm_*`、`gclid`、`fbclid` 等跟踪参数；
- 对查询参数排序；
- 处理重复末尾斜杠；
- canonical URL 去重。

页面选择优先取不同域名：

```text
第一条：最高分结果
第二条：另一个域名的最高分结果
```

如果不同域名不足，再从已有域名中补充。已经抓取过的 canonical URL 不会重复抓取。

## 7. 页面质量判断

网页抓取后，对返回 Chunk 重新评分：

```ts
pageChunkScore =
  lexicalScore     * 0.60 +
  searchResultScore * 0.40;
```

页面状态：

```text
正文少于 160 字或内容为空：unreadable
最高分 < 0.42：irrelevant
0.42 <= 最高分 < 0.64：weak
最高分 >= 0.64：sufficient
```

与原逻辑相比，无关页面不会因为“总能返回页面开头几个 Chunk”而被误当作证据。只有至少命中问题词项的 Chunk 才会进入候选来源。

整体充分性条件：

- 单个页面证据分数达到 `0.76`；或
- 至少两个独立域名，并且最佳页面分数达到 `0.62`。

否则继续执行查询改写，直至充分或预算耗尽。

## 8. Verdict 语义

| Verdict | 含义 | Agent 使用规则 |
| --- | --- | --- |
| `sufficient` | 达到单来源高置信或多来源质量条件 | 可以作为外部事实证据 |
| `weak` | 找到部分相关来源，但没有可用的新查询且预算未硬耗尽 | 只能给出保留性说明 |
| `empty` | 没有找到可用网页证据 | 不得当作事实来源 |
| `exhausted` | 找到相关材料，但达到查询或页面预算仍不充分 | 只能给出受限的部分结论，并说明缺口 |

研究工作台与普通 Agent Prompt 已更新，明确要求将该 Verdict 视为权威质量状态。

## 9. 网页来源接入研究链路

`retrieve_web_evidence` 产生的高分网页片段会转换为兼容现有 `RagSource` 的来源：

```ts
{
  id: contentHash,
  file: pageUrl,
  title: pageTitle,
  heading: domain,
  content: selectedChunks,
  score: pageQualityScore
}
```

Agent Loop 会为这些来源发送 `source_found` 事件，研究服务继续执行：

- 保存到 `research_sources`；
- 分配 `[S1]`、`[S2]` 引用键；
- 通过 SSE 推送到前端来源面板；
- 将来源附加到研究回答。

这修复了原先 `web_search`、`fetch_page` 结果只进入模型上下文、却不能稳定进入研究来源列表的问题。

## 10. 工具与前端调整

- `getToolDefinitions()` 现在只返回 `exposedToModel !== false` 的工具；
- 研究工作台工具列表隐藏底层 `web_search`、`fetch_page`；
- 任务控制台默认工具改为 `retrieve_web_evidence`；
- Durable Runtime 将 `retrieve_web_evidence` 识别为检索工具，可用于证据缺口补充步骤；
- Agent Loop 对完整的 `retrieve_web_evidence` 参数做重复调用去重。
- 历史任务若仍保存 `web_search` 或 `fetch_page` 权限，运行时会兼容映射到 `retrieve_web_evidence`。

## 11. 主要代码变更

### 新增

```text
backend/src/web/types.ts
backend/src/web/quality.ts
backend/src/web/queryRewrite.ts
backend/src/web/controller.ts
backend/src/web/quality.test.ts
backend/src/web/controller.test.ts
backend/src/web/webSearchTool.test.ts
backend/src/web/integration.test.ts
```

### 修改

```text
backend/src/tools/webSearchTool.ts
backend/src/tools/registry.ts
backend/src/tools/definitions.ts
backend/src/agent/agentLoop.ts
backend/src/rag/index.ts
backend/src/research/service.ts
backend/src/routes/agent.ts
backend/src/routes/research.ts
backend/src/runtime/service.ts
frontend/src/views/TaskConsoleView.vue
backend/package.json
```

## 12. 测试覆盖

新增测试覆盖：

1. 跟踪参数清理和 canonical URL 去重；
2. 优先选择不同域名；
3. 可读但完全不相关的页面被拒绝；
4. 弱搜索经过改写后找到高置信来源；
5. 查询预算耗尽后正确返回 `empty`；
6. `advanced`、时间范围和域名过滤正确传给 Tavily；
7. 模型只能看到高层受控联网工具；
8. 网页证据可以进入研究来源提取链路。

验证结果：

```text
联网模块测试：13/13 通过
完整后端测试：93/93 通过
前端 TypeScript/Vue 类型检查：通过
```

本机依赖目录曾链接到 Qdrant Client 1.19，而锁文件指定 1.18，导致后端类型检查在既有 `vectorStore.ts` 出现两处版本类型差异；这与本次联网实现无关。锁文件与依赖声明未被本次功能修改。

## 13. 当前边界与后续建议

本次实现已经形成可运行的质量闭环，但仍有以下边界：

- 当前二次评分使用 Tavily score + 本地词项覆盖，没有额外调用 Embedding，避免让联网搜索强依赖 Embedding Provider；
- 没有把复杂问题拆成多个独立 Evidence Need，改写依据是当前整体失败原因；
- 阈值目前由规则与单元测试确定，尚未通过大规模联网评测集校准；
- 当前只实现来源级相关度，没有实现 Claim-Evidence 的逐结论支持校验；
- `fetch_page` 的生产级 SSRF 与流式响应大小限制不属于本次质量闭环范围。

下一步最值得做的是建立 40～60 条冻结联网评测集，记录 Hit@3、Evidence Precision、False Sufficient、Retry Recovery Rate、平均查询数和 P95 延迟，再根据真实数据校准 `quality.ts` 中的权重与阈值。

## 14. 页面手工验收方法

### 启动环境

在项目根目录准备 `backend/.env`，至少配置：

```dotenv
DEEPSEEK_API_KEY=你的_DeepSeek_Key
TAVILY_API_KEY=你的_Tavily_Key
```

然后在 Windows PowerShell 中运行：

```powershell
pnpm.cmd qdrant:up
pnpm.cmd dev
```

访问 `http://localhost:5173`，进入“研究工作台”。

### 工具设置

在研究工作台的工具列表中确认存在“受控联网检索”，对应工具名：

```text
retrieve_web_evidence
```

为了单独观察联网效果，可以只保留“受控联网检索”，临时关闭知识库检索、文档读取和 Word 生成等其他工具。

底层 `web_search` 和 `fetch_page` 不再单独显示，这是预期行为：两者已被收进受控联网检索内部，避免模型绕过质量判断。

页面标签会分别显示“过程总数”和“工具数”。过程包含模型判断、工具调用和模型根据结果继续推理，因此常见的一次联网会显示 3 个过程，但只有 1 个工具调用。

### 查看诊断信息

发起研究后，在右侧时间线中选择 `retrieve_web_evidence` 工具步骤，查看输出：

```text
verdict             最终质量状态
score               最佳网页证据分数
retrievalQueries    实际执行过的查询
queryAttempts       每次查询的深度、结果数、最高分和 URL
pageAttempts        每个页面的相关度、状态和选中 Chunk 数
sources             最终进入引用链的网页来源
diagnostics         查询数、页面数、预算、具体耗尽项、域名数、耗时和停止原因
```

同时打开 Sources 面板，确认高分网页以 URL 形式进入来源列表，并获得 `[S1]`、`[S2]` 引用键。

### 用例一：直接找到高质量官方来源

```text
请联网查询 Tavily Search API 的 advanced search 中 chunks_per_source 的允许取值范围，只根据官方文档回答并给出来源。
```

预期：

- 调用 `retrieve_web_evidence`；
- `queryAttempts` 通常只有 1 次；
- `verdict` 为 `sufficient`；
- Sources 中出现 `docs.tavily.com`；
- `stopReason` 为高置信单来源或多域名证据充分。

### 用例二：验证渐进式查询改写

```text
请联网查清 BrowseComp 官方发布材料中关于可解题目数量与人工验证结果的具体数据；第一次搜索不够时继续针对缺失数据检索，并列出来源。
```

观察重点：

- `retrievalQueries` 是否出现 2～3 个不同查询；
- 后续查询是否比原问题更具体；
- 最后一轮是否可能从 `basic` 升级为 `advanced`；
- 无关页面是否在 `pageAttempts` 中显示为 `irrelevant`；
- 只有通过页面质量判断的内容才进入 `sources`。

联网结果具有实时性，若第一轮已经高置信命中，系统会直接停止，这是正常行为，并不应为了展示循环而强制重搜。

### 用例三：验证无结果和预算停止

```text
请联网查询不存在的产品 ZXQ-9917-EvidentLoop Quantum Search Appliance 的官方发布日期和技术规格；找不到可靠资料时不要猜测。
```

预期：

- 最多执行 3 个查询；
- 不相关页面不会进入 Sources；
- 没有任何可用来源时返回 `empty`；
- 如果存在弱相关资料但预算耗尽，则返回 `exhausted`；
- 最终回答明确说明没有可靠证据，而不是编造产品信息。

### 用例四：验证时效与域名约束

```text
请只查询 docs.tavily.com，核对最近一年 Tavily Search API 的 search_depth 可选值和各模式的定位，引用官方来源。
```

观察 `queryAttempts` 和工具输入中是否包含：

```json
{
  "timeRange": "year",
  "includeDomains": ["docs.tavily.com"]
}
```

### 对比优化效果

建议每个问题记录：

| 项目 | 记录内容 |
| --- | --- |
| 最终 Verdict | sufficient / weak / empty / exhausted |
| 查询次数 | `diagnostics.queriesUsed` |
| 抓取页面数 | `diagnostics.pagesFetched` |
| 独立域名数 | `diagnostics.independentDomains` |
| 是否发生改写 | `retrievalQueries.length > 1` |
| 无关页面是否进入 Sources | 应为否 |
| 引用是否能打开 | Sources 中逐一验证 |
| 最终结论是否被网页支持 | 人工核对原文 |

连续测试 10～20 个固定问题后，将结果保存下来，后续调整阈值时用同一批问题回归，才能客观判断联网搜索是否真正变好。

## 规则型意图识别与查询路由

联网检索入口现在会在质量循环开始前执行本地规则路由。该步骤不调用 LLM，也不产生额外 API 费用，输出保存在工具结果的 `intent` 和 `queryRoute` 字段中。

当前识别的信号包括：

- 明确 URL，以及 URL 是否为 PDF/arXiv；
- 官方 API、SDK 和开发者文档；
- 今天、实时、最新等时效要求；
- 中文表达与中国国内范围（两者独立判断）；
- 动态页面、浏览器渲染、OCR 等抓取提示；
- 核验或交叉验证要求；
- CVE、DOI、法规文号、仓库 URL 等高置信垂直领域标识。

路由不是单标签分类。一个问题可以同时要求 `web_fetch`、`web_search`、`docs_search` 和 `vertical_search`。例如“核验一个 PDF 是否符合最新国内监管要求”会同时产生 URL、PDF、时效、国内、核验和法律领域信号。

当前已经影响实际执行的路由行为：

- 只有明确 URL 的总结/读取请求先直接抓取，不再无条件搜索；
- 明确 URL 且要求核验时，先抓取 URL，再继续进行来源发现；
- 强时效请求没有显式 `timeRange` 时自动使用 `day`，一般“最新/近期”使用 `month`；
- 英文时效词按完整单词识别，避免把 `keep-alive` 中的 `live` 误判为“实时”；
- 官方文档查询会生成面向官方资料的初始查询；
- 五个及以上证据点的复合问题默认扩展为最多 5 次查询、8 个页面；
- 改写查询的结果同时按原始问题和聚焦后的查询评分，避免子主题权威页面因未重复全部要点而被淘汰；
- 返回 Provider 候选、分数、是否配置及选择原因，供后续 Provider 适配器执行。

Provider 候选目前包含 Tavily、智谱、原生抓取、Jina、Firecrawl、Context7 和 Exa。现阶段联网搜索实际适配器仍为 Tavily，普通网页抓取仍为原生抓取；其他候选只是可审计的路由规划，不会在缺少适配器或 Key 时被虚假标记为已经调用。

推荐回归问题：

```text
请用中文解释 React useEffect
查找今天国内人工智能监管政策
总结 https://arxiv.org/pdf/2401.01234.pdf
核验 https://example.com/report 的说法，并找其他来源
查找最新 OpenAI Responses API 官方文档
查询 CVE-2026-12345 的 CVSS 和漏洞影响
```

检查点：中文解释不能被识别为国内检索；PDF URL 应采用 `direct_fetch` 并将 Jina 排在抓取候选前列；URL 核验应采用 `fetch_then_verify`；CVE 编号应高置信启用安全垂直能力。
# 联网评测题库维护（v2）

- 内置 **36 道版本化回归题**，覆盖 Tavily、MDN、GitHub Docs、Node.js 与 OpenAI 官方文档；包含参数枚举、多事实覆盖、时效性、中文查询和不可回答负例。
- 默认只运行 **10 道冒烟题**，用于节省联网预算；“完整回归”固定运行 36 道，适合与历史基线作严格比较。
- 每次运行会把所选题目快照写进运行配置，因此后续升级题库不会改变历史运行的解释。
- 页面支持导出/导入 JSON。导出的是本地扩展题和内置基线版本号；导入只会新增本地题并分配新 ID，不能覆盖或污染固定基线。

## 评测诊断面板（Schema v2）

除 Hit@K、MRR、证据精确率、问题覆盖率和严格通过率外，新报告还记录并展示：首轮命中率、查询改写触发与挽回率、官方来源率、页面提取成功率、预算耗尽率、P95 查询轮数。失败用例会归入“误判充分、预算耗尽、没有可用来源、缺少官方来源、证据点未覆盖、有效来源排名靠后”之一，并可在页面点击原因筛选逐题检查。旧版报告继续兼容，但需要重新运行才能生成这些诊断字段。

## 主体一致的证据验证

- 为 SSE 等容易与相邻技术混淆的问题提取主体词；证据必须在同一 Chunk 中同时包含主体和事实语义，WebSocket 页面不能再单独证明 SSE 的心跳、背压、压缩或负载均衡。
- 收紧背压定义，普通连接数和连接上限不再等价于 backpressure；要求出现 drain、highWaterMark、写缓冲区或生产/消费速率等流控语义。
- 查询改写优先围绕一个未覆盖 Claim 生成聚焦查询，并保留原始主体；根据缺口动态限定 MDN、WHATWG、Nginx、Node.js 等官方域名。
- `sufficient` 除页面分数和 Claim 覆盖外，还要求主体一致率达标且不存在跨主题证据。
- 评测报告新增主体一致率、主体不一致 URL 和“证据主体不一致”失败原因，页面可按该原因筛选具体题目。
