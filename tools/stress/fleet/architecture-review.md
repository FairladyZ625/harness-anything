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

## 实测

服务器实测使用 `dispatch-isolated-test.mjs --target server --file packages/daemon/test/fleet-replica-load.integration.test.mjs` 执行真实多进程 workload。中心 worker 以独立 Node 进程启动 `openDaemonHost` 与生产 Fleet TLS listener；每个边缘以独立进程、独立 Git 工作区和 user root 启动 remote-edge `openDaemonHost`，由 daemon 自动运行生产副本同步。中心连续执行 `task-create` 并记录完成时间与 ledger revision；边缘每 10ms 检查自己的 `current.json`，首次观察到 `cut.revision >= target revision` 时记录到达时间。中心 worker 每 500ms 采集自身 CPU 与 RSS。TCP 代理对每个转发 chunk 实施时延，并按连接、按方向限速。

到达时间是边缘读模型 current cut 的首次观察，精度受 10ms 轮询和调度影响；中心 CPU/RSS 是中心 worker 进程读数，不含 edge workers 与代理资源。限速按每条 TCP 连接的每个方向生效，不能直接等同共享 WAN 链路总带宽。

| 节点 / 网络 | 写入数 | 实测写入率 | 到达延迟 p50 / p95 / p99 | 最大 revision lag | 最终追平 | 中心 CPU 峰值 / RSS 范围 | 代理转发字节 |
| --- | ---: | ---: | ---: | ---: | --- | --- | ---: |
| 3 / 0ms smoke, 3s | 5 | 1.42/s | 1.272 / 2.043 / 2.043s | 6 | 是 | 2.03% / 469–673MB | 653,818 |
| 10 / 0ms, 15s | 18 | 1.15/s | 2.516 / 4.297 / 5.077s | 8 | 是 | 2.10% / 491–706MB | 7,864,009 |
| 10 / 50ms per forwarded chunk, 15s | 17 | 1.08/s | 2.242 / 3.904 / 4.171s | 6 | 是 | 2.22% / 503–732MB | 7,443,506 |
| 10 / 200ms per forwarded chunk, 15s | 22 | 1.45/s | 6.743 / 14.926 / 16.677s | 13 | 是 | 2.28% / 452–751MB | 9,468,200 |
| 3 / 2,048Kbps per connection direction, 5s | 11 | 2.11/s | 1.960 / 3.009 / 3.250s | 7 | 是 | 2.13% / 500–677MB | 1,459,158 |

10-node 50ms p50/p95 略低于无延迟单次运行；这些数据存在运行噪声，不表示延迟会改善传播。200ms 档的 p50 和尾延迟明显增加。三次 10 节点运行都在配置的 15 秒窗口持续写入，停止写入后全部边缘到达最终 revision。表中无节流写入率仅代表当前 `task-create` workload 的观测吞吐，不是所有写入类型的容量上限，也没有通过速率扫描求得最大值。

### 未收敛与资源上限

256Kbps/每连接方向档在 5 秒内接受 17 次写入，代理转发 253,518 字节；15 秒 catch-up allowance 后仍没有边缘 current cut。原始结果有 51 个预期到达样本缺失，`allEdgesCaughtUp` 为 false。

50 节点尝试在 dispatcher 分配的 4 CPU / 8 GiB shard 执行。中心 worker 启动 RSS 为 438,489,088 字节；28 个边缘 worker ready 时各自 RSS 为 352,894,976 至 380,461,056 字节。继续注册下一个边缘时中心 IPC channel 关闭（`ERR_IPC_CHANNEL_CLOSED`），持续写入尚未开始，因此这不是 50 节点传播结果。当前最大完成的持续负载档为 10 节点。50 节点完整压测和 100 节点均 **unverified**；50 节点尝试日志保留在任务 artifacts。100 节点未在 50 节点已超出当前 shard 资源包络后启动。

原始服务器 JSON：`harness/tasks/task_47eea76581a316a4a9c0b3b964-fleet/artifacts/load-3-node-smoke.json`、`load-10-node-0ms.json`、`load-10-node-50ms.json`、`load-10-node-200ms.json`、`load-3-node-2048kbps.json` 与 `load-3-node-256kbps-unreached.json`。50 节点启动/容量日志位于 `artifacts/load-50-node-capacity-attempt.log`。JSON 是测试原样输出的测量 payload。

这些数据补上了真实 workload 与到达观测，但还没有证明通用 Fleet 吞吐上限，也没有得到成功的 50/100 节点资源曲线。要继续这些档位，需要为隔离测试分配足以容纳数十个 daemon 进程的资源；当前指定文件 shard 为 8 GiB。不要从 10 节点曲线外推 100 节点表现。
