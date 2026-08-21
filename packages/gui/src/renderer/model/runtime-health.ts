import type { SystemRepoRow } from "../api-client.ts";

/**
 * 第四格「运行时健康」的纯派生模型:只消费现有可读面,不改 daemon 协议。
 *
 * 输入三路:
 * - daemon.gui.system.read(systemQuery):响应成败、observedAt(最近一次成功
 *   观测时刻——daemon 冻死时轮询挂起,该年龄会持续增长,这是 2026-08-21
 *   那类停摆在本格的显影方式)、uptime、本仓 cell 状态。
 * - repo.tasks.list(tasksQuery):watermark/sourceRevision/status——投影落后
 *   = sourceRevision − watermark,与侧栏「台账追赶中」同一对数字。
 * - 任务行 updatedAt 最大值:最新一次落到台账的任务快照时间。
 *
 * 阈值:systemQuery 轮询 10s 一次;observedAt 年龄超过 30s(连续三次未回来)
 * 判 unresponsive,比单次失败更稳(瞬时抖动不红)。
 */
export const DAEMON_OBSERVED_STALE_SEC = 30;

export type DaemonHealthState = "responsive" | "unresponsive" | "unknown";
export type CellHealthState = SystemRepoRow["cellState"] | "unknown";

export interface RuntimeHealthDaemon {
  readonly state: DaemonHealthState;
  /** 距最近一次成功观测的秒数;从未成功过为 null。 */
  readonly observedAgeSec: number | null;
  readonly uptimeMs: number | null;
}

export interface RuntimeHealthCell {
  readonly state: CellHealthState;
  readonly queueDepth: number | null;
  /** unavailable/not_loaded 时的原因(lastError 优先)。 */
  readonly problem: string | null;
}

export interface RuntimeHealthProjection {
  /** sourceRevision − watermark;null = 投影尚未读到。 */
  readonly lag: number | null;
  readonly status: "ready" | "pending" | null;
}

export interface RuntimeHealthLedgerChange {
  readonly at: string | null;
  readonly ageSec: number | null;
}

export interface RuntimeHealth {
  readonly daemon: RuntimeHealthDaemon;
  readonly cell: RuntimeHealthCell;
  readonly projection: RuntimeHealthProjection;
  readonly ledgerChange: RuntimeHealthLedgerChange;
}

export interface RuntimeHealthInput {
  /** null = 查询还没回来过;state 由调用方按 isError 折算。 */
  readonly daemon: { readonly ok: boolean; readonly observedAt: string | null; readonly uptimeMs: number | null } | null;
  readonly repo: Pick<SystemRepoRow, "cellState" | "queueDepth" | "lastError" | "unavailableReason"> | null;
  readonly projection: { readonly watermark: number; readonly sourceRevision: number; readonly status: "ready" | "pending" } | null;
  readonly lastSnapshotAt: string | null;
  readonly now: string;
}

function ageSec(from: string | null, now: string): number | null {
  if (from === null) return null;
  const at = Date.parse(from), current = Date.parse(now);
  if (!Number.isFinite(at) || !Number.isFinite(current)) return null;
  return Math.max(0, Math.round((current - at) / 1_000));
}

export function deriveRuntimeHealth(input: RuntimeHealthInput): RuntimeHealth {
  const observedAgeSec = ageSec(input.daemon?.observedAt ?? null, input.now);
  const daemonState: DaemonHealthState = input.daemon === null
    ? "unknown"
    : input.daemon.ok === false || (observedAgeSec !== null && observedAgeSec > DAEMON_OBSERVED_STALE_SEC)
      ? "unresponsive"
      : "responsive";
  const cell = input.repo;
  return {
    daemon: { state: daemonState, observedAgeSec, uptimeMs: input.daemon?.uptimeMs ?? null },
    cell: {
      state: cell?.cellState ?? "unknown",
      queueDepth: cell?.queueDepth ?? null,
      problem: cell ? cell.lastError ?? cell.unavailableReason : null,
    },
    projection: input.projection === null
      ? { lag: null, status: null }
      : { lag: Math.max(0, input.projection.sourceRevision - input.projection.watermark), status: input.projection.status },
    ledgerChange: { at: input.lastSnapshotAt, ageSec: ageSec(input.lastSnapshotAt, input.now) },
  };
}

/** 健康卡的整体灯:daemon 与 cell 任一红即红,投影落后只降黄。 */
export function runtimeHealthWorst(health: RuntimeHealth): "ok" | "degraded" | "down" {
  if (health.daemon.state === "unresponsive" || health.cell.state === "unavailable") return "down";
  if (health.cell.state === "warming" || health.cell.state === "not_loaded" || health.cell.state === "unknown"
    || health.daemon.state === "unknown" || (health.projection.lag ?? 0) > 0) return "degraded";
  return "ok";
}
