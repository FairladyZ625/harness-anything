import { TabPanel } from "../components/primitives/EntryBoundary.tsx";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { ArrowRight, Crosshair, Handshake, Scales, SealCheck } from "@phosphor-icons/react";
import type { RelationCoverageRow, WorkspaceSummaryRead } from "../../api/renderer-dto.ts";
import type { DecisionProposalInput } from "../api-client.ts";
import { AttestFeedbackRow, GateAttestForm } from "../components/taskDetail/TaskGateAttestCard.tsx";
import type { GateAttestMode } from "../components/taskDetail/TaskGateAttestCard.tsx";
import { DecisionsView } from "./DecisionsView.tsx";
import { DecisionPoolSection } from "./decision-pool-section.tsx";
import type { DecisionAction, DecisionMutationFeedback } from "../decision-actions.ts";
import { type DecisionRow, type FactRef, type RelationEdge, type TaskRow } from "../model/types.ts";
import {
  deriveAttestationLanes,
  TASK_CLOSEOUT_TABS,
  type AttestationPoolTabId,
  type GateAttestationItem,
} from "../model/attestation-pool.ts";
import type { TaskMutationFeedback } from "../task-actions.ts";
import { Drawer } from "../components/primitives/Drawer.tsx";
import { FilterChips } from "../components/primitives/FilterChips.tsx";
import { PageHeader } from "../components/primitives/PageHeader.tsx";
import { Section } from "../components/primitives/Section.tsx";
import { StatusTag } from "../components/primitives/StatusTag.tsx";
import { Tabs } from "../components/primitives/Tabs.tsx";
import { TitleText } from "../components/primitives/TitleText.tsx";
import { t, type MessageKey } from "../i18n/index.tsx";

type RelationState = "ready" | "loading" | "error";

/** 任务收口域的第二级筛选文案;决策域的浏览分组由 DecisionPoolSection 自带。 */
const LANE_LABEL_KEY: Record<(typeof TASK_CLOSEOUT_TABS)[number], MessageKey> = {
  taskCloseout: "views.attestationPoolView.laneAllCloseout",
  gates: "views.attestationPoolView.tabGates",
  consents: "views.attestationPoolView.tabConsents",
  breakGlass: "views.attestationPoolView.tabBreakGlass",
};

/**
 * 待办签发总池:人类治理动作的唯一收件箱,回答「哪些要我签、先签哪个、签了会发生
 * 什么」。版式按 gui-visual-language-standard §2.4 列表页:页头(页名+一句话+计数
 * +主动作)、域用下划线 Tabs、任务收口域内 lane 用带计数 FilterChips、行用单行条目
 * +有底色状态标签 +就地动作,详情与签发表单进右侧抽屉,空 lane 整块消失。内部两级
 * 分组——第一级按域分:「决策待裁」(decision 域,DecisionPoolSection 的过滤/分组/
 * 快速批复保留,并可进入专注裁决模式)与「任务收口」(task 域);第二级只在任务
 * 收口域内分:待我签门禁(manual-attest 打勾签注与双控缺签)、待我同意收口
 * (consent)、阻断需特批(契约声明 allowOverride 的 failed/missing)。数据源只来自
 * 投影行真实状态;Tab 由 AppLocation 携带(poolTab),URL/刷新可寻址;动作全部行内
 * 展开,不出全局模态。域与 lane 的区分一律图标+文字,不只靠颜色。
 */
export function AttestationPoolView({
  repoId,
  decisions,
  summary,
  facts,
  relations,
  coverageRows = [],
  relationState = "ready",
  focusedDecisionId,
  onFocusGraph,
  onNavigateDecision,
  onNavigateEntity,
  onPropose,
  proposalFeedback,
  onJudge,
  mutationFeedback,
  onCheckReceipt,
  tasks,
  onAttest,
  taskFeedback,
  onConsentReview,
  onNavigateTask,
  poolTab,
  onPoolTabChange,
  renderHeader,
}: {
  repoId: string;
  decisions: DecisionRow[];
  summary: WorkspaceSummaryRead["decisions"];
  facts: FactRef[];
  relations: RelationEdge[];
  coverageRows?: ReadonlyArray<RelationCoverageRow>;
  relationState?: RelationState;
  focusedDecisionId?: string | null;
  onFocusGraph?: (ref: string) => void;
  /** G10 实体互链:卡头/supersede 链的 decision ID 必须有路。 */
  onNavigateDecision: (decisionId: string) => void;
  /** 专注裁决模式(内嵌 DecisionsView)的实体互链出口。 */
  onNavigateEntity?: (ref: string) => void;
  onPropose?: (input: DecisionProposalInput) => Promise<DecisionMutationFeedback>;
  proposalFeedback?: DecisionMutationFeedback;
  onJudge?: (
    decision: DecisionRow,
    action: DecisionAction,
    input: { readonly rationale: string; readonly judgmentOnlyRationale?: string },
  ) => Promise<DecisionMutationFeedback>;
  mutationFeedback?: (decisionId: string) => DecisionMutationFeedback | undefined;
  onCheckReceipt?: (key: string) => void;
  /** 任务侧 lane 数据源(投影行原样);签发判据见 model/attestation-pool.ts。 */
  tasks: readonly TaskRow[];
  onAttest?: (
    task: Pick<TaskRow, "taskId">,
    gateId: string,
    mode: GateAttestMode,
    rationale?: string,
  ) => Promise<TaskMutationFeedback>;
  taskFeedback?: (taskId: string) => TaskMutationFeedback | undefined;
  /** CEO 终审批准:对最新已批准评审记录同意。 */
  onConsentReview?: (task: TaskRow, reviewId: string) => Promise<unknown>;
  onNavigateTask?: (taskId: string) => void;
  /** 当前 Tab 由应用位置携带(可寻址、刷新不丢)。 */
  poolTab: AttestationPoolTabId;
  onPoolTabChange: (tab: AttestationPoolTabId) => void;
  /** 页头渲染:缺省装总池页头 + 专注裁决入口;工作台面板可只保留主动作。 */
  renderHeader?: (slot: { readonly focusEntryAction: ReactNode }) => ReactNode;
}) {
  const lanes = useMemo(() => deriveAttestationLanes(tasks), [tasks]),
    // 计数口径与侧栏角标统一:决策待裁读 workspace summary 的 kernel proposed 判定
    // (kernel decisionCapabilities 的 accept 前置就是 proposed,两个词表恒等),
    // 与 App 的 poolBadgeCount 同一 query key 同一缓存对象,结构性相等;行级动作
    // 门仍走 decisionCan 行能力投影。任务侧计数 = lane 长度。
    taskCloseoutCount = lanes.gates.length + lanes.consents.length + lanes.breakGlass.length,
    counts: Record<AttestationPoolTabId, number> = {
      decisions: summary.inboxCount,
      taskCloseout: taskCloseoutCount,
      gates: lanes.gates.length,
      consents: lanes.consents.length,
      breakGlass: lanes.breakGlass.length,
    },
    total = counts.decisions + counts.taskCloseout;
  // 深链聚焦一条决策时,决策域是落点(与 openDecisionInPool 的推栈路径一致)。
  useEffect(() => {
    if (focusedDecisionId && poolTab !== "decisions") onPoolTabChange("decisions");
  }, [focusedDecisionId, onPoolTabChange, poolTab]);
  // 默认落点先回答问题(业主 2026-09-30 截图验收):定位携带的页签落在没有任何待办
  // 的决策域、而任务收口域确实有待办时,默认改开有待办的页签——打开这页的人要看的是
  // 待办,不是空列表。用户亲手切过页签或深链聚焦决策后本效果不再介入;显式落在
  // 任务收口域的定位不受影响(条件只在 decisions 域起判)。
  const orientedRef = useRef(false);
  useEffect(() => {
    if (orientedRef.current || focusedDecisionId) return;
    if (poolTab === "decisions" && counts.decisions === 0 && counts.taskCloseout > 0) {
      orientedRef.current = true;
      onPoolTabChange("taskCloseout");
    }
  }, [counts.decisions, counts.taskCloseout, focusedDecisionId, onPoolTabChange, poolTab]);
  /** 用户亲手选页签(Tabs/FilterChips):此后的页签完全按用户来,默认定向不再介入。 */
  const pickTab = (tab: AttestationPoolTabId) => {
    orientedRef.current = true;
    onPoolTabChange(tab);
  };

  const inDecisionDomain = poolTab === "decisions",
    // 专注裁决是决策域的模式:整个池体让位给 DecisionsView(J/K 键盘流 + 判定历史)。
    [focusMode, setFocusMode] = useState(false);
  const showGates = poolTab === "taskCloseout" || poolTab === "gates",
    showConsents = poolTab === "taskCloseout" || poolTab === "consents",
    showBreakGlass = poolTab === "taskCloseout" || poolTab === "breakGlass";

  if (inDecisionDomain && focusMode && onJudge) {
    return (
      <DecisionsView
        decisions={decisions}
        tasks={tasks}
        relations={relations}
        facts={facts}
        onJudge={onJudge}
        mutationFeedback={mutationFeedback}
        onCheckReceipt={(decisionId) => onCheckReceipt?.(decisionId)}
        relationState={relationState}
        onNavigateDecision={onNavigateDecision}
        onNavigateTask={onNavigateTask}
        onFocusGraph={onFocusGraph}
        onNavigateEntity={onNavigateEntity}
        coverageRows={coverageRows}
        onExit={() => setFocusMode(false)}
      />
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col" data-testid="attestation-pool-view">
      {(() => {
        const focusEntryAction =
          inDecisionDomain && onJudge ? (
            <button
              type="button"
              data-testid="attestation-pool-focus-entry"
              onClick={() => setFocusMode(true)}
              title={t("views.attestationPoolView.focusEntryTitle")}
              className="inline-flex h-7 items-center gap-1.5 rounded-xs border border-border bg-text/5 px-2.5 ui-meta text-text transition-colors duration-100 hover:bg-text/10"
            >
              <Crosshair weight="bold" aria-hidden />
              {t("views.attestationPoolView.focusEntry")}
              <b className="font-mono font-medium tabular-nums">{counts.decisions}</b>
            </button>
          ) : undefined;
        return renderHeader !== undefined ? (
          renderHeader({ focusEntryAction })
        ) : (
          <PageHeader
            title={t("views.attestationPoolView.title")}
            note={t("views.attestationPoolView.subtitle")}
            meta={
              <span data-testid="attestation-pool-total">
                {t("views.attestationPoolView.totalCount", { count: total })}
              </span>
            }
            actions={focusEntryAction}
          />
        );
      })()}
      <div className="mt-2.5">
        <Tabs
          ariaLabel={t("views.attestationPoolView.tablist")}
          idPrefix="pool-domain"
          value={inDecisionDomain ? "decisions" : "taskCloseout"}
          onChange={(key) => pickTab(key)}
          tabs={[
            {
              key: "decisions" as const,
              label: (
                <span className="inline-flex items-center gap-1.5">
                  <Scales weight="bold" aria-hidden />
                  {t("views.attestationPoolView.domainDecisions")}
                </span>
              ),
              count: counts.decisions,
            },
            {
              key: "taskCloseout" as const,
              label: (
                <span className="inline-flex items-center gap-1.5">
                  <SealCheck weight="bold" aria-hidden />
                  {t("views.attestationPoolView.domainTaskCloseout")}
                </span>
              ),
              count: counts.taskCloseout,
            },
          ]}
        />
      </div>
      <TabPanel
        idPrefix="pool-domain"
        value={inDecisionDomain ? "decisions" : "taskCloseout"}
        className="flex min-h-0 flex-1 flex-col overflow-hidden"
      >
        {inDecisionDomain ? (
          <div className="min-h-0 flex-1 overflow-auto px-5 pb-10 pt-4 md:px-7">
            <DecisionPoolSection
              repoId={repoId}
              decisions={decisions}
              summary={summary}
              facts={facts}
              relations={relations}
              coverageRows={coverageRows}
              relationState={relationState}
              focusedDecisionId={focusedDecisionId}
              onFocusGraph={onFocusGraph}
              onNavigateDecision={onNavigateDecision}
              onPropose={onPropose}
              proposalFeedback={proposalFeedback}
              onJudge={onJudge}
              mutationFeedback={mutationFeedback}
              onCheckReceipt={onCheckReceipt}
            />
          </div>
        ) : (
          <>
            <div className="flex-none px-5 pt-3 md:px-7" data-testid="attestation-pool-lane-chips">
              <FilterChips
                value={poolTab}
                onChange={pickTab}
                chips={TASK_CLOSEOUT_TABS.map((id) => ({
                  key: id,
                  label: t(LANE_LABEL_KEY[id]),
                  count: counts[id],
                }))}
              />
            </div>
            <div className="min-h-0 flex-1 overflow-auto px-5 pb-10 pt-1 md:px-7">
              <div>
                {taskCloseoutCount === 0 ? (
                  <p data-testid="pool-closeout-clear" className="flex items-center gap-2 py-2 text-text-faint ui-body">
                    <StatusTag tone="done" label={t("views.attestationPoolView.allClear")} />
                    {t("views.attestationPoolView.closeoutAllClear")}
                  </p>
                ) : null}
                {showGates && lanes.gates.length > 0 && (
                  <Section
                    variant="hero"
                    title={t("views.attestationPoolView.tabGates")}
                    count={lanes.gates.length}
                    note={t("views.attestationPoolView.gatesHint")}
                  >
                    {lanes.gates.map((item) => (
                      <GateLaneRow
                        key={`${item.taskId}:${item.gateId}`}
                        item={item}
                        feedback={taskFeedback?.(item.taskId)}
                        onAttest={onAttest}
                        onNavigateTask={onNavigateTask}
                      />
                    ))}
                  </Section>
                )}
                {showConsents && lanes.consents.length > 0 && (
                  <Section
                    variant="hero"
                    title={t("views.attestationPoolView.tabConsents")}
                    count={lanes.consents.length}
                    note={t("views.attestationPoolView.consentHint")}
                  >
                    {lanes.consents.map((item) => {
                      const task = tasks.find((candidate) => candidate.taskId === item.taskId),
                        feedback = taskFeedback?.(item.taskId),
                        approved = (task?.reviews ?? []).filter((review) => review.verdict === "approved").at(-1),
                        consentFeedback = feedback?.kind === "adjudicate" ? feedback : undefined;
                      return (
                        <ConsentLaneRow
                          key={item.taskId}
                          item={item}
                          approvedReviewId={approved?.reviewId ?? null}
                          pending={consentFeedback?.state === "pending" || !task || !approved}
                          onConsentReview={
                            onConsentReview && task && approved
                              ? () => void onConsentReview(task, approved.reviewId)
                              : undefined
                          }
                          onNavigateTask={onNavigateTask}
                        />
                      );
                    })}
                  </Section>
                )}
                {showBreakGlass && lanes.breakGlass.length > 0 && (
                  <Section
                    variant="warn"
                    title={t("views.attestationPoolView.tabBreakGlass")}
                    count={lanes.breakGlass.length}
                    note={t("views.attestationPoolView.breakGlassHint")}
                  >
                    {lanes.breakGlass.map((item) => (
                      <GateLaneRow
                        key={`${item.taskId}:${item.gateId}`}
                        item={item}
                        feedback={taskFeedback?.(item.taskId)}
                        onAttest={onAttest}
                        onNavigateTask={onNavigateTask}
                      />
                    ))}
                  </Section>
                )}
              </div>
            </div>
          </>
        )}
      </TabPanel>
    </div>
  );
}

/** 就地动作行(与工作页 ActionRow 同款):整行与右侧动作各自可点,动作不冒泡。 */
function LaneActionRow({
  tag,
  title,
  reason,
  state,
  children,
}: {
  readonly tag: ReactNode;
  readonly title: string;
  readonly reason?: string;
  readonly state?: TaskMutationFeedback;
  readonly children?: ReactNode;
}) {
  return (
    <div className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-2.5 rounded-xs px-2.5 py-[7px] hover:bg-text/5">
      <span className="flex min-w-0 items-center gap-2">
        <span className="shrink-0">{tag}</span>
        <span className="min-w-0 truncate text-text ui-body" title={title}>
          <TitleText title={title} />
          {reason ? <span className="ml-2 text-text-faint ui-meta">{reason}</span> : null}
          {state ? (
            <span className="ml-2 text-text-faint ui-micro">
              {state.state}
              {state.code ? ` · ${state.code}` : state.hint ? ` · ${state.hint}` : ""}
            </span>
          ) : null}
        </span>
      </span>
      {children !== undefined && <div className="flex shrink-0 items-center gap-1.5">{children}</div>}
    </div>
  );
}

const laneActionClass =
  "inline-flex h-6 items-center gap-1 rounded-xs border px-2.5 ui-meta font-medium disabled:pointer-events-none disabled:opacity-50";

/** 门禁 lane 行:待签(approve)/可特批失败(override)共用,按 item.mode 分支交互;签发表单进抽屉。 */
function GateLaneRow({
  item,
  feedback,
  onAttest,
  onNavigateTask,
}: {
  readonly item: GateAttestationItem;
  readonly feedback?: TaskMutationFeedback;
  readonly onAttest?: (
    task: Pick<TaskRow, "taskId">,
    gateId: string,
    mode: GateAttestMode,
    rationale?: string,
  ) => Promise<TaskMutationFeedback>;
  readonly onNavigateTask?: (taskId: string) => void;
}) {
  const [open, setOpen] = useState(false),
    mode = item.mode,
    attestFeedback = feedback?.kind === "attest" ? feedback : undefined,
    pending = attestFeedback?.state === "pending",
    approve = mode === "approve";
  return (
    <>
      <div data-testid={`pool-gate-row-${item.taskId}-${item.gateId}`} className="cv-auto-3r">
        <LaneActionRow
          tag={
            <StatusTag
              tone={approve ? "wait" : "bad"}
              label={t(approve ? "views.attestationPoolView.tagAwaitSign" : "views.attestationPoolView.tagBreakGlass")}
            />
          }
          title={item.taskTitle}
          reason={`${t("views.attestationPoolView.gateReason", {
            gate: item.gateId,
            status: item.gateStatus,
          })}${item.adapterId ? ` · ${item.adapterId}` : ""}${item.detail ? ` · ${item.detail}` : ""}`}
          state={attestFeedback}
        >
          <button
            type="button"
            data-testid={`pool-gate-${mode}-${item.taskId}-${item.gateId}`}
            onClick={() => setOpen(true)}
            disabled={pending}
            className={`${laneActionClass} ${
              approve
                ? "border-status-submitted/45 bg-status-submitted/15 text-status-submitted"
                : "border-status-blocked/45 bg-status-blocked/15 text-status-blocked"
            }`}
          >
            {t(approve ? "views.attestationPoolView.attest" : "views.attestationPoolView.override")}
          </button>
        </LaneActionRow>
      </div>
      <Drawer
        open={open}
        onClose={() => setOpen(false)}
        ariaLabel={t("views.attestationPoolView.attestDrawerTitle", { gate: item.gateId })}
      >
        <header className="flex flex-wrap items-baseline gap-2">
          <h2 className="min-w-0 font-semibold text-text ui-title">
            <TitleText title={item.taskTitle} />
          </h2>
          <span className="font-mono text-text-faint ui-meta">{item.taskId}</span>
          <StatusTag
            tone={approve ? "wait" : "bad"}
            label={t(approve ? "views.attestationPoolView.tagAwaitSign" : "views.attestationPoolView.tagBreakGlass")}
          />
        </header>
        <p className="mt-1 font-mono ui-meta text-text-muted">
          {t("views.attestationPoolView.gateReason", { gate: item.gateId, status: item.gateStatus })}
          {item.adapterId ? ` · ${item.adapterId}` : ""}
        </p>
        {item.detail ? <p className="mt-1 ui-meta text-text-muted">{item.detail}</p> : null}
        {onNavigateTask ? (
          <button
            type="button"
            onClick={() => onNavigateTask(item.taskId)}
            className="mt-2 inline-flex items-center gap-1 text-accent hover:underline ui-meta"
          >
            {t("views.attestationPoolView.openTask")}
            <ArrowRight weight="bold" aria-hidden />
          </button>
        ) : null}
        <div className="mt-3">
          <GateAttestForm
            mode={mode}
            gateStatus={item.gateStatus}
            pending={pending}
            onCancel={() => setOpen(false)}
            onSubmit={(rationale) => {
              setOpen(false);
              void onAttest?.({ taskId: item.taskId }, item.gateId, mode, rationale || undefined);
            }}
          />
        </div>
        <AttestFeedbackRow feedback={attestFeedback} />
      </Drawer>
    </>
  );
}

/** 同意收口 lane 行:动作直接行内完成,失败就地显示回执。 */
function ConsentLaneRow({
  item,
  approvedReviewId,
  pending,
  onConsentReview,
  onNavigateTask,
}: {
  readonly item: { readonly taskId: string; readonly taskTitle: string };
  readonly approvedReviewId: string | null;
  readonly pending: boolean;
  readonly onConsentReview?: () => void;
  readonly onNavigateTask?: (taskId: string) => void;
}) {
  return (
    <div data-testid={`pool-consent-card-${item.taskId}`} className="cv-auto-3r">
      <LaneActionRow
        tag={<StatusTag tone="wait" label={t("views.attestationPoolView.tagConsent")} />}
        title={item.taskTitle}
        reason={t("views.attestationPoolView.consentHint")}
      >
        {onNavigateTask ? (
          <button
            type="button"
            onClick={() => onNavigateTask(item.taskId)}
            className={`${laneActionClass} border-border bg-text/5 text-text-muted hover:text-text`}
          >
            {t("views.attestationPoolView.openTask")}
          </button>
        ) : null}
        <button
          type="button"
          data-testid={`pool-consent-approve-${item.taskId}`}
          disabled={!onConsentReview || pending || approvedReviewId === null}
          onClick={onConsentReview}
          className={`${laneActionClass} border-status-submitted/45 bg-status-submitted/15 text-status-submitted`}
        >
          <Handshake weight="bold" aria-hidden />
          {t("views.attestationPoolView.consentApprove")}
        </button>
      </LaneActionRow>
    </div>
  );
}
