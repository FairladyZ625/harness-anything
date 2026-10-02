import { useMemo, useState } from "react";
import { AgendaView } from "../../views/AgendaView.tsx";
import { BoardView } from "../../views/BoardView.tsx";
import { CadenceView } from "../../views/CadenceView.tsx";
import { FreshnessView } from "../../views/FreshnessView.tsx";
import { WorkView } from "../../views/WorkView.tsx";
import { WorkspaceView } from "../../views/WorkspaceView.tsx";
import { TaskPreviewDrawer } from "../../components/TaskPreviewDrawer.tsx";
import { WorkspaceSummaryPending } from "../../components/WorkspaceSummaryPending.tsx";
import { DEFAULT_TASK_FILTERS, type TaskFilters } from "../../model/taskFilters.ts";
import { combineWorkspaceScopePages, useWorkspaceScopeQuery } from "../../workspace-scope-data.ts";
import { t } from "../../i18n/index.tsx";
import { PanelActionStrip, PanelEntityPicker, PanelPickHint, type WorkbenchPanelProps } from "../workbench-panels.tsx";

/**
 * 台账域面板(工作列表/工作详情/议程/看板/研发态势/失真预警):
 * 页面功能体 + renderHeader 空渲染/动作条进面板。数据与动作全部来自 App 常驻读面与
 * 既有 hook(同缓存键),筛选/选中/预览归面板本地态,不写全局路由。
 */

/** 议程面板:议程页同一功能体;数据 = App 常驻 repo.agenda.read,答复面板已 portal 出浮窗。 */
export function AgendaPanel({
  repoId,
  agenda,
  agendaError,
  onNavigateEntity,
}: {
  readonly repoId: string;
  readonly agenda: WorkbenchPanelProps["agenda"];
  readonly agendaError: string | null;
  readonly onNavigateEntity: (ref: string) => void;
}) {
  return (
    <div className="h-full min-h-0" data-testid="workbench-agenda-panel">
      <AgendaView
        repoId={repoId}
        agenda={agenda}
        agendaError={agendaError}
        onNavigateEntity={onNavigateEntity}
        renderHeader={() => null}
      />
    </div>
  );
}

/** 工作列表面板:工作页功能体;「开始一项工作」主动作保留在面板动作条。 */
export function WorksPanel(props: WorkbenchPanelProps) {
  return (
    <div className="h-full min-h-0" data-testid="workbench-works-panel">
      <WorkView
        tasks={props.tasks}
        repoId={props.repoId}
        ready={props.ready}
        onOpenTask={props.onOpenTask}
        catalog={props.catalog}
        catalogError={props.catalogError}
        daemonState={props.health.daemon.state}
        onRefreshLedger={props.onRefreshLedger}
        agenda={props.agenda}
        renderHeader={({ startWorkAction }) => <PanelActionStrip>{startWorkAction}</PanelActionStrip>}
      />
    </div>
  );
}

/**
 * 工作详情面板:工作选择归面板(工作索引行下拉),范围读面走工作页同一条
 * workspace-scope 查询(缓存键 = 仓 + 根任务,与工作页共享);根任务页签不进面板
 * (页面版的 renderRootTask 需要 App 的任务详情接线),根行点击走全局任务详情出口。
 */
export function WorkDetailPanel(props: WorkbenchPanelProps) {
  const works = props.works?.works ?? [];
  const [rootTaskId, setRootTaskId] = useState<string | null>(works[0]?.taskId ?? null);
  const scopeQuery = useWorkspaceScopeQuery(props.activeRepoId, rootTaskId);
  const scope = useMemo(() => combineWorkspaceScopePages(scopeQuery.data?.pages ?? []), [scopeQuery.data]);
  const { taskActions } = props;
  return (
    <div className="flex h-full min-h-0 flex-col" data-testid="workbench-work-detail-panel">
      <PanelEntityPicker
        label={t("views.panelWorkbench.pickWork")}
        testId="workbench-work-detail-root"
        value={rootTaskId}
        onChange={setRootTaskId}
        options={works.map((work) => ({ id: work.taskId, label: work.title ?? work.taskId }))}
      />
      {rootTaskId === null ? (
        <PanelPickHint messageKey="views.panelWorkbench.workDetailEmpty" />
      ) : scope ? (
        <WorkspaceView
          scope={scope}
          repoId={props.repoId}
          projectName={props.projectName}
          onOpenTask={props.onOpenTask}
          tasks={props.tasks}
          decisions={props.decisions}
          facts={props.facts}
          relations={props.relations}
          onNavigateEntity={props.onNavigateEntity}
          onSetTaskPin={props.onSetTaskPin}
          onAttest={(task, gateId, mode) => {
            void taskActions.attestGate(task, gateId, mode);
          }}
          onConsent={(task, reviewId) => {
            void taskActions.consentReview(task, reviewId);
          }}
          onAdjudicate={(task, decision, reason, reviewId) => {
            void taskActions.adjudicateTask(task, decision, reason, reviewId);
          }}
          feedback={(taskId) => taskActions.feedback.get(taskId)}
          onLoadMore={() => {
            void scopeQuery.fetchNextPage();
          }}
          loadingMore={scopeQuery.isFetchingNextPage}
        />
      ) : (
        <WorkspaceSummaryPending error={scopeQuery.error} />
      )}
    </div>
  );
}

/**
 * 看板面板:看板页功能体;筛选是面板本地态(不写 AppLocation),卡片点击开面板本地
 * 的任务预览抽屉(与页面同一 TaskPreviewDrawer,壳层已 portal 出浮窗裁切),
 * 「打开完整详情」走全局任务详情出口离开工作台。
 */
export function BoardPanel(props: WorkbenchPanelProps) {
  const [filters, setFilters] = useState<TaskFilters>(DEFAULT_TASK_FILTERS);
  const [previewId, setPreviewId] = useState<string | null>(null);
  const { taskActions } = props;
  const previewTask = props.tasks.find((task) => task.taskId === previewId) ?? null;
  return (
    <div className="h-full min-h-0" data-testid="workbench-board-panel">
      <BoardView
        tasks={props.tasks}
        allTasks={[...props.tasks]}
        wipSnapshot={props.wipSnapshot}
        filters={filters}
        onFiltersChange={setFilters}
        onSelect={setPreviewId}
        favorites={props.favorites}
        onToggleFavorite={props.onToggleFavorite}
        onStartTask={taskActions.startTask}
        mutationFeedback={(taskId) => taskActions.feedback.get(taskId)}
        onSetPin={(task, pinned) => {
          void taskActions.setTaskPin(task, pinned);
        }}
        renderHeader={() => null}
      />
      <TaskPreviewDrawer
        task={previewTask}
        tasks={props.tasks}
        relations={props.relations}
        onClose={() => setPreviewId(null)}
        onOpenDetail={props.onOpenTask}
        onPreviewTask={setPreviewId}
        onSetPin={(task, pinned) => {
          void taskActions.setTaskPin(task, pinned);
        }}
      />
    </div>
  );
}

/** 研发态势面板:研发态势页功能体(自带 observe.tail 会话组读面);决策行来自工作台的完整投影。 */
export function CadencePanel(props: WorkbenchPanelProps) {
  return (
    <div className="h-full min-h-0" data-testid="workbench-cadence-panel">
      <CadenceView
        repoId={props.repoId}
        projectName={props.projectName}
        tasks={props.tasks}
        agenda={props.agenda}
        decisions={props.decisions}
        onNavigateEntity={props.onNavigateEntity}
        onOpenPool={props.onOpenPool}
        renderHeader={() => null}
      />
    </div>
  );
}

/** 失真预警面板:失真预警页功能体;数据 = 工作台挂载的完整三元投影。 */
export function FreshnessPanel(props: WorkbenchPanelProps) {
  return (
    <div className="h-full min-h-0" data-testid="workbench-freshness-panel">
      <FreshnessView
        decisions={props.decisions}
        coverageRows={props.coverageRows ?? []}
        relationState={props.relationState}
        onNavigateEntity={props.onNavigateEntity}
        renderHeader={() => null}
      />
    </div>
  );
}
