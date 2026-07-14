import { Panel } from "@xyflow/react";
import type { TerritorySkel } from "../graph/useTerritoryView";
import { t } from "../i18n/index.tsx";

/**
 * 实体工作台 3 态模式:领地 / 聚光灯 / 演化史(territory / spotlight / genealogy)。
 *
 * 三态由 EntityWorkspace 派生:演化史(entityFacet=lineage)优先,否则反映本地 viewMode
 * (territory/spotlight)。演化史是全屏时间线视图(非画布覆盖层),所以这条选择栏由
 * EntityWorkspace 在画布之上渲染,而不在 ReactFlow Panel 里 —— 否则演化史视图下它无处挂。
 */
export type WorkspaceMode = "territory" | "spotlight" | "lineage";

/**
 * 实体工作台 3 态模式选择条(领地/聚光灯/演化史)。
 *
 * 三选项常驻(不随焦点类型隐藏演化史,保持模式条的稳定心智模型)。演化史仅 decision 焦点
 * 可用:非 decision 焦点时按钮置灰 + tooltip(指向 EmptyStates 的同款文案)。
 */
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
          {t("components.territoryModeBar.territory")}
        </ModeBtn>
        <ModeBtn active={mode === "spotlight"} onClick={() => onModeChange("spotlight")}>
          {t("components.territoryModeBar.spotlight")}
        </ModeBtn>
        <ModeBtn
          active={mode === "lineage"}
          disabled={!canShowLineage}
          onClick={canShowLineage ? () => onModeChange("lineage") : undefined}
          title={canShowLineage ? undefined : t("components.entityWorkspace.lineageRequiresDecisionFocus")}
        >
          {t("components.territoryModeBar.genealogy")}
        </ModeBtn>
      </div>
    </div>
  );
}

/**
 * Territory 模式下的骨架轴(任务/决策)切换 —— 画布内浮层 Panel。
 *
 * 与 3 态选择条分离:skel 是领地内部的布局轴,只在 GraphView 渲染且 viewMode==="territory"
 * 时才有意义,所以它留在 ReactFlow Panel 里(GraphView 挂载/卸载时随之出现/消失)。
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
          {t("components.territoryModeBar.task")}
        </ModeBtn>
        <ModeBtn active={skel === "decision"} onClick={() => onSkelChange("decision")}>
          {t("components.territoryModeBar.decisionMaking")}
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
        active
          ? "bg-accent text-accent-fg"
          : "bg-surface text-text-muted hover:text-text"
      }${disabled ? " cursor-not-allowed opacity-50" : ""}`}
    >
      {children}
    </button>
  );
}
