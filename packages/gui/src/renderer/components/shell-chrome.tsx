import { ArrowClockwise, FolderSimple, CheckCircle, Sun, Moon, Desktop } from "@phosphor-icons/react";
import type { SystemRepoRow } from "../api-client.ts";
import { t } from "../i18n/index.tsx";
import { useTheme, type ThemeMode } from "../theme.tsx";

const THEME_CYCLE: Record<ThemeMode, ThemeMode> = {
  dark: "light",
  light: "system",
  system: "dark",
};

const THEME_ICON: Record<ThemeMode, React.ReactNode> = {
  dark: <Moon weight="duotone" />,
  light: <Sun weight="duotone" />,
  system: <Desktop weight="duotone" />,
};

export function ThemeToggle() {
  const { mode, setMode } = useTheme();
  return (
    <button
      onClick={() => setMode(THEME_CYCLE[mode])}
      title={`主题：${mode}（点击切换）`}
      className="grid size-6 place-items-center rounded text-text-faint hover:bg-surface-raised hover:text-text"
    >
      {THEME_ICON[mode]}
    </button>
  );
}

export function NavButton({
  active,
  onClick,
  icon,
  label,
  badge,
}: {
  active: boolean;
  onClick: () => void;
  icon: React.ReactNode;
  label: string;
  badge?: number;
}) {
  return (
    <button
      onClick={onClick}
      title={label}
      className={`flex min-w-0 items-center gap-2 rounded-md px-2.5 py-1.5 text-left text-[15px] leading-snug transition-colors duration-100 ${
        active
          ? "bg-surface-raised font-medium text-text"
          : "text-text-muted hover:bg-surface-raised/60 hover:text-text"
      }`}
    >
      <span className="shrink-0 text-base">{icon}</span>
      <span className="min-w-0 truncate">{label}</span>
      {badge !== undefined && badge > 0 && (
        <span className="ml-auto shrink-0 rounded bg-accent px-1.5 font-mono text-[11px] font-semibold tabular-nums text-accent-fg">
          {badge}
        </span>
      )}
    </button>
  );
}

/**
 * 左上角一行实时状态栏(task_b2fb4bc7,取代原任务普查块):
 * 事件/版本总数 + 最后刷新相对时间 + 手动刷新 + 连接状态圆点。
 *
 * 计数直读 daemon 报的投影事实(`repo.tasks.list` 的 sourceRevision),不在 renderer
 * 重数行;刷新走既有 react-query refetch,不加轮询密度。原普查块的分状态计数整体
 * 搬去总览页底部的 OverviewStatsBar(那里才是要读数字的地方)。
 */
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
      className={`flex h-[26px] items-center gap-1.5 font-mono text-[11px] ${
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

function relativeRefresh(seconds: number): string {
  if (seconds < 5) return t("components.appSidebar.ledgerJustNow");
  if (seconds < 90) return t("components.appSidebar.ledgerSecondsAgo", { seconds: String(seconds) });
  if (seconds < 5_400)
    return t("components.appSidebar.ledgerMinutesAgo", { minutes: String(Math.round(seconds / 60)) });
  return t("components.appSidebar.ledgerHoursAgo", { hours: String(Math.round(seconds / 3_600)) });
}

export function ProjectSummary({ repo, active, onOpen }: { repo: SystemRepoRow; active: boolean; onOpen: () => void }) {
  return (
    <button
      onClick={onOpen}
      disabled={repo.registrationState !== "enabled"}
      className={`flex w-full items-start gap-2 rounded-md border px-2.5 py-2 text-left transition-colors duration-100 ${
        active
          ? "border-accent/70 bg-accent/10"
          : repo.registrationState === "enabled"
            ? "border-border bg-surface hover:border-border-strong hover:bg-surface-raised"
            : "cursor-not-allowed border-border bg-surface opacity-60"
      }`}
    >
      <span className="mt-0.5 grid size-5 shrink-0 place-items-center rounded bg-surface-raised text-text-muted">
        <FolderSimple weight="duotone" />
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-[15px] font-semibold text-text">{repo.displayName}</span>
        <span className="block truncate font-mono text-[13px] text-text-faint">
          {repo.repoId} · {repo.registrationState} / {repo.cellState}
        </span>
        <span className="mt-1 flex flex-wrap gap-1.5 font-mono text-[12px] tabular-nums">
          <span className={repo.cellState === "attached" ? "text-status-done" : "text-status-blocked"}>
            {repo.cellState}
          </span>
          <span className="text-text-faint">queue {repo.queueDepth ?? "unknown"}</span>
          <span className="text-text-faint">lock {repo.lockState}</span>
        </span>
        {repo.cellState !== "attached" && (
          <span className="mt-1 block text-[11px] text-status-blocked">
            {repo.unavailableReason ?? repo.lastError ?? "unknown / 未投影"}
          </span>
        )}
      </span>
      {active && (
        <CheckCircle weight="fill" className="mt-0.5 shrink-0 text-[15px]" style={{ color: "var(--color-accent)" }} />
      )}
    </button>
  );
}
