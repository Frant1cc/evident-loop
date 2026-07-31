# Agent 与 RAG 工程实践

> 本文面向知识库检索、Agent 工作流与系统设计测试，重点讨论可落地的工程机制。

## 1. Agent 的基本组成

Agent 不是一次普通的大模型调用，而是一个能够围绕目标持续决策、调用工具并记录状态的软件系统。一个可维护的 Agent 通常包含 Planner、Executor、Tool Runtime、Memory、Reviewer 和 Writer。Planner 把目标拆成步骤；Executor 逐步执行；Tool Runtime 负责调用搜索、数据库或外部 API；Reviewer 检查证据是否充分；Writer 根据已确认的证据生成最终结果。

模型负责非确定性的语言理解和决策，运行时负责确定性的状态约束。任务状态、超时、重试次数、权限和审计记录不应只存在于提示词中，而应由代码和持久化存储控制。

## 2. Durable Agent Runtime

Durable Agent Runtime 指可恢复的 Agent 执行环境。系统会持久化 Task、Plan、Step、Event 和 Checkpoint，使进程重启后仍能从最近的安全位置继续执行。Task 表示用户目标，Plan 表示执行方案，Step 表示最小执行单元，Event 记录状态变化，Checkpoint 保存某个时刻的完整运行快照。

恢复时不能简单地把整个任务重新运行。运行时应读取最后一个 Checkpoint，识别已完成步骤、正在执行步骤和失败步骤，再根据幂等策略决定复用、重试或人工确认。对于有副作用的操作，例如发邮件或提交订单，默认不得自动重复。

## 3. Planner、Executor 与 Reviewer

Planner 的输出应采用结构化格式，例如 JSON，而不是自由文本。每个步骤至少包含 objective、expectedEvidence、dependencies 和 completionCriteria。结构化计划可以被校验、持久化和重放，也便于前端展示执行进度。

Executor 一次只处理当前步骤，并受允许工具列表、Token 预算和超时限制。Reviewer 不应仅判断文字是否流畅，而应检查：结论是否有来源、来源是否支持结论、是否遗漏反例、数据是否过期，以及工具返回是否完整。

当 Reviewer 发现证据缺口时，可以生成 Evidence Gap。例如“缺少官方文档对限流策略的说明”或“只有二手来源，没有原始数据”。Evidence Gap 应转化为受控的新检索步骤，而不是让 Agent 无限搜索。

## 4. RAG 检索流水线

典型 RAG 流水线包括文档加载、清洗、切分、Embedding、向量存储、召回、重排和上下文构建。切分策略会直接影响召回质量：Chunk 太大时主题混杂，太小时语义和限定条件容易丢失。

Markdown 文档适合按二级标题切分，同时保留文档标题、章节标题、路径和行号。Embedding 输入可以由“文档标题 + 章节标题 + 正文”组成，这样既保留全局主题，也保留局部语义。

## 5. Hybrid Search、RRF 与 Rerank

Hybrid Search 同时使用关键词检索和向量检索。关键词检索擅长查找错误码、API 名称、产品型号和精确数字；向量检索擅长处理同义表达和自然语言问题。两路结果可用 Reciprocal Rank Fusion（RRF）融合：

```text
RRF(d) = Σ 1 / (k + rank_i(d))
```

其中 `rank_i(d)` 是文档在第 i 路检索中的名次，k 是平滑常数。RRF 主要依赖排名而不是不可比的原始分数，因此实现简单且稳定。

Rerank 会对召回候选进行更精细的相关性判断。常见做法是先召回 20 到 50 个候选，再用 Cross-Encoder 或大模型重排，最后选择少量片段进入上下文。重排提高精度，但会增加延迟和成本。

## 6. Parent-Child Chunk

Parent-Child Chunk 将较小的 Child Chunk 用于检索，将包含完整上下文的 Parent Chunk 用于回答。Child 可以是一段或一个小节，Parent 可以是整个章节。这样既能提高匹配精度，又能避免答案缺失限定条件。

如果多个 Child 指向同一个 Parent，构建上下文时应去重。系统还应限制单个文档占据的上下文比例，避免相似片段挤掉其他来源。

## 7. Source–Evidence–Claim 证据链

可靠回答需要建立 Source–Evidence–Claim 链路。Source 是来源文档及版本；Evidence 是可定位的原文片段；Claim 是回答中的具体主张。一个 Claim 可以由多个 Evidence 支持，一个 Evidence 也可能支持多个 Claim。

系统应保存文档路径、Chunk ID、标题、行号、检索分数和引用关系。Writer 只能使用已进入证据集合的内容生成关键结论。若证据之间冲突，应展示冲突并说明判断依据，不能静默选择其中一条。

## 8. Tool Runtime 与安全控制

Tool Runtime 负责工具注册、参数校验、权限、超时、重试、审批和结果审计。每次调用应记录 taskId、stepId、toolName、arguments、status、startedAt、completedAt、result 或 error。

工具按风险可以分为只读、可逆写入和高风险写入。知识库搜索通常属于只读；创建草稿属于可逆写入；转账、删除数据和对外发布属于高风险操作。高风险工具应要求人工审批，并显示准确参数和潜在影响。

## 9. 幂等、重试与任务重放

幂等意味着同一个逻辑操作执行一次或多次，最终效果一致。可以用 taskId、stepId、attempt 和规范化参数生成 executionKey。若已有成功结果，运行时直接复用；若状态未知且操作有副作用，则进入人工确认。

网络超时、限流和临时服务不可用通常适合指数退避重试；参数错误、权限不足和业务规则拒绝通常不应自动重试。Run Replay 应优先复用历史工具结果，让开发者重现 Planner 和状态机行为，而不是再次访问外部系统。

## 10. Agent 评测指标

Agent 评测应同时覆盖结果质量和运行过程。结果指标包括答案正确性、引用准确率、证据覆盖率和幻觉率；过程指标包括任务完成率、平均步骤数、工具成功率、恢复成功率、重复调用率、延迟和成本。

故障注入可模拟模型返回非法 JSON、向量库超时、工具返回空结果、进程在步骤中断以及 Writer 生成失败。优秀的演示项目不仅展示成功路径，还应展示失败、恢复和审计能力。
