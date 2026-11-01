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

/**
 * 瞬时状态的宽限:投影落后、daemon/cell 尚无结论,必须连续观测到这么久才算「降级」。
 *
 * 依据:两路读面(`systemQuery` / `tasksQuery`)都是 10s 一个快照(`QUERY_PACING_MS`),
 * 所以 30s = 连续三个快照仍是同一状态,与 `DAEMON_OBSERVED_STALE_SEC` 的「连续三次
 * 没回来」同一取数。多 worker 并发写台账造成的落后通常是亚秒级,会在下一次快照前
 * 消失;跨过三个快照还落后就不是写放大,而是真的卡住。值直接取同一个常量,不另设
 * 配置项,也不新增轮询。
 */
export const TRANSIENT_GRACE_SEC = DAEMON_OBSERVED_STALE_SEC;

export type DaemonHealthState = "responsive" | "unresponsive" | "unknown";
export type CellHealthState = SystemRepoRow["cellState"] | "unknown";

/**
 * 三档灯 + 两个中性档：
 * - `syncing`:投影瞬时落后,正在追;
 * - `starting`:daemon 刚起/仓在挂载/水合还没读完;
 * - `degraded`:瞬时状态跨过宽限,或有隔离行这类真实不完整;
 * - `down`:daemon 无响应或仓不可用。
 */
export type RuntimeHealthLevel = "ok" | "syncing" | "starting" | "degraded" | "down";

/** 跨快照推进的瞬时状态起点;只由 `deriveRuntimeHealth` 读写,调用方原样回传。 */
export interface RuntimeHealthTransient {
  /** lag>0 首次被观测到的时刻;null = 当前没有落后。 */
  readonly lagSince: string | null;
  /** daemon 或 cell 第一次没有结论的时刻;null = 两者都有结论。 */
  readonly unknownSince: string | null;
  /** 本快照按 now 算出的已持续秒数;null = 当前不处于该状态。 */
  readonly lagAgeSec: number | null;
  readonly unknownAgeSec: number | null;
}

export const EMPTY_RUNTIME_HEALTH_TRANSIENT: RuntimeHealthTransient = {
  lagSince: null,
  unknownSince: null,
  lagAgeSec: null,
  unknownAgeSec: null,
};

/** enabled 仓里已 attached 的数量;只用于「启动中」的一句话说明。 */
export interface RuntimeHealthMount {
  readonly attached: number;
  readonly total: number;
}

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
  /** 首次 tasksQuery 尚未返回;与读完后仍未知的 projection 区分。 */
  readonly loading: boolean;
  readonly status: "ready" | "pending" | null;
  /**
   * `repo.tasks.list` 亲口报出的被隔离行数。非 0 意味着 daemon 拿着 ledger 里的行却拒绝服务它,
   * 行集相对 watermark **不完整**——此时「落后 0 revisions」是假象,侧栏必须说「不完整」而不是「已追平」。
   * null = 还没读到过切面。
   */
  readonly isolatedRows: number | null;
  /**
   * 切面还带着 `page.nextCursor`:水化没读完,行集只是已读到的部分。lag 可以是 0,
   * 所以完整性与落后是两个独立事实,不能用 lag 推断前者。
   */
  readonly hydrating: boolean;
}

export interface RuntimeHealthLedgerChange {
  readonly at: string | null;
  readonly ageSec: number | null;
}

export interface RuntimeHealth {
  readonly daemon: RuntimeHealthDaemon;
  readonly cell: RuntimeHealthCell;
  readonly projection: RuntimeHealthProjection;
  readonly transient: RuntimeHealthTransient;
  readonly mount: RuntimeHealthMount | null;
  readonly ledgerChange: RuntimeHealthLedgerChange;
}

export interface RuntimeHealthInput {
  /** null = 查询还没回来过;state 由调用方按 isError 折算。 */
  readonly daemon: {
    readonly ok: boolean;
    readonly observedAt: string | null;
    readonly uptimeMs: number | null;
  } | null;
  readonly repo:
    | (Pick<SystemRepoRow, "cellState" | "queueDepth" | "lastError" | "unavailableReason"> & {
        readonly mode?: SystemRepoRow["mode"];
      })
    | null;
  readonly projection: {
    readonly watermark: number;
    readonly sourceRevision: number;
    readonly status: "ready" | "pending";
    /** The isolated-row count the same read reported; omitted when the caller does not carry it. */
    readonly isolatedRows?: number;
    /**
     * The answered cut still carries `page.nextCursor`: hydration stopped at the page budget, so the
     * row set is only the pages read so far. Omitted when the caller does not carry it. This is a
     * distinct fact from `status === "pending"`: a lagging projection still answers a row set that is
     * complete *relative to its watermark*, and only the cut's own cursor tells us the difference.
     */
    readonly hydrating?: boolean;
  } | null;
  /** TanStack isLoading: pending 且正在请求,不会把未选仓的 disabled query 算成加载。 */
  readonly projectionLoading?: boolean;
  /**
   * 上一份派生携带的瞬时起点(只取两个 since)。调用方跨快照原样回传,不用新增轮询;
   * 不传 = 本快照是第一次观测,所有瞬时状态从 0s 起算。
   */
  readonly prior?: Pick<RuntimeHealthTransient, "lagSince" | "unknownSince">;
  /** daemon 全局挂载进度;读不到时不传。 */
  readonly mount?: RuntimeHealthMount;
  readonly lastSnapshotAt: string | null;
  readonly now: string;
}

function ageSec(from: string | null, now: string): number | null {
  if (from === null) return null;
  const at = Date.parse(from),
    current = Date.parse(now);
  if (!Number.isFinite(at) || !Number.isFinite(current)) return null;
  return Math.max(0, Math.round((current - at) / 1_000));
}

export function deriveRuntimeHealth(input: RuntimeHealthInput): RuntimeHealth {
  const observedAgeSec = ageSec(input.daemon?.observedAt ?? null, input.now);
  const daemonState: DaemonHealthState =
    input.daemon === null
      ? "unknown"
      : input.daemon.ok === false || (observedAgeSec !== null && observedAgeSec > DAEMON_OBSERVED_STALE_SEC)
        ? "unresponsive"
        : "responsive";
  const cell = input.repo;
  const remoteProxy = cell?.mode === "remote-proxy";
  const cellState: CellHealthState =
    remoteProxy && cell.cellState === "not_loaded" ? "attached" : (cell?.cellState ?? "unknown");
  const lag =
    input.projection === null ? null : Math.max(0, input.projection.sourceRevision - input.projection.watermark);
  const lagSince = lag !== null && lag > 0 ? (input.prior?.lagSince ?? input.now) : null;
  const unknownSince =
    daemonState === "unknown" || cellState === "unknown" ? (input.prior?.unknownSince ?? input.now) : null;
  return {
    daemon: { state: daemonState, observedAgeSec, uptimeMs: input.daemon?.uptimeMs ?? null },
    cell: {
      state: cellState,
      queueDepth: cell?.queueDepth ?? null,
      problem:
        remoteProxy && cell.cellState === "not_loaded"
          ? null
          : cell
            ? (cell.lastError ?? cell.unavailableReason)
            : null,
    },
    projection:
      input.projection === null
        ? {
            lag: null,
            loading: input.projectionLoading === true,
            status: null,
            isolatedRows: null,
            hydrating: false,
          }
        : {
            lag,
            loading: false,
            status: input.projection.status,
            isolatedRows: Math.max(0, input.projection.isolatedRows ?? 0),
            hydrating: input.projection.hydrating === true,
          },
    transient: {
      lagSince,
      unknownSince,
      lagAgeSec: lagSince === null ? null : ageSec(lagSince, input.now),
      unknownAgeSec: unknownSince === null ? null : ageSec(unknownSince, input.now),
    },
    mount: input.mount ?? null,
    ledgerChange: { at: input.lastSnapshotAt, ageSec: ageSec(input.lastSnapshotAt, input.now) },
  };
}

/** 灯色之外还要知道「为什么」:面板据此给出一句话,判定只在这里做一次。 */
export type RuntimeHealthCause =
  | { readonly kind: "daemon-unresponsive" }
  | { readonly kind: "cell-unavailable"; readonly problem: string | null }
  | { readonly kind: "projection-isolated"; readonly rows: number }
  | { readonly kind: "cell-warming" }
  | { readonly kind: "cell-not-loaded" }
  | { readonly kind: "projection-hydrating" }
  | { readonly kind: "projection-lag"; readonly lag: number; readonly ageSec: number }
  | { readonly kind: "daemon-unknown"; readonly ageSec: number }
  | { readonly kind: "cell-unknown"; readonly ageSec: number };

export interface RuntimeHealthAssessment {
  readonly level: RuntimeHealthLevel;
  readonly cause: RuntimeHealthCause | null;
}

/**
 * 唯一判定入口。顺序即优先级:
 * 1. daemon 无响应 = down;单仓不可用只降级仓库健康;
 * 2. 隔离行是真不完整,哪怕 lag 刚出现也是 degraded;
 * 3. 挂载/水合是中性 starting(挂载失败会落到 unavailable,不靠 warming 超时猜);
 * 4. 落后与「无结论」先按瞬时状态给中性档,跨过 TRANSIENT_GRACE_SEC 才降级。
 */
export function runtimeHealthAssessment(health: RuntimeHealth): RuntimeHealthAssessment {
  if (health.daemon.state === "unresponsive") {
    return { level: "down", cause: { kind: "daemon-unresponsive" } };
  }
  if (health.cell.state === "unavailable") {
    return { level: "degraded", cause: { kind: "cell-unavailable", problem: health.cell.problem } };
  }
  const isolatedRows = health.projection.isolatedRows ?? 0;
  if (isolatedRows > 0) {
    return { level: "degraded", cause: { kind: "projection-isolated", rows: isolatedRows } };
  }
  if (health.cell.state === "warming") return { level: "starting", cause: { kind: "cell-warming" } };
  if (health.cell.state === "not_loaded") return { level: "starting", cause: { kind: "cell-not-loaded" } };
  if (health.projection.hydrating) return { level: "starting", cause: { kind: "projection-hydrating" } };
  const lag = health.projection.lag ?? 0;
  if (lag > 0) {
    const ageSec = health.transient.lagAgeSec ?? 0;
    return {
      level: ageSec >= TRANSIENT_GRACE_SEC ? "degraded" : "syncing",
      cause: { kind: "projection-lag", lag, ageSec },
    };
  }
  if (health.daemon.state === "unknown") {
    const ageSec = health.transient.unknownAgeSec ?? 0;
    return {
      level: ageSec >= TRANSIENT_GRACE_SEC ? "degraded" : "starting",
      cause: { kind: "daemon-unknown", ageSec },
    };
  }
  if (health.cell.state === "unknown") {
    const ageSec = health.transient.unknownAgeSec ?? 0;
    return {
      level: ageSec >= TRANSIENT_GRACE_SEC ? "degraded" : "starting",
      cause: { kind: "cell-unknown", ageSec },
    };
  }
  return { level: "ok", cause: null };
}

/** 健康卡的整体灯;判定口径统一走 `runtimeHealthAssessment`。 */
export function runtimeHealthWorst(health: RuntimeHealth): RuntimeHealthLevel {
  return runtimeHealthAssessment(health).level;
}
