# 系统的形状

当前启用的 canonical generation 在 SQLite 中接受命令。canonical 数据库及其必需的内容对象是持久记录；
Git 发布、撰写工作树和读取投影都从这份记录派生。

## 存储职责

解析后的 local root 包含 `store/generations/<generation>/ledger.sqlite` 与
`store/generations/<generation>/objects/sha256/`。接受事务前先同步必需对象的文件与目录链接。
一个 `BEGIN IMMEDIATE` 事务校验 writer epoch fence 与操作身份，并原子提交完整事件区间与 command outcome。
Git commit 不是接受边界。

`packages/kernel/src/store/sqlite-event-store.ts` 实现接受事务；
`packages/kernel/src/store/task-event-store-factory.ts` 为读写双方解析 active generation；
`sqlite-task-event-store.ts` 实现 canonical store 端口，并把已接受事件派生的文档和
`events/segments/manifest.json` 发布到 Git。每次只把 Git manifest 所指 cut 之后新接受的事件
提交在该 commit 之上，撰写 worktree 结算同一批事件。有并发修改的文件保留用户字节并报告为冲突；
worktree facet 保持 pending，直到后续事件或 `ha doc materialize` 结算该文件。

SQLite 使用 `journal_mode=WAL` 与 `synchronous=FULL`；
实现见 `packages/kernel/src/store/sqlite-event-store.ts`。

## 命令与回执

CLI／GUI 经 daemon JSON-RPC 提交 typed command。daemon 为每仓持有串行化 `RepoCell`：实际写者运行在
专用 `repo-writer-worker` 线程内，由 `packages/daemon/src/writer-supervisor.ts` 监管；
`writer-epoch` 持久 fence 在 daemon 重启后阻止旧写者，并在 fleet 场景防止脑裂双写
（`packages/daemon/src/writer-epoch.ts`、`packages/daemon/src/repo-writer-worker.ts`）。
application 与 domain handler 在接受前校验权限、实体转换和冻结写计划；
读取投影从 canonical SQLite 事件流追赶或重建。

仓库有四种模式：`local`、`remote-proxy`、`remote-center`、`remote-edge`
（`packages/daemon/src/repo-mode.ts`）。边缘节点把命令转发给中心，不获得第二个写者。

只有按 opId 回读到已提交 outcome，回执才声明 `status: accepted_durable`。
接受区间与 projection、Git、worktree、replica facets 分开表达。
`ha receipt show <op-id> --wait git_verified` 等待 Git facet；超时不会撤销已接受持久性。
每个认证 cut 带仓库、generation 和 revision；未配置的 replica 明确返回 not_configured。

## 恢复与转换

投影可以重建，`ledger.sqlite` 及必需对象不能随意删除。Git clone 无法恢复尚未发布的已接受命令。
切换 daemon 前，用 `ha backup` 产出的 SQLite 一致性副本和匹配的 objects 备份 canonical 数据
（`packages/kernel/src/store/ledger-backup.ts`）。

新仓库原生使用 generation 2，并写入 `generation-activation/v2` 激活证书。存量 generation-1
仓库经离线、已验证的备份转换进入 generation 2：`legacy-generation-conversion.ts` 在停止写入后
导入不可变前缀，`generation-two-conversion.ts` 执行激活 preflight 与转换，激活证书落盘后
`resolveActiveGeneration` 才会选择 generation 2。转换不是原地重写；历史原地重写命令已退役。

参见[投影](03-projection.md)与[历史转换](../../migration-legacy-ledger-recovery.zh-CN.md)。
