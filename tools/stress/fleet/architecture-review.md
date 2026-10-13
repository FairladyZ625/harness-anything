# Fleet 同步架构评审（基线阶段）

本评审基于 `packages/daemon/src/fleet/contract.ts`、`edge-replica-sync.ts`、`center-replica-offer.ts`、`replica-ack-store.ts` 和现有 scale/integration tests。持续推送实现与本评审分开，等待 CEO 在第①②项检查点裁决。

| 能力 | 当前 Fleet 协议 | PostgreSQL 流复制 | MySQL binlog | Kafka 消费者 | etcd/Raft 跟随者 | 差距与建议 |
|---|---|---|---|---|---|---|
| 单写 | 中心 writer epoch + SQLite cut | primary | single writer/binlog source | partition leader | leader | 语义相近；需测中心写入上限。 |
| 有序日志 | revision/headDigest、delta page | WAL LSN | binlog position/GTID | partition offset | log index/term | Fleet 只有按 repo 顺序，缺少跨节点统一消费位点。 |
| ACK | transfer ACK 持久化在 replica-ack-store | flush/replay LSN | relay/master position | committed offset | matchIndex | 现有 ACK 只在一次 offer 完成后确认；持续流需要周期 ACK。 |
| 流控 | 会话/键发送窗口、96KiB frame、64KiB chunk | sender/receiver feedback | relay limits | fetch/max bytes | inflight append entries | 有基础窗口，但没有持续流的队列水位和每边缘预算。 |
| 断线续传 | 最后 ACK cursor 可构造 delta | WAL replay | binlog reconnect | offset resume | nextIndex | 已有能力，需把连接生命周期与 cursor 绑定。 |
| 快照追平 | retention 外切换 snapshot | base backup | snapshot/clone | rebuild from compacted topic | snapshot | 已有 fallback；应保留“超过窗口走快照”负例。 |
| 扇出成本 | 每个边缘独立 offer/分页/Blob 读取 | WAL sender per standby | binlog stream per replica | broker fan-out | leader sends per follower | 目前中心读放大为 O(edges × delta/blob)，100 节点必须量 CPU、带宽和 pin 生命周期。 |

## 结论

协议的可靠性要素大多存在，但生产路径仍是 `pull -> watch -> pull`：`runFleetReplicaSync` 在 watch 看到新 cut 后返回，下一轮重新拉取。它在互联网延迟下增加一次通知往返，并使持续负载的传播延迟取决于 watch 重连和 offer 准备时间。建议第③项把已建立 TLS session 变为有界发送队列：追平后持续发送 delta/snapshot frame，按序应用，周期性 ACK；断线从最后 ACK 续传，超出 retention 才 snapshot。

## 测量方法

`replica-load.mjs` 在服务器运行，接受 10/50/100 节点、事件速率、持续时间、人工延迟与限速参数，保留每个事件的 issued/completed 时间和失败 stderr，并输出 p50/p95/p99。`--command` 应调用实际中心写入/边缘观测命令；脚本不会伪造确认时间。当前 worktree 没有公司服务器凭据或网络整形权限，因此 10/50/100 与 50/200ms 的数字为 **unverified**，待服务器执行后把 JSON 原始数据附在任务 artifacts。

示例：

```sh
node tools/stress/fleet/replica-load.mjs --nodes 10 --events-per-second 5 --duration 300 --delay-ms 50 --bandwidth-kbps 512 --command 'ha fleet stress-event --node "$FLEET_NODE_ID" --event "$FLEET_EVENT_ID"' --output artifacts/fleet-baseline-10-50ms.json
```
