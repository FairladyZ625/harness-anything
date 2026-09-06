# 系统的形状

Generation 1 在 SQLite 中接受命令。canonical 数据库及其必需的内容对象是持久记录；
Git 和读取投影从这份记录派生。

## 存储职责

解析后的 local root 包含 `store/generations/1/ledger.sqlite` 与
`store/generations/1/objects/sha256/`。接受事务前先同步必需对象的文件与目录链接。
一个 `BEGIN IMMEDIATE` 事务校验仓库 writer lease，并提交完整事件区间与 command outcome。

`packages/kernel/src/store/sqlite-event-store.ts` 实现接受事务；
`sqlite-task-event-store.ts` 实现 canonical store 端口，并把已接受事件派生的文档和
`events/segments/manifest.json` 发布到 Git。只有独立回读 manifest、文档内容、文件模式及
退役路径后才认证 Git cut。Worktree 可见性单独检查；并发撰写修改可以让该 facet 保持 pending。

旧 segment WAL、合并 shadow reader、publication pointer 家族和 materializer worker 已退役。
SQLite 自身的事务日志仍是数据库实现细节。

## 命令与回执

CLI／GUI 经 daemon RPC 进入 RepoCell 单写队列，完成归属、权限与领域校验后，
由 SQLite 事务和必需对象形成接受点。读取投影从 canonical SQLite 事件流追赶或重建。

只有按 opId 回读到已提交 outcome，回执才声明 `status: accepted_durable`。
接受区间与 projection、Git、worktree、replica facets 分开表达。
`ha receipt show <op-id> --wait git_verified` 等待 Git facet；超时不会撤销已接受持久性。
每个认证 cut 带仓库、generation 和 revision；未配置的 replica 明确返回 not_configured。

## 恢复与转换

投影可以重建，`ledger.sqlite` 及必需对象不能随意删除。Git clone 无法恢复尚未发布的已接受命令。
切换 daemon 前，用 SQLite 一致性副本和匹配的 objects 备份 canonical 数据。

历史格式转换在激活前执行：不可变 generation-0 snapshot → 未激活 generation-1。
激活验证转换前缀及对象；后续重启保留该前缀并允许新接受的后缀。原地历史重写命令已退役。

参见[投影](03-projection.md)与[历史转换](../../migration-legacy-ledger-recovery.zh-CN.md)。
