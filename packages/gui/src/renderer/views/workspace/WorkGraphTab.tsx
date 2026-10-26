import { useCallback, useMemo, useState } from "react";
import { RelationCanvas, type RelationCanvasStats } from "../../graph/RelationCanvas.tsx";
import { workTopologyGraphOf, workTopologySummaryOf } from "../../graph/workTopology.ts";
import { useWorkTopologyQuery } from "../../task-data.ts";
import type { DecisionRow, FactRef, RelationEdge, TaskRow } from "../../model/types.ts";
import type { FactAnchorRow } from "../../../api/renderer-dto.ts";
import { t } from "../../i18n/index.tsx";

/**
 * 工作页 Graph 页签(dec_17A863CC CH3):全局关系图同一个画布宿主、同一套节点卡片与边
 * 抽屉,只换三件事 —— 预设 work scope(daemon 单 cut 拓扑的成员 + 一跳外部边界)、
 * 边只取该读面返回的 depends-on、以及画布上的拓扑状态层。
 *
 * 状态层是**纯展示**:前沿、在飞、待裁决、关键路径、revision 与 warnings 全部原样读
 * `repo.work.topology.read` 的字段(GUI 不按事件/状态/边自行判定可开工或阻塞,RJ3)。
 * 刷新沿用台账 cut 失效:拓扑查询键在 `["tasks", repoId, ...]` 下,`invalidateLedgerDependents`
 * 已经覆盖它,本页不新增轮询或订阅。
 */
export interface WorkGraphTabProps {
  readonly repoId: string;
  readonly workRootTaskId: string;
  /** 成员行的展示字段来自同一台账切面;拓扑读只补状态标记。 */
  readonly tasks?: readonly TaskRow[];
  readonly onNavigateEntity?: (ref: string) => void;
  readonly onSetTaskPin?: (task: TaskRow, pinned: boolean) => void;
  /** false 时暂停隐藏页签的专属读取,但保留画布交互状态。 */
  readonly active: boolean;
}

const EMPTY_TASKS: readonly TaskRow[] = [];
const EMPTY_DECISIONS: readonly DecisionRow[] = [];
const EMPTY_FACTS: readonly FactRef[] = [];
const EMPTY_ANCHORS: ReadonlyArray<FactAnchorRow> = [];
const EMPTY_RELATIONS: ReadonlyArray<RelationEdge> = [];

export function WorkGraphTab({
  repoId,
  workRootTaskId,
  tasks = EMPTY_TASKS,
  onNavigateEntity,
  onSetTaskPin,
  active,
}: WorkGraphTabProps) {
  const [focusRef, setFocusRef] = useState<string | null>(`task/${workRootTaskId}`);
  const [stats, setStats] = useState<RelationCanvasStats>({ nodes: 0, edges: 0, focusLabel: null });
  const topologyQuery = useWorkTopologyQuery(repoId, workRootTaskId, active),
    topology = topologyQuery.data;
  const onStats = useCallback((next: RelationCanvasStats) => {
    setStats((current) =>
      current.nodes === next.nodes && current.edges === next.edges && current.focusLabel === next.focusLabel
        ? current
        : next,
    );
  }, []);
  const scoped = useMemo(() => workTopologyGraphOf(topology, tasks), [topology, tasks]),
    summary = useMemo(() => (topology ? workTopologySummaryOf(topology) : null), [topology]),
    // 画布数据面按引用稳定:每次 render 新建数组会让 ego 图与布局每个 pass 重算。
    graph = useMemo(
      () => ({
        tasks: scoped.tasks,
        decisions: EMPTY_DECISIONS,
        facts: EMPTY_FACTS,
        relations: scoped.relations.length > 0 ? scoped.relations : EMPTY_RELATIONS,
        factAnchors: EMPTY_ANCHORS,
      }),
      [scoped],
    );

  return (
    <section className="flex min-h-0 flex-1 flex-col" aria-labelledby="workspace-graph">
      <h2 id="workspace-graph" className="sr-only">
        {t("views.workspace.localGraph")}
      </h2>
      <div
        data-testid="workspace-graph-scroll"
        className="min-h-0 flex-1 overflow-hidden rounded-sm border border-border"
      >
        <div data-testid="workspace-graph-canvas" className="h-full w-full">
          {topology ? (
            <RelationCanvas
              repoId={repoId}
              scope="work"
              graph={graph}
              focusRef={focusRef}
              onFocusChange={setFocusRef}
              onNavigateEntity={onNavigateEntity}
              {...(onSetTaskPin ? { onSetTaskPin } : {})}
              onLayoutStats={onStats}
              active={active}
              panelSlot={<WorkTopologyStatus summary={summary!} stats={stats} missing={scoped.missingTaskIds.length} />}
            />
          ) : (
            <div data-testid="workspace-graph-loading" role="status" className="p-3 ui-meta text-text-muted">
              {topologyQuery.error ? t("views.workspace.topologyUnavailable") : t("views.workspace.topologyLoading")}
            </div>
          )}
        </div>
      </div>
    </section>
  );
}

/** 拓扑状态层:只渲染 daemon 返回值,不在这里派生任何生命周期判断。 */
function WorkTopologyStatus({
  summary,
  stats,
  missing,
}: {
  readonly summary: ReturnType<typeof workTopologySummaryOf>;
  readonly stats: RelationCanvasStats;
  readonly missing: number;
}) {
  return (
    <div
      data-testid="workspace-graph-topology"
      className="flex max-w-full flex-wrap items-center gap-x-2 gap-y-1 rounded-md border border-border bg-surface-raised px-2 py-1 ui-micro text-text-muted"
    >
      <span className="font-mono tabular-nums">
        {t("views.workspace.graphStats", { nodes: stats.nodes, edges: stats.edges })}
      </span>
      <span className="font-mono tabular-nums" data-testid="workspace-topology-frontier">
        {t("views.workspace.topologyFrontier", { frontier: summary.frontier, members: summary.members })}
      </span>
      <span className="font-mono tabular-nums">
        {t("views.workspace.topologyInFlight", { count: summary.inFlight })}
      </span>
      <span className="font-mono tabular-nums">{t("views.workspace.topologyBlocked", { count: summary.blocked })}</span>
      <span className="font-mono tabular-nums">
        {t("views.workspace.topologyAwaitingRuling", { count: summary.awaitingRuling })}
      </span>
      <span className="font-mono tabular-nums">
        {summary.criticalPathTasks === null
          ? t("views.workspace.topologyCriticalPathUnknown")
          : t("views.workspace.topologyCriticalPath", { count: summary.criticalPathTasks })}
      </span>
      {summary.boundary > 0 && (
        <span className="font-mono tabular-nums">
          {t("views.workspace.topologyBoundary", { count: summary.boundary })}
        </span>
      )}
      <span className="font-mono tabular-nums">
        {t("views.workspace.topologyRevision", { revision: summary.revision })}
      </span>
      {summary.completeness === "partial" && (
        <span className="text-warning" data-testid="workspace-topology-partial">
          {t("views.workspace.topologyPartial", { warnings: summary.warnings.join("; ") || "—" })}
        </span>
      )}
      {missing > 0 && (
        <span className="text-warning" data-testid="workspace-topology-missing">
          {t("views.workspace.topologyMissing", { count: missing })}
        </span>
      )}
    </div>
  );
}
