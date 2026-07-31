# 知识库测试资料包

本目录包含 6 篇可独立上传到项目知识库的 Markdown 文档：

- `computer/agent-rag-engineering.md`
- `computer/distributed-systems.md`
- `computer/database-internals.md`
- `finance/corporate-valuation.md`
- `finance/fixed-income-risk.md`
- `finance/portfolio-risk-management.md`

知识库数据保存在 SQLite，而不是直接从本目录读取。请在前端“知识库”页面点击“上传文档”，逐个选择上述文件；上传时开启自动向量化，或上传完成后执行一次知识库同步。

建议测试问题：

1. Durable Agent Runtime 为什么需要 Checkpoint 和幂等键？
2. RRF 与 Rerank 分别解决什么问题？
3. Transactional Outbox 如何解决数据库和消息队列双写问题？
4. MVCC 为什么仍然可能出现业务并发冲突？
5. DCF 中 WACC 和永续增长率为什么会显著影响估值？
6. 久期、凸性和 DV01 之间是什么关系？
7. VaR 为什么不能代表最大损失？
8. 为什么压力时期的分散化效果可能下降？

金融文档仅用于教育和软件测试，不构成投资建议。
