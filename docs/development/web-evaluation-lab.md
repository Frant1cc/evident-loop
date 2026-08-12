# 联网检索评测实验台

## 本次实现

在现有 EvidentLoop 联网质量闭环之上新增了一套可重复运行的网页评测能力：

- 新增版本化固定问题集，当前包含官方 API、多事实点、时效性和不可回答问题。
- 每道题预先定义预期官方域名和应覆盖的证据点，判定从“页面相关”升级为“问题覆盖”。
- 批量运行真实的 `retrieveWebEvidence`，按顺序执行，避免并发放大 Tavily API credits 消耗。
- 保存每次运行的配置、状态、完整报告、耗时和失败原因，并通过 SSE 推送逐题进度。
- 输出 Hit@K、MRR、Evidence Precision、Evidence Recall、Pass Rate 和 False Sufficient。
- 新增“质量评测 → 联网检索评测”页面，支持选择问题、运行评测、查看逐题证据和对比历史基线。
- 原有知识库 RAG 评测保留在同一入口的“知识库 RAG 评测”标签下。

## 第二轮闭环优化

- 评测题的 `expectedEvidence` 会作为 `requiredEvidence` 传入联网检索闭环；当所有证据点都由已抓取页面支持时，直接以 `sufficient` 停止，不再为通用质量阈值继续消耗查询和页面预算。
- 对标记为“不可回答”的评测题，在限定官方域名下连续两次精确检索均未形成可用来源时，直接返回 `empty`；避免错误参数题耗尽完整预算。
- 停止原因会写入每题报告，方便对比“证据已全覆盖而提前停止”和“真实预算耗尽”。

这两项只在评测运行中启用：日常聊天仍保持通用、保守的质量闭环，不会因为某个评测题的人工标签而改变回答策略。

## 指标口径

| 指标 | 含义 |
| --- | --- |
| Hit@K | 前 K 个来源中是否出现来自预期域名、且支持至少一个预期证据点的来源 |
| MRR | 第一条有效证据来源排名的倒数 |
| Evidence Precision | 返回来源中，域名正确并支持预期证据点的来源占比 |
| Evidence Recall | 一道题预先定义的证据点被覆盖的比例 |
| False Sufficient | 系统 verdict 为 `sufficient`，但证据点未覆盖完整，或不可回答问题被判为充分 |
| Pass Rate | 可回答问题同时满足命中、完整覆盖且无误判；不可回答问题没有被判为充分 |

## 页面测试方法

1. 启动 Qdrant、后端和前端：`pnpm qdrant:up`、`pnpm dev`。
2. 打开页面顶部的“质量评测”，进入“联网检索评测”。
3. 第一次保持全选，点击“运行 5 道题”，生成基线。
4. 运行完成后查看总指标，并逐题检查问题覆盖、查询轨迹、停止原因与来源。
5. 修改检索策略后，用同一问题集再次运行。
6. 在“与历史运行对比”中选择第一次基线，重点观察 Evidence Recall 是否上升、False Sufficient 是否保持为 0。

评测调用真实联网搜索，因此结果会消耗实际 API credits。建议先选 1 至 2 道题做快速验证，确认配置后再运行完整问题集。

## 主要代码位置

- 后端问题集：`backend/src/web/eval/fixtures.ts`
- 指标与判定：`backend/src/web/eval/run.ts`
- 运行服务：`backend/src/web/eval/service.ts`
- 记录持久化：`backend/src/web/eval/store.ts`
- HTTP / SSE 接口：`backend/src/routes/evaluations.ts`
- 前端页面：`frontend/src/views/WebEvaluationView.vue`
- 评测总入口：`frontend/src/views/EvaluationHubView.vue`
- 判定单测：`backend/src/web/eval/run.test.ts`

## 后续扩展

固定问题集是代码中的版本化 fixture，便于评测口径随代码一起评审。下一步可增加 JSON/CSV 导入、按类别统计、人工标注来源，以及 CI 中使用 mock 快照做低成本回归；真实联网全集仍建议人工触发，避免 CI 消耗搜索额度。
