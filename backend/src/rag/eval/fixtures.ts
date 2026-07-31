export type RagEvalCase = {
  id: string;
  query: string;
  expectedFiles: string[];
  category?: 'exact' | 'semantic' | 'distractor' | 'multi_document' | 'unanswerable';
  /** 目标章节标题（与文档 `## ` 标题逐字一致），用于章节级（chunk 级）相关性判定 */
  expectedHeadings?: string[];
  /** 人类可读的答案要点，用于人工复核与未来回答层评测，不参与自动判定 */
  expectedEvidence?: string[];
  /** 文档原文的逐字子串，用于证据级相关性判定，由 rag:eval:validate 校验 */
  expectedAnchors?: string[];
  /** 知识库是否可回答该问题。false 时 expectedFiles 必须为空，仅统计检索分数分布 */
  answerable?: boolean;
};

export const ragEvalConfig = {
  k: 3,
  thresholds: {
    recallAtK: 0.9,
    mrrAtK: 0.8,
    minRejectionRecall: 0.7,
    maxFalseRejections: 3
  }
} as const;

export const ragEvalCases: RagEvalCase[] = [
  {
    id: 'mvcc-snapshot-cleanup',
    query: '为什么一个长时间不提交的只读事务也会阻止旧版本清理？',
    expectedFiles: ['mvcc-foundations.md'],
    category: 'semantic',
    expectedHeadings: ['长事务与版本清理'],
    expectedEvidence: ['旧快照仍可能访问历史版本时，数据库不能安全回收这些版本'],
    expectedAnchors: ['只要旧快照仍可能读取某个版本，数据库就不能安全回收它']
  },
  {
    id: 'mvcc-read-write-locks',
    query: '使用 MVCC 后，普通快照读取为什么通常不需要等待写事务？',
    expectedFiles: ['mvcc-foundations.md'],
    category: 'exact',
    expectedHeadings: ['MVCC 解决的问题', 'MVCC 与锁'],
    expectedEvidence: ['读取者根据快照选择可见版本，而不是读取写事务尚未提交的新版本'],
    expectedAnchors: ['读事务根据自己的快照选择可见版本', 'MVCC 减少普通快照读与写之间的阻塞']
  },
  {
    id: 'mvcc-read-committed-snapshot',
    query: 'Read Committed 和 Repeatable Read 在获取事务快照的时机上有什么典型差异？',
    expectedFiles: ['mvcc-foundations.md'],
    category: 'distractor',
    expectedHeadings: ['事务快照'],
    expectedEvidence: ['Read Committed 常按语句获取快照，Repeatable Read 往往复用事务级快照'],
    expectedAnchors: ['Read Committed 通常在每条语句开始时获得新快照']
  },
  {
    id: 'mvcc-inventory-conditional-update',
    query: '库存为 1 时两个请求都读到可售，应该如何用一条 SQL 避免超卖？',
    expectedFiles: ['mvcc-business-conflicts.md'],
    category: 'semantic',
    expectedHeadings: ['条件更新与库存扣减'],
    expectedEvidence: ['把库存检查与扣减合并为带 available >= quantity 条件的原子更新，并检查受影响行数'],
    expectedAnchors: ['available >= :quantity']
  },
  {
    id: 'mvcc-write-skew-doctors',
    query: '两个值班人员修改不同记录，为什么仍可能违反至少一人在线的约束？',
    expectedFiles: ['mvcc-business-conflicts.md'],
    category: 'distractor',
    expectedHeadings: ['写偏差'],
    expectedEvidence: ['事务基于相同旧快照分别修改不同记录，行级写冲突未必阻止写偏差'],
    expectedAnchors: ['两次写入没有修改同一行']
  },
  {
    id: 'mvcc-retry-redecision',
    query: '版本冲突或序列化失败后，为什么不能只重复最后一次 UPDATE？',
    expectedFiles: ['mvcc-business-conflicts.md', 'optimistic-locking-idempotency.md'],
    category: 'multi_document',
    expectedHeadings: ['重试必须重新决策', '乐观冲突后的重试'],
    expectedEvidence: ['必须重新读取最新状态并重新验证业务规则，旧快照上的决策可能已经失效'],
    expectedAnchors: ['应重新读取最新状态并重新执行完整业务判断', '重新读取最新数据并重新验证业务规则']
  },
  {
    id: 'optimistic-lock-versus-idempotency',
    query: '版本号乐观锁和接口幂等键分别解决什么问题，为什么不能互相替代？',
    expectedFiles: ['optimistic-locking-idempotency.md'],
    category: 'distractor',
    expectedHeadings: ['乐观锁的目标', '幂等键的目标'],
    expectedEvidence: ['乐观锁检测旧状态写入冲突，幂等键识别重复的逻辑操作'],
    expectedAnchors: ['我基于旧状态计算的更新是否仍然有效', '幂等键用于识别逻辑操作']
  },
  {
    id: 'idempotency-timeout-unknown',
    query: '支付请求超时后为什么不应该立刻换一个新请求标识再次扣款？',
    expectedFiles: ['optimistic-locking-idempotency.md'],
    category: 'semantic',
    expectedHeadings: ['超时后的未知结果'],
    expectedEvidence: ['超时不代表服务端未执行，应使用相同幂等键查询或核对原操作'],
    expectedAnchors: ['调用方超时只说明没有及时收到响应，不代表服务端没有执行']
  },
  {
    id: 'agent-execution-key',
    query: 'Agent 任务重放时，稳定的工具 executionKey 应由哪些信息生成？',
    expectedFiles: ['optimistic-locking-idempotency.md', 'durable-agent-runtime.md'],
    category: 'multi_document',
    expectedHeadings: ['Agent 工具执行中的应用', '工具幂等'],
    expectedEvidence: ['组合 taskId、stepId、attempt、toolName 与规范化参数哈希'],
    expectedAnchors: ['taskId、stepId、attempt、toolName']
  },
  {
    id: 'outbox-duplicate-publish',
    query: 'Outbox 发布器已经把事件发到消息队列，为什么恢复后仍可能再次发送？',
    expectedFiles: ['distributed-transactions-outbox.md'],
    category: 'semantic',
    expectedHeadings: ['发布器为何仍可能重复发送'],
    expectedEvidence: ['发送成功后可能在标记已发布前崩溃，因此恢复后会重复发送'],
    expectedAnchors: ['在标记 outbox 已发布前崩溃']
  },
  {
    id: 'outbox-double-write-window',
    query: '同时更新数据库并发布消息时，简单调整两个操作的先后顺序为什么不能保证一致？',
    expectedFiles: ['distributed-transactions-outbox.md'],
    category: 'exact',
    expectedHeadings: ['双写问题', 'Transactional Outbox'],
    expectedEvidence: ['任一顺序都存在一个资源成功而另一个失败的不一致窗口'],
    expectedAnchors: ['简单交换顺序不能消除问题']
  },
  {
    id: 'saga-compensation-not-rollback',
    query: 'Saga 的补偿操作为什么不能被理解成数据库事务回滚？',
    expectedFiles: ['distributed-transactions-outbox.md'],
    category: 'distractor',
    expectedHeadings: ['Saga'],
    expectedEvidence: ['补偿是新的业务操作，可能失败、收费或无法完全恢复原状态'],
    expectedAnchors: ['补偿不是数据库回滚']
  },
  {
    id: 'kafka-idempotent-producer-boundary',
    query: 'Kafka 开启 enable.idempotence 后，为什么消费者写外部数据库仍需要业务去重？',
    expectedFiles: ['kafka-delivery-semantics.md'],
    category: 'distractor',
    expectedHeadings: ['幂等生产者'],
    expectedEvidence: ['幂等生产者只保护生产者到 Kafka 分区的写入，不覆盖外部数据库副作用'],
    expectedAnchors: ['enable.idempotence']
  },
  {
    id: 'kafka-offset-commit-order',
    query: '消费者先提交 offset 和先写业务数据库分别有什么失败风险？',
    expectedFiles: ['kafka-delivery-semantics.md'],
    category: 'exact',
    expectedHeadings: ['Offset 提交时机'],
    expectedEvidence: ['先提交可能丢业务处理，先写库可能在位点提交失败后重复处理'],
    expectedAnchors: ['若先提交 offset 再写数据库，写库失败后消息可能被跳过']
  },
  {
    id: 'kafka-partition-ordering',
    query: '怎样保证同一订单的 Kafka 事件有序，为什么这不等于 Topic 全局有序？',
    expectedFiles: ['kafka-delivery-semantics.md'],
    category: 'semantic',
    expectedHeadings: ['Consumer Group 与分区'],
    expectedEvidence: ['使用订单 ID 作为分区键只能保证对应分区内顺序，不同分区没有全局顺序'],
    expectedAnchors: ['应使用稳定订单 ID 作为分区键']
  },
  {
    id: 'cache-aside-delete-after-write',
    query: 'Cache-Aside 写入时为什么常选择更新数据库后删除缓存，而不是同时覆盖缓存值？',
    expectedFiles: ['cache-consistency-patterns.md'],
    category: 'semantic',
    expectedHeadings: ['写后删除缓存'],
    expectedEvidence: ['并发写可能以不同顺序更新缓存导致旧值覆盖新值，删除后可从数据库重建'],
    expectedAnchors: ['使旧值覆盖新值']
  },
  {
    id: 'cache-penetration-breakdown-avalanche',
    query: '缓存穿透、单个热点键击穿和大量键雪崩三者分别是什么？',
    expectedFiles: ['cache-consistency-patterns.md'],
    category: 'exact',
    expectedHeadings: ['缓存穿透', '缓存击穿', '缓存雪崩'],
    expectedEvidence: ['穿透针对不存在数据，击穿针对热键失效，雪崩针对大量键或集群同时失效'],
    expectedAnchors: ['请求持续查询本来就不存在的数据', '键过期时大量请求同时访问数据库', '大量键在相近时间失效']
  },
  {
    id: 'cache-delayed-double-delete-limit',
    query: '延迟双删为什么只能降低旧值回填概率，不能提供严格一致性？',
    expectedFiles: ['cache-consistency-patterns.md'],
    category: 'distractor',
    expectedHeadings: ['延迟双删'],
    expectedEvidence: ['等待时间难以确定且进程可能跳过第二次删除'],
    expectedAnchors: ['它是概率性工程技巧，不是严格一致性协议']
  },
  {
    id: 'runtime-event-versus-checkpoint',
    query: 'Durable Agent Runtime 中 Event 和 Checkpoint 的职责有什么区别？',
    expectedFiles: ['durable-agent-runtime.md'],
    category: 'exact',
    expectedHeadings: ['Event', 'Checkpoint'],
    expectedEvidence: ['Event 是追加写事实时间线，Checkpoint 是特定版本的可恢复状态快照'],
    expectedAnchors: ['Event 是追加写的事实记录', 'Checkpoint 是特定版本的可恢复状态快照']
  },
  {
    id: 'runtime-crash-after-tool',
    query: '工具已成功但 Step 尚未完成时进程崩溃，恢复流程应该怎么处理？',
    expectedFiles: ['durable-agent-runtime.md'],
    category: 'semantic',
    expectedHeadings: ['步骤恢复'],
    expectedEvidence: ['重新进入运行中步骤，通过 executionKey 复用工具结果，再完成证据链和步骤'],
    expectedAnchors: ['通过 executionKey 复用工具结果']
  },
  {
    id: 'runtime-terminated-diagnosis',
    query: 'Agent 任务失败原因为 terminated 时，应该如何理解并定位中断阶段？',
    expectedFiles: ['durable-agent-runtime.md'],
    category: 'distractor',
    expectedHeadings: ['失败分类'],
    expectedEvidence: ['terminated 表示请求或进程被外部终止，需要结合阶段事件定位'],
    expectedAnchors: ['表示请求或进程被外部终止']
  },
  {
    id: 'rag-rrf-score-fusion',
    query: '为什么融合 BM25 和向量召回时，RRF 通常比直接相加两种原始分数更稳健？',
    expectedFiles: ['rag-retrieval-pipeline.md'],
    category: 'exact',
    expectedHeadings: ['Hybrid Search', 'Reciprocal Rank Fusion'],
    expectedEvidence: ['两路分数尺度不可比，RRF 使用名次而不依赖原始分数校准'],
    expectedAnchors: ['因为 BM25 分数和余弦相似度的尺度不可直接比较', 'RRF 不依赖原始分数校准']
  },
  {
    id: 'rag-parent-child-purpose',
    query: 'Parent–Child Chunk 如何同时兼顾小片段精确匹配和完整上下文？',
    expectedFiles: ['rag-retrieval-pipeline.md'],
    category: 'semantic',
    expectedHeadings: ['Parent–Child Chunk'],
    expectedEvidence: ['Child 用于检索，命中后返回受限大小的 Parent 上下文'],
    expectedAnchors: ['Child Chunk 较小，用于精确检索']
  },
  {
    id: 'rag-evidence-ranking-metadata',
    query: '为了让证据链解释检索结果，Evidence 应记录哪些 Hybrid Search 和 Rerank 字段？',
    expectedFiles: ['rag-retrieval-pipeline.md'],
    category: 'distractor',
    expectedHeadings: ['证据元数据'],
    expectedEvidence: ['保存关键词和语义排名、RRF 与 Rerank 分数、Chunk 和 Parent 定位信息'],
    expectedAnchors: ['keywordRank、semanticRank、rrfScore、rerankScore']
  },
  {
    id: 'bond-duration-versus-dv01',
    query: '修正久期和 DV01 分别表示百分比敏感度还是金额敏感度？',
    expectedFiles: ['bond-duration-convexity.md'],
    category: 'exact',
    expectedHeadings: ['Modified Duration', 'DV01'],
    expectedEvidence: ['修正久期是价格百分比敏感度，DV01 是一个基点变化对应的金额变化'],
    expectedAnchors: ['久期是百分比敏感度，DV01 是金额敏感度']
  },
  {
    id: 'bond-convexity-large-move',
    query: '收益率变化较大时，为什么只用久期估算债券价格不够？',
    expectedFiles: ['bond-duration-convexity.md'],
    category: 'semantic',
    expectedHeadings: ['凸性'],
    expectedEvidence: ['价格与收益率关系弯曲，需要凸性描述二阶效应'],
    expectedAnchors: ['收益率变化较大时，加入凸性通常比仅使用久期更准确']
  },
  {
    id: 'bond-callable-negative-convexity',
    query: '可赎回债券为什么在利率下降区间可能出现负凸性？',
    expectedFiles: ['bond-duration-convexity.md'],
    category: 'distractor',
    expectedHeadings: ['含权债券'],
    expectedEvidence: ['利率下降时发行人更可能赎回，限制债券价格上涨空间'],
    expectedAnchors: ['某些区间会表现为负凸性']
  },
  {
    id: 'yield-curve-same-duration-different-risk',
    query: '两个组合总久期相同，为什么面对收益率曲线扭转仍可能产生不同损益？',
    expectedFiles: ['yield-curve-key-rate-risk.md'],
    category: 'distractor',
    expectedHeadings: ['平行移动的局限', 'Key Rate Duration'],
    expectedEvidence: ['组合可能集中在不同期限节点，总久期无法反映关键期限暴露'],
    expectedAnchors: ['可能分别集中在 2 年和 10 年节点', 'KRD 能揭示表面总久期匹配下的期限错配']
  },
  {
    id: 'yield-curve-steepening-ambiguity',
    query: '只说收益率曲线变陡，为什么还不能判断债券组合一定盈利或亏损？',
    expectedFiles: ['yield-curve-key-rate-risk.md'],
    category: 'semantic',
    expectedHeadings: ['陡峭化与扁平化'],
    expectedEvidence: ['需要区分长短端变化方向以及熊市或牛市陡峭化'],
    expectedAnchors: ['仅说“曲线变陡”不足以确定债券组合损益']
  },
  {
    id: 'yield-key-rate-duration',
    query: 'Key Rate Duration 相比单一总 DV01 多揭示了什么风险？',
    expectedFiles: ['yield-curve-key-rate-risk.md'],
    category: 'exact',
    expectedHeadings: ['Key Rate Duration'],
    expectedEvidence: ['它分解不同期限节点的敏感度，揭示期限错配和曲线形状风险'],
    expectedAnchors: ['关键期限久期（KRD）衡量某个曲线节点发生小幅变化']
  },
  {
    id: 'dcf-terminal-growth-constraint',
    query: '永续增长终值模型中为什么要求长期增长率 g 小于 WACC？',
    expectedFiles: ['dcf-valuation-sensitivity.md'],
    category: 'exact',
    expectedHeadings: ['永续增长终值'],
    expectedEvidence: ['WACC 与 g 的差值是终值分母，差值过小或非正会使估值失去经济合理性'],
    expectedAnchors: ['必须小于 WACC']
  },
  {
    id: 'dcf-cashflow-discount-rate-match',
    query: '为什么 FCFF 应与 WACC 匹配，而 FCFE 应使用股权资本成本？',
    expectedFiles: ['dcf-valuation-sensitivity.md'],
    category: 'distractor',
    expectedHeadings: ['DCF 的基本结构'],
    expectedEvidence: ['现金流归属的资本提供者范围必须与折现率口径一致'],
    expectedAnchors: ['现金流口径与折现率口径不匹配会产生系统性错误']
  },
  {
    id: 'dcf-sensitivity-matrix',
    query: 'DCF 为什么不应只给单点估值，WACC 与永续增长率矩阵能暴露什么？',
    expectedFiles: ['dcf-valuation-sensitivity.md'],
    category: 'semantic',
    expectedHeadings: ['敏感性矩阵'],
    expectedEvidence: ['矩阵展示关键假设的非线性影响，并暴露 WACC 减 g 过小时的不稳定'],
    expectedAnchors: ['过小造成的不稳定']
  },
  {
    id: 'portfolio-var-not-maximum-loss',
    query: '一日 99% VaR 为 100 万为什么不代表最大损失只有 100 万？',
    expectedFiles: ['portfolio-tail-risk.md'],
    category: 'exact',
    expectedHeadings: ['Value at Risk'],
    expectedEvidence: ['VaR 是损失分位数，仍有约 1% 的交易日损失超过该阈值'],
    expectedAnchors: ['不代表最大损失只有 100 万元']
  },
  {
    id: 'portfolio-expected-shortfall',
    query: 'Expected Shortfall 相比 VaR 额外描述了哪部分尾部风险？',
    expectedFiles: ['portfolio-tail-risk.md'],
    category: 'semantic',
    expectedHeadings: ['Expected Shortfall'],
    expectedEvidence: ['ES 衡量进入 VaR 尾部以后损失的条件平均严重程度'],
    expectedAnchors: ['进入 VaR 尾部后损失的条件平均值']
  },
  {
    id: 'portfolio-reverse-stress-test',
    query: '反向压力测试为什么从资本或保证金不可接受的结果倒推风险因子组合？',
    expectedFiles: ['portfolio-tail-risk.md'],
    category: 'distractor',
    expectedHeadings: ['反向压力测试'],
    expectedEvidence: ['它用于寻找会让当前策略或风险承受能力失效的潜在路径'],
    expectedAnchors: ['从不可接受结果出发']
  },
  {
    id: 'hb-fisher-relation',
    query: '通胀挂钩债券定价中，名义收益率、实际收益率与通胀预期之间的费雪关系是什么形式？',
    expectedFiles: ['inflation-linked-bonds.md'],
    category: 'exact',
    expectedHeadings: ['费雪关系'],
    expectedEvidence: ['(1 + 名义) = (1 + 实际) × (1 + 通胀预期)，低通胀时可用加法近似'],
    expectedAnchors: ['(1 + 名义) = (1 + 实际) × (1 + 通胀预期)']
  },
  {
    id: 'hb-pmi-threshold',
    query: 'PMI 采购经理人指数的荣枯线是多少，高于该值代表什么？',
    expectedFiles: ['financial-markets-handbook.md'],
    category: 'exact',
    expectedHeadings: ['2. 宏观经济指标与资产价格'],
    expectedEvidence: ['PMI 以 50 为荣枯线，高于 50 代表扩张倾向'],
    expectedAnchors: ['PMI 通常以 50 为荣枯线']
  },
  {
    id: 'hb-contango-backwardation',
    query: '期货升水 contango 和现货升水 backwardation 分别指什么，对商品基金展期收益有什么影响？',
    expectedFiles: ['financial-markets-handbook.md'],
    category: 'exact',
    expectedHeadings: ['8. 商品与通胀敏感资产'],
    expectedEvidence: ['远月高于近月为期货升水，滚动可能产生展期损失；近月高于远月为现货升水'],
    expectedAnchors: ['期货升水（contango）']
  },
  {
    id: 'hb-option-greeks-theta-vega',
    query: '期权希腊字母中 Theta 和 Vega 分别衡量什么敏感度？',
    expectedFiles: ['options-greeks-hedging.md'],
    category: 'exact',
    expectedHeadings: ['Theta 与 Gamma 的对偶', 'Vega 与波动率敞口'],
    expectedEvidence: ['Theta 衡量时间价值衰减速度，Vega 衡量隐含波动率变动一个百分点的价值变化'],
    expectedAnchors: ['期权价值随时间流逝的衰减速度', 'Vega 衡量隐含波动率变动一个百分点时的期权价值变化']
  },
  {
    id: 'hb-fx-risk-types',
    query: '企业面临的交易风险、折算风险和经济风险这三种外汇风险有什么区别？',
    expectedFiles: ['financial-markets-handbook.md'],
    category: 'semantic',
    expectedHeadings: ['7. 外汇与国际收支'],
    expectedEvidence: ['交易风险影响外币应收应付，折算风险影响报表换算，经济风险影响长期竞争力'],
    expectedAnchors: ['未来以外币计价的应收、应付款价值发生变化']
  },
  {
    id: 'hb-sharpe-drawdown',
    query: '夏普比率衡量什么？为什么它对尾部风险明显的策略可能不够用？',
    expectedFiles: ['financial-markets-handbook.md'],
    category: 'semantic',
    expectedHeadings: ['6. 基金、指数与资产配置'],
    expectedEvidence: ['夏普比率衡量单位波动的超额回报，对尾部风险和非线性收益策略不充分'],
    expectedAnchors: ['夏普比率衡量单位总波动承担的超额回报']
  },
  {
    id: 'hb-rate-cut-stock-drop',
    query: '为什么央行宣布降息之后股票市场反而可能下跌？',
    expectedFiles: ['financial-markets-handbook.md'],
    category: 'distractor',
    expectedHeadings: ['3. 利率、收益率曲线与货币政策'],
    expectedEvidence: ['市场关注政策相对预期的偏离，若预期更大幅度宽松，降息后风险资产仍可能下跌'],
    expectedAnchors: ['若市场原本预期更大幅度降息，风险资产也可能下跌']
  },
  {
    id: 'hb-pe-cyclical-trap',
    query: '周期性行业公司在盈利高点市盈率很低，为什么不一定便宜？',
    expectedFiles: ['relative-valuation-multiples.md'],
    category: 'distractor',
    expectedHeadings: ['P/E 的适用与失效'],
    expectedEvidence: ['周期顶部盈利膨胀使 P/E 显得低，利润回落后读数失真'],
    expectedAnchors: ['周期顶部盈利膨胀时 P/E 显得很低']
  },
  {
    id: 'md-var-two-docs',
    query: '单日 99% VaR 的正确解释是什么？它为什么不能描述阈值之外的尾部损失？',
    expectedFiles: ['portfolio-tail-risk.md', 'financial-markets-handbook.md'],
    category: 'multi_document',
    expectedHeadings: ['Value at Risk', '10. 风险管理'],
    expectedEvidence: ['VaR 是给定置信水平下的损失分位数，无法描述超过阈值后的尾部损失'],
    expectedAnchors: ['VaR 表示给定持有期和置信水平下的损失分位数', '也无法充分描述阈值之外的尾部损失']
  },
  {
    id: 'md-duration-two-docs',
    query: '修正久期如何近似债券价格对收益率变动的敏感度？期限和票息又如何影响久期？',
    expectedFiles: ['bond-duration-convexity.md', 'financial-markets-handbook.md'],
    category: 'multi_document',
    expectedHeadings: ['Modified Duration', '5. 债券与固定收益'],
    expectedEvidence: ['价格变化约等于负修正久期乘以收益率变化；期限更长、票息更低久期更高'],
    expectedAnchors: ['ΔP / P ≈ −Dmod × Δy', '期限更长、票息更低的债券通常久期更高']
  },
  {
    id: 'md-inbox-dedup',
    query: '消费者如何用 Inbox 表和唯一约束把重复投递的消息变成可识别的正常情况？',
    expectedFiles: ['idempotent-consumer-patterns.md'],
    category: 'distractor',
    expectedHeadings: ['去重表结构'],
    expectedEvidence: ['消息标识上的唯一索引让重复插入触发约束冲突，成为可识别的正常控制流'],
    expectedAnchors: ['让重复插入直接触发约束冲突']
  },
  {
    id: 'md-unique-constraint-idempotency',
    query: '为什么先查询“是否处理过”再插入幂等记录仍然有竞争？正确的原子做法是什么？',
    expectedFiles: ['mvcc-business-conflicts.md', 'optimistic-locking-idempotency.md'],
    category: 'multi_document',
    expectedHeadings: ['唯一约束与幂等记录', '原子占位'],
    expectedEvidence: ['先查再插会重新引入竞争窗口，应在事务内先插入唯一约束占位记录'],
    expectedAnchors: ['会重新引入检查与写入之间的竞争窗口', '先插入具有唯一约束的处理中记录']
  },
  {
    id: 'md-stress-correlation',
    query: '为什么危机时期资产之间相关性上升，会让历史数据显示的分散化效果失效？',
    expectedFiles: ['portfolio-tail-risk.md', 'financial-markets-handbook.md'],
    category: 'multi_document',
    expectedHeadings: ['相关性在压力期变化', '6. 基金、指数与资产配置'],
    expectedEvidence: ['压力期相关性同时上升，传统分散化收益减弱'],
    expectedAnchors: ['传统分散化收益减弱', '两种资产在危机期间的相关性可能上升']
  },
  {
    id: 'rag-rrf-constant',
    query: 'RRF 的融合公式是什么？平滑常数 k 通常取多少？',
    expectedFiles: ['rag-retrieval-pipeline.md'],
    category: 'exact',
    expectedHeadings: ['Reciprocal Rank Fusion'],
    expectedEvidence: ['RRF(d) = Σ 1 / (k + rank_i(d))，k 常取 60'],
    expectedAnchors: ['RRF(d) = Σ 1 / (k + rank_i(d))', '平滑常数 k 常取 60']
  },
  {
    id: 'rag-rerank-cost',
    query: '为什么 Cross-Encoder 重排更准确，却只用来处理召回后的几十个候选？',
    expectedFiles: ['rag-retrieval-pipeline.md'],
    category: 'semantic',
    expectedHeadings: ['Rerank'],
    expectedEvidence: ['Cross-Encoder 更准确但计算成本高，只处理少量召回候选'],
    expectedAnchors: ['但计算成本更高']
  },
  {
    id: 'kafka-rebalance-duplicates',
    query: 'Rebalance 期间为什么同一批消息可能被两个消费者先后处理？',
    expectedFiles: ['kafka-delivery-semantics.md'],
    category: 'semantic',
    expectedHeadings: ['Rebalance'],
    expectedEvidence: ['分区转移时旧消费者尚未停止，新消费者可能重新获取同一批消息'],
    expectedAnchors: ['在旧消费者尚未完全停止时被新消费者重新获取']
  },
  {
    id: 'kafka-dlq-not-trash',
    query: '死信队列里的消息应该保留哪些信息，为什么它不是垃圾桶？',
    expectedFiles: ['kafka-delivery-semantics.md'],
    category: 'distractor',
    expectedHeadings: ['失败、重试与死信队列'],
    expectedEvidence: ['应保留原 topic、partition、offset、eventId、错误类型，并支持修复重驱动'],
    expectedAnchors: ['死信队列不是垃圾桶']
  },
  {
    id: 'outbox-aggregate-version',
    query: '事件里的 aggregateId 和单调递增的 aggregateVersion 分别用来解决什么问题？',
    expectedFiles: ['distributed-transactions-outbox.md'],
    category: 'exact',
    expectedHeadings: ['顺序与分区键'],
    expectedEvidence: ['aggregateId 作为分区键保证聚合内顺序，版本号用于检测跳跃'],
    expectedAnchors: ['消息代理使用 aggregateId 作为分区键']
  },
  {
    id: 'cache-bloom-filter',
    query: '布隆过滤器为什么可以过滤不存在的键？它会产生假阳性还是假阴性？',
    expectedFiles: ['cache-consistency-patterns.md'],
    category: 'exact',
    expectedHeadings: ['缓存穿透'],
    expectedEvidence: ['布隆过滤器可能假阳性但不会假阴性，可过滤明确不存在的键'],
    expectedAnchors: ['布隆过滤器可能产生假阳性，但不会产生假阴性']
  },
  {
    id: 'runtime-replay-vs-retry',
    query: 'Run Replay 和生产环境的任务重试有什么本质区别？',
    expectedFiles: ['durable-agent-runtime.md'],
    category: 'distractor',
    expectedHeadings: ['Run Replay'],
    expectedEvidence: ['Replay 目标是可解释调试且默认不重放副作用，重试目标是完成原任务'],
    expectedAnchors: ['Replay 的目标是可解释调试，重试的目标是完成原任务']
  },
  {
    id: 'runtime-checkpoint-frequency',
    query: 'Checkpoint 创建得过于频繁或过少分别有什么代价？',
    expectedFiles: ['durable-agent-runtime.md'],
    category: 'semantic',
    expectedHeadings: ['Checkpoint'],
    expectedEvidence: ['过频繁增加写放大，过少扩大恢复时需要重新计算的范围'],
    expectedAnchors: ['过于频繁会增加写放大']
  },
  {
    id: 'dcf-fcff-formula',
    query: 'FCFF 企业自由现金流的近似计算公式是什么？',
    expectedFiles: ['dcf-valuation-sensitivity.md'],
    category: 'exact',
    expectedHeadings: ['FCFF'],
    expectedEvidence: ['FCFF = EBIT × (1−税率) + 折旧摊销 − 资本开支 − 营运资本增加'],
    expectedAnchors: ['FCFF = EBIT × (1−税率) + 折旧摊销 − 资本开支 − 经营性营运资本增加']
  },
  {
    id: 'mvcc-lost-update',
    query: '什么是丢失更新？如何用原子表达式或版本号条件避免？',
    expectedFiles: ['mvcc-business-conflicts.md'],
    category: 'exact',
    expectedHeadings: ['丢失更新'],
    expectedEvidence: ['先读后无条件覆盖会丢失并发更新，应使用原子表达式或版本条件'],
    expectedAnchors: ['balance = balance + delta']
  },
  {
    id: 'yield-spot-forward-ytm',
    query: '即期利率、远期利率和到期收益率三者有什么区别？',
    expectedFiles: ['yield-curve-key-rate-risk.md'],
    category: 'distractor',
    expectedHeadings: ['收益率曲线'],
    expectedEvidence: ['即期折现单笔现金流，远期是隐含利率，YTM 是内部收益率，三者不能混用'],
    expectedAnchors: ['三者不能混用']
  },
  {
    id: 'un-react-state',
    query: 'React 项目中应该选择 Redux 还是 Pinia 做状态管理？',
    expectedFiles: [],
    category: 'unanswerable',
    answerable: false
  },
  {
    id: 'un-k8s-hpa',
    query: 'Kubernetes 的 HPA 水平自动扩缩容是根据什么指标触发的？',
    expectedFiles: [],
    category: 'unanswerable',
    answerable: false
  },
  {
    id: 'un-oauth-refresh',
    query: 'OAuth2 的 refresh token 过期后应该如何处理？',
    expectedFiles: [],
    category: 'unanswerable',
    answerable: false
  },
  {
    id: 'un-http3-quic',
    query: 'HTTP/3 为什么改用基于 UDP 的 QUIC 协议？',
    expectedFiles: [],
    category: 'unanswerable',
    answerable: false
  },
  {
    id: 'un-fed-meeting-2026',
    query: '美联储在 2026 年 7 月的议息会议上做出了什么利率决定？',
    expectedFiles: [],
    category: 'unanswerable',
    answerable: false
  },
  {
    id: 'un-mysql-replication-lag',
    query: 'MySQL 主从复制延迟过高应该如何排查和优化？',
    expectedFiles: [],
    category: 'unanswerable',
    answerable: false
  },
  // ==== 语料扩充第二批：新增 21 篇文档的基础题与改述型难题 ====
  {
    id: 'redis-expire-memory-not-freed',
    query: '键上设的存活时间明明已经到点了，为什么内存占用没有马上掉下来？',
    expectedFiles: ['redis-cache-invalidation.md'],
    category: 'semantic',
    expectedHeadings: ['惰性删除与定期删除'],
    expectedEvidence: ['键过期后不会立即释放内存，删除由访问触发的惰性删除与后台抽样的定期删除共同完成'],
    expectedAnchors: ['认为键一到期内存就立刻释放是不准确的']
  },
  {
    id: 'redis-eviction-policy-degrade',
    query: '内存满了想让服务自己挑键腾地方，可挑选范围被限定在设过存活时间的那一批，结果会怎样？',
    expectedFiles: ['redis-cache-invalidation.md'],
    category: 'semantic',
    expectedHeadings: ['maxmemory 与淘汰策略'],
    expectedEvidence: ['volatile 系列只在设置过 TTL 的键中挑选，若没有这类键则退化为拒绝写入'],
    expectedAnchors: ['选用 volatile 系列时，若没有任何键设置过过期时间']
  },
  {
    id: 'write-behind-data-loss-window',
    query: '写请求先记在内存里、过一会儿再批量落库，这种做法什么时候会真的丢数据？',
    expectedFiles: ['read-through-write-behind.md'],
    category: 'semantic',
    expectedHeadings: ['队列积压与丢数据窗口'],
    expectedEvidence: ['异步回写存在未刷盘窗口，进程崩溃会丢失队列中尚未落库的写入，不能用于资金类写路径'],
    expectedAnchors: ['不允许丢失的写路径上，是最典型的误用']
  },
  {
    id: 'local-cache-instances-diverge',
    query: '服务扩到十几台机器后，改一次配置有的机器生效有的没生效，怎么让所有副本一起更新？',
    expectedFiles: ['local-cache-multi-level.md'],
    category: 'semantic',
    expectedHeadings: ['副本各自为政', '广播失效'],
    expectedEvidence: ['进程内缓存每个实例各持一份副本，需要通过发布订阅广播失效消息让所有实例同时删除'],
    expectedAnchors: ['粘性会话能掩盖现象却不解决问题', '发起变更的实例通常也订阅同一主题']
  },
  {
    id: 'pg-table-size-grows-without-rows',
    query: '一张表的行数基本没变，占用的磁盘却一直涨，扫描也越来越慢，先从哪儿查？',
    expectedFiles: ['postgres-vacuum-bloat.md'],
    category: 'semantic',
    expectedHeadings: ['死元组从哪里来'],
    expectedEvidence: ['更新与删除留下的旧版本形成死元组，回收不及时会让物理体积远大于逻辑数据量'],
    expectedAnchors: ['物理体积可能远大于逻辑数据量']
  },
  {
    id: 'pg-autovacuum-threshold-large-table',
    query: '小表很快就被后台整理干净，同样参数下大表却迟迟没有动静，差别在哪？',
    expectedFiles: ['postgres-vacuum-bloat.md'],
    category: 'exact',
    expectedHeadings: ['autovacuum 的触发阈值'],
    expectedEvidence: ['触发量 = threshold + scale_factor × 表行数，默认 50 与 0.2，大表要攒够两成死元组'],
    expectedAnchors: ['autovacuum_vacuum_scale_factor']
  },
  {
    id: 'deadlock-cross-order-batch',
    query: '两个批量任务偶尔互相卡住，最后其中一个被数据库强行结束，怎么从根上避免？',
    expectedFiles: ['pessimistic-locking-deadlock.md'],
    category: 'semantic',
    expectedHeadings: ['死锁是怎么形成的', '固定加锁顺序'],
    expectedEvidence: ['交叉的加锁顺序形成等待环，统一加锁顺序（例如先对 ID 排序）可消除大部分死锁'],
    expectedAnchors: ['交叉后谁都无法前进', '批量更新前先对 ID 排序']
  },
  {
    id: 'queue-skip-locked-not-for-count',
    query: '让多个工作进程各取各的活、跳过别人已经占住的行，这样拿到的数据能用来做统计吗？',
    expectedFiles: ['pessimistic-locking-deadlock.md'],
    category: 'semantic',
    expectedHeadings: ['NOWAIT 与 SKIP LOCKED'],
    expectedEvidence: ['SKIP LOCKED 跳过被锁行，结果集不完整，只适合抢任务不适合统计对账'],
    expectedAnchors: ['SKIP LOCKED']
  },
  {
    id: 'isolation-highest-level-not-default',
    query: '并发出过几次事故，是不是干脆把级别拉到最严就一劳永逸？',
    expectedFiles: ['database-isolation-levels.md'],
    category: 'semantic',
    expectedHeadings: ['按不变量选级别'],
    expectedEvidence: ['应先写下业务不变量再选最低够用的级别，最高级并发度低且会带来需要重试的失败'],
    expectedAnchors: ['选型不该从最高级最安全出发']
  },
  {
    id: 'rabbitmq-prefetch-fair-dispatch',
    query: '有一台在拼命干活、其余几台都空转，怎么让待处理的活分得更均匀？',
    expectedFiles: ['rabbitmq-delivery-model.md'],
    category: 'semantic',
    expectedHeadings: ['服务质量与公平分发'],
    expectedEvidence: ['通过 prefetch_count 限制未确认消息数量，太小造成闲置，太大退化为盲目轮询'],
    expectedAnchors: ['太小会让消费者在等待新消息时闲置']
  },
  {
    id: 'event-sourcing-fact-source',
    query: '如果把每一次变更都完整记下来，当前状态还需要单独存一份吗？',
    expectedFiles: ['event-sourcing-cqrs.md'],
    category: 'semantic',
    expectedHeadings: ['事件即事实源'],
    expectedEvidence: ['事件序列本身是事实源，当前状态由事件折叠得出，读模型可以随时删除重建'],
    expectedAnchors: ['写入路径只做追加']
  },
  {
    id: 'cqrs-read-after-write-lag',
    query: '刚点完保存就刷新，页面上还是老样子，这个空档是设计上必然会有的吗？',
    expectedFiles: ['event-sourcing-cqrs.md'],
    category: 'semantic',
    expectedHeadings: ['读写分离与读时延'],
    expectedEvidence: ['读模型由投影异步更新，写入到投影可见之间存在最终一致的时间差'],
    expectedAnchors: ['用户提交后立刻刷新，可能看不到自己刚做的修改']
  },
  {
    id: 'inbox-unique-index-same-transaction',
    query: '同一条通知被下游处理了两遍，账就多加了一笔，接收方该怎么挡住？',
    expectedFiles: ['idempotent-consumer-patterns.md'],
    category: 'semantic',
    expectedHeadings: ['去重表结构', '去重与业务写入同事务'],
    expectedEvidence: ['用带唯一索引的去重表记录已处理 ID，并与业务写入放在同一个本地事务里'],
    expectedAnchors: ['唯一索引是整张去重表的可靠性来源', '去重记录必须与业务修改落在同一个本地事务里']
  },
  {
    id: 'inbox-out-of-order-not-dedup',
    query: '重复的问题挡住了，但先发的消息后到、把新数据覆盖成旧的，这该怎么处理？',
    expectedFiles: ['idempotent-consumer-patterns.md'],
    category: 'distractor',
    expectedHeadings: ['乱序与迟到更新'],
    expectedEvidence: ['去重解决重复，次序颠倒要靠版本号比较丢弃过期更新，二者是不同问题'],
    expectedAnchors: ['去重只能挡住重复，挡不住次序颠倒']
  },
  {
    id: 'context-budget-output-reserve',
    query: '多轮跑下来，模型经常写到一半就断在半截 JSON 上，应该先查哪里？',
    expectedFiles: ['agent-context-management.md'],
    category: 'semantic',
    expectedHeadings: ['上下文预算分配'],
    expectedEvidence: ['必须先扣除输出预留额度，否则生成中途会被最大输出长度截断'],
    expectedAnchors: ['输出预留必须最先扣除']
  },
  {
    id: 'embedding-version-mixed-vectors',
    query: '底层的语义模型升级了一版，之前建好的那套库还能直接接着用吗？',
    expectedFiles: ['embedding-model-selection.md'],
    category: 'semantic',
    expectedHeadings: ['换版必须全量重建'],
    expectedEvidence: ['必须全量重建索引，新旧向量混放会让距离计算失去意义且不会报错'],
    expectedAnchors: ['把新旧向量混放在同一个集合里']
  },
  {
    id: 'tool-call-missing-result-message',
    query: '模型一次要求调三个函数，我只把其中两个的结果发回去，请求直接被判非法，为什么？',
    expectedFiles: ['llm-tool-calling-protocol.md'],
    category: 'semantic',
    expectedHeadings: ['tool_call_id 配对规则'],
    expectedEvidence: ['每个 tool_call 都必须有一条一一对应的结果消息，缺失会导致请求非法'],
    expectedAnchors: ['多数供应商会直接判定请求非法']
  },
  {
    id: 'tool-schema-description-quality',
    query: '有三个功能相近的查询函数，模型总是挑错，应该改哪里？',
    expectedFiles: ['llm-tool-calling-protocol.md'],
    category: 'distractor',
    expectedHeadings: ['工具描述质量', '工具数量与选择退化'],
    expectedEvidence: ['描述必须写清适用场景与差异，工具过多会互相混淆导致选择退化'],
    expectedAnchors: ['模型无法在三个查询类工具之间做出区分']
  },
  {
    id: 'cs01-remains-after-rate-hedge',
    query: '组合里利率那一块的敏感度已经压到接近零，为什么行情一变差还是跟着亏？',
    expectedFiles: ['credit-spread-risk.md'],
    category: 'semantic',
    expectedHeadings: ['利差久期与 CS01'],
    expectedEvidence: ['利率对冲只中和 DV01，利差敏感度 CS01 仍完整保留，两者是不同维度'],
    expectedAnchors: ['组合的 CS01 依然完整保留在账上']
  },
  {
    id: 'breakeven-not-inflation-forecast',
    query: '两只期限一样但计价方式不同的国债，把收益率相减得到的那个数，能当成大家对物价的判断吗？',
    expectedFiles: ['inflation-linked-bonds.md'],
    category: 'semantic',
    expectedHeadings: ['盈亏平衡通胀率', '通胀风险溢价'],
    expectedEvidence: ['该数字是两类债券的相对定价结果，还包含通胀风险溢价，不等于纯预期'],
    expectedAnchors: ['它是两个品种的相对定价结果', '会把风险补偿误读为预期本身']
  },
  {
    id: 'redemption-maturity-mismatch',
    query: '账面上东西不少，但客户集中来要钱的时候还是周转不开，问题出在哪一环？',
    expectedFiles: ['liquidity-risk-management.md'],
    category: 'semantic',
    expectedHeadings: ['市场流动性与融资流动性', '赎回压力与期限错配'],
    expectedEvidence: ['申赎周期短于底层资产变现周期形成错配，优质资产也可能变现不及支付时点'],
    expectedAnchors: ['因为资产变现速度跟不上现金支付时点', '一旦集中赎回，管理人被迫先卖流动性最好的资产']
  },
  {
    id: 'multiples-median-over-mean',
    query: '拿一批同行的数字取个平均来给公司定价，这个做法有什么毛病？',
    expectedFiles: ['relative-valuation-multiples.md'],
    category: 'semantic',
    expectedHeadings: ['可比样本与中位数'],
    expectedEvidence: ['个别极端倍数会拉动均值，中位数更稳健，异常值多来自盈利接近零的公司'],
    expectedAnchors: ['汇总时中位数优于算术平均数']
  },
  {
    id: 'multiple-numerator-denominator-consistency',
    query: '上面一项按全部出资人算、下面一项只算归股东的部分，这样得出的比值为什么不能用？',
    expectedFiles: ['relative-valuation-multiples.md'],
    category: 'distractor',
    expectedHeadings: ['分子分母口径一致'],
    expectedEvidence: ['分子分母必须同属股权口径或企业口径，跨口径搭配会系统性失真'],
    expectedAnchors: ['股权口径对股权口径，企业口径对企业口径']
  },
  {
    id: 'beta-index-choice',
    query: '做回归时把基准换成覆盖范围更广的那一个，得到的结果会变吗？',
    expectedFiles: ['capm-cost-of-equity.md'],
    category: 'semantic',
    expectedHeadings: ['Beta 的回归设定'],
    expectedEvidence: ['基准应与投资者分散化范围一致，换基准会得到明显不同的估计值'],
    expectedAnchors: ['指数选择应与投资者的分散化范围一致']
  },
  {
    id: 'saga-compensation-not-delete',
    query: '多步骤流程走到第四步失败了，前面几步已经落库的动作该怎么退回？',
    expectedFiles: ['saga-orchestration-patterns.md'],
    category: 'semantic',
    expectedHeadings: ['补偿的语义反向'],
    expectedEvidence: ['补偿是业务上的反向动作而非删除写入，正向记录要保留以支撑审计与对账'],
    expectedAnchors: ['都依赖那条正向记录存在']
  },
  {
    id: 'saga-irreversible-step-ordering',
    query: '整条链路里有一步做完就再也收不回来，它应该安排在什么位置？',
    expectedFiles: ['saga-orchestration-patterns.md'],
    category: 'distractor',
    expectedHeadings: ['不可补偿动作后置'],
    expectedEvidence: ['不可补偿动作必须排在流程末尾，前置会让失败时无法回退'],
    expectedAnchors: ['已出库交付承运商的货物']
  },
  {
    id: 'fixed-window-boundary-burst',
    query: '明明限了每分钟的量，可两段计时的接缝处还是被打进来两倍的请求，为什么？',
    expectedFiles: ['api-rate-limiting.md'],
    category: 'semantic',
    expectedHeadings: ['固定窗口的临界突刺'],
    expectedEvidence: ['固定窗口在边界处可能在极短时间内放行两个窗口的配额，形成两倍突刺'],
    expectedAnchors: ['这个临界突刺足以打穿按平均值估算的容量']
  },
  {
    id: 'rate-limit-retry-after-jitter',
    query: '服务端让我们稍后再来，如果所有调用方都按同一个间隔重来会发生什么？',
    expectedFiles: ['api-rate-limiting.md'],
    category: 'distractor',
    expectedHeadings: ['429 响应与客户端退避'],
    expectedEvidence: ['应返回 429 与 Retry-After，客户端需在退避基础上加随机抖动避免同步重试'],
    expectedAnchors: ['Retry-After']
  },
  {
    id: 'gamma-rehedge-cost',
    query: '仓位刚调平没多久，价格一动又得重新调，来回买卖的损耗是从哪冒出来的？',
    expectedFiles: ['options-greeks-hedging.md'],
    category: 'semantic',
    expectedHeadings: ['Gamma 与再对冲频率', '离散对冲误差与成本'],
    expectedEvidence: ['Delta 随标的变化的速度由 Gamma 决定，空头 Gamma 被迫追涨杀跌，可用容忍带控制成本'],
    expectedAnchors: ['再对冲亏损越大', '常见做法是设置 Delta 容忍带']
  },
  {
    id: 'forward-not-expectation',
    query: '远期报出来的价格比现在高，是不是说明市场认为这个货币会涨？',
    expectedFiles: ['fx-hedging-instruments.md'],
    category: 'semantic',
    expectedHeadings: ['远期定价与远期点数'],
    expectedEvidence: ['远期价差由两国利差决定，不是对未来汇率的预期'],
    expectedAnchors: ['是财资管理中最常见的误解']
  },
  {
    id: 'fx-exposure-types-match',
    query: '海外分部的账折回来带来的波动，和签了外币合同还没收到的那笔钱，能用同一种办法处理吗？',
    expectedFiles: ['fx-hedging-instruments.md'],
    category: 'distractor',
    expectedHeadings: ['三类外汇敞口'],
    expectedEvidence: ['交易性、折算性与经营性敞口性质不同，工具需与敞口类型匹配'],
    expectedAnchors: ['用短期远期对冲经营性敞口通常无效']
  },
  // ==== 簇内干扰题：问题落在整簇的语义范围内，答案只在其中一篇 ====
  {
    id: 'cluster-cache-delete-or-update',
    query: '更新完数据库之后，缓存到底应该删掉还是直接写成新值？',
    expectedFiles: ['cache-consistency-patterns.md'],
    category: 'distractor',
    expectedHeadings: ['写后删除缓存'],
    expectedEvidence: ['并发写可能让旧值覆盖新值，删除让后续读取重新建立，缩小顺序错乱风险'],
    expectedAnchors: ['使旧值覆盖新值']
  },
  {
    id: 'cluster-db-repeatable-read-differs',
    query: '同样叫可重复读这个级别，换一个数据库产品之后实际行为会不一样吗？',
    expectedFiles: ['database-isolation-levels.md'],
    category: 'distractor',
    expectedHeadings: ['Repeatable Read 的两种口径'],
    expectedEvidence: ['不同产品对同名级别的实现口径不同，迁移时必须重做并发测试'],
    expectedAnchors: ['迁移数据库时必须重做并发测试']
  },
  {
    id: 'cluster-mq-delayed-task',
    query: '想让一条消息过几分钟之后才被处理，在这个 broker 上一般怎么做？',
    expectedFiles: ['rabbitmq-delivery-model.md'],
    category: 'distractor',
    expectedHeadings: ['存活时间与延迟队列'],
    expectedEvidence: ['用队列 TTL 加死信路由可实现固定延迟，任意延迟需要延迟消息插件'],
    expectedAnchors: ['需要任意延迟应改用延迟消息插件']
  },
  {
    id: 'cluster-agent-middle-lost',
    query: '把检索到的资料一股脑塞进去以后，模型反而抓不住中间那几段的重点，怎么办？',
    expectedFiles: ['agent-context-management.md'],
    category: 'distractor',
    expectedHeadings: ['中间信息丢失'],
    expectedEvidence: ['序列中部的信息更容易被忽略，应把关键证据放在开头或结尾'],
    expectedAnchors: ['lost in the middle']
  },
  {
    id: 'cluster-fi-two-sensitivities',
    query: '为什么一份债券风险报告要分开列两个"变动一个基点"的数字，只给一个合计值不行吗？',
    expectedFiles: ['credit-spread-risk.md'],
    category: 'distractor',
    expectedHeadings: ['利率与利差的正交分解'],
    expectedEvidence: ['合计敏感度无法区分损失来自政策利率还是信用环境，需分开归因'],
    expectedAnchors: ['使用者无法判断损失来自政策利率变化还是信用环境恶化']
  },
  {
    id: 'cluster-valuation-discount-rate-source',
    query: '折现率里归股东的那一块，本身是怎么定出来的？',
    expectedFiles: ['capm-cost-of-equity.md'],
    category: 'distractor',
    expectedHeadings: ['CAPM 的构成与输入'],
    expectedEvidence: ['由无风险利率加上贝塔乘以市场风险溢价得到，只补偿不可分散的系统性风险'],
    expectedAnchors: ['公司特有风险不进入定价']
  },
  {
    id: 'cluster-risk-cannot-sell',
    query: '压力时期资产卖不掉这件事，和用分位数衡量的亏损幅度是同一回事吗？',
    expectedFiles: ['liquidity-risk-management.md'],
    category: 'distractor',
    expectedHeadings: ['流动性调整后的 VaR'],
    expectedEvidence: ['分位数模型假设可即时变现，需按变现天数拉长持有期并计入变现成本'],
    expectedAnchors: ['让慢速变现的头寸承担更长时间的价格波动']
  },
  {
    id: 'cluster-option-seller-loss',
    query: '收了权利金的那一方最多能赚多少、最多可能亏多少？',
    expectedFiles: ['options-greeks-hedging.md'],
    category: 'distractor',
    expectedHeadings: ['卖方尾部风险与保证金'],
    expectedEvidence: ['收益上限为权利金，极端行情下损失可能远超权利金，裸卖看涨理论上无上界'],
    expectedAnchors: ['收益上限就是收到的权利金']
  },
  // ==== 跨文档综合题 ====
  {
    id: 'md-cache-proxy-vs-aside',
    query: '一种是由组件自己去后端取数、写完也由它落库，另一种是业务代码里显式地先查再补，责任分界差在哪？',
    expectedFiles: ['read-through-write-behind.md', 'cache-consistency-patterns.md'],
    category: 'multi_document',
    expectedHeadings: ['责任边界在缓存层', 'Cache-Aside 读流程'],
    expectedEvidence: ['前者把加载与回写职责注册在缓存组件上，后者由应用代码显式编排读写'],
    expectedAnchors: ['未命中时由谁查库、写完由谁落库，全由组件决定', 'Cache-Aside 由应用先读取缓存']
  },
  {
    id: 'md-saga-vs-outbox',
    query: '业务流程中途失败要回退，同时又得保证发出去的通知不丢，这两件事分别靠什么机制？',
    expectedFiles: ['saga-orchestration-patterns.md', 'distributed-transactions-outbox.md'],
    category: 'multi_document',
    expectedHeadings: ['与事件可靠投递的边界', 'Transactional Outbox'],
    expectedEvidence: ['补偿动作负责业务回退，本地事务内写入事件表加后台发布器负责不丢事件'],
    expectedAnchors: ['投递失败可以原样重发，业务失败只能靠反向动作抵消', '在同一个本地事务中写入业务数据和 outbox 事件']
  },
  {
    id: 'md-long-transaction-cost',
    query: '一个事务开着不提交，除了让读到的数据变旧，还会给数据库留下哪些运维负担？',
    expectedFiles: ['mvcc-foundations.md', 'postgres-vacuum-bloat.md'],
    category: 'multi_document',
    expectedHeadings: ['长事务与版本清理', '什么会阻塞清理'],
    expectedEvidence: ['旧快照阻止版本回收，导致膨胀；被遗忘的复制槽等同样会让清理停滞'],
    expectedAnchors: ['只要旧快照仍可能读取某个版本，数据库就不能安全回收它', '一个被遗忘的复制槽足以让整库清理停滞数天']
  },
  {
    id: 'md-rate-vs-spread-attribution',
    query: '一只债券这个月跌了，怎么把跌幅拆成利率因素和信用因素两部分？',
    expectedFiles: ['bond-duration-convexity.md', 'credit-spread-risk.md'],
    category: 'multi_document',
    expectedHeadings: ['Modified Duration', '利率与利差的正交分解'],
    expectedEvidence: ['价格变动近似等于负修正久期乘以收益率变化，再加上负利差久期乘以利差变化'],
    expectedAnchors: ['ΔP / P ≈ −Dmod × Δy', 'Dspread × Δs']
  },
  // ==== 追加簇内改述型难题 ====
  {
    id: 'cluster-mq-no-replay-after-ack',
    query: '确认之后那条消息就从服务端消失了，事后还能倒回去重新处理一遍吗？',
    expectedFiles: ['rabbitmq-delivery-model.md'],
    category: 'distractor',
    expectedHeadings: ['顺序保证与模型边界'],
    expectedEvidence: ['确认即删除，服务端不保留可回放的位点，重放需要业务侧自己留存'],
    expectedAnchors: ['服务端不保留可回放的位点']
  },
  {
    id: 'cluster-db-hot-update-same-page',
    query: '改一行数据时如果同一页里还有空位，那些没被改到的索引还需要跟着写一遍吗？',
    expectedFiles: ['postgres-vacuum-bloat.md'],
    category: 'distractor',
    expectedHeadings: ['HOT 更新与 fillfactor'],
    expectedEvidence: ['同页内的堆内更新可以不更新索引，预留空间可提高命中率'],
    expectedAnchors: ['fillfactor']
  },
  {
    id: 'cluster-agent-truncate-traceback',
    query: '外部返回的内容太长，塞进去就把额度挤爆了，砍掉之后原始内容还找得回来吗？',
    expectedFiles: ['agent-context-management.md'],
    category: 'distractor',
    expectedHeadings: ['工具结果截断策略'],
    expectedEvidence: ['截断后应把完整结果写入外部存储并返回引用 ID，保证可追溯'],
    expectedAnchors: ['完整结果写入外部存储并返回一个引用 ID']
  },
  {
    id: 'cluster-valuation-unprofitable-company',
    query: '一家还在亏钱、但收入涨得很快的公司，横向对标时该拿哪个口径去比？',
    expectedFiles: ['relative-valuation-multiples.md'],
    category: 'distractor',
    expectedHeadings: ['EV/Sales 与未盈利成长期'],
    expectedEvidence: ['盈利为负时收入类倍数更可用，但它把利润率假设隐含在了倍数里'],
    expectedAnchors: ['它其实是把利润率判断藏进了倍数里']
  },
  {
    id: 'cluster-fi-deflation-floor-coupon',
    query: '本金会跟着物价走的那种券，遇到物价往下掉的时候，拿到手的利息也会跟着缩水吗？',
    expectedFiles: ['inflation-linked-bonds.md'],
    category: 'distractor',
    expectedHeadings: ['指数滞后与通缩下限'],
    expectedEvidence: ['到期本金有下限保护，但期间票息仍按调整后的本金计算'],
    expectedAnchors: ['这个下限只保护本金']
  },
  {
    id: 'cluster-cache-multilevel-ttl-order',
    query: '同一份数据在机器本地和公共存储里各留了一份，两边的存活时间该怎么配才不打架？',
    expectedFiles: ['local-cache-multi-level.md'],
    category: 'distractor',
    expectedHeadings: ['L1 本地与 L2 分布式'],
    expectedEvidence: ['本地层存活时间必须显著短于共享层，一般取秒级到几十秒'],
    expectedAnchors: ['L1 的存活时间必须显著短于 L2']
  },
  // ==== 近主题不可答：话题在语料领域内，但语料确实没有覆盖 ====
  {
    id: 'un-mongodb-sharded-transaction',
    query: 'MongoDB 的多文档事务在分片集群上有哪些限制？',
    expectedFiles: [],
    category: 'unanswerable',
    answerable: false
  },
  {
    id: 'un-flink-state-backend',
    query: 'Flink 的状态后端选内存还是 RocksDB，取舍是什么？',
    expectedFiles: [],
    category: 'unanswerable',
    answerable: false
  },
  {
    id: 'un-span-margin-model',
    query: '商品期权的保证金按 SPAN 模型具体是怎么算出来的？',
    expectedFiles: [],
    category: 'unanswerable',
    answerable: false
  },
  {
    id: 'un-reits-ffo',
    query: 'REITs 为什么要用 FFO 而不是净利润来衡量分红能力？',
    expectedFiles: [],
    category: 'unanswerable',
    answerable: false
  }
];
