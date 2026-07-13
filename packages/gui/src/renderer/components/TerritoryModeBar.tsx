import { Panel } from "@xyflow/react";
import type { ViewMode, TerritorySkel } from "../graph/useTerritoryView";

/**
 * L1 ↔ L2 模式切换条(IA v2 Layer 0 ↔ Layer 1)。
 *
 * 三个开关:
 *   领地 ↔ 聚光灯 — 顶层视图模式(L1 = 首屏领地总览,L2 = ego 聚光灯)。
 *   任务 / 决策   — territory 内的骨架轴(只有领地模式显示)。
 *
 * 放在 ReactFlow 的 Panel(position="top-center)里,与左上 Filters 面板、右上 minimap 不冲突。
 */
export function TerritoryModeBar({
  viewMode,
  skel,
  onModeChange,
  onSkelChange,
}: {
  viewMode: ViewMode;
  skel: TerritorySkel;
  onModeChange: (m: ViewMode) => void;
  onSkelChange: (s: TerritorySkel) => void;
}) {
  return (
    <Panel position="top-center">
      <div className="flex items-center gap-2 rounded-lg border border-border bg-surface-raised px-1.5 py-1 shadow-sm">
        <div className="flex overflow-hidden rounded-md border border-border">
          <ModeBtn active={viewMode === "territory"} onClick={() => onModeChange("territory")}>
            领地
          </ModeBtn>
          <ModeBtn active={viewMode === "spotlight"} onClick={() => onModeChange("spotlight")}>
            聚光灯
          </ModeBtn>
        </div>
        {viewMode === "territory" && (
          <div className="flex overflow-hidden rounded-md border border-border">
            <ModeBtn active={skel === "task"} onClick={() => onSkelChange("task")}>
              任务
            </ModeBtn>
            <ModeBtn active={skel === "decision"} onClick={() => onSkelChange("decision")}>
              决策
            </ModeBtn>
          </div>
        )}
      </div>
    </Panel>
  );
}

function ModeBtn({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      className={`px-2.5 py-1 text-[12px] font-medium transition-colors ${
        active
          ? "bg-accent text-accent-fg"
          : "bg-surface text-text-muted hover:text-text"
      }`}
    >
      {children}
    </button>
  );
}
