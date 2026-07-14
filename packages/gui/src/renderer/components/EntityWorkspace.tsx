import { useEffect, useState } from "react";
import type { TaskRow, RelationEdge, DecisionRow, FactRef } from "../model/types";
import type {
  RelationCoverageRow,
  FactAnchorRow,
} from "../../api/renderer-dto.ts";
import type { EntityHit } from "../model/entitySearch";
import { GraphView } from "../views/GraphView.tsx";
import { GenealogyTimelineView } from "../views/GenealogyTimelineView.tsx";
import { TerritoryModeBar, type WorkspaceMode } from "./TerritoryModeBar.tsx";
import type { EntityFacet } from "../navigation/navigationHistory.ts";
import type { ViewMode } from "../graph/useTerritoryView.ts";

/**
 * 实体工作台(G3 §②):同一 focusedEntityRef 下,在实体的多个「面」之间切换。
 *
 * 视图 vs 面的区别:视图是路由级(看板 / 决策批准 / 关系图 ...),面是同一实体
 * 的不同投影。聚合 = 同一实体的多个面,不是把所有视图收成一块画布(批量工作流保留
 * 独立入口,RJ1)。
 *
 * 3 态选择条(领地/聚光灯/演化史)fuse 了两个原本分离的开关:
 *   - 领地/聚光灯(territory/spotlight):GraphView 画布模式,本工作台本地态(不推栈,
 *     与旧 useTerritoryView 行为一致 —— 切模式不污染焦点历史)。
 *   - 演化史(lineage):全屏时间线,写 AppLocation.entityFacet(推栈,Cmd+[ 能回)。
 * 选择条由本组件在画布之上渲染:演化史不是画布覆盖层,旧 facet tab 在画布之上才能在
 * 演化史视图下也保持可见。
 *
 * D6 焦点连续性:focusedEntityRef 在领地/聚光灯/演化史三态间始终保留 —— 切模式不丢焦点。
 *   - 聚光灯→演化史:focusedEntityRef 经 props 传给 GenealogyTimelineView.focusRef,直接显
 *     该 decision 的谱系(不需重选)。
 *   - 演化史→聚光灯:genealogy 侧栏的 onFocusChange 已把当前 decision 写回 focusedEntityRef;
 *     GraphView 重新挂载时 useEgoCanvas 的 bootstrap effect 据 focusRef 复焦点。
 *   - 领地→聚光灯:territory chip / 全域节点单击 → enterSpotlight(navRef) 同步切模式 + 复焦。
 *   - 聚光灯历史 back/forward/clear:useEgoCanvas.stepHistory / clearFocus 上行 onFocusChange,
 *     同步 AppLocation.focusedEntityRef —— 否则历史导航后演化史会开在陈旧 decision 上。
 *
 * 演化史仅 decision 有谱系(GENEALOGY_KINDS 只认 decision↔decision)。非 decision 焦点时
 * 演化史按钮置灰 + tooltip(三选项常驻,不像旧 facet tab 那样隐藏 —— 不假装万物皆有谱系,
 * 但保持模式条的稳定心智)。
 */
export interface EntityWorkspaceProps {
  focusedEntityRef: string | null;
  entityFacet: EntityFacet | null;
  tasks: TaskRow[];
  relations: RelationEdge[];
  decisions: DecisionRow[];
  facts: FactRef[];
  coverageRows?: ReadonlyArray<RelationCoverageRow>;
  factAnchors?: ReadonlyArray<FactAnchorRow>;
  onNavigateEntity: (ref: string) => void;
  /** 切换 facet 写回 AppLocation(经 navigate 推栈,Cmd+[ 能回)。 */
  onFacetChange: (facet: EntityFacet) => void;
  /** 画布内焦点变更上行(useEgoCanvas.openFocus → AppLocation.focusedEntityRef)。 */
  onFocusEntityChange: (ref: string | null) => void;
  /** Cmd+K 面板派生的最近焦点实体,GraphView 左栏 Recent 直接消费。 */
  recentHits?: readonly EntityHit[];
  /** 用户在 GraphView 左栏点「⌘K」触发器 → 打开全局命令面板。 */
  onOpenPalette?: () => void;
}

const FOCUS_REF_DECISION = /^decision\//u;

export function EntityWorkspace({
  focusedEntityRef,
  entityFacet,
  tasks,
  relations,
  decisions,
  facts,
  coverageRows,
  factAnchors,
  onNavigateEntity,
  onFacetChange,
  onFocusEntityChange,
  recentHits,
  onOpenPalette,
}: EntityWorkspaceProps) {
  // lineage 仅 decision 有谱系。focusedEntityRef 为 null 时也允许 relations
  // (Graph 自己挑默认焦点 + 引导用户选)。
  const canShowLineage = focusedEntityRef ? FOCUS_REF_DECISION.test(focusedEntityRef) : false;
  const activeFacet: EntityFacet = entityFacet === "lineage" && canShowLineage ? "lineage" : "relations";

  // territory/spotlight 是画布内模式(非导航态),由工作台本地持有 —— 切换不推历史栈,
  // 与旧 useTerritoryView 行为一致。lineage 走 entityFacet(AppLocation,推栈)。
  const [viewMode, setViewMode] = useState<ViewMode>("territory");

  // 新焦点到达 → 切 spotlight(用户「跳到这张图/选了某个实体」= 要看它)。保留旧
  // GraphView 的 useEffect 语义:有焦点默认聚光灯,无焦点默认领地总览。
  useEffect(() => {
    if (focusedEntityRef) setViewMode("spotlight");
  }, [focusedEntityRef]);

  // 3 态派生:演化史优先(用户显式选了 entityFacet=lineage),否则反映本地 viewMode。
  const mode: WorkspaceMode = activeFacet === "lineage" ? "lineage" : viewMode;

  const handleModeChange = (next: WorkspaceMode) => {
    if (next === "lineage") {
      onFacetChange("lineage");
      return;
    }
    // territory/spotlight:写本地画布模式;只要 AppLocation 的 facet 仍是 lineage 就退回
    // relations —— 读原始 entityFacet 而非 gated activeFacet:非 decision 焦点下 activeFacet
    // 已算成 relations,若只清 activeFacet 会漏掉这条脏路径,导致下次聚焦 decision 时被无意
    // 甩回演化史。(GraphView 重新挂载,读取最新的 viewMode)。
    setViewMode(next);
    if (entityFacet === "lineage") onFacetChange("relations");
  };

  return (
    <div className="flex h-full min-h-0 flex-1 flex-col">
      <TerritoryModeBar
        mode={mode}
        canShowLineage={canShowLineage}
        onModeChange={handleModeChange}
      />

      <div className="flex min-h-0 flex-1 flex-col">
        {activeFacet === "lineage" ? (
          <GenealogyTimelineView
            decisions={decisions}
            relations={relations}
            focusRef={focusedEntityRef}
            onNavigateEntity={onNavigateEntity}
            onFocusGraph={(ref) => {
              // 从演化史跳回关系图 = 回到 spotlight 模式(看这个实体的画布)。
              setViewMode("spotlight");
              onFocusEntityChange(ref);
              onFacetChange("relations");
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
            recentHits={recentHits}
            onOpenPalette={onOpenPalette}
            viewMode={viewMode}
            onViewModeChange={setViewMode}
          />
        )}
      </div>
    </div>
  );
}
