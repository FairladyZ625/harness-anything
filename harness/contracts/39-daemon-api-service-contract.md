# 39 · Daemon API / Service Contract Index

- **状态**: split index（原 canonical entry 已在 2026-07-07 拆分）
- **日期**: 2026-07-07
- **适用范围**: 只作为旧引用迁移入口；新的权威内容见 39A / 39B。
- **关联**: 39A、39B、ADR-0004、ADR-0005、ADR-0013

## 读取入口

| 需要回答的问题 | 权威合同 |
| --- | --- |
| daemon JSON-RPC / REST / WS handler、Service contract registry、hello/repo namespace/receipt envelope、GUI local/remote 连接模型、handler gate | [39A · Daemon Transport/API 与 Service Contract 生成合同](39A-daemon-transport-api-service-contract.md) |
| terminal session API、PTY backend、tmux/remote backend、session registry、env profile、scrollback、terminal WS frame、display-only 边界 | [39B · Terminal / WS Service Contract](39B-terminal-ws-service-contract.md) |

## 迁移表

| 原 39 section | 新位置 |
| --- | --- |
| §0 结论 | 39A §0 |
| §1 边界 | 39A §1 |
| §2 Service 方法形态 | 39A §2 |
| §3 API Contract Registry | 39A §3 |
| §4 Handler 生成 / 校验策略 | 39A §4 |
| §5 Terminal / WS 特例 | 39B 全文 |
| §6 GUI 连接模型 | 39A §6 |
| §7 CI / Check 分阶段 | 39A §7 |
| §8 文档与任务要求 | 39A §8 |
| §9 非目标 | 39A §9；terminal registry 非目标同时由 39B 约束 |

旧路径保留为索引以避免既有引用断裂。新任务和 PR 应直接引用 39A/39B。
