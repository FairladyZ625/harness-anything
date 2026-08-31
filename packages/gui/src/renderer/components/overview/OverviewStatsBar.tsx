import { useEffect, useState } from "react";
import { CaretDown, CaretUp } from "@phosphor-icons/react";
import type { WorkspaceSummaryRead } from "../../../api/renderer-dto.ts";
import { AxisBar, type Seg } from "./parts.tsx";
import { t } from "../../i18n/index.tsx";
import { consumeKnownError } from "../../../api/error-consumption.ts";

/**
 * 总览页最底部的可折叠统计窄条(task_b2fb4bc7)。
 *
 * 原侧栏任务普查块的全部内容(任务分状态、决策分状态、版本对)搬到这里,默认折叠成
 * 一行「统计 ▸」;任一异常指标(daemon 断连 / 投影落后 / 读失败)时折叠态整条变红并
 * 点名异常项。异常只改变颜色与文案,不替用户展开 —— 展开仍是显式动作。
 * 折叠状态记 localStorage;数据全部来自 OverviewView 已有的读面,零新增读。
 */

const STORAGE_KEY = "harness:gui:overview-stats-expanded";

export interface OverviewStatsAnomaly {
  readonly code: "daemon" | "projection" | "read";
  readonly label: string;
}

export function OverviewStatsBar({
  summary,
  revision,
  anomalies,
}: {
  readonly summary: WorkspaceSummaryRead;
  readonly revision: { readonly watermark: number; readonly sourceRevision: number } | null;
  readonly anomalies: readonly OverviewStatsAnomaly[];
}) {
  // 默认折叠:只有显式展开过才记 true,坏值/未设一律回落折叠。
  const [expanded, setExpanded] = useState<boolean>(() => readExpanded());
  useEffect(() => {
    writeExpanded(expanded);
  }, [expanded]);
  const abnormal = anomalies.length > 0;

  return (
    <section
      data-testid="overview-stats-bar"
      className={`shrink-0 border-t ${abnormal ? "border-danger/40 bg-danger/10" : "border-border bg-surface/60"}`}
    >
      <button
        type="button"
        data-testid="overview-stats-toggle"
        onClick={() => setExpanded((value) => !value)}
        aria-expanded={expanded}
        className={`flex h-[30px] w-full items-center gap-2 px-5 text-left font-mono text-[11px] ${
          abnormal ? "text-danger" : "text-text-faint"
        }`}
      >
        {expanded ? (
          <CaretUp weight="bold" className="size-3 shrink-0" />
        ) : (
          <CaretDown weight="bold" className="size-3 shrink-0" />
        )}
        <span className="shrink-0">{t("views.overviewView.statsTitle")}</span>
        {abnormal ? (
          <span className="min-w-0 flex-1 truncate" data-testid="overview-stats-anomaly">
            {anomalies.map((anomaly) => anomaly.label).join(" · ")}
          </span>
        ) : (
          <span className="min-w-0 flex-1 truncate">
            {t("views.overviewView.statsCollapsedHint", {
              tasks: String(summary.tasks.total),
              decisions: String(summary.decisions.total),
            })}
          </span>
        )}
      </button>
      {expanded ? (
        <div data-testid="overview-stats-detail" className="flex flex-col gap-3 px-5 pb-4 pt-1">
          <AxisBar label={t("views.overviewView.statsTasks")} segments={taskSegments(summary)} />
          <AxisBar label={t("views.overviewView.statsDecisions")} segments={decisionSegments(summary)} />
          <p className="font-mono text-[11px] text-text-faint">
            {revision === null
              ? t("views.overviewView.statsRevisionUnknown")
              : t("views.overviewView.statsRevision", {
                  watermark: revision.watermark.toLocaleString("en-US"),
                  sourceRevision: revision.sourceRevision.toLocaleString("en-US"),
                })}
          </p>
        </div>
      ) : null}
    </section>
  );
}

/** 分段颜色沿用 STATUS_META 的语义色,不另立第二套配色。 */
function taskSegments(summary: WorkspaceSummaryRead): Seg[] {
  const entries = Object.entries(summary.tasks.byStatus) as ReadonlyArray<
    [keyof WorkspaceSummaryRead["tasks"]["byStatus"], number]
  >;
  return entries.map(([status, count]) => ({
    key: String(status),
    count,
    color: statusColor(String(status)),
  }));
}

function decisionSegments(summary: WorkspaceSummaryRead): Seg[] {
  const entries = Object.entries(summary.decisions.byState) as ReadonlyArray<[string, number]>;
  return entries.map(([state, count]) => ({ key: state, count, color: statusColor(state) }));
}

function statusColor(status: string): string {
  const palette: Record<string, string> = {
    planned: "var(--color-status-planned)",
    active: "var(--color-status-active)",
    in_review: "var(--color-status-in-review)",
    blocked: "var(--color-status-blocked)",
    done: "var(--color-status-done)",
    cancelled: "var(--color-status-cancelled)",
    proposed: "var(--color-status-active)",
    in_effect: "var(--color-status-done)",
    rejected: "var(--color-status-blocked)",
    deferred: "var(--color-stale)",
    superseded: "var(--color-status-cancelled)",
    outcome_retired: "var(--color-status-cancelled)",
  };
  return palette[status] ?? "var(--color-status-unknown)";
}

function readExpanded(): boolean {
  try {
    return JSON.parse(window.localStorage.getItem(STORAGE_KEY) ?? "false") === true;
  } catch (cause) {
    consumeKnownError(cause);
    return false;
  }
}

function writeExpanded(expanded: boolean): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(expanded));
  } catch (cause) {
    // 隐私模式/quota 满:本会话折叠态仍生效,只是不跨会话记忆。
    consumeKnownError(cause);
  }
}
