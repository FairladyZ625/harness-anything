import { useCallback, useMemo, useState, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import type { ArtifactGuiKind } from "@harness-anything/daemon/protocol";
import type {
  WorkIndexRead,
  WorkspaceSummaryRead,
  RelationCoverageRow,
  FactAnchorRow,
  TaskWipRead,
} from "../../api/renderer-dto.ts";
import type { AgendaSuccess, SystemRepoRow } from "../api-client.ts";
import type { CatalogSnapshotSuccess } from "../api-client-catalog.ts";
import type { AppLocation } from "../navigation/viewHistory.ts";
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
import type { useTaskActions } from "../task-actions.ts";
import type { useDecisionActions } from "../decision-actions.ts";
import { artifactsClient } from "../artifacts-client.ts";
import { schedulesClient } from "../schedules-client.ts";
import { t, type MessageKey } from "../i18n/index.tsx";
import type { FloatingPanelCanvas, FloatingPanelDescriptor } from "./floating-panel-grid.tsx";
import type { PanelGeometry } from "./panel-workspace-layout.ts";
import {
  AgendaPanel,
  BoardPanel,
  CadencePanel,
  FreshnessPanel,
  WorkDetailPanel,
  WorksPanel,
} from "./panels/ledger-panels.tsx";
import {
  DecisionDetailPanel,
  DecisionPoolPanel,
  FactDetailPanel,
  TaskDetailPanel,
} from "./panels/governance-panels.tsx";
import {
  AdaptersPanel,
  AgentSquadPanel,
  DaemonObservePanel,
  EntitiesPanel,
  IdentityAccessPanel,
  PresetsPanel,
  SettingsPanel,
  SystemPanel,
  TokenUsagePanel,
} from "./panels/system-panels.tsx";
import { BrowserPanel, TerminalPanel } from "./panels/lifecycle-panels.tsx";

/**
 * 工作台面板目录与功能体组合源(task_48fe291624e06a2e9ad9496c81 起;
 * task_d87e6982658ceccc5f26c80f30 覆盖剩余真实功能路由)。
 *
 * 每个面板类型 = 一个真实功能块:整块复用既有视图或其提取出的 Workspace 功能体
 * (页面与工作台共用同一组合源,不复制业务状态)。目录是有限清单:文档/关系图/
 * 时间线三个默认面板(PR3253 原样保留)+ 全部既有功能路由的可选面板。一个类型一个
 * 面板,不新增同步或插件协议。home 项目选择与工作台自身是全局导航/递归宿主,不进目录。
 *
 * 面板内选择态归面板(不写全局路由):各功能体消费自己的引用前缀(会话面板
 * session/…、计划面板 schedule/、Provider 面板 provider/ 等);其余实体引用经
 * onNavigateEntity 走既有全局路由离开工作台——与关系图面板的 onFocusGraph 同一语义。
 * 前缀判定只声明「本面板消费哪类」,路由表仍在 entityRoutes。
 *
 * 路由覆盖表(App 的 ViewId → 面板 id;新页面照此行接入):
 * - home            —(项目选择宿主,全局导航)      - presets      preset/<id> 本地
 * - overview        overview                          - entities     entitydoc/<kind> 本地
 * - work            works                             - adapters     —
 * - workspace       workDetail(work 下拉选择根)    - sessions     session/… 本地
 * - agenda          agenda                            - schedules    schedule/ 本地
 * - board           board(筛选/预览本地)           - artifacts    —
 * - graph           graph(画布模式本地)           - agentSquad   agent/·squad/ 本地
 * - workbench       —(递归宿主)                   - providers    provider/ 本地
 * - cadence         cadence                           - tokenUsage   tokenAgent/·tokenSquad/ 本地
 * - decisionPool    decisionPool(域 Tab 本地)     - terminal     生命周期=离页语义
 * - decisionDetail  decisionDetail(dec_ 下拉)     - browser      webview 随挂载销毁
 * - factDetail      factDetail(fact/ 下拉)
 * - taskDetail(选中位叠加页)taskDetail(task 下拉)
 * - freshness       freshness
 * - system/daemonObserve/settings/identityAccess 同名面板(daemon 连接实况经 props)
 *
 * 接入路径:视图先给页头加 renderHeader 插槽(信息页头传空渲染、主动作经插槽进
 * PanelActionStrip),再在 panels/ 按域加面板组件,最后在 WORKBENCH_PANEL_CATALOG
 * 登记身份与标题键(shell.nav.* 同词)。数据一律走 App 已有读面/动作实例经
 * WorkbenchPanelProps 透传,不自建第二份查询状态。
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
  readonly runtimeRelations?: RelationEdge[];
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
  /** repo.agenda.read 的读取错误消息;null = 无错。 */
  readonly agendaError: string | null;
  /** daemon 工作索引(repo.works.index):总览「工作」区域与工作详情面板选择器的行。 */
  readonly works: WorkIndexRead | undefined;
  /** `task/<id>` → 标题(App 常驻任务列表投影)。 */
  readonly titles: ReadonlyMap<string, string>;
  /** 工作区摘要(总览/总池面板的数据前提);null = 尚未读到,面板内显示等待/失败态。 */
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
  // —— 剩余功能面板的数据与回调(task_d87e6982658ceccc5f26c80f30)——
  /** 当前项目显示名(详情类面板的面包屑/上下文行)。 */
  readonly projectName: string;
  /** 任务完整切面是否已 ready(工作面板的读取中提示)。 */
  readonly ready: boolean;
  /** repo.gui.catalog.snapshot 同一条投影(App 常驻);工作/预设/适配器面板共用。 */
  readonly catalog: CatalogSnapshotSuccess | undefined;
  readonly catalogError: string | null;
  readonly onRefreshLedger: () => void;
  /** 看板面板:收藏集合与切换(与看板页同一 localStorage 通道)。 */
  readonly favorites: ReadonlySet<string>;
  readonly onToggleFavorite: (taskId: string) => void;
  /** 看板面板:任务 WIP 快照(App 的 taskWipQuery,工作台视图一并启用)。 */
  readonly wipSnapshot: TaskWipRead | undefined;
  /** 任务/总池面板的动作与回执(App 的 useTaskActions 同一实例,不复制状态)。 */
  readonly taskActions: ReturnType<typeof useTaskActions>;
  /** 决策详情/总池面板的动作与回执(App 的 useDecisionActions 同一实例)。 */
  readonly decisionActions: ReturnType<typeof useDecisionActions>;
  /** 决策跳转:App 的可寻址决策详情路由(离开工作台)。 */
  readonly onNavigateDecision: (decisionId: string) => void;
  /** 研发态势面板「直达总池」出口:与 cadence 页同一 navigate(离开工作台)。 */
  readonly onOpenPool: () => void;
  /** daemon 投影的连接实况:系统/设置/账号/终端/Daemon观察面板的宿主输入。 */
  readonly activeRepoId: string | null;
  readonly repos: ReadonlyArray<SystemRepoRow>;
  readonly daemonGeneration: number | null;
  readonly repoRoot: string | null;
  /** 系统面板「观察详情」出口:daemonObserve 页既有路由(离开工作台)。 */
  readonly onOpenObserve: (repoId: string) => void;
  /** 设置面板「打开项目」出口:App 的切仓流程(离开工作台)。 */
  readonly onOpenProject: (repoId: string) => void;
  /** 终端面板的 URL 出口:App navigate(终端里点链接去浏览器页,离开工作台)。 */
  readonly navigate: (fields: Partial<AppLocation>) => void;
  /** 终端面板的本机文档出口:App 的文档预览浮层。 */
  readonly onOpenDocument: (path: string) => void;
  /** 任务详情面板「打开终端」出口:App 的建会话+切终端页流程(离开工作台)。 */
  readonly onOpenTerminal: (task: TaskRow) => void;
  /** 任务详情面板的工作面包屑出口:App 的 openWork(离开工作台)。 */
  readonly onOpenWork: (taskId: string) => void;
  /** 实体面板的视图出口:App goto(声明实体的视图跳转,离开工作台)。 */
  readonly onOpenView: (viewId: AppLocation["view"]) => void;
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
  // 可选面板的标题与侧栏一级入口同词(shell.nav.*):同一概念一个名字,不另造副本。
  { id: "overview", titleKey: "shell.nav.overview", defaultOpen: false },
  { id: "works", titleKey: "shell.nav.work", defaultOpen: false },
  { id: "workDetail", titleKey: "shell.nav.workspaceScope", defaultOpen: false },
  { id: "agenda", titleKey: "shell.nav.agenda", defaultOpen: false },
  { id: "board", titleKey: "shell.nav.board", defaultOpen: false },
  { id: "cadence", titleKey: "shell.nav.cadence", defaultOpen: false },
  { id: "decisionPool", titleKey: "shell.nav.decisionPool", defaultOpen: false },
  { id: "taskDetail", titleKey: "views.panelWorkbench.panelTaskDetail", defaultOpen: false },
  { id: "factDetail", titleKey: "shell.nav.factDetail", defaultOpen: false },
  { id: "decisionDetail", titleKey: "shell.nav.decisionDetail", defaultOpen: false },
  { id: "freshness", titleKey: "shell.nav.freshness", defaultOpen: false },
  { id: "entities", titleKey: "shell.nav.entities", defaultOpen: false },
  { id: "presets", titleKey: "shell.nav.presets", defaultOpen: false },
  { id: "adapters", titleKey: "shell.nav.adapters", defaultOpen: false },
  { id: "sessions", titleKey: "shell.nav.sessions", defaultOpen: false },
  { id: "schedules", titleKey: "shell.nav.schedules", defaultOpen: false },
  { id: "artifacts", titleKey: "shell.nav.artifacts", defaultOpen: false },
  { id: "agentSquad", titleKey: "shell.nav.agentSquad", defaultOpen: false },
  { id: "providers", titleKey: "shell.nav.providers", defaultOpen: false },
  { id: "tokenUsage", titleKey: "shell.nav.tokenUsage", defaultOpen: false },
  { id: "terminal", titleKey: "shell.nav.terminal", defaultOpen: false },
  { id: "browser", titleKey: "shell.nav.browser", defaultOpen: false },
  { id: "system", titleKey: "shell.nav.system", defaultOpen: false },
  { id: "daemonObserve", titleKey: "shell.nav.daemonObserve", defaultOpen: false },
  { id: "settings", titleKey: "shell.nav.settings", defaultOpen: false },
  { id: "identityAccess", titleKey: "shell.nav.identityAccess", defaultOpen: false },
];

/** 默认选择:PR3253 的原三块,重置布局/首次进入都回到这里。 */
export const DEFAULT_WORKBENCH_PANEL_IDS: readonly string[] = WORKBENCH_PANEL_CATALOG.filter(
  (entry) => entry.defaultOpen,
).map((entry) => entry.id);

/**
 * 面板本地选择路由:本面板自消费的引用留在面板本地态,其余实体引用走全局导航。
 * isLocalRef 是模块级常量函数,保证 useCallback 依赖稳定。
 */
export function usePanelLocalSelection(
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

/**
 * 面板顶的动作条:功能体页头里的主动作(重读/刷新/范围切换等)在面板里仍需可达,
 * 用一行窄条承接;纯信息页头则由面板标签承担,不渲染本条。
 */
export function PanelActionStrip({ children }: { readonly children: ReactNode }) {
  return (
    <div className="flex shrink-0 flex-wrap items-center justify-end gap-1.5 border-b border-border bg-surface px-2 py-1">
      {children}
    </div>
  );
}

/**
 * 详情类面板的本地实体选择入口(任务/事实/决策/工作):一行「类别 + 下拉」,
 * 不依赖切走全局页面就能查看;选择归面板本地态。
 */
export function PanelEntityPicker({
  label,
  testId,
  value,
  onChange,
  options,
}: {
  readonly label: string;
  readonly testId: string;
  readonly value: string | null;
  readonly onChange: (id: string | null) => void;
  readonly options: readonly { readonly id: string; readonly label: string }[];
}) {
  return (
    <div className="flex shrink-0 items-center gap-2 border-b border-border bg-surface px-2 py-1.5">
      <label htmlFor={testId} className="shrink-0 font-mono ui-micro text-text-faint">
        {label}
      </label>
      <select
        id={testId}
        data-testid={testId}
        value={value ?? ""}
        onChange={(event) => onChange(event.target.value || null)}
        className="control min-w-0 flex-1"
      >
        <option value="">{t("views.panelWorkbench.pickNone")}</option>
        {options.map((option) => (
          <option key={option.id} value={option.id}>
            {option.label || option.id}
          </option>
        ))}
      </select>
    </div>
  );
}

/** 详情面板未选中实体时的引导空态:说明这里能做什么,不假装有内容。 */
export function PanelPickHint({ messageKey }: { readonly messageKey: MessageKey }) {
  return (
    <div className="grid h-full place-items-center p-4" data-testid="panel-pick-hint">
      <Empty>{t(messageKey)}</Empty>
    </div>
  );
}

/** 全部面板身份 → 浮窗描述符:身份/标题/顺序全部来自目录,上层按选择清单过滤后交给画板。 */
export function buildWorkbenchPanels(props: WorkbenchPanelProps): readonly FloatingPanelDescriptor[] {
  const nodes: Readonly<Record<string, React.ReactNode>> = {
    documents: <TaskDocumentsPanel tasks={props.tasks} onNavigateEntity={props.onNavigateEntity} />,
    graph: <GraphPanel {...props} />,
    timeline: <TimelinePanel {...props} />,
    overview: <OverviewPanel {...props} />,
    works: <WorksPanel {...props} />,
    workDetail: <WorkDetailPanel {...props} />,
    agenda: (
      <AgendaPanel
        repoId={props.repoId}
        agenda={props.agenda}
        agendaError={props.agendaError}
        onNavigateEntity={props.onNavigateEntity}
      />
    ),
    board: <BoardPanel {...props} />,
    cadence: <CadencePanel {...props} />,
    decisionPool: <DecisionPoolPanel {...props} />,
    taskDetail: <TaskDetailPanel {...props} />,
    factDetail: <FactDetailPanel {...props} />,
    decisionDetail: <DecisionDetailPanel {...props} />,
    freshness: <FreshnessPanel {...props} />,
    entities: <EntitiesPanel {...props} />,
    presets: <PresetsPanel {...props} />,
    adapters: <AdaptersPanel repoId={props.repoId} tasks={props.tasks} />,
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
    agentSquad: <AgentSquadPanel {...props} />,
    providers: <ProvidersPanel repoId={props.repoId} onNavigateEntity={props.onNavigateEntity} />,
    tokenUsage: <TokenUsagePanel {...props} />,
    terminal: <TerminalPanel {...props} />,
    browser: <BrowserPanel />,
    system: <SystemPanel {...props} />,
    daemonObserve: <DaemonObservePanel {...props} />,
    settings: <SettingsPanel {...props} />,
    identityAccess: <IdentityAccessPanel {...props} />,
  };
  return WORKBENCH_PANEL_CATALOG.map((entry) => ({
    id: entry.id,
    title: t(entry.titleKey),
    node: nodes[entry.id]!,
  }));
}

/**
 * 预设几何:默认三块维持 PR3253 的画布三栏平铺(文档 1/4 · 图 1/2 · 时间线 1/4);
 * 可选面板按目录序错位级联(近左上角,随画布尺寸伸缩、不超画布可用宽高)。级联到
 * 右边界即换行到下一排——目录扩大到全部功能路由后,后来的面板不再挤在同一夹点,
 * 添加即落在可见位置,不与平铺位冲突——之后全归用户自由排。
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
  const stepX = 36;
  const stepY = 28;
  const maxX = Math.max(gap, canvas.width - gap - cascadeWidth);
  const maxY = Math.max(gap, canvas.height - gap - cascadeHeight);
  // 一排能放几个错位位;窄画布上一排一位(全被夹到 maxX 时 span 仍 ≥ 1)。
  const perRow = Math.max(1, Math.floor((maxX - gap) / stepX) + 1);
  WORKBENCH_PANEL_CATALOG.forEach((entry, index) => {
    if (entry.defaultOpen) return;
    const columnInRow = index % perRow;
    const row = Math.floor(index / perRow);
    preset[entry.id] = {
      x: Math.min(gap + columnInRow * stepX, maxX),
      y: Math.min(gap + row * stepY, maxY),
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
