import { useState } from "react";
import { AttestationPoolView } from "../../views/AttestationPoolView.tsx";
import { FactDetailView } from "../../views/EntityDetailView.tsx";
import { TaskDetailView } from "../../views/TaskDetailView.tsx";
import { DecisionDetailView } from "../../components/decisionDetail/DecisionDetailView.tsx";
import { WorkspaceSummaryPending } from "../../components/WorkspaceSummaryPending.tsx";
import type { AttestationPoolTabId } from "../../model/attestation-pool.ts";
import { t } from "../../i18n/index.tsx";
import { PanelActionStrip, PanelEntityPicker, PanelPickHint, type WorkbenchPanelProps } from "../workbench-panels.tsx";

/**
 * 治理域面板(待办签发总池/任务详情/事实详情/决策详情):页面功能体原样进面板,
 * 详情的实体选择归面板(本地下拉),动作走 App 的 taskActions/decisionActions 同一
 * 实例;跨实体出口(在图中查看/打开任务/决策路由)离开工作台走既有全局路由。
 * 总池的域 Tab 是面板本地态(页面版由 AppLocation 携带,面板不写全局位置)。
 */

/** 待办签发总池面板:专注裁决入口保留在面板动作条;数据前提 = 工作区摘要。 */
export function DecisionPoolPanel(props: WorkbenchPanelProps) {
  const [poolTab, setPoolTab] = useState<AttestationPoolTabId>("decisions");
  if (props.workspaceSummary === null) {
    return <WorkspaceSummaryPending error={props.workspaceSummaryError} />;
  }
  const { taskActions, decisionActions } = props;
  return (
    <div className="h-full min-h-0" data-testid="workbench-decision-pool-panel">
      <AttestationPoolView
        repoId={props.repoId}
        decisions={props.decisions}
        summary={props.workspaceSummary.decisions}
        facts={props.facts}
        relations={props.relations}
        coverageRows={props.coverageRows}
        relationState={props.relationState}
        focusedDecisionId={null}
        onFocusGraph={props.onFocusGraph}
        onNavigateDecision={props.onNavigateDecision}
        onNavigateEntity={props.onNavigateEntity}
        onPropose={decisionActions.propose}
        proposalFeedback={decisionActions.feedback.get("proposal")}
        onJudge={decisionActions.judge}
        mutationFeedback={(decisionId) => decisionActions.feedback.get(decisionId)}
        onCheckReceipt={(key) => {
          void decisionActions.checkReceipt(key);
        }}
        tasks={props.tasks}
        onAttest={taskActions.attestGate}
        taskFeedback={(taskId) => taskActions.feedback.get(taskId)}
        onConsentReview={(task, reviewId) => taskActions.consentReview(task, reviewId)}
        onNavigateTask={props.onOpenTask}
        poolTab={poolTab}
        onPoolTabChange={setPoolTab}
        renderHeader={({ focusEntryAction }) =>
          focusEntryAction !== undefined ? <PanelActionStrip>{focusEntryAction}</PanelActionStrip> : null
        }
      />
    </div>
  );
}

/** 任务详情面板:任务选择归面板(下拉);动作全走 App 的 taskActions 同一实例。 */
export function TaskDetailPanel(props: WorkbenchPanelProps) {
  const [taskId, setTaskId] = useState<string | null>(() =>
    defaultDetailTaskId(
      props.tasks.map(({ taskId: id, title, pinned, lastKnownAt }) => ({ id, label: title, pinned, lastKnownAt })),
    ),
  );
  const task = props.tasks.find((candidate) => candidate.taskId === taskId) ?? null;
  const { taskActions } = props;
  const work =
    task !== null && task.workId !== undefined && task.workId !== task.taskId
      ? { taskId: task.workId, title: task.workTitle ?? task.workId }
      : null;
  return (
    <div className="flex h-full min-h-0 flex-col" data-testid="workbench-task-detail-panel">
      <PanelEntityPicker
        label={t("views.panelWorkbench.documentsTask")}
        testId="workbench-task-detail-task"
        value={taskId}
        onChange={setTaskId}
        options={props.tasks.map(({ taskId: id, title }) => ({ id, label: title }))}
      />
      {task === null ? (
        <PanelPickHint messageKey="views.panelWorkbench.taskDetailEmpty" />
      ) : (
        <TaskDetailView
          repoId={props.repoId}
          task={task}
          onBack={() => setTaskId(null)}
          tasks={props.tasks}
          relations={props.relations}
          decisions={props.decisions}
          onSelect={setTaskId}
          projectName={props.projectName}
          fromViewLabel={t("shell.nav.workbench")}
          work={work}
          onOpenWork={props.onOpenWork}
          onNavigateDecision={props.onNavigateDecision}
          onNavigateEntity={props.onNavigateEntity}
          onOpenTerminal={props.onOpenTerminal}
          mutationFeedback={taskActions.feedback.get(task.taskId)}
          onProgress={(input) => taskActions.appendProgress(task, input)}
          onSubmit={() => taskActions.submitTask(task)}
          onComplete={() => taskActions.completeTask(task)}
          onAdjudicate={(decision, reason, reviewId) => taskActions.adjudicateTask(task, decision, reason, reviewId)}
          onConsentReview={(reviewId) => taskActions.consentReview(task, reviewId)}
          onAttest={taskActions.attestGate}
          onSetPin={(target, pinned) => {
            void taskActions.setTaskPin(target, pinned);
          }}
          onFocusGraph={props.onFocusGraph}
        />
      )}
    </div>
  );
}

/** 事实详情面板:事实选择归面板(下拉,anchor 即引用);邻域数据 = 工作台完整投影。 */
export function FactDetailPanel(props: WorkbenchPanelProps) {
  const [factRef, setFactRef] = useState<string | null>(
    defaultDetailEntityId(props.facts.map((fact) => ({ id: fact.anchor, label: fact.text }))),
  );
  return (
    <div className="flex h-full min-h-0 flex-col" data-testid="workbench-fact-detail-panel">
      <PanelEntityPicker
        label={t("views.panelWorkbench.pickFact")}
        testId="workbench-fact-detail-fact"
        value={factRef}
        onChange={setFactRef}
        options={props.facts.map((fact) => ({ id: fact.anchor, label: fact.text }))}
      />
      {factRef === null ? (
        <PanelPickHint messageKey="views.panelWorkbench.factDetailEmpty" />
      ) : (
        <FactDetailView
          repoId={props.repoId}
          factRef={factRef}
          facts={props.facts}
          tasks={props.tasks}
          decisions={props.decisions}
          relations={props.relations}
          factAnchors={props.factAnchors ?? []}
          coverageRows={props.coverageRows ?? []}
          loading={props.relationState === "loading"}
          onNavigateEntity={props.onNavigateEntity}
          onNavigateDecision={props.onNavigateDecision}
          onNavigateTask={props.onOpenTask}
          onFocusGraph={props.onFocusGraph}
        />
      )}
    </div>
  );
}

/** 决策详情面板:决策选择归面板(下拉);裁决动作走 App 的 decisionActions 同一实例。 */
export function DecisionDetailPanel(props: WorkbenchPanelProps) {
  const [decisionId, setDecisionId] = useState<string | null>(
    defaultDetailEntityId(props.decisions.map((decision) => ({ id: decision.decisionId, label: decision.title }))),
  );
  const { decisionActions } = props;
  return (
    <div className="flex h-full min-h-0 flex-col" data-testid="workbench-decision-detail-panel">
      <PanelEntityPicker
        label={t("views.panelWorkbench.pickDecision")}
        testId="workbench-decision-detail-decision"
        value={decisionId}
        onChange={setDecisionId}
        options={props.decisions.map((decision) => ({ id: decision.decisionId, label: decision.title }))}
      />
      {decisionId === null ? (
        <PanelPickHint messageKey="views.panelWorkbench.decisionDetailEmpty" />
      ) : (
        <DecisionDetailView
          repoId={props.repoId}
          decisionId={decisionId}
          decisions={props.decisions}
          tasks={props.tasks}
          relations={props.relations}
          loading={props.relationState === "loading"}
          onBack={() => setDecisionId(null)}
          projectName={props.projectName}
          fromViewLabel={t("shell.nav.workbench")}
          onNavigateDecision={props.onNavigateDecision}
          onNavigateTask={props.onOpenTask}
          onNavigateEntity={props.onNavigateEntity}
          onFocusGraph={props.onFocusGraph}
          onOpenPool={props.onOpenDecisionPool}
          onJudge={decisionActions.judge}
          judgeFeedback={decisionActions.feedback.get(decisionId)}
          onCheckReceipt={() => {
            void decisionActions.checkReceipt(decisionId);
          }}
        />
      )}
    </div>
  );
}

/** 默认任务(与文档面板同判据):置顶优先,其次最近有动静的任务。 */
function defaultDetailTaskId(
  rows: readonly {
    readonly id: string;
    readonly label: string;
    readonly pinned?: boolean;
    readonly lastKnownAt?: string;
  }[],
): string | null {
  const pinnedRow = rows.find((row) => row.pinned === true);
  if (pinnedRow) return pinnedRow.id;
  let best: { readonly id: string; readonly lastKnownAt?: string } | null = null;
  for (const row of rows) {
    if (best === null || (row.lastKnownAt ?? "") > (best.lastKnownAt ?? "")) best = row;
  }
  return best?.id ?? null;
}

/** 默认详情实体:第一行(事实/决策行集已按读面序排列);没有就空。 */
function defaultDetailEntityId(rows: readonly { readonly id: string; readonly label: string }[]): string | null {
  return rows[0]?.id ?? null;
}
