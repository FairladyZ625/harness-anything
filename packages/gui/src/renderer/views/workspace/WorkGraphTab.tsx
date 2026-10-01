import { useCallback, useMemo, useState } from "react";
import { EgoNeighborhood } from "../../graph/EgoNeighborhood.tsx";
import { egoFactRefOf } from "../../graph/egoCanvas.ts";
import { workspaceGraphSlice } from "../../model/workspace-evidence.ts";
import type { DecisionRow, FactRef, RelationEdge, TaskRow } from "../../model/types.ts";
import { t } from "../../i18n/index.tsx";

/**
 * 关系图页(S5 补回):本工作成员 + 直接外部边界的 ego 画布,单击展开、双击设为画布
 * 中心。宿主保持本组件挂载、只在离开页签时置 active=false —— 焦点与展开累积在页签
 * 切换间保留(画布 DOM 卸载,累积态在 hooks 里)。
 */

export interface WorkGraphTabProps {
  /** 工作成员引用,首位是工作根任务(焦点初值)。 */
  readonly memberTaskIds: readonly string[];
  readonly tasks: readonly TaskRow[];
  readonly decisions: readonly DecisionRow[];
  readonly facts: readonly FactRef[];
  readonly relations: readonly RelationEdge[];
  readonly onNavigateEntity?: (ref: string) => void;
  readonly onSetTaskPin?: (task: TaskRow, pinned: boolean) => void;
  /** false = 隐藏但保持挂载(保留画布累积态)。 */
  readonly active: boolean;
}

export function WorkGraphTab({
  memberTaskIds,
  tasks,
  decisions,
  facts,
  relations,
  onNavigateEntity,
  onSetTaskPin,
  active,
}: WorkGraphTabProps) {
  const [focusRef, setFocusRef] = useState(`task/${memberTaskIds[0]}`);
  const [graphStats, setGraphStats] = useState({ nodes: 0, edges: 0, focusLabel: null as string | null });
  const onGraphStats = useCallback((next: typeof graphStats) => {
    setGraphStats((current) =>
      current.nodes === next.nodes && current.edges === next.edges && current.focusLabel === next.focusLabel
        ? current
        : next,
    );
  }, []);
  const graph = useMemo(() => {
    const slice = workspaceGraphSlice(memberTaskIds, relations);
    const refs = new Set(slice.nodeRefs);
    return {
      tasks: tasks.filter(({ taskId }) => refs.has(`task/${taskId}`)),
      decisions: decisions.filter(({ decisionId }) => refs.has(`decision/${decisionId}`)),
      facts: facts.filter((fact) => refs.has(egoFactRefOf(fact))),
      relations: [...slice.edges],
    };
  }, [memberTaskIds, tasks, decisions, facts, relations]);

  return (
    <section className="flex min-h-0 flex-1 flex-col gap-2" aria-labelledby="workspace-graph">
      <h2 id="workspace-graph" className="sr-only">
        {t("views.workspace.localGraph")}
      </h2>
      <p className="text-text-muted ui-meta">
        {t("views.workspace.localGraphNote")} ·{" "}
        {t("views.workspace.graphStats", { nodes: graphStats.nodes, edges: graphStats.edges })}
        {graphStats.focusLabel === null
          ? ""
          : ` · ${t("views.workspace.graphFocus", { label: graphStats.focusLabel })}`}
        。{t("views.workspace.graphHint")}
      </p>
      {/* 画布高度由 flex 分配、宽度跟随容器(原则 9①/9②):ReactFlow 自己按容器实测尺寸
          布局,画布内容靠平移/缩放浏览,不需要横向滚动条与最小宽度。 */}
      <div
        data-testid="workspace-graph-scroll"
        className="min-h-0 flex-1 overflow-hidden rounded-sm border border-border"
      >
        <div data-testid="workspace-graph-canvas" className="h-full w-full">
          <EgoNeighborhood
            {...graph}
            focusRef={focusRef}
            factAnchors={[]}
            onNavigateEntity={onNavigateEntity}
            onSetTaskPin={onSetTaskPin}
            onRefocus={setFocusRef}
            onLayoutStats={onGraphStats}
            active={active}
          />
        </div>
      </div>
    </section>
  );
}
