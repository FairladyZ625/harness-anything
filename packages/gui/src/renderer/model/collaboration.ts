import type { TaskRow } from "./types.ts";

/**
 * lease 结构字段的共享查看侧模型。协作页舰队拓扑(task_8ce646d94)改由
 * `repo.fleet.overview.read` 在 daemon 侧聚合后,这里只保留列表/任务详情仍在
 * 消费的结构消费函数:会话标识剥离与节点来源判定。语义与 kernel 同源,不重立规则:
 * - executor id 是 daemon 写侧的 runtime-session 执行会话;
 * - lease/v1.source 的 node 通道携带 nodeId;local/remote_direct 是写入通道词,
 *   不据此推断节点在线;
 * - 台账里只有边缘节点有 nodeId,中心的保留 id 由 daemon 的 fleet overview DTO 定义。
 */

/** daemon 写侧的 executor id 格式 `runtime-session:<sessionId>`(agent-runtime-stream);剥出会话 id 供跳转,不匹配则无链接。 */
export function leaseRuntimeSessionIdOf(leaseActor: TaskRow["leaseActor"]): string | null {
  const executor = leaseActor?.executor;
  if (executor === null || executor === undefined) return null;
  return executor.id.startsWith("runtime-session:") ? executor.id.slice("runtime-session:".length) : null;
}

/** lease 来源节点(node 通道携带 nodeId;local/remote_direct 无节点,返回 null 不猜)。 */
export function leaseNodeIdOf(leaseSource: TaskRow["leaseSource"]): string | null {
  return typeof leaseSource === "object" && leaseSource !== null && leaseSource.kind === "node"
    ? leaseSource.nodeId
    : null;
}

const ACTIVE_LEASE_PHASES = new Set(["held", "reserving"]);

/** 执行中只认 lease phase(held/reserving);orphaned/released 是持有人还在但不在执行,phase 缺失也不算。 */
export const isExecutingLeasePhase = (phase: string | undefined): boolean =>
  phase !== undefined && ACTIVE_LEASE_PHASES.has(phase);
