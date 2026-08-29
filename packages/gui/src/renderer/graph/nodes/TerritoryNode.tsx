import type { NodeProps } from "@xyflow/react";
import { ArrowsOutSimple } from "@phosphor-icons/react";
import type { ZoneProgress } from "../territoryProgress";
import {
  zoneHeaderH,
  ZONE_PROGRESS_H,
  type TerritoryChipFlowNode,
  type TerritoryZoneFlowNode,
} from "../territoryLayout";

/**
 * L1 领地总览的两级节点(REQ-GUI-03 territory,archive 两级结构):
 *   TerritoryZoneNode  — zone 壳(标题 + 进度信号 + 折叠钮),自身不参与点击选中,
 *                        chip 是独立 React Flow 节点叠在壳的 body 区上。
 *   TerritoryChipNode  — zone 内实体 chip,单击进聚光灯;fold 变体是折叠态底部
 *                        「▸ 还有 N 项」提示行,单击展开 zone。
 *
 * 节点尺寸由 territoryLayout.ts 算好,style.width/height 与顶层 width/height 同时给
 * (顶层必给,否则 MiniMap 不画)。头部高度必须与布局常量同源(zoneHeaderH)。
 */

type Entity = "task" | "decision" | "fact";

const AXIS_VAR: Record<Entity, string> = {
  task: "var(--color-axis-execution)",
  decision: "var(--color-axis-authority)",
  fact: "var(--color-axis-evidence)",
};

/** 状态段配色(等亮度状态色,与视觉系统同源)。 */
const PROGRESS_SEGMENTS: ReadonlyArray<{ key: keyof ZoneProgress; label: string; color: string }> = [
  { key: "done", label: "完成", color: "var(--color-status-done)" },
  { key: "inReview", label: "评审", color: "var(--color-status-in-review)" },
  { key: "active", label: "进行", color: "var(--color-status-active)" },
  { key: "blocked", label: "阻塞", color: "var(--color-status-blocked)" },
  { key: "planned", label: "规划", color: "var(--color-status-planned)" },
  { key: "other", label: "其他", color: "var(--color-status-unknown)" },
];

export function TerritoryZoneNode({ data }: NodeProps<TerritoryZoneFlowNode>) {
  const zone = data.zone;
  const axis = AXIS_VAR[zone.entity] ?? AXIS_VAR.task;
  const headerH = zoneHeaderH(zone);
  const landing = data.variant === "landing";

  return (
    <div
      data-testid="territory-zone"
      data-zone-id={zone.zoneId}
      className={`flex h-full w-full flex-col overflow-hidden rounded-xl border bg-surface ${
        landing ? "border-dashed" : ""
      }`}
      style={{
        borderColor: zone.progress?.unprojected
          ? "color-mix(in oklch, var(--color-stale) 45%, var(--color-border))"
          : "var(--color-border)",
      }}
    >
      {/* zone header:高度与布局常量同源,固定不死(negative flex 由 body 吸收) */}
      <div className="flex shrink-0 flex-col border-b border-border" style={{ height: headerH }}>
        <div className="flex min-h-0 flex-1 items-center gap-2 px-3 pt-2" data-testid="territory-zone-header">
          <span
            className="inline-block size-2.5 shrink-0 rounded-sm"
            style={{ backgroundColor: axis, opacity: 0.75 }}
          />
          <span className="ui-body min-w-0 flex-1 truncate text-[13px] font-semibold text-text">{zone.title}</span>
          <span className="shrink-0 rounded bg-surface-raised px-1.5 py-0.5 font-mono text-[10px] text-text-faint">
            {zone.chips.length}
          </span>
          <button
            onClick={(e) => {
              e.stopPropagation();
              data.onFold(zone.zoneId);
            }}
            title={data.folded ? "展开全部 chip" : "折叠(只显热点)"}
            className="shrink-0 rounded border border-border px-1.5 py-0.5 font-mono text-[10px] text-text-muted hover:border-border-strong hover:text-text"
          >
            {data.folded ? "▸" : "▾"}
          </button>
        </div>
        {zone.progress && zone.progress.total > 0 && <ZoneProgressBar progress={zone.progress} />}
      </div>
      {/* chip 底板:实际 chip 是独立 RF 节点叠在这里 */}
      <div className="min-h-0 flex-1" />
    </div>
  );
}

/**
 * PRD 块进度条:状态比例条 + 完成率 + 阻塞计数。
 * 老版领地的核心可读性来源 —— 一眼看出「这个 PRD 推到哪了、卡没卡住」。
 * 高度占 ZONE_PROGRESS_H,与布局常量同源。
 */
function ZoneProgressBar({ progress }: { progress: ZoneProgress }) {
  return (
    <div className="flex flex-col gap-1 px-3 pb-2" style={{ height: ZONE_PROGRESS_H }} data-testid="zone-progress">
      <div className="flex h-1.5 w-full overflow-hidden rounded-full bg-surface-raised">
        {PROGRESS_SEGMENTS.map((segment) => {
          const count = progress[segment.key] as number;
          if (!count) return null;
          return (
            <span
              key={segment.key}
              title={`${segment.label} ${count}`}
              style={{ width: `${(count / progress.total) * 100}%`, background: segment.color }}
            />
          );
        })}
      </div>
      <div className="ui-micro flex items-center gap-2 font-mono text-text-faint">
        <span data-testid="zone-done-ratio">{Math.round(progress.doneRatio * 100)}% 完成</span>
        <span>
          {progress.done}/{progress.total}
        </span>
        {progress.blocked > 0 && <span className="text-danger">阻塞 {progress.blocked}</span>}
      </div>
    </div>
  );
}

export function TerritoryChipNode({ data }: NodeProps<TerritoryChipFlowNode>) {
  if (!data.chip) {
    const fold = data.fold;
    return (
      <button
        onClick={(e) => {
          e.stopPropagation();
          data.onFold(fold.zoneId);
        }}
        data-testid="territory-fold"
        data-zone-id={fold.zoneId}
        className="flex h-full w-full items-center justify-center rounded-lg border border-dashed border-border text-[11.5px] text-text-muted transition-colors hover:border-border-strong hover:text-text"
      >
        ▸ 还有 {fold.hidden} 项{fold.hidden >= 50 ? "(展开也只显前 50)" : ""} —— 点击展开
      </button>
    );
  }

  const chip = data.chip;
  const axis = AXIS_VAR[chip.entity] ?? AXIS_VAR.task;
  return (
    <div
      onClick={(e) => {
        e.stopPropagation();
        data.onOpen(chip.navRef);
      }}
      data-testid="territory-chip"
      data-nav-ref={chip.navRef}
      className="flex h-full w-full cursor-pointer items-center gap-2 overflow-hidden rounded-lg border border-border bg-surface-raised px-2.5 transition-colors hover:border-border-strong"
    >
      <span
        className="grid size-[18px] shrink-0 place-items-center rounded font-mono text-[10px] font-bold"
        style={{
          backgroundColor: `color-mix(in srgb, ${axis} 18%, transparent)`,
          color: axis,
        }}
      >
        {chip.entity === "task" ? "T" : chip.entity === "decision" ? "D" : "F"}
      </span>
      <span
        className="size-[7px] shrink-0 rounded-full"
        style={{
          backgroundColor:
            chip.entity === "task"
              ? statusDot(chip.sub)
              : chip.entity === "decision"
                ? "var(--color-axis-authority)"
                : "var(--color-axis-evidence)",
        }}
      />
      <span className="ui-body min-w-0 flex-1 truncate text-[12.5px] text-text">{chip.label}</span>
      {chip.sub && (
        <span className="shrink-0 rounded bg-surface px-1.5 py-0.5 font-mono text-[10px] text-text-faint">
          {chip.sub}
        </span>
      )}
      <ArrowsOutSimple weight="bold" className="shrink-0 text-[11px] text-text-faint" />
    </div>
  );
}

/** task 状态 → 状态色点(coordinationStatus 即 chip.sub);未知回落 planned。 */
function statusDot(status: string | undefined): string {
  switch (status) {
    case "blocked":
      return "var(--color-status-blocked)";
    case "active":
      return "var(--color-status-active)";
    case "in_review":
      return "var(--color-status-in-review)";
    case "planned":
      return "var(--color-status-planned)";
    case "done":
      return "var(--color-status-done)";
    case "cancelled":
      return "var(--color-status-cancelled)";
    default:
      return "var(--color-status-unknown)";
  }
}
