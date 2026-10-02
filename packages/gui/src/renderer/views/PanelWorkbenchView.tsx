import { useMemo, useState } from "react";
import { ArrowClockwise } from "@phosphor-icons/react";
import { FloatingPanelGrid, type FloatingPanelCanvas } from "../panel-workspace/floating-panel-grid.tsx";
import type { PanelGeometry } from "../panel-workspace/panel-workspace-layout.ts";
import { PageHeader } from "../components/primitives/PageHeader";
import { Button } from "../components/primitives/Button";
import { Empty } from "../components/primitives/Empty.tsx";
import { GraphView, type ViewMode } from "./GraphView.tsx";
import { GenealogyTimelineView } from "./GenealogyTimelineView.tsx";
import { TaskDocumentSidebar, TaskFilesTab } from "../components/taskDetail/TaskFilesTab.tsx";
import type { TaskRow, RelationEdge, DecisionRow, FactRef } from "../model/types.ts";
import type { RelationCoverageRow, FactAnchorRow } from "../../api/renderer-dto";
import type { AgentNodeRow, ScheduleNodeRow } from "../graph/runtimeEntities.ts";
import type { PaletteEntry } from "../components/CommandPalette.tsx";
import type { EntityTypeOption } from "../components/GraphFilterPanel.tsx";
import type { GovernedEntityRow } from "../graph/governedEntities.ts";
import { t } from "../i18n/index.tsx";

/**
 * 可定制面板工作台(task_f82b0d6058966986403ef1b635 首个检查点)。
 *
 * 预设页面(任务详情的分栏、实体工作台的模式条)之外,把「文档 / 时间线 / 关系图」
 * 三个真实功能面板放到同一块自由画板上:拖条拖动、四边四角缩放、放大还原、按仓
 * 保存恢复、一键重置。面板是完整功能块——内部的文件树、DAG、图节点交互原样保留,
 * 长内容在面板内部滚动,不撑长页面。CEO 亲验交互后再推广到其他页面。
 */
export interface PanelWorkbenchViewProps {
  readonly repoId: string;
  /** 布局分槽键:daemon 投影的 connectionId + repoId(连接目标 + 仓),不取显示名。 */
  readonly workspaceKey: string;
  readonly tasks: readonly TaskRow[];
  readonly relations: RelationEdge[];
  readonly decisions: DecisionRow[];
  readonly facts: FactRef[];
  readonly coverageRows?: ReadonlyArray<RelationCoverageRow>;
  readonly factAnchors?: ReadonlyArray<FactAnchorRow>;
  readonly agents?: ReadonlyArray<AgentNodeRow>;
  readonly schedules?: ReadonlyArray<ScheduleNodeRow>;
  readonly runtimeRelations?: ReadonlyArray<RelationEdge>;
  readonly entityKinds?: readonly EntityTypeOption[];
  readonly governedEntities?: ReadonlyArray<GovernedEntityRow>;
  readonly relationState?: "ready" | "loading" | "error";
  readonly onNavigateEntity: (ref: string) => void;
  readonly onSetTaskPin?: (task: TaskRow, pinned: boolean) => void;
  readonly onOpenDecisionPool?: (decisionId: string) => void;
  /** 「在关系图中查看」等跨页实体跳转:离开工作台,落关系图页的既有路由。 */
  readonly onFocusGraph?: (ref: string) => void;
  readonly recentRefs?: ReadonlyArray<string>;
  readonly entries?: ReadonlyArray<PaletteEntry>;
  readonly onOpenPalette?: () => void;
  readonly onSearchActiveChange?: (active: boolean) => void;
}

const documentsPanelId = "documents",
  timelinePanelId = "timeline",
  graphPanelId = "graph";

/** 预设几何:画布三栏平铺(文档 1/4 · 图 1/2 · 时间线 1/4),之后全归用户自由排。 */
function presetGeometry(canvas: FloatingPanelCanvas): Readonly<Record<string, PanelGeometry>> {
  const gap = 16;
  const column = Math.max(220, Math.floor((canvas.width - gap * 4) / 4));
  const height = Math.max(200, canvas.height - gap * 2);
  return {
    [documentsPanelId]: { x: gap, y: gap, width: column, height },
    [graphPanelId]: { x: gap * 2 + column, y: gap, width: column * 2, height },
    [timelinePanelId]: { x: gap * 3 + column * 3, y: gap, width: column, height },
  };
}

export function PanelWorkbenchView(props: PanelWorkbenchViewProps) {
  const [resetNonce, setResetNonce] = useState(0);

  return (
    <div className="flex h-full min-h-0 flex-col bg-bg" data-testid="panel-workbench-view">
      <PageHeader
        testId="panel-workbench-header"
        title={t("views.panelWorkbench.title")}
        note={t("views.panelWorkbench.note")}
        actions={
          <Button variant="ghost" testId="panel-workbench-reset" onClick={() => setResetNonce((nonce) => nonce + 1)}>
            <ArrowClockwise weight="bold" className="ui-meta" />
            {t("views.panelWorkbench.resetLayout")}
          </Button>
        }
      />
      <main className="min-h-0 flex-1 px-3 pb-3">
        <FloatingPanelGrid
          workspaceId={props.workspaceKey}
          panels={[
            {
              id: documentsPanelId,
              title: t("views.panelWorkbench.panelDocuments"),
              node: <TaskDocumentsPanel tasks={props.tasks} onNavigateEntity={props.onNavigateEntity} />,
            },
            {
              id: graphPanelId,
              title: t("views.panelWorkbench.panelGraph"),
              node: <GraphPanel {...props} />,
            },
            {
              id: timelinePanelId,
              title: t("views.panelWorkbench.panelTimeline"),
              node: <TimelinePanel {...props} />,
            },
          ]}
          presetGeometry={presetGeometry}
          resetNonce={resetNonce}
        />
      </main>
    </div>
  );
}

/** 关系图面板:整块 GraphView 原样进面板,画布模式是面板本地态(不推导航栈)。 */
function GraphPanel({
  repoId,
  tasks,
  relations,
  decisions,
  facts,
  coverageRows,
  factAnchors,
  agents,
  schedules,
  runtimeRelations,
  entityKinds,
  governedEntities,
  relationState,
  onNavigateEntity,
  onSetTaskPin,
  recentRefs,
  entries,
  onOpenPalette,
  onSearchActiveChange,
}: PanelWorkbenchViewProps) {
  const [viewMode, setViewMode] = useState<ViewMode>("territory");
  const [focusRef, setFocusRef] = useState<string | null>(null);
  return (
    <GraphView
      repoId={repoId}
      tasks={tasks}
      relations={relations}
      decisions={decisions}
      facts={facts}
      coverageRows={coverageRows}
      factAnchors={factAnchors}
      agents={agents}
      schedules={schedules}
      runtimeRelations={runtimeRelations}
      entityKinds={entityKinds}
      governedEntities={governedEntities}
      relationState={relationState}
      onNavigateEntity={onNavigateEntity}
      onSetTaskPin={onSetTaskPin}
      viewMode={viewMode}
      onViewModeChange={setViewMode}
      focusRef={focusRef}
      onFocusEntityChange={setFocusRef}
      recentRefs={recentRefs}
      entries={entries}
      onOpenPalette={onOpenPalette}
      onSearchActiveChange={onSearchActiveChange}
    />
  );
}

/** 时间线面板:整块演化史视图进面板;参与者点击是面板本地焦点,不离开工作台。 */
function TimelinePanel({ decisions, relations, onOpenDecisionPool, onFocusGraph }: PanelWorkbenchViewProps) {
  const [focusRef, setFocusRef] = useState<string | null>(null);
  return (
    <GenealogyTimelineView
      decisions={decisions}
      relations={relations}
      focusRef={focusRef}
      onOpenDecisionPool={onOpenDecisionPool}
      onFocusGraph={onFocusGraph}
      onFocusChange={setFocusRef}
    />
  );
}

/** 文档面板:任务包文档树 + 阅读器(Task 详情「文件」页的同一组真实组件)。 */
function TaskDocumentsPanel({
  tasks,
  onNavigateEntity,
}: {
  readonly tasks: readonly TaskRow[];
  readonly onNavigateEntity: (ref: string) => void;
}) {
  const [taskId, setTaskId] = useState(() => defaultDocumentsTaskId(tasks));
  const [activeDoc, setActiveDoc] = useState("task_plan.md");
  const task =
    tasks.find((candidate) => candidate.taskId === taskId) ??
    tasks.find((candidate) => candidate.taskId === defaultDocumentsTaskId(tasks)) ??
    null;
  const options = useMemo(() => tasks.map(({ taskId: id, title }) => ({ id, title })), [tasks]);

  if (tasks.length === 0) {
    return (
      <div className="grid h-full place-items-center p-4" data-testid="panel-documents-empty">
        <Empty>{t("views.panelWorkbench.documentsEmpty")}</Empty>
      </div>
    );
  }

  return (
    <div className="content-viewport flex h-full min-h-0 flex-col" data-testid="panel-documents">
      <div className="flex shrink-0 items-center gap-2 border-b border-border bg-surface px-2 py-1.5">
        <label htmlFor="panel-documents-task" className="shrink-0 font-mono ui-micro text-text-faint">
          {t("views.panelWorkbench.documentsTask")}
        </label>
        <select
          id="panel-documents-task"
          data-testid="panel-documents-task"
          value={task?.taskId ?? ""}
          onChange={(event) => {
            setTaskId(event.target.value);
            setActiveDoc("task_plan.md");
          }}
          className="control min-w-0 flex-1"
        >
          {options.map((option) => (
            <option key={option.id} value={option.id}>
              {option.title || option.id}
            </option>
          ))}
        </select>
      </div>
      {task ? (
        <div className="grid min-h-0 flex-1 grid-cols-1 grid-rows-[auto_minmax(0,1fr)] @min-[620px]:grid-cols-[13rem_minmax(0,1fr)] @min-[620px]:grid-rows-1">
          <TaskDocumentSidebar
            task={task}
            activeDoc={activeDoc}
            onActiveDocChange={setActiveDoc}
            onOpenDoc={setActiveDoc}
          />
          <div className="min-h-0 min-w-0 overflow-y-auto bg-bg px-4 py-3" data-testid="panel-documents-body">
            <TaskFilesTab
              task={task}
              activeDoc={activeDoc}
              onOpenDoc={setActiveDoc}
              onNavigateEntity={onNavigateEntity}
            />
          </div>
        </div>
      ) : null}
    </div>
  );
}

/** 默认任务:置顶优先,其次最近有动静的任务;不替用户编造别的选择。 */
function defaultDocumentsTaskId(tasks: readonly TaskRow[]): string {
  const pinned = tasks.find((candidate) => candidate.pinned === true);
  if (pinned) return pinned.taskId;
  let best: TaskRow | null = null;
  for (const candidate of tasks) {
    if (best === null || (candidate.lastKnownAt ?? "") > (best.lastKnownAt ?? "")) best = candidate;
  }
  return best?.taskId ?? "";
}
