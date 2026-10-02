import { useCallback, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import type { ArtifactGuiKind } from "@harness-anything/daemon/protocol";
import type {
  WorkIndexRead,
  WorkspaceSummaryRead,
  RelationCoverageRow,
  FactAnchorRow,
} from "../../api/renderer-dto.ts";
import type { AgendaSuccess } from "../api-client.ts";
import { Notice } from "../components/primitives/Notice.tsx";
import { Empty } from "../components/primitives/Empty.tsx";
import { WorkspaceSummaryPending } from "../components/WorkspaceSummaryPending.tsx";
import { GraphView, type ViewMode } from "../views/GraphView.tsx";
import { GenealogyTimelineView } from "../views/GenealogyTimelineView.tsx";
import { OverviewView } from "../views/OverviewView.tsx";
import { SessionsView } from "../views/SessionsView.tsx";
import { ProvidersWorkspace } from "../views/ProvidersView.tsx";
import { ScheduleWorkspace } from "../views/SchedulesView.tsx";
import { ARTIFACTS_READ_ERROR_ROW_CLASS, ArtifactsWorkspace } from "../views/ArtifactsView.tsx";
import { TaskDocumentSidebar, TaskFilesTab } from "../components/taskDetail/TaskFilesTab.tsx";
import type { TaskRow, RelationEdge, DecisionRow, FactRef } from "../model/types.ts";
import type { AgentNodeRow, ScheduleNodeRow } from "../graph/runtimeEntities.ts";
import type { PaletteEntry } from "../components/CommandPalette.tsx";
import type { EntityTypeOption } from "../components/GraphFilterPanel.tsx";
import type { GovernedEntityRow } from "../graph/governedEntities.ts";
import type { RuntimeHealth } from "../model/runtime-health.ts";
import { artifactsClient } from "../artifacts-client.ts";
import { schedulesClient } from "../schedules-client.ts";
import { t, type MessageKey } from "../i18n/index.tsx";
import type { FloatingPanelCanvas, FloatingPanelDescriptor } from "./floating-panel-grid.tsx";
import type { PanelGeometry } from "./panel-workspace-layout.ts";

/**
 * 工作台面板目录与功能体组合源(task_48fe291624e06a2e9ad9496c81)。
 *
 * 每个面板类型 = 一个真实功能块:整块复用既有视图或其提取出的 Workspace 功能体
 * (页面与工作台共用同一组合源,不复制业务状态)。目录是有限清单:文档/关系图/
 * 时间线三个默认面板(PR3253 原样保留)+ 总览/会话/定时计划/产物/Provider 五个
 * 可选面板。一个类型一个面板,不新增同步或插件协议。
 *
 * 面板内选择态归面板(不写全局路由):会话面板消费 session/tasksessions/
 * decisionsessions 引用,计划面板消费 schedule/,Provider 面板消费 provider/;
 * 其余实体引用经 onNavigateEntity 走既有全局路由离开工作台——与关系图面板的
 * onFocusGraph 同一语义。前缀判定只声明「本面板消费哪类」,路由表仍在 entityRoutes。
 */
export interface WorkbenchPanelProps {
  readonly repoId: string;
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
  /** ⌘K 命令面板入口:关系图面板与总览面板的顶栏搜索都从这里打开(App 的既有出口)。 */
  readonly onOpenPalette: () => void;
  readonly onSearchActiveChange?: (active: boolean) => void;
  // —— 总览面板的数据与回调(App 常驻读面,不新增请求)——
  /** `ha agenda` 同一条 repo.agenda.read 投影;undefined = 尚未读到。 */
  readonly agenda: AgendaSuccess | undefined;
  /** daemon 工作索引(repo.works.index):总览「工作」区域的行。 */
  readonly works: WorkIndexRead | undefined;
  /** `task/<id>` → 标题(App 常驻任务列表投影)。 */
  readonly titles: ReadonlyMap<string, string>;
  /** 工作区摘要(总览的数据前提);null = 尚未读到,面板内显示等待/失败态。 */
  readonly workspaceSummary: WorkspaceSummaryRead | null;
  readonly workspaceSummaryError: Error | null;
  /** 侧栏系统运行区同一份派生(App 折算,见 model/runtime-health.ts)。 */
  readonly health: RuntimeHealth;
  /** 会话/产物面板的任务出口:App 的任务详情既有路由(离开工作台)。 */
  readonly onOpenTask: (taskId: string) => void;
  /** 总览「在跑会话」出口:会话页既有路由(离开工作台)。 */
  readonly onOpenSessions: () => void;
  /** 总览取消置顶:与 App 侧栏同一 pin 写通道。 */
  readonly onUnpinTask: (taskId: string) => void;
}

export interface WorkbenchCatalogEntry {
  readonly id: string;
  readonly titleKey: MessageKey;
  readonly defaultOpen: boolean;
}

export const WORKBENCH_PANEL_CATALOG: readonly WorkbenchCatalogEntry[] = [
  { id: "documents", titleKey: "views.panelWorkbench.panelDocuments", defaultOpen: true },
  { id: "graph", titleKey: "views.panelWorkbench.panelGraph", defaultOpen: true },
  { id: "timeline", titleKey: "views.panelWorkbench.panelTimeline", defaultOpen: true },
  // 五个可选面板的标题与侧栏一级入口同词(shell.nav.*):同一概念一个名字,不另造副本。
  { id: "overview", titleKey: "shell.nav.overview", defaultOpen: false },
  { id: "sessions", titleKey: "shell.nav.sessions", defaultOpen: false },
  { id: "schedules", titleKey: "shell.nav.schedules", defaultOpen: false },
  { id: "artifacts", titleKey: "shell.nav.artifacts", defaultOpen: false },
  { id: "providers", titleKey: "shell.nav.providers", defaultOpen: false },
];

/** 默认选择:PR3253 的原三块,重置布局/首次进入都回到这里。 */
export const DEFAULT_WORKBENCH_PANEL_IDS: readonly string[] = WORKBENCH_PANEL_CATALOG.filter(
  (entry) => entry.defaultOpen,
).map((entry) => entry.id);

/**
 * 面板本地选择路由:本面板自消费的引用留在面板本地态,其余实体引用走全局导航。
 * isLocalRef 是模块级常量函数,保证 useCallback 依赖稳定。
 */
function usePanelLocalSelection(
  isLocalRef: (ref: string) => boolean,
  onNavigateEntity: (ref: string) => void,
): {
  readonly localRef: string | null;
  readonly setLocalRef: (ref: string | null) => void;
  readonly selectEntity: (ref: string) => void;
} {
  const [localRef, setLocalRef] = useState<string | null>(null);
  const selectEntity = useCallback(
    (ref: string) => {
      if (isLocalRef(ref)) setLocalRef(ref);
      else onNavigateEntity(ref);
    },
    [isLocalRef, onNavigateEntity],
  );
  return { localRef, setLocalRef, selectEntity };
}

const sessionsPanelRef = (ref: string): boolean =>
  ref.startsWith("session/") || ref.startsWith("tasksessions/") || ref.startsWith("decisionsessions/");
const schedulesPanelRef = (ref: string): boolean => ref.startsWith("schedule/");
const providersPanelRef = (ref: string): boolean => ref.startsWith("provider/");

/** 全部面板身份 → 浮窗描述符:身份/标题/顺序全部来自目录,上层按选择清单过滤后交给画板。 */
export function buildWorkbenchPanels(props: WorkbenchPanelProps): readonly FloatingPanelDescriptor[] {
  const nodes: Readonly<Record<string, React.ReactNode>> = {
    documents: <TaskDocumentsPanel tasks={props.tasks} onNavigateEntity={props.onNavigateEntity} />,
    graph: <GraphPanel {...props} />,
    timeline: <TimelinePanel {...props} />,
    overview: <OverviewPanel {...props} />,
    sessions: (
      <SessionsPanel
        repoId={props.repoId}
        relations={props.relations}
        onNavigateEntity={props.onNavigateEntity}
        onOpenTask={props.onOpenTask}
      />
    ),
    schedules: <SchedulesPanel {...props} />,
    artifacts: <ArtifactsPanel repoId={props.repoId} onOpenTask={props.onOpenTask} />,
    providers: <ProvidersPanel repoId={props.repoId} onNavigateEntity={props.onNavigateEntity} />,
  };
  return WORKBENCH_PANEL_CATALOG.map((entry) => ({
    id: entry.id,
    title: t(entry.titleKey),
    node: nodes[entry.id]!,
  }));
}

/**
 * 预设几何:默认三块维持 PR3253 的画布三栏平铺(文档 1/4 · 图 1/2 · 时间线 1/4);
 * 可选面板按目录序错位级联(近左上角,随画布尺寸伸缩、不超画布可用宽高),添加即
 * 落在可见位置,不与平铺位冲突——之后全归用户自由排。
 */
export function workbenchPresetGeometry(canvas: FloatingPanelCanvas): Readonly<Record<string, PanelGeometry>> {
  const gap = 16;
  const column = Math.max(220, Math.floor((canvas.width - gap * 4) / 4));
  const height = Math.max(200, canvas.height - gap * 2);
  const cascadeWidth = Math.round(
    Math.min(Math.max(canvas.width * 0.55, 320), 980, Math.max(240, canvas.width - gap * 2)),
  );
  const cascadeHeight = Math.round(
    Math.min(Math.max(canvas.height * 0.6, 240), 640, Math.max(160, canvas.height - gap * 2)),
  );
  const preset: Record<string, PanelGeometry> = {
    documents: { x: gap, y: gap, width: column, height },
    graph: { x: gap * 2 + column, y: gap, width: column * 2, height },
    timeline: { x: gap * 3 + column * 3, y: gap, width: column, height },
  };
  WORKBENCH_PANEL_CATALOG.forEach((entry, index) => {
    if (entry.defaultOpen) return;
    preset[entry.id] = {
      // 目录序错位级联;偏移同样夹回画布内(窄画布上多个可选面板叠在同一起点,由用户拖开)。
      x: Math.min(gap + index * 36, Math.max(gap, canvas.width - gap - cascadeWidth)),
      y: Math.min(gap + index * 28, Math.max(gap, canvas.height - gap - cascadeHeight)),
      width: cascadeWidth,
      height: cascadeHeight,
    };
  });
  return preset;
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
}: WorkbenchPanelProps) {
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
function TimelinePanel({ decisions, relations, onOpenDecisionPool, onFocusGraph }: WorkbenchPanelProps) {
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

/** 总览面板:整块总览视图(自带顶栏状态行,无页头外壳)进面板;数据全部来自 App 常驻读面。 */
function OverviewPanel(props: WorkbenchPanelProps) {
  if (props.workspaceSummary === null) {
    return <WorkspaceSummaryPending error={props.workspaceSummaryError} />;
  }
  return (
    <OverviewView
      repoId={props.repoId}
      agenda={props.agenda}
      works={props.works}
      titles={props.titles}
      workspaceSummary={props.workspaceSummary}
      health={props.health}
      onNavigateEntity={props.onNavigateEntity}
      onOpenTask={props.onOpenTask}
      onOpenSearch={props.onOpenPalette}
      onOpenSessions={props.onOpenSessions}
      onUnpin={props.onUnpinTask}
    />
  );
}

/** 会话面板:会话页提取出的 SessionsView 功能体;选择态(session/…)归面板本地。 */
function SessionsPanel({
  repoId,
  relations,
  onNavigateEntity,
  onOpenTask,
}: {
  readonly repoId: string;
  readonly relations: readonly RelationEdge[];
  readonly onNavigateEntity: (ref: string) => void;
  readonly onOpenTask: (taskId: string) => void;
}) {
  const { localRef, selectEntity } = usePanelLocalSelection(sessionsPanelRef, onNavigateEntity);
  return (
    <SessionsView
      renderHeader={() => null}
      repoId={repoId}
      relations={relations}
      focusedEntityRef={localRef}
      onSelectEntity={selectEntity}
      onOpenTask={onOpenTask}
    />
  );
}

/**
 * 计划面板:计划页的 ScheduleWorkspace 功能体 + 同一条 repo.schedules.list 读
 * (与计划页共享缓存键)。schedule/<id> 选择态归面板本地,「在关系图中查看」离开工作台。
 */
function SchedulesPanel({ repoId, onFocusGraph, onNavigateEntity }: WorkbenchPanelProps) {
  const { localRef, setLocalRef, selectEntity } = usePanelLocalSelection(schedulesPanelRef, onNavigateEntity);
  const query = useQuery({
    queryKey: ["schedules", repoId],
    queryFn: () => schedulesClient.list(repoId),
    staleTime: 2_000,
  });
  return (
    <div className="flex h-full min-h-0 flex-col" data-testid="workbench-schedules-panel">
      {query.isError && (
        <Notice tone="bad" variant="strip" testId="schedules-read-error">
          {t("schedules.readFailed", {
            error: query.error instanceof Error ? query.error.message : String(query.error),
          })}
        </Notice>
      )}
      <ScheduleWorkspace
        repoId={repoId}
        data={query.data ?? null}
        pending={query.isPending}
        focusedEntityRef={localRef}
        onSelectEntity={selectEntity}
        onFocusSchedule={setLocalRef}
        onFocusGraph={onFocusGraph}
      />
    </div>
  );
}

/** 产物面板:产物页的 ArtifactsWorkspace 功能体 + 同一条 repo.artifacts.list 读(缓存键共享)。 */
function ArtifactsPanel({
  repoId,
  onOpenTask,
}: {
  readonly repoId: string;
  readonly onOpenTask: (taskId: string) => void;
}) {
  const [kind, setKind] = useState<ArtifactGuiKind>("html");
  const query = useQuery({
    queryKey: ["artifacts", repoId, kind],
    queryFn: () => artifactsClient.list(repoId, kind),
    staleTime: 10_000,
  });
  return (
    <div className="flex h-full min-h-0 flex-col" data-testid="workbench-artifacts-panel">
      {query.isError && (
        <p role="alert" data-testid="artifacts-read-error" className={ARTIFACTS_READ_ERROR_ROW_CLASS}>
          {t("artifacts.readFailed", {
            error: query.error instanceof Error ? query.error.message : String(query.error),
          })}
        </p>
      )}
      <ArtifactsWorkspace
        repoId={repoId}
        data={query.data ?? null}
        pending={query.isPending}
        kind={kind}
        onKindChange={setKind}
        onNavigateTask={onOpenTask}
      />
    </div>
  );
}

/** Provider 面板:Provider 页提取出的 ProvidersWorkspace 功能体;provider/<id> 选择态归面板本地。 */
function ProvidersPanel({
  repoId,
  onNavigateEntity,
}: {
  readonly repoId: string;
  readonly onNavigateEntity: (ref: string) => void;
}) {
  const { localRef, selectEntity } = usePanelLocalSelection(providersPanelRef, onNavigateEntity);
  return <ProvidersWorkspace repoId={repoId} focusedEntityRef={localRef} onSelectEntity={selectEntity} />;
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
