# Architecture Decision Records

## Decision Projection Boundary

decision 状态由 canonical decision store 持有。这里仅容纳从 decision 选择生成的持久 ADR 投影；初始化不会创建 ADR 实例。

## Navigation

每个 ADR 投影都应链接回 canonical decision，实现跟踪留在 task。
