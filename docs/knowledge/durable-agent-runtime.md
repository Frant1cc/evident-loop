# Durable Agent Runtime：状态、恢复与重放

> 领域：Agent 工程。本文聚焦可恢复运行时，不展开 RAG 排序算法。

## 为什么需要 Durable Runtime

长任务可能经历多次模型调用、工具调用和人工审批。进程重启、HTTP 断开或模型超时不应迫使任务从头开始。Durable Agent Runtime 把执行进度持久化，使系统能够识别已经完成的工作并从安全边界继续。

语言模型负责生成候选决策，运行时负责状态转换、权限、预算、幂等和审计。把这些约束只写进 Prompt，无法抵抗进程故障或重复请求。

## Task、Plan 与 Step

Task 表示用户目标和全局约束，包括最大步骤数、Token 预算与允许工具。Plan 是结构化步骤集合。Step 是最小恢复单元，包含 objective、expectedEvidence、dependencies、status、attempts、input、output 和 error。

步骤依赖应由运行时代码检查。模型不能直接把一个依赖尚未完成的步骤标记为可执行。

## Event

Event 是追加写的事实记录，例如 `step_started、tool_completed、review_failed`。事件序号在任务内单调增加，可用于时间线、调试和重放。Event 不应被随意覆盖，因为覆盖会失去故障发生时的原始证据。

事件载荷应避免保存密钥和不必要的敏感数据，并为未来 Schema 升级保留版本策略。

## Checkpoint

Checkpoint 是特定版本的可恢复状态快照。它可以保存 Task、Plan Steps、Review、Evidence Gap 和 Source–Evidence–Claim 证据链。恢复时先加载最新合法 Checkpoint，再通过后续事件或数据库当前状态校验是否存在未完成动作。

Checkpoint 必须在明确的状态边界创建，例如步骤开始、步骤完成、审查保存或任务状态转换。过于频繁会增加写放大，过少则会扩大恢复时需要重新计算的范围。

## 工具幂等

工具调用可以使用 taskId、stepId、attempt、toolName 和规范化参数哈希生成 executionKey。若同一键已有 completed 结果，运行时直接复用；若状态为 failed，可按错误类型决定是否重试；若状态为 running 或 unknown 且工具有副作用，应先确认外部状态。

模型生成的临时 toolCall ID 不稳定，不能作为任务重放的唯一幂等依据。

## 步骤恢复

进程可能在工具成功后、步骤完成前崩溃。恢复时重新进入 running Step，通过 executionKey 复用工具结果，再完成证据链构建。进程也可能在 Step 完成后、Reviewer 审查前崩溃，因此执行循环应优先查找“completed 但没有 Review”的步骤。

恢复逻辑必须覆盖中间窗口，而不仅测试在步骤边界主动暂停。

## Run Replay

Run Replay 用历史输入、事件和工具结果重现 Planner、Reviewer 或 Writer 行为。默认不应重新执行外部副作用。开发者可以选择从某个 Checkpoint 分叉，使用新模型或新 Prompt 运行，并比较计划、Claim、Evidence Gap 和最终报告差异。

Replay 与生产重试不同：Replay 的目标是可解释调试，重试的目标是完成原任务。

## 失败分类

模型返回非法 JSON、工具超时、权限拒绝、数据验证失败和人工取消需要不同处理。临时网络错误可以有限重试；参数错误通常应回到 Planner 或模型修正；权限拒绝需要审批；`terminated` 表示请求或进程被外部终止，应结合阶段事件定位中断点。

## 可观测性

运行时应统计各阶段耗时、Token、工具成功率、重试次数、Checkpoint 数量和恢复成功率。只有最终回答而没有过程记录，无法证明系统具备 Durable 能力。

