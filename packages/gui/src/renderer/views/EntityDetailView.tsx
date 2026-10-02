import { useMemo } from "react";
import { WarningCircle } from "@phosphor-icons/react";
import type { TaskRow, DecisionRow, FactRef, RelationEdge } from "../model/types";
import type { RelationCoverageRow, FactAnchorRow } from "../../api/renderer-dto";
import { FactInspector } from "../components/FactInspector";
import { EgoNeighborhood } from "../graph/EgoNeighborhood";
import { EntityRefLink } from "../components/EntityRefLink.tsx";
import { IdText } from "../components/IdText.tsx";
import { t } from "../i18n/index.tsx";

/**
 * Fact 详情页(W4 可寻址路由):
 *   fact/<anchor> → view=factDetail + focusedEntityRef
 *
 * 「打开详情」不再落在列表页。页面 = 详情栏(复用 FactInspector)
 * + 邻域画布(复用 graph/EgoNeighborhood):任意实体就地看到「它周围有什么」,
 * 双击/详情钮直接跳去邻居的详情页,导航历史栈可原路返回。
 *
 * Decision 详情已迁至 components/decisionDetail/(正文经 decision-show 单体
 * read 取回),此文件不再承载 decision/<id> 路由。
 *
 * 取数:没有 fact 单体 read,详情复用 App 已加载的 triadic 投影集合
 * (facts / decisions / relations / factAnchors)。集合仍在加载时显示加载态;
 * 加载完仍找不到 → 「不在当前投影」态,不编造内容。
 */
export function FactDetailView({
  repoId,
  factRef,
  facts,
  tasks,
  decisions,
  relations,
  factAnchors,
  coverageRows,
  loading,
  onNavigateEntity,
  onNavigateDecision,
  onNavigateTask,
  onFocusGraph,
}: {
  /** 会话归属仓:透传给邻域画布(egoSession 按 repoId 隔离)。 */
  repoId: string;
  factRef: string | null;
  facts: FactRef[];
  tasks: readonly TaskRow[];
  decisions: DecisionRow[];
  relations: RelationEdge[];
  factAnchors: ReadonlyArray<FactAnchorRow>;
  coverageRows: ReadonlyArray<RelationCoverageRow>;
  loading: boolean;
  onNavigateEntity?: (ref: string) => void;
  onNavigateDecision?: (decisionId: string) => void;
  onNavigateTask?: (taskId: string) => void;
  onFocusGraph?: (ref: string) => void;
}) {
  const anchor = factRef?.replace(/^fact\//, "") ?? null;
  const fact = useMemo(
    () => (factRef ? (facts.find((f) => f.anchor === factRef || f.anchor === anchor) ?? null) : null),
    [facts, factRef, anchor],
  );
  // anchor-only fact(有锚点、正文未投影)仍是图上一等节点 —— 邻域照常铺开。
  const inProjection = fact !== null || (factRef ? factAnchors.some((a) => a.factRef === factRef) : false);

  return (
    <div data-testid="fact-detail-view" className="flex h-full min-h-0 flex-1">
      {inProjection ? (
        <FactInspector
          factRef={factRef!}
          facts={facts}
          tasks={tasks}
          decisions={decisions}
          relations={relations}
          side="right"
          onNavigateDecision={onNavigateDecision}
          onNavigateTask={onNavigateTask}
          onFocusGraph={onFocusGraph}
          coverageRows={coverageRows}
        />
      ) : (
        <DetailPendingColumn loading={loading} refLabel={factRef ?? "—"} />
      )}
      <NeighborhoodPane
        repoId={repoId}
        focusRef={inProjection ? factRef : null}
        tasks={tasks}
        decisions={decisions}
        facts={facts}
        relations={relations}
        factAnchors={factAnchors}
        onNavigateEntity={onNavigateEntity}
      />
    </div>
  );
}

function DetailPendingColumn({ loading, refLabel }: { loading: boolean; refLabel: string }) {
  return (
    <aside
      data-testid="entity-detail-pending"
      className="flex w-[26rem] shrink-0 flex-col gap-3 border-r border-border bg-surface px-3 py-3"
    >
      {loading ? (
        <p className="font-mono ui-meta text-text-faint">{t("views.entityDetail.loadingProjection")}</p>
      ) : (
        <>
          <div className="flex items-center gap-1 ui-meta font-semibold text-stale">
            <WarningCircle weight="bold" />
            {t("views.entityDetail.notProjected")}
          </div>
          <div className="font-mono ui-micro text-text-faint">{refLabel}</div>
        </>
      )}
    </aside>
  );
}

function NeighborhoodPane({
  repoId,
  focusRef,
  tasks,
  decisions,
  facts,
  relations,
  factAnchors,
  onNavigateEntity,
}: {
  repoId: string;
  focusRef: string | null;
  tasks: readonly TaskRow[];
  decisions: DecisionRow[];
  facts: FactRef[];
  relations: RelationEdge[];
  factAnchors: ReadonlyArray<FactAnchorRow>;
  onNavigateEntity?: (ref: string) => void;
}) {
  // 「和谁有关 / 最近变了什么」(§1.1):邻居数与邻居里最近一次变化,都从已加载投影现算。
  const fullRef = focusRef?.startsWith("fact/") ? focusRef : focusRef ? `fact/${focusRef}` : null;
  const neighborRefs = new Set<string>();
  if (fullRef !== null)
    for (const edge of relations)
      if (edge.from === fullRef || edge.to === fullRef) {
        neighborRefs.add(edge.from === fullRef ? edge.to : edge.from);
      }
  const latestChange = [
    ...tasks.map((task) => ({ at: task.lastKnownAt, label: task.taskId, ref: `task/${task.taskId}` })),
    ...decisions.map((decision) => ({
      at: decision.proposedAt ?? "",
      label: decision.decisionId,
      ref: `decision/${decision.decisionId}`,
    })),
  ]
    .filter((item) => item.at !== "" && neighborRefs.has(item.ref))
    .sort((left, right) => right.at.localeCompare(left.at))
    .at(0);
  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      <div className="flex items-baseline gap-3 border-b border-border px-4 py-1.5">
        <span className="font-mono ui-micro font-semibold uppercase tracking-wide text-text-muted">
          {t("views.entityDetail.neighborhoodHint")}
        </span>
        {neighborRefs.size > 0 && latestChange !== undefined ? (
          <span className="min-w-0 flex-1 truncate font-mono tabular-nums text-text-faint ui-meta">
            {t("views.entityDetail.neighborhoodMeta", { count: neighborRefs.size })}{" "}
            {onNavigateEntity ? (
              <EntityRefLink
                entityRef={latestChange.ref}
                onNavigate={onNavigateEntity}
                title={latestChange.ref}
                className="text-text-faint hover:text-accent hover:underline"
              >
                {latestChange.label}
              </EntityRefLink>
            ) : (
              <IdText value={latestChange.ref} title={latestChange.label} />
            )}
          </span>
        ) : null}
        <span className="shrink-0 text-text-faint ui-micro">{t("views.entityDetail.refocusHint")}</span>
      </div>
      <div className="flex min-h-0 flex-1">
        <EgoNeighborhood
          repoId={repoId}
          focusRef={focusRef}
          tasks={tasks}
          decisions={decisions}
          facts={facts}
          relations={relations}
          factAnchors={factAnchors}
          onNavigateEntity={onNavigateEntity}
          // 详情页里「设为焦点」(卡片按钮/双击节点)的语义 = 跳去该邻居自己的详情页。
          onRefocus={onNavigateEntity}
          refocusTitle={t("views.entityDetail.refocusHint")}
        />
      </div>
    </div>
  );
}
