# PLT-Notify · 通知框架 (Notification Framework)

- **状态**: canonical
- **日期**: 2026-06-14
- **产品线**: 平台线 (Platform)
- **来源**: 2026-06-14 路线图产品线重构

## 目标 (North Star)

建立统一的事件通知基础设施。当任务状态变化、审阅就绪、构建完成等关键事件发生时，系统可通过多种通道将通知推送给用户。通知框架是平台级能力，CLI 和 GUI 共同消费。

## §0. 为什么需要通知

当前 Harness 的所有状态变化都是"拉模式"——用户必须主动运行 `harness check` 或打开 GUI 才能看到变化。对于以下场景，推模式（Push）是刚需：

| 场景 | 痛点 | 通知解法 |
|------|------|---------|
| Agent 在后台执行任务 | 用户不知道何时完成，反复刷看板 | 任务进入 `close-ready` 时桌面通知 |
| 远程服务器上的 agent | SSH 过去看日志太重 | Webhook 推到 Slack/钉钉/邮件 |
| 团队场景（未来） | 队友改了状态，自己不知道 | @mention 通知 |
| CI/CD 集成 | 构建/测试结果需要回写 | Webhook 回调 |

## 范围内 (In Scope)

### 层级 1: 事件总线 (Event Bus)

- Kernel/Application 层发出标准化领域事件（`TaskStatusChanged`、`CloseoutReadinessChanged`、`ReviewSubmitted`、`NoteAdded` 等）
- 事件定义为 Effect-TS Schema 类型，带时间戳、任务 ID、变更摘要
- 事件总线为进程内发布/订阅模型，不引入外部消息队列
- Daemon 模式下事件可通过 WebSocket 实时推送给已连接的客户端

### 层级 2: 通知通道 (Notification Channels)

| 通道 | 优先级 | 实现位置 | 说明 |
|------|--------|---------|------|
| **桌面通知** (macOS/Windows/Linux) | P0 | GUI-V1 (Electron Notification API) | 随 GUI-V1 一起交付 |
| **Webhook** (通用 HTTP POST) | P1 | Daemon | 用户配置 URL + secret；JSON payload |
| **邮件** | P2 | Daemon 或独立服务 | SMTP 配置；摘要模板 |
| **Slack** | P2 | Webhook 通道的预置模板 | Incoming Webhook URL |
| **钉钉** | P2 | Webhook 通道的预置模板 | Robot Webhook URL |
| **自定义脚本** | P3 | Daemon | 用户提供 shell 脚本路径，事件以 JSON stdin 传入 |

### 层级 3: 通知配置

- `harness.yaml` 新增 `notifications` 配置段
- 每个通道可配置：启用/禁用、事件过滤规则（按事件类型、任务标签、严重级别）
- 静默时段（Do Not Disturb）支持
- 通知去重（同一事件短时间内不重复推送）

## 范围外 (Non-goal)

- 外部消息队列（Kafka/RabbitMQ/Redis Pub/Sub）——不引入，进程内事件总线足够
- 双向交互（从通知回复触发操作）——不做，通知是单向推送
- 手机推送（APNs/FCM）——归 COM-Mobile 里程碑
- 团队级通知路由（按角色分发）——归 COM-Team 里程碑
- 通知历史持久化（通知中心/收件箱）——视产品需求决定，当前不做

## 入口条件

1. M2.5 验收通过（kernel Application Service 稳定）。
2. 领域事件类型定义的 Schema ADR 签署。

## 验收标准

- [ ] Kernel 发出 `TaskStatusChanged` 事件，Daemon WebSocket 客户端可接收
- [ ] `harness.yaml` 配置 Webhook 通道后，任务状态变化触发 HTTP POST
- [ ] Webhook payload 包含事件类型、任务 ID、变更摘要、时间戳
- [ ] 事件过滤规则生效：配置只关注 `close-ready` 事件时，其他事件不触发通知
- [ ] 静默时段内不发送通知
- [ ] 桌面通知随 GUI-V1 交付（Electron Notification API）

## 依赖

- 前序: M2.5（kernel 稳定）
- 消费者: GUI-V1（桌面通知）、COM-Team（团队通知路由）
- 设计文档: 需新建 `harness/contracts/41-event-notification-contract.md`

## 退出条件

- [ ] 验收标准全部满足
- [ ] Webhook + 桌面通知两个通道均可端到端走通
- [ ] 事件 Schema 类型定义已冻结并入 `harness/contracts/`
