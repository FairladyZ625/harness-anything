import { SegCtl } from "./primitives/SegCtl.tsx";
import type { TerritorySkel } from "../graph/territory.ts";

/**
 * 实体工作台 3 态模式条(REQ-GUI-03):领地 / 聚光灯 / 演化史。
 *
 * 三选项常驻(不随焦点类型隐藏演化史,保持模式条稳定心智)。演化史仅 decision
 * 焦点有内容:非 decision 焦点仍可点击查看引导空态，提示说明原因。
 */
export type WorkspaceMode = "territory" | "spotlight" | "lineage";
// 领地 skeleton 的取值由分区模块拥有,这里只转出,不写第二份。
export type { TerritorySkel };

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
      <SegCtl<WorkspaceMode>
        label="关系图模式"
        value={mode}
        onChange={onModeChange}
        options={[
          { value: "territory", label: "领地" },
          { value: "spotlight", label: "聚光灯" },
          {
            value: "lineage",
            label: "演化史",
            tip: canShowLineage ? undefined : "演化史需要 decision 焦点 — 点击查看引导空态",
          },
        ]}
      />
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
    <SegCtl<TerritorySkel>
      label="关系图实体范围"
      value={skel}
      onChange={onSkelChange}
      options={[
        { value: "task", label: "任务" },
        { value: "decision", label: "决策" },
        { value: "fact", label: "事实" },
        { value: "unified", label: "全域" },
      ]}
    />
  );
}
