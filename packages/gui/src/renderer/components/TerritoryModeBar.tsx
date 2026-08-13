import { Panel } from "@xyflow/react";

/**
 * 实体工作台 3 态模式条(REQ-GUI-03):领地 / 聚光灯 / 演化史。
 *
 * 三选项常驻(不随焦点类型隐藏演化史,保持模式条稳定心智)。演化史仅 decision
 * 焦点可用:非 decision 焦点时按钮置灰 + tooltip(指向空态文案)。
 */
export type WorkspaceMode = "territory" | "spotlight" | "lineage";
export type TerritorySkel = "task" | "decision" | "fact" | "unified";

export function TerritoryModeBar({
  mode,
  canShowLineage,
  onModeChange,
}: {
  mode: WorkspaceMode;
  canShowLineage: boolean;
  onModeChange: (m: WorkspaceMode) => void;
}) {
  return (
    <div
      data-testid="entity-workspace-mode-bar"
      className="flex items-center gap-2 border-b border-border bg-surface/60 px-3 py-1.5"
    >
      <div className="flex overflow-hidden rounded-md border border-border bg-surface-raised">
        <ModeBtn active={mode === "territory"} onClick={() => onModeChange("territory")}>
          领地
        </ModeBtn>
        <ModeBtn active={mode === "spotlight"} onClick={() => onModeChange("spotlight")}>
          聚光灯
        </ModeBtn>
        <ModeBtn
          active={mode === "lineage"}
          onClick={() => onModeChange("lineage")}
          title={canShowLineage ? undefined : "演化史需要 decision 焦点 — 点击查看引导空态"}
        >
          演化史
        </ModeBtn>
      </div>
    </div>
  );
}

/**
 * Territory 骨架轴切换(任务/决策/事实/全域)——画布内浮层 Panel。
 * 只在领地模式渲染。
 */
export function TerritorySkelToggle({
  skel,
  onSkelChange,
}: {
  skel: TerritorySkel;
  onSkelChange: (s: TerritorySkel) => void;
}) {
  return (
    <Panel position="top-center">
      <div className="flex overflow-hidden rounded-md border border-border bg-surface-raised shadow-sm">
        <ModeBtn active={skel === "task"} onClick={() => onSkelChange("task")}>
          任务
        </ModeBtn>
        <ModeBtn active={skel === "decision"} onClick={() => onSkelChange("decision")}>
          决策
        </ModeBtn>
        <ModeBtn active={skel === "fact"} onClick={() => onSkelChange("fact")}>
          事实
        </ModeBtn>
        <ModeBtn active={skel === "unified"} onClick={() => onSkelChange("unified")}>
          全域
        </ModeBtn>
      </div>
    </Panel>
  );
}

function ModeBtn({
  active,
  onClick,
  disabled,
  title,
  children,
}: {
  active: boolean;
  onClick?: () => void;
  disabled?: boolean;
  title?: string;
  children: React.ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      title={title}
      className={`px-2.5 py-1 text-[12px] font-medium transition-colors ${
        active ? "bg-accent text-accent-fg" : "bg-surface text-text-muted hover:text-text"
      }${disabled ? " cursor-not-allowed opacity-50" : ""}`}
    >
      {children}
    </button>
  );
}
