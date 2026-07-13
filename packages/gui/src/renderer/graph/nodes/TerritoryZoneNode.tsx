import type { NodeProps } from "@xyflow/react";
import type { SemanticAxis } from "../constants";
import { AXIS_COLOR_VAR } from "../constants";
import type { SnapshotStatus } from "../../model/types";
import { t } from "../../i18n/index.tsx";

/**
 * L1 领地总览的 zone 背景节点(IA v2 Layer 0)。
 *
 * 泛化自 LaneBackgroundNode(L2 三泳道背景):同样是「不参与点击拖拽的纯视觉分区壳」,
 * 但 L1 的 zone 承载更丰富的健康信号 —— task zone 画状态比例条 + done/active 计数,
 * decision zone 画 coverage 灯 + 状态分布。两种变体共享一个组件:
 *
 *   variant 'section' — 宽薄一行,只画 section 标题(里程碑 / 模块 / 未落地)。
 *   variant 'zone'    — 一块领地:header(标题 + 健康条 + meta)+ chip 容器底板。
 *
 * 节点尺寸由布局器算好通过 style.width/height + 顶层 width/height 同时给(顶层必给,
 * 否则 MiniMap 一个方块都不画 —— 同 ego 节点)。chip 是独立 React Flow 节点,叠在 zone 上。
 */

type Variant = "section" | "zone";

interface ZoneData {
  variant?: Variant;
  title?: string;
  subtitle?: string;
  skel?: "task" | "decision";
  axis?: SemanticAxis;
  virtual?: boolean;
  unlanded?: boolean;
  // task 健康:
  statusCounts?: Record<string, number>;
  isAllDone?: boolean;
  // decision 健康:
  stateCounts?: Record<string, number>;
  coverageSummary?: { covered: number; total: number; uncovered: number };
  historyTotal?: number;
  total?: number;
  folded?: boolean;
  zoneId?: string;
  onFold?: (id: string) => void;
}

const STATUS_BAR_ORDER: Array<{ key: SnapshotStatus; label: string; color: string }> = [
  { key: "blocked", get label() { return t("graph.territoryZoneNode.blocked"); }, color: "var(--color-status-blocked)" },
  { key: "active", get label() { return t("graph.territoryZoneNode.active"); }, color: "var(--color-status-active)" },
  { key: "in_review", get label() { return t("graph.territoryZoneNode.seal"); }, color: "var(--color-status-in-review)" },
  { key: "planned", get label() { return t("graph.territoryZoneNode.planned"); }, color: "var(--color-status-planned)" },
  { key: "done", get label() { return t("graph.territoryZoneNode.done"); }, color: "var(--color-status-done)" },
  { key: "cancelled", get label() { return t("graph.territoryZoneNode.cancelled"); }, color: "var(--color-status-cancelled)" },
];

const DECISION_STATE_COLOR: Record<string, string> = {
  proposed: "var(--color-status-in-review)",
  active: "var(--color-axis-authority)",
  deferred: "var(--color-status-planned)",
  retired: "var(--color-text-faint)",
  rejected: "var(--color-status-cancelled)",
};

export function TerritoryZoneNode({ data }: NodeProps) {
  const d = data as unknown as ZoneData;

  if (d.variant === "section") {
    return (
      <div className="flex h-full w-full items-end gap-3 px-1 pb-1">
        <span className="ui-body text-[14px] font-semibold text-text">{d.title}</span>
        {d.subtitle && (
          <span className="ui-meta text-[11.5px] text-text-faint">{d.subtitle}</span>
        )}
      </div>
    );
  }

  const axis = d.axis ?? "execution";
  const accent = d.unlanded
    ? "var(--color-danger)"
    : AXIS_COLOR_VAR[axis];
  const total = d.total ?? 0;

  return (
    <div
      className="flex h-full w-full flex-col overflow-hidden rounded-xl border bg-surface"
      style={{
        borderColor: d.unlanded
          ? "color-mix(in oklch, var(--color-danger) 40%, transparent)"
          : "var(--color-border)",
        borderWidth: d.unlanded ? 2 : 1,
      }}
    >
      {/* zone header */}
      <div
        className="flex shrink-0 flex-col gap-1.5 px-3 pt-2.5 pb-2 border-b"
        style={{ borderColor: "var(--color-border)" }}
      >
        <div className="flex items-center gap-2">
          <span
            className="inline-block h-2.5 w-2.5 shrink-0 rounded-sm"
            style={{ backgroundColor: accent, opacity: 0.7 }}
          />
          {d.isAllDone && (
            <span
              className="text-[12px] font-bold"
              style={{ color: "var(--color-status-done)" }}
            >
              ✓
            </span>
          )}
          <span
            className={`ui-body min-w-0 flex-1 truncate text-[13px] font-semibold ${
              d.virtual ? "text-text-muted" : "text-text"
            }`}
          >
            {d.title}
          </span>
          {d.folded !== undefined && d.zoneId && d.onFold && (
            <button
              onClick={(e) => {
                e.stopPropagation();
                d.onFold?.(d.zoneId!);
              }}
              className="shrink-0 rounded border border-border px-1.5 py-0.5 font-mono text-[10px] text-text-muted hover:border-[var(--color-border-strong)] hover:text-text"
            >
              {d.folded ? t("graph.territoryZoneNode.expand") : t("graph.territoryZoneNode.collapse")}
            </button>
          )}
        </div>

        {/* 健康条(task skel:状态比例条)*/}
        {d.skel === "task" && d.statusCounts && total > 0 && (
          <StatusBar counts={d.statusCounts} total={total} />
        )}

        {/* 健康条(decision skel:coverage 灯 + 状态分布)*/}
        {d.skel === "decision" && (
          <DecisionHealth
            coverage={d.coverageSummary}
            stateCounts={d.stateCounts}
            historyTotal={d.historyTotal}
          />
        )}

        {/* meta 行 */}
        {d.skel === "task" && d.statusCounts && (
          <TaskMeta counts={d.statusCounts} total={total} allDone={d.isAllDone ?? false} />
        )}
      </div>
      {/* chip 容器底板(实际 chip 是独立 RF 节点叠在 zone 的 body 区域)*/}
      <div className="flex min-h-0 flex-1 flex-col px-2 py-2" />
    </div>
  );
}

function StatusBar({ counts, total }: { counts: Record<string, number>; total: number }) {
  return (
    <div
      className="flex h-[5px] w-full overflow-hidden rounded-full"
      style={{ backgroundColor: "var(--color-surface-raised)" }}
    >
      {STATUS_BAR_ORDER.map(({ key, color }) => {
        const v = counts[key];
        if (!v) return null;
        return (
          <div
            key={key}
            style={{ width: `${(v / total) * 100}%`, backgroundColor: color }}
          />
        );
      })}
    </div>
  );
}

function TaskMeta({
  counts,
  total,
  allDone,
}: {
  counts: Record<string, number>;
  total: number;
  allDone: boolean;
}) {
  const items: Array<{ label: string; color?: string; bold?: boolean }> = [];
  if (counts.blocked)
    items.push({ label: `${counts.blocked} blocked`, color: "var(--color-status-blocked)", bold: true });
  if (counts.active)
    items.push({ label: `${counts.active} active`, color: "var(--color-status-active)", bold: true });
  if (counts.in_review) items.push({ label: t("graph.territoryZoneNode.reviewArchive", { in_review: counts.in_review }) });
  if (counts.planned) items.push({ label: `${counts.planned} planned` });
  if (counts.done)
    items.push({
      label: `${counts.done} done`,
      color: "var(--color-status-done)",
      bold: allDone,
    });
  if (counts.cancelled)
    items.push({ label: `${counts.cancelled} cancelled` });
  void total;
  return (
    <div className="flex flex-wrap gap-x-2.5 gap-y-0.5 ui-meta text-[11px] text-text-muted">
      {items.map((it, i) => (
        <span
          key={i}
          style={{
            color: it.color,
            fontWeight: it.bold ? 600 : 400,
            opacity: it.color ? 1 : undefined,
          }}
        >
          {it.label}
        </span>
      ))}
    </div>
  );
}

function DecisionHealth({
  coverage,
  stateCounts,
  historyTotal,
}: {
  coverage?: { covered: number; total: number; uncovered: number };
  stateCounts?: Record<string, number>;
  historyTotal?: number;
}) {
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 ui-meta text-[11px] text-text-muted">
      {coverage && coverage.total > 0 && (
        <span className="flex items-center gap-1.5">
          <span className="flex items-center gap-0.5">
            {/* coverage 灯:covered 绿 / uncovered 红 / 每灯一 claim,封顶 10 */}
            {Array.from({ length: Math.min(coverage.total, 10) }).map((_, i) => {
              const covered = i < coverage.covered;
              return (
                <span
                  key={i}
                  className="inline-block h-[7px] w-[7px] rounded-[1.5px]"
                  style={{
                    backgroundColor: covered
                      ? "var(--color-status-done)"
                      : "var(--color-danger)",
                  }}
                />
              );
            })}
          </span>
          <span>
            {t("graph.territoryZoneNode.claimCoverage", { covered: coverage.covered, total: coverage.total })}
          </span>
        </span>
      )}
      {stateCounts && (
        <span className="flex items-center gap-1.5">
          {Object.entries(stateCounts).map(([state, cnt]) => (
            <span
              key={state}
              className="rounded px-1 font-mono text-[10px]"
              style={{
                color: DECISION_STATE_COLOR[state] ?? "var(--color-text-muted)",
                backgroundColor: `color-mix(in oklch, ${
                  DECISION_STATE_COLOR[state] ?? "var(--color-text-muted)"
                } 12%, transparent)`,
              }}
            >
              {cnt} {state}
            </span>
          ))}
        </span>
      )}
      {historyTotal !== undefined && historyTotal > 0 && (
        <span style={{ color: "var(--color-axis-authority)" }}>
          ⧉ {historyTotal} {t("graph.territoryZoneNode.historicalVersion")}</span>
      )}
    </div>
  );
}
