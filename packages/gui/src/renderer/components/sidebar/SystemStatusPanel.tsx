import { ArrowClockwise, GearSix } from "@phosphor-icons/react";
import { runtimeHealthWorst, type RuntimeHealth } from "../../model/runtime-health.ts";
import { formatTime, formatUptimeMs } from "../../model/time.ts";
import { t } from "../../i18n/index.tsx";

const HEALTH_TONE = {
  ok: "text-success",
  degraded: "text-stale",
  down: "text-danger",
} as const;

const HEALTH_LAMP = {
  ok: "bg-success",
  degraded: "bg-stale",
  down: "bg-danger",
} as const;

const CELL_LABEL: Record<string, string> = {
  warming: "warming",
  attached: "attached",
  unavailable: "unavailable",
  not_loaded: "not_loaded",
  unknown: "—",
};

function relativeSeconds(seconds: number): string {
  if (seconds < 90) return t("components.appSidebar.ledgerSecondsAgo", { seconds: String(seconds) });
  if (seconds < 5_400)
    return t("components.appSidebar.ledgerMinutesAgo", { minutes: String(Math.round(seconds / 60)) });
  return t("components.appSidebar.ledgerHoursAgo", { hours: String(Math.round(seconds / 3_600)) });
}

function ageText(seconds: number | null): string {
  if (seconds === null) return t("components.appSidebar.healthUnknown");
  if (seconds < 5) return t("components.appSidebar.ledgerJustNow");
  return relativeSeconds(seconds);
}

function projectionText(health: RuntimeHealth): string {
  if (health.projection.lag === null) return t("components.appSidebar.healthLagUnknown");
  return t("components.appSidebar.healthLagRevs", { lag: String(health.projection.lag) });
}

/** 折叠面(悬浮提示)承载原健康卡四行信号:daemon/cell/投影/最近台账变化。 */
export function systemHealthDetail(health: RuntimeHealth): string {
  const daemon =
    health.daemon.state === "responsive"
      ? t("components.appSidebar.healthResponsive")
      : health.daemon.state === "unresponsive"
        ? t("components.appSidebar.healthUnresponsive")
        : t("components.appSidebar.healthUnknown");
  return [
    `${t("components.appSidebar.healthDaemon")}: ${daemon}` +
      (health.daemon.uptimeMs === null
        ? ""
        : ` · ${t("components.appSidebar.healthUptime")} ${formatUptimeMs(health.daemon.uptimeMs)}`),
    `${t("components.appSidebar.healthCell")}: ${CELL_LABEL[health.cell.state] ?? health.cell.state}` +
      (health.cell.queueDepth === null
        ? ""
        : ` · ${t("components.appSidebar.healthQueueDepth", { depth: String(health.cell.queueDepth) })}`) +
      (health.cell.problem ? ` · ${health.cell.problem}` : ""),
    `${t("components.appSidebar.healthProjection")}: ${projectionText(health)}` +
      (health.projection.status === "pending" ? ` · ${t("components.appSidebar.healthCatchingUp")}` : ""),
    `${t("components.appSidebar.healthLedgerChange")}: ${
      health.ledgerChange.at === null
        ? t("components.appSidebar.healthNever")
        : `${ageText(health.ledgerChange.ageSec)} · ${formatTime(health.ledgerChange.at, { style: "date-time-seconds" }) ?? "—"}`
    }`,
  ].join("\n");
}

export interface LedgerStatusBarInput {
  /** null = 还没读到过一次台账切面。 */
  readonly revision: number | null;
  /** 距最近一次成功刷新的秒数;null = 从未成功。 */
  readonly refreshedAgoSec: number | null;
  /** 连接状态:绿 = 最近一次读成功;红 = 最近一次读失败。 */
  readonly connected: boolean;
  readonly refreshing: boolean;
  readonly empty: boolean;
  readonly error: string | null;
}

function relativeRefresh(seconds: number): string {
  if (seconds < 5) return t("components.appSidebar.ledgerJustNow");
  return relativeSeconds(seconds);
}

/**
 * 系统运行区第一行(原左上角实时状态栏,task_b2fb4bc7 的产物):
 * 事件水位 + 相对刷新时间 + 手动刷新 + 连接圆点。
 *
 * 计数直读 daemon 报的投影事实(`repo.tasks.list` 的 sourceRevision),不在 renderer
 * 重数行;刷新走既有 react-query refetch,不加轮询密度。`real-task-summary` /
 * `task-empty-state` / `task-error-state` 三个 testid 是 e2e 与读基线工具的就绪探针,
 * 随本组件一起搬家,不随总览删除。
 */
export function LedgerStatusBar({
  status,
  onRefresh,
}: {
  readonly status: LedgerStatusBarInput;
  readonly onRefresh: () => void;
}) {
  const testId = status.error !== null ? "task-error-state" : status.empty ? "task-empty-state" : "real-task-summary";
  const headline =
    status.error !== null
      ? `${t("components.appSidebar.failedReadLedgerBridge")}: ${status.error}`
      : status.empty
        ? t("components.appSidebar.noTaskRowsFromLocalBridge")
        : t("components.appSidebar.ledgerEvents", {
            count: status.revision === null ? "—" : status.revision.toLocaleString("en-US"),
          });
  return (
    <span
      data-testid={testId}
      className={`flex h-[22px] min-w-0 items-center gap-1.5 font-mono text-[11px] ${
        status.error !== null ? "text-status-blocked" : "text-text-faint"
      }`}
    >
      <span
        data-testid="ledger-connection-dot"
        title={status.connected ? undefined : t("components.appSidebar.ledgerDisconnected")}
        className={`size-2 shrink-0 rounded-full ${status.connected ? "bg-success" : "bg-danger"}`}
      />
      <span className={`shrink-0 tabular-nums ${status.empty ? "" : "text-text"}`}>{headline}</span>
      <span className="min-w-0 flex-1 truncate">
        ·{" "}
        {status.refreshedAgoSec === null
          ? t("components.appSidebar.ledgerNeverRefreshed")
          : t("components.appSidebar.ledgerRefreshedAgo", { ago: relativeRefresh(status.refreshedAgoSec) })}
      </span>
      <button
        type="button"
        data-testid="ledger-refresh-button"
        onClick={onRefresh}
        disabled={status.refreshing}
        title={t("components.appSidebar.ledgerRefreshTitle")}
        aria-label={t("components.appSidebar.ledgerRefreshTitle")}
        className={[
          "shrink-0 rounded px-1 text-[11px] text-text-faint",
          "hover:bg-surface-raised hover:text-text disabled:opacity-50",
        ].join(" ")}
      >
        <ArrowClockwise weight="bold" className="size-3" />
      </button>
    </span>
  );
}

/**
 * 侧栏左下角的常驻紧凑系统运行区(账号区之上)。
 *
 * 2026-08-31 泽宇反馈收纳:总览主区的「运行时健康」大区块与左上角事件刷新条信息同族
 * 却分居两处,前者常态近乎全空却占一整行高度。两处信息在这里合并成两行:
 *   第一行 运行健康灯 + 观测年龄 + 投影落后 revisions,整行即「系统页」入口,
 *         四路信号细节(daemon/cell/投影/最近台账变化)进 title 悬浮提示;
 *   第二行 事件水位 + 相对刷新时间 + 手动刷新 + 连接圆点(原状态栏原样搬来)。
 * 信号面零新增:model/runtime-health.ts 继续只消费 systemQuery / tasksQuery /
 * 任务行 updatedAt。系统详情仍走既有「系统」页,本区不是新页面。
 */
export function SystemStatusPanel({
  status,
  health,
  onRefresh,
  onOpenSystem,
}: {
  readonly status: LedgerStatusBarInput;
  readonly health: RuntimeHealth;
  readonly onRefresh: () => void;
  readonly onOpenSystem: () => void;
}) {
  const worst = runtimeHealthWorst(health);
  return (
    <div data-testid="sidebar-system-status" className="shrink-0 border-t border-border px-3 pt-1.5 pb-2">
      {/* 第一行:整体灯色 +「系统页」入口。整行可点,细节四路信号在 title 悬浮提示。 */}
      <button
        type="button"
        data-testid="sidebar-system-status-open"
        onClick={onOpenSystem}
        title={systemHealthDetail(health)}
        aria-label={t("components.appSidebar.goSystemTitle")}
        className="flex h-[20px] w-full items-center gap-1.5 rounded text-left hover:bg-surface-raised/60"
      >
        <span
          data-testid="sidebar-system-status-lamp"
          className={`size-2 shrink-0 rounded-full ${HEALTH_LAMP[worst]}`}
        />
        <span className={`shrink-0 font-mono text-[11px] font-semibold ${HEALTH_TONE[worst]}`}>
          {worst === "ok"
            ? t("components.appSidebar.healthOk")
            : worst === "degraded"
              ? t("components.appSidebar.healthDegraded")
              : t("components.appSidebar.healthDown")}
        </span>
        <span className="ml-auto flex shrink-0 items-center gap-1 pl-1 font-mono text-[11px] text-accent">
          <GearSix weight="bold" className="size-3" />
          {t("components.appSidebar.goSystem")}
        </span>
      </button>
      {/* 第二行:观测年龄 + 投影落后 revisions。revisions 计数按约束保持可见(shrink-0)。 */}
      <div
        className="flex h-[18px] min-w-0 items-center gap-1.5 font-mono text-[11px] text-text-faint"
        title={systemHealthDetail(health)}
      >
        <span className="min-w-0 truncate">
          {t("components.appSidebar.healthObservedAge", { age: ageText(health.daemon.observedAgeSec) })}
        </span>
        <span className="shrink-0 truncate" data-testid="sidebar-system-status-projection">
          · {projectionText(health)}
        </span>
      </div>
      {/* 第三行:事件水位 + 相对刷新时间 + 手动刷新 + 连接圆点(原左上角状态栏整行搬来)。 */}
      <LedgerStatusBar status={status} onRefresh={onRefresh} />
    </div>
  );
}
