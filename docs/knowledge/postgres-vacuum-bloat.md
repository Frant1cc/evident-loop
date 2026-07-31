# PostgreSQL 死元组、VACUUM 与表膨胀

> 领域：PostgreSQL 运维。本文聚焦死元组回收的具体机制与参数，不重复数据库无关的快照可见性原理。

## 死元组从哪里来

PostgreSQL 的 UPDATE 不是原地覆盖，而是写入新行版本并把旧版本标记为过期，DELETE 也只打标记。当再没有快照需要旧版本时，它成为死元组（dead tuple），但占用的页面空间仍留在表文件里。

于是一张高频更新的小表，物理体积可能远大于逻辑数据量。让磁盘占用回落的不是删除数据，而是清理与空间复用。

## VACUUM 与 VACUUM FULL

普通 VACUUM 把死元组空间标记为可复用，供同表后续插入更新使用；它只取较弱的锁，不阻塞读写，但通常不把文件缩小还给操作系统。

VACUUM FULL 重写整张表并重建索引，能真正回收磁盘，代价是持有 ACCESS EXCLUSIVE 锁，期间该表不可读写，还需接近一倍额外空间。把 VACUUM FULL 当作日常清理手段是危险的，线上更常用 pg_repack 一类在线重组工具。

## autovacuum 的触发阈值

autovacuum 是否对某张表发起清理，由死元组数量与一个阈值比较决定：

```text
threshold = autovacuum_vacuum_threshold + autovacuum_vacuum_scale_factor × reltuples
```

默认 `autovacuum_vacuum_threshold` 为 50，`autovacuum_vacuum_scale_factor` 为 0.2，即大表要攒够两成死元组才会被清理。亿行级表因此常年得不到清理，通常需按表把 scale factor 降到 0.01 级别，并调大 `autovacuum_vacuum_cost_limit`。

清理由后台 worker 执行，`autovacuum_max_workers` 默认为 3，繁忙实例上很容易被几张大表长期占满，让小表一直排队等不到清理。

## 膨胀诊断看哪些字段

诊断先查 `pg_stat_user_tables`：`n_dead_tup` 反映累积死元组，`n_live_tup` 提供对照基数，`last_autovacuum` 与 `autovacuum_count` 说明清理是否真的发生过。死元组很高而 `last_autovacuum` 长期为空，多半是阈值没触发或 worker 被占满。

索引膨胀要单独看。索引条目只有在对应堆元组被清理后才会摘除，频繁更新的表常出现索引比数据还大。另一个早期信号是 `n_mod_since_analyze` 持续增长，说明统计信息同样在过期，执行计划可能随之走偏。

## 事务 ID 回卷与 freeze

事务 ID 是有限的循环空间，过老的行版本必须被 freeze，标记为对所有事务永久可见，否则回卷后会被误判成来自未来的事务。`autovacuum_freeze_max_age` 默认两亿，达到后即使表看起来干净也会强制触发防回卷清理。

这类清理不受 autovacuum 开关约束，也不会因负载高而让路。监控里剩余事务 ID 快速下降时应排查阻塞源，而不是调大参数了事。

## 可见性映射与回表

VACUUM 会顺带维护可见性映射（visibility map），把整页元组都对所有事务可见的数据块标记为 all-visible。index-only scan 依赖这个标记：只有命中 all-visible 的页，查询才能只读索引而跳过回表。

所以清理滞后不只是磁盘问题，它会让本该走 index-only scan 的查询退化成大量随机堆访问，执行计划中 Heap Fetches 居高不下。

## HOT 更新与 fillfactor

若更新没有修改任何被索引的列，且新版本放得进同一个数据块，PostgreSQL 会走 HOT（Heap-Only Tuple）更新：新版本不进索引，旧版本可由页内轻量清理回收。HOT 命中率高的表膨胀压力明显更小。

提高命中率的做法是对更新密集的表把 `fillfactor` 从默认 100 调到 80 左右，为同页新版本预留空间，同时不给频繁变化的列建多余索引。

## 什么会阻塞清理

清理无法回收比最老快照更新的版本，因此三类对象会直接卡住回收：长时间未提交或空转的事务、遗留的 prepared 事务、以及落后或废弃的复制槽。

排查顺序是从 `pg_stat_activity` 的 `xact_start` 找最老事务，从 `pg_prepared_xacts` 找无人提交的两阶段事务，再看 `pg_replication_slots` 的活跃状态与滞后量。一个被遗忘的复制槽足以让整库清理停滞数天。

## 本文边界

本文只覆盖 PostgreSQL 侧的空间回收与参数调优。版本可见性怎么判断、快照与版本链的抽象模型属于多版本并发控制原理；超卖和重复扣减即使清理健康也会发生，应查阅业务层并发冲突与幂等设计的内容。调大清理参数不能修复业务不变量。
