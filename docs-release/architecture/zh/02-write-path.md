# 唯一写路径

CLI 与 GUI 经 daemon 协议提交 typed command。daemon 为每仓持有串行化 RepoCell；
application 与 domain handler 在接受前校验权限、实体转换和冻结写计划。
`packages/daemon/src/repo-cell.ts` 构造事件库并提供 writer epoch fence。
边缘节点把命令交给中心，不获得第二个写者。

## SQLite 接受命令

`packages/kernel/src/store/task-event-store-factory.ts` 为读写选择同一个 active
canonical generation。
本地存储为 `store/generations/<generation>/ledger.sqlite` 与匹配的 `objects/sha256/`。

`packages/kernel/src/store/sqlite-event-store.ts` 先同步必需内容对象，再进入
`BEGIN IMMEDIATE`。
事务校验 writer fence 与操作身份，分配连续事件区间，并一起提交事件和 command outcome。
SQLite 使用 `journal_mode=WAL` 与 `synchronous=FULL`；同一 opId 携带不同意图会被拒绝。

```text
CLI / GUI → daemon → RepoCell 队列 + writer epoch fence
  → 已校验事件 + 冻结写计划
  → 必需对象同步 → SQLite COMMIT
  → 接受回执
  → Git / worktree 发布与读取投影 facets
```

## 接受与发布分别回执

`packages/kernel/src/composition/receipt-acceptance.ts` 回读已提交 command outcome
构造接受回执。
已提交的 command outcome 确立 `accepted_durable`；Git、worktree、projection 和 replica
分别报告进度。Git pending 不会撤销已接受命令。

`packages/kernel/src/store/sqlite-task-event-store.ts` 在接受之后调度 Git 发布，
从已认证 Git cut 之后的事件生成发布内容，并结算撰写工作区。工作区并发编辑保留为冲突，不会被覆盖。
`ha receipt show <op-id> --wait git_verified` 等待 Git 发布；`ha doc materialize` 从
canonical 内容结算文档。

只有读取投影可丢弃。必须保留 canonical SQLite 数据库与必需对象；Git 可能缺少尚未发布的已接受命令。
参见[存储职责](00-overview.md)与[读取投影](03-projection.md)。

## 验证原生持久化边界

`tools/stress/storage-campaign.integration.test.mjs` 中的
`F01/sqlite-accept-sync-before-receipt`
用 Linux strace 断言：最后一次接受写入与 accepted 回执之间，对 `ledger.sqlite-wal` 存在成功的
原生 `fsync` 或 `fdatasync`。它也注入写失败，重新打开 SQLite 比较事件与 outcome 的原子性。
运行现有隔离用例：

```sh
node tools/dispatch-isolated-test.mjs --file tools/stress/storage-campaign.integration.test.mjs
```

这验证观察到的系统调用边界，不代表物理断电行为验证。
