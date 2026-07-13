import { Graph, ClockCounterClockwise } from "@phosphor-icons/react";
import type { TaskRow, RelationEdge, DecisionRow, FactRef } from "../model/types";
import type {
  RelationCoverageRow,
  FactAnchorRow,
} from "../../api/renderer-dto.ts";
import type { EntityHit } from "../model/entitySearch";
import { GraphView } from "../views/GraphView.tsx";
import { GenealogyTimelineView } from "../views/GenealogyTimelineView.tsx";
import { t } from "../i18n/index.tsx";
import type { EntityFacet } from "../navigation/navigationHistory.ts";

/**
 * 实体工作台(G3 §②):同一 focusedEntityRef 下,在实体的多个「面」之间切换。
 *
 * 视图 vs 面的区别:视图是路由级(看板 / 决策批准 / 关系图 ...),面是同一实体
 * 的不同投影(decision 的「关系」vs「演化」)。聚合 = 同一实体的多个面,不是把
 * 所有视图收成一块画布(批量工作流保留独立入口,RJ1)。
 *
 * 当前面:
 *   - relations:Graph ego 画布,所有实体都有此面
 *   - lineage:Genealogy 谱系,**仅 decision** 有(GENEALOGY_KINDS 只认 decision↔decision)
 *
 * 焦点为 task/fact 时,lineage tab 隐藏 —— 不假装万物皆有谱系(G3 §⑥3)。
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
  // lineage 仅 decision 有谱系 —— 非 decision 焦点时强制 relations,不显示 lineage tab。
  // focusedEntityRef 为 null 时也允许 relations(Graph 自己挑默认焦点 + 引导用户选)。
  const canShowLineage = focusedEntityRef ? FOCUS_REF_DECISION.test(focusedEntityRef) : false;
  const activeFacet: EntityFacet = entityFacet === "lineage" && canShowLineage ? "lineage" : "relations";

  return (
    <div className="flex h-full min-h-0 flex-1 flex-col">
      {/* facet tabs:替代原 ViewSwitch 顶栏的「关系图|演化史」常驻条(G3 §③2)。
          区别:这条只在工作台内挂,且 lineage 仅 decision 时显示 —— 不再每个页面都顶两条。 */}
      <div
        data-testid="entity-facet-tabs"
        className="flex items-center gap-2 border-b border-border bg-surface/60 px-3 py-1.5"
      >
        <FacetTab
          active={activeFacet === "relations"}
          onClick={() => onFacetChange("relations")}
          icon={<Graph weight="bold" className="text-[12px]" />}
          label={t("components.entityWorkspace.facetRelations")}
        />
        {canShowLineage && (
          <FacetTab
            active={activeFacet === "lineage"}
            onClick={() => onFacetChange("lineage")}
            icon={<ClockCounterClockwise weight="bold" className="text-[12px]" />}
            label={t("components.entityWorkspace.facetLineage")}
          />
        )}
      </div>

      <div className="flex min-h-0 flex-1 flex-col">
        {activeFacet === "lineage" ? (
          <GenealogyTimelineView
            decisions={decisions}
            relations={relations}
            focusRef={focusedEntityRef}
            onNavigateEntity={onNavigateEntity}
            onFocusGraph={(ref) => {
              // Graph 是本工作台的另一个 facet —— 点「在关系图中聚焦」= 回 relations,
              // focusedEntityRef 经 onFocusEntityChange 写回,继续在同一实体工作台里。
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
          />
        )}
      </div>
    </div>
  );
}

function FacetTab({
  active,
  onClick,
  icon,
  label,
}: {
  active: boolean;
  onClick: () => void;
  icon: React.ReactNode;
  label: string;
}) {
  return (
    <button
      onClick={onClick}
      className={`inline-flex items-center gap-1 rounded-md border px-2.5 py-1 text-[12px] transition-colors ${
        active
          ? "border-border-strong bg-surface-raised font-medium text-text"
          : "border-transparent text-text-muted hover:text-text"
      }`}
    >
      {icon}
      {label}
    </button>
  );
}
