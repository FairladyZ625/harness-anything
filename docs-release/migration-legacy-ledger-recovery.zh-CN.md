# 激活前的历史台账转换

Generation 1 严格拒绝不支持的历史形状。原地 fact rekey、event-shape、dispatch-record
及 ledger-layout 历史重写命令已退役。

转换前停止旧仓写入，保留原始数据库、objects、authored Git 历史及备份身份。
投影重建不能修复不合法的 canonical 来源。

操作 API 在解析后的 local root 的 `store/imports/generation-0.snapshot.json` 创建不可变
来源快照，保存事件、必需对象及 source digest。`convertLegacyGeneration` 在写入未激活的
generation-1 前先验证转换计划。中断后从同一来源续传；完整转换再跑一次新增事件数为零；
已经激活的 generation 不可再次转换。

`preflightCanonicalGeneration` 验证不可变来源、import marker、转换前缀、必需对象，以及
零待处理历史重写，并在数据库旁记录 `ledger.sqlite.activation.json`。后续打开保留固定前缀，
允许已接受的新后缀。没有来源证据的非空 generation 会被拒绝。

Git 文档与 segment manifest follower 完成后执行：

```sh
ha ledger reconcile --generation 1
```

对账比较不可变来源及 metadata、行 digest、command outcomes、objects 和实际 Git 回读。
保留 `matches=true` 与两次一致的 cold rebuild 作为切换证据，按已批准 runbook 备份、切换
daemon、验证 canary 回执及回滚。没有在线原地历史重写恢复入口。

备份 cut 之后的已接受命令必须在回滚时保全。Git tag 不能替代 SQLite 接受记录；
不可直接删除 canonical 数据库。由所有者完成命令对账前保持停写。

把老仓导入另一个新目标时，参见[创世重放](migration-genesis-replay.zh-CN.md)。
