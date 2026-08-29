import { useEffect, useState } from "react";
import type { TaskRow, RelationEdge, DecisionRow, FactRef } from "../model/types";
import type { RelationCoverageRow, FactAnchorRow } from "../../api/renderer-dto";
import { GraphView, type ViewMode } from "../views/GraphView.tsx";
import type { PaletteEntry } from "./CommandPalette.tsx";
import { GenealogyTimelineView } from "../views/GenealogyTimelineView.tsx";
import { TerritoryModeBar, type WorkspaceMode } from "./TerritoryModeBar.tsx";

/**
 * 实体工作台(G3 §② + REQ-GUI-03):同一 focusedEntityRef 下,在实体的多个「面」之间切换。
 *
 * 3 态选择条(领地/聚光灯/演化史):
 *   - 领地/聚光灯(territory/spotlight):GraphView 画布模式,本工作台本地态(不推栈,
 *     切模式不污染焦点历史)。
 *   - 演化史(lineage):全屏时间线。
 *
 * D6 焦点连续性:focusedEntityRef 在三态间始终保留 —— 切模式不丢焦点。
 * 演化史仅 decision 有谱系。非 decision 焦点时演化史按钮置灰 + tooltip。
 * 缺字段(module/PLT/parent)显示「未投影」,不假分组(REQ-GUI-03 验收硬项)。
 */
export interface EntityWorkspaceProps {
  focusedEntityRef: string | null;
  tasks: readonly TaskRow[];
  relations: RelationEdge[];
  decisions: DecisionRow[];
  facts: FactRef[];
  coverageRows?: ReadonlyArray<RelationCoverageRow>;
  factAnchors?: ReadonlyArray<FactAnchorRow>;
  onNavigateEntity: (ref: string) => void;
  onFocusEntityChange: (ref: string | null) => void;
  /** 跳去决策池并聚焦该 decision(演化史 DecisionDetailPanel 的「在决策池查看」)。 */
  onOpenDecisionPool?: (decisionId: string) => void;
  /** 最近访问 navRef 列表,透传给 GraphView 左栏(最近访问/搜索)。 */
  recentRefs?: ReadonlyArray<string>;
  /** 统一实体索引(buildPaletteIndex 产物),透传给 GraphView 左栏。 */
  entries?: ReadonlyArray<PaletteEntry>;
  /** 点击左栏 ⌘K 徽标打开全局面板。 */
  onOpenPalette?: () => void;
}

const FOCUS_REF_DECISION = /^decision\//u;

export function EntityWorkspace({
  focusedEntityRef,
  tasks,
  relations,
  decisions,
  facts,
  coverageRows,
  factAnchors,
  onNavigateEntity,
  onFocusEntityChange,
  onOpenDecisionPool,
  recentRefs,
  entries,
  onOpenPalette,
}: EntityWorkspaceProps) {
  // lineage 仅 decision 有谱系。
  const canShowLineage = focusedEntityRef ? FOCUS_REF_DECISION.test(focusedEntityRef) : false;

  // territory/spotlight 是画布内模式(非导航态),由工作台本地持有。
  const [viewMode, setViewMode] = useState<ViewMode>("territory");
  // lineage 是独立 facet(非画布模式)。
  const [lineageActive, setLineageActive] = useState(false);

  // 新焦点到达 → 切 spotlight(用户「跳到这张图/选了某个实体」= 要看它)。
  useEffect(() => {
    if (focusedEntityRef) setViewMode("spotlight");
  }, [focusedEntityRef]);

  // 非 decision 焦点仍可停在 lineage —— GenealogyTimelineView 显示规定引导空态,
  // 让用户知道「先在聚光灯里选 decision」。不强制退回画布。

  const mode: WorkspaceMode = lineageActive ? "lineage" : viewMode;

  const handleModeChange = (next: WorkspaceMode) => {
    if (next === "lineage") {
      // 允许非 decision 焦点进入 lineage —— GenealogyTimelineView 会显示规定引导空态。
      setLineageActive(true);
      return;
    }
    setLineageActive(false);
    setViewMode(next);
  };

  return (
    <div className="flex h-full min-h-0 flex-1 flex-col">
      <TerritoryModeBar mode={mode} canShowLineage={canShowLineage} onModeChange={handleModeChange} />

      <div className="flex min-h-0 flex-1 flex-col">
        {lineageActive ? (
          <GenealogyTimelineView
            decisions={decisions}
            relations={relations}
            focusRef={focusedEntityRef}
            onOpenDecisionPool={onOpenDecisionPool}
            onFocusGraph={(ref) => {
              // 从演化史跳回关系图 = 回到 spotlight 模式。
              setLineageActive(false);
              setViewMode("spotlight");
              onFocusEntityChange(ref);
            }}
            onFocusChange={onFocusEntityChange}
          />
        ) : (
          <GraphView
            tasks={tasks}
            relations={relations}
            decisions={decisions}
            facts={facts}
            coverageRows={coverageRows}
            factAnchors={factAnchors}
            onNavigateEntity={onNavigateEntity}
            onFocusEntityChange={onFocusEntityChange}
            focusRef={focusedEntityRef}
            viewMode={viewMode}
            onViewModeChange={setViewMode}
            recentRefs={recentRefs}
            entries={entries}
            onOpenPalette={onOpenPalette}
          />
        )}
      </div>
    </div>
  );
}
