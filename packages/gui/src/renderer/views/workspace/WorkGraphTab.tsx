import { useCallback, useMemo, useState } from "react";
import { EgoNeighborhood } from "../../graph/EgoNeighborhood.tsx";
import { useWorkTopologyQuery } from "../../task-data.ts";
import type { WorkTopologyRead } from "../../../api/renderer-dto.ts";
import type { RelationEdge, TaskRow } from "../../model/types.ts";
import { t } from "../../i18n/index.tsx";

/** 工作图完全消费 daemon 的单 cut 拓扑；画布仍复用通用 ego 交互与布局。 */
export interface WorkGraphTabProps {
  readonly repoId: string;
  readonly workRootTaskId: string;
  readonly onNavigateEntity?: (ref: string) => void;
  readonly onSetTaskPin?: (task: TaskRow, pinned: boolean) => void;
  /** false 时暂停隐藏页签的专属读取，但保留画布交互状态。 */
  readonly active: boolean;
}

export function WorkGraphTab({ repoId, workRootTaskId, onNavigateEntity, onSetTaskPin, active }: WorkGraphTabProps) {
  const [focusRef, setFocusRef] = useState(`task/${workRootTaskId}`);
  const [graphStats, setGraphStats] = useState({ nodes: 0, edges: 0, focusLabel: null as string | null });
  const topologyQuery = useWorkTopologyQuery(repoId, workRootTaskId, active),
    topology = topologyQuery.data;
  const onGraphStats = useCallback((next: typeof graphStats) => {
    setGraphStats((current) =>
      current.nodes === next.nodes && current.edges === next.edges && current.focusLabel === next.focusLabel
        ? current
        : next,
    );
  }, []);
  const graph = useMemo(() => {
    if (!topology) return { tasks: [], relations: [] as RelationEdge[] };
    const frontier = new Set(topology.frontier),
      criticalPathPositions = new Map((topology.criticalPath ?? []).map((taskId, index) => [taskId, index + 1]));
    return {
      tasks: [...topology.members, ...topology.boundaryTasks].map((node) =>
        topologyNodeToTaskRow(node, frontier.has(node.taskId), criticalPathPositions.get(node.taskId)),
      ),
      relations: topology.edges.map(
        (edge): RelationEdge => ({
          relationId: edge.relationId,
          from: edge.from,
          to: edge.to,
          kind: "depends-on",
          direction: edge.direction as RelationEdge["direction"],
          state: edge.state as RelationEdge["state"],
          provenance: "local-document",
          rationale: edge.rationale,
        }),
      ),
    };
  }, [topology]);
  const inFlight = topology?.members.filter(({ topologyState }) => topologyState === "in-flight").length ?? 0,
    awaitingRuling = topology?.members.filter(({ topologyState }) => topologyState === "awaiting-ruling").length ?? 0;

  return (
    <section className="flex min-h-0 flex-1 flex-col gap-2" aria-labelledby="workspace-graph">
      <h2 id="workspace-graph" className="sr-only">
        {t("views.workspace.localGraph")}
      </h2>
      <p className="text-text-muted ui-meta">
        {t("views.workspace.localGraphNote")} ·{" "}
        {t("views.workspace.graphStats", {
          nodes: graphStats.nodes,
          edges: graphStats.edges,
        })}
        {topology
          ? ` · 前沿 ${topology.frontier.length} / ${topology.members.length} · ${inFlight} 在飞 · ${awaitingRuling} 待裁决 · 关键路径 ${topology.criticalPath === null ? "未知" : `${topology.criticalPath.length} 个任务`} · revision ${topology.sourceRevision}`
          : topologyQuery.isPending
            ? " · 正在读取拓扑"
            : topologyQuery.error
              ? " · 拓扑读取失败"
              : ""}
        {graphStats.focusLabel === null
          ? ""
          : ` · ${t("views.workspace.graphFocus", { label: graphStats.focusLabel })}`}
        。{t("views.workspace.graphHint")}
        {topology?.completeness === "partial" ? ` · 部分状态：${topology.warnings.join("；")}` : ""}
      </p>
      <div
        data-testid="workspace-graph-scroll"
        className="min-h-0 flex-1 overflow-hidden rounded-sm border border-border"
      >
        <div data-testid="workspace-graph-canvas" className="h-full w-full">
          {topology ? (
            <EgoNeighborhood
              {...graph}
              repoId={repoId}
              focusRef={focusRef}
              decisions={[]}
              facts={[]}
              factAnchors={[]}
              onNavigateEntity={onNavigateEntity}
              onSetTaskPin={onSetTaskPin}
              onRefocus={setFocusRef}
              onLayoutStats={onGraphStats}
              active={active}
            />
          ) : (
            <div data-testid="workspace-graph-loading" role="status" className="p-3 ui-meta text-text-muted">
              {topologyQuery.error ? "拓扑读取失败" : "正在读取拓扑"}
            </div>
          )}
        </div>
      </div>
    </section>
  );
}

function topologyNodeToTaskRow(
  node: WorkTopologyRead["members"][number],
  topologyFrontier: boolean,
  topologyCriticalPathPosition: number | undefined,
): TaskRow {
  const canonicalStatus = node.canonicalStatus ?? "unknown";
  // The reusable canvas only needs task identity, title, status and pin state. These topology-only
  // rows deliberately do not borrow a possibly older full task list for their presentation.
  return {
    taskId: node.taskId,
    title: node.title,
    coordinationStatus: canonicalStatus,
    canonicalStatus: node.canonicalStatus ?? undefined,
    rawStatus: canonicalStatus,
    parentTaskId: node.parentTaskId ?? undefined,
    pinned: node.pinned,
    topologyState: node.topologyState,
    topologyFrontier,
    topologyCriticalPathPosition,
    topologyOnly: true,
  } as unknown as TaskRow;
}
