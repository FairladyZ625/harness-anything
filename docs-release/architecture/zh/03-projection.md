# 投影：canonical SQLite 事件到读取缓存

当前启用的 canonical generation 有两种 SQLite 职责：
`store/generations/<generation>/ledger.sqlite` 是接受命令的
canonical 数据库，task projection 是派生读取缓存。只有后者可在不丢失已接受命令的前提下删除重建。

`makeTaskProjection` 读取 canonical store 的有限事件批次及必需对象。Catch-up 推进完整
watermark，cold rebuild 重放同一段已接受历史。读取者观察已安装的投影 cut，不观察应用到一半的行。

投影服务 task、decision、fact、relation、session、execution、review、声明和权限读取。
命令已持久化时，projection facet 仍可能 pending。回执等待条件比较仓库、generation、revision，
并在 revision 相等时比较 digest，再声明可见。

读取投影损坏或缺失时使用 `ha daemon projection rebuild`。保留 canonical 数据库及
`objects/sha256/`；只从 Markdown 或 Git 重建会遗漏尚未完成 Git 发布的已接受命令。

切换验收对固定接受 cut 做两次 cold rebuild 并比较结果。独立台账对账还要验证不可变导入前缀、
metadata、行 digest、command outcomes、必需对象和真实 Git follower 回读。
两个读取器互相比较同一个数据库，不能证明导入保留了原始来源。

实现依据：`packages/kernel/src/projection/rebuildable-task-projection-factory.ts` 与
`packages/kernel/src/projection/rebuildable-task-projection-reads.ts`.
