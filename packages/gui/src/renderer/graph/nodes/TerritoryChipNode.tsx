import type { NodeProps } from "@xyflow/react";
import { ArrowsOutSimple } from "@phosphor-icons/react";
import type { TaskRow, DecisionRow } from "../../model/types";
import { STATUS_META } from "../../components/badges";

/**
 * L1 领地总览的实体 chip 节点(IA v2 Layer 0)。
 *
 * 两种形态(同一组件按 skel 切换):
 *   task skel     — 紧凑一条(30px 高):状态色点 + 标题 + hiddenCount 徽章。点击 → 聚光灯(L2)。
 *   decision skel — 家族卡片(92px 高):标题 + 状态标签 + coverage 灯 + 历史版本 / 派生计数。
 *                   带视觉「堆叠」效果(historyCount>0 时背后错开两层,= 同一决策的多个版本)。
 *
 * 与 EgoNode(L2 的 chip/card)同源但不同行:L1 chip 的点击语义是「进聚光灯」而非 L2 的
 * 「就地展开」。所以交互回调叫 onOpen(切到 L2 + openFocus),不是 onCollapse/expandNode。
 * chip 本身不展开成卡片 —— 详情是 L2 / L3 的职责,L1 只负责分区与健康信号。
 *
 * 另有 entity='fold' 的特殊 chip:zone 折叠态底部的「▸ 还有 N 项」提示,点击 → 展开 zone。
 */

interface ChipData {
  entity: "task" | "decision" | "fold";
  skel?: "task" | "decision";
  raw?: TaskRow | DecisionRow;
  label?: string;
  color?: string;
  dimmed?: boolean;
  hiddenCount?: number;
  state?: string;
  coverage?: { covered: number; total: number; uncovered: number };
  historyCount?: number;
  derivedCount?: number;
  riskTier?: string;
  urgency?: string;
  unlanded?: boolean;
  navRef?: string;
  zoneId?: string;
  onOpen?: (ref: string) => void;
  onFold?: (id: string) => void;
}

const KD_LETTER: Record<string, string> = { task: "T", decision: "D" };
const AXIS_VAR: Record<string, string> = {
  task: "var(--color-axis-execution)",
  decision: "var(--color-axis-authority)",
};
const DECISION_STATE_COLOR: Record<string, string> = {
  proposed: "var(--color-status-in-review)",
  active: "var(--color-axis-authority)",
  deferred: "var(--color-status-planned)",
  retired: "var(--color-text-faint)",
  rejected: "var(--color-status-cancelled)",
};

export function TerritoryChipNode({ data }: NodeProps) {
  const d = data as unknown as ChipData;

  // fold 提示行
  if (d.entity === "fold") {
    return (
      <button
        onClick={(e) => {
          e.stopPropagation();
          if (d.zoneId) d.onFold?.(d.zoneId);
        }}
        className="flex h-full w-full items-center justify-center rounded-md border border-dashed border-border px-2 py-0.5 text-[11.5px] text-text-muted hover:border-[var(--color-border-strong)] hover:text-text"
      >
        {d.label}
      </button>
    );
  }

  if (d.skel === "decision") {
    return <DecisionCardChip d={d} />;
  }
  return <TaskChip d={d} />;
}

function TaskChip({ d }: { d: ChipData }) {
  const axis = AXIS_VAR[d.entity] ?? AXIS_VAR.task;
  return (
    <div
      onClick={(e) => {
        e.stopPropagation();
        if (d.navRef) d.onOpen?.(d.navRef);
      }}
      className={`flex h-full w-full cursor-pointer items-center gap-2 overflow-hidden rounded-lg border bg-surface-raised px-2.5 transition-colors hover:border-[var(--color-border-strong)] ${
        d.dimmed ? "opacity-60" : ""
      }`}
      style={{ borderColor: "var(--color-border)" }}
    >
      <span
        className="grid size-[18px] shrink-0 place-items-center rounded font-mono text-[10px] font-bold"
        style={{
          backgroundColor: `color-mix(in srgb, ${axis} 18%, transparent)`,
          color: axis,
        }}
      >
        {KD_LETTER[d.entity] ?? "?"}
      </span>
      <span
        className="size-[7px] shrink-0 rounded-full"
        style={{ backgroundColor: d.color ?? "var(--color-status-planned)" }}
      />
      <span
        className={`ui-body min-w-0 flex-1 truncate text-[12.5px] ${
          d.dimmed ? "text-text-muted" : "text-text"
        }`}
      >
        {d.label}
      </span>
      {d.hiddenCount !== undefined && d.hiddenCount > 0 && (
        <span className="shrink-0 rounded-full bg-surface px-1.5 py-0.5 font-mono text-[10px] text-text-faint">
          +{d.hiddenCount}
        </span>
      )}
      <ArrowsOutSimple
        weight="bold"
        className="shrink-0 text-[11px] text-text-faint"
      />
    </div>
  );
}

function DecisionCardChip({ d }: { d: ChipData }) {
  const axis = AXIS_VAR.decision;
  const hasHistory = (d.historyCount ?? 0) > 0;
  const state = d.state ?? "active";
  const stateColor = DECISION_STATE_COLOR[state] ?? axis;

  return (
    // 堆叠效果:historyCount>0 时,relative 容器后跟两个 absolute 层(错开 4px / 8px)。
    // 通过包裹层实现 —— 但 React Flow 节点尺寸固定,堆叠只在节点内视觉表达。
    <div className="relative h-full w-full">
      {hasHistory && (
        <>
          <div
            className="absolute inset-0 rounded-xl border bg-surface"
            style={{
              transform: "translate(5px, 5px)",
              borderColor: "var(--color-border)",
              opacity: 0.5,
            }}
          />
          <div
            className="absolute inset-0 rounded-xl border bg-surface"
            style={{
              transform: "translate(3px, 3px)",
              borderColor: "var(--color-border)",
              opacity: 0.75,
            }}
          />
        </>
      )}
      <div
        onClick={(e) => {
          e.stopPropagation();
          if (d.navRef) d.onOpen?.(d.navRef);
        }}
        className="relative flex h-full w-full cursor-pointer flex-col gap-1.5 overflow-hidden rounded-xl border bg-surface-raised px-3 py-2 transition-colors hover:border-[var(--color-axis-authority)]"
        style={{
          borderColor: d.unlanded
            ? "color-mix(in oklch, var(--color-danger) 30%, transparent)"
            : "var(--color-border)",
        }}
      >
        {/* 标题(最多 2 行)*/}
        <p
          className="ui-body line-clamp-2 text-[12.5px] font-semibold leading-snug text-text"
          style={{ display: "-webkit-box", WebkitLineClamp: 2, WebkitBoxOrient: "vertical", overflow: "hidden" }}
        >
          {d.label}
        </p>

        {/* 健康行:状态 + coverage 灯 + 历史版本 + 派生 */}
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1 ui-meta text-[10.5px]">
          <span
            className="rounded px-1.5 py-0.5 font-mono text-[10px] font-bold uppercase"
            style={{
              color: stateColor,
              backgroundColor: `color-mix(in oklch, ${stateColor} 14%, transparent)`,
            }}
          >
            {state}
          </span>
          {d.coverage && d.coverage.total > 0 && (
            <span className="flex items-center gap-1">
              {Array.from({ length: Math.min(d.coverage.total, 8) }).map((_, i) => (
                <span
                  key={i}
                  className="inline-block h-[6px] w-[6px] rounded-[1px]"
                  style={{
                    backgroundColor:
                      i < d.coverage!.covered
                        ? "var(--color-status-done)"
                        : "var(--color-danger)",
                  }}
                />
              ))}
            </span>
          )}
          {hasHistory && (
            <span style={{ color: "var(--color-axis-authority)" }}>
              ⧉ {d.historyCount}
            </span>
          )}
          {d.derivedCount !== undefined && d.derivedCount > 0 && (
            <span className="flex items-center gap-1" style={{ color: "var(--color-axis-execution)" }}>
              ▸ {d.derivedCount} 派生
            </span>
          )}
          {d.riskTier === "high" && (
            <span style={{ color: "var(--color-danger)" }}>high risk</span>
          )}
        </div>
      </div>
    </div>
  );
}

/** GraphView minimap 用:territoryChip 的 entity → 轴色。 */
export function territoryChipColor(entity: string): string {
  return AXIS_VAR[entity] ?? "var(--color-border-strong)";
}

/** statusColor 兜底(task 无 STATUS_META 命中时)。re-export 以便 GraphView 共享。 */
export { STATUS_META };
