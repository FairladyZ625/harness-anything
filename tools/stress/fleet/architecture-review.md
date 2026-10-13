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

本轮尚无服务器实测数据。指定隔离服务器资源观测为空闲（16 CPU、29.65 GiB 可用内存；预算 12 CPU / 24 GiB），但获准的 `dispatch-isolated-test.mjs` 只接受登记的 Node/Vitest 测试，并在远端固定调用 `node tools/run-node-tests.mjs`；它不提供任意命令执行入口。仓库也不存在示例所写的 `ha fleet stress-event` 命令或本任务需要的生产中心写入/边缘到达观测 adapter。因此无法通过该服务器通道启动任务要求的真实中心与边缘负载。未连接或操作中心服务。

现有 `replica-load.mjs` 不能充当实测证据：`--delay-ms` 和 `--bandwidth-kbps` 仅传入子进程环境变量，没有执行网络整形；每个节点的完成时间是整批命令结束时间，不是各边缘实际应用事件的时间；运行器也没有采集中心 CPU、内存或带宽。它的本地 stub smoke 只验证输出格式。10/50/100 节点、50/200ms、吞吐上限、传播 p50/p95/p99、追赶有界性及资源曲线均为 **unverified**，本轮不附伪造 JSON。

继续服务器实测前需提供可在隔离服务器执行的真实 workload adapter：它必须创建/复用任务专用中心和边缘进程、报告每条事件在边缘应用的时间与 revision，并能注入 50/200ms 延迟和限速。否则 dispatcher 的测试执行模型与压测目标不相容。
