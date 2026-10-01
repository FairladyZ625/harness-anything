import { useEffect, useMemo, useState } from "react";
import { ArrowLeft, CaretRight, WarningCircle } from "@phosphor-icons/react";
import { DecisionStateBadge, RiskTierBadge, UrgencyBadge } from "../badges.tsx";
import { EntityRefLink } from "../EntityRefLink.tsx";
import { TabPanel } from "../primitives/EntryBoundary";
import { Tabs } from "../primitives/Tabs";
import { ViewInGraphButton } from "../ViewInGraphButton.tsx";
import { formatTime } from "../../model/time.ts";
import type { DecisionRow, RelationEdge, TaskRow } from "../../model/types.ts";
import { t } from "../../i18n/index.tsx";
import { DecisionBodyPanel } from "./DecisionBodyPanel.tsx";
import { ClaimsPanel, OverviewPanel, RelationsPanel } from "./DecisionDetailSections.tsx";
import { ActorRef, actorsLabel, IdentityItem } from "./widgets.tsx";
import { AwaitsAskStrip } from "../AwaitsAskStrip.tsx";
import type { DecisionAction, DecisionMutationFeedback } from "../../decision-actions.ts";
import { useDecisionReviewActions } from "../../decision-review-actions.ts";
import {
  decisionReviewRef,
  decisionSessionsRef,
  type DecisionReviewTab,
} from "../../navigation/decisionReviewRoutes.ts";
import { DecisionReviewBadge } from "../decisionReview/parts.tsx";
import { DecisionReviewTab as ReviewPanel } from "../decisionReview/DecisionReviewTab.tsx";
import { DecisionRespondTab } from "../decisionReview/DecisionRespondTab.tsx";
import { DecisionReportTab } from "../decisionReview/DecisionReportTab.tsx";
import { DecisionJudgeTab } from "../decisionReview/DecisionJudgeTab.tsx";

/**
 * 决策详情页(与 Task 详情同级的信息架构:身份条 + 分页签)。
 * 列表读面(repo.decisions.list)从不携带正文——kernel 列表路径显式 body:null,
 * 所以正文按决策逐条经 decision-show(includeBody)取回,一次一份,规模天然有界。
 * 取不到时逐态说明原因(加载/投影追赶/未投影/读取失败),绝不静默留白。
 */

const tabs = [
  { id: "body", label: "views.decisionDetailView.tabBody" },
  { id: "overview", label: "views.decisionDetailView.tabOverview" },
  { id: "claims", label: "views.decisionDetailView.tabClaims" },
  { id: "relations", label: "views.decisionDetailView.tabRelations" },
  // Decision 评审(dec_A64B14D6 CH6):评审/回应/报告/裁决是可寻址页签,落点见 decisionReviewRoutes。
  { id: "review", label: "views.decisionReview.tabReview" },
  { id: "respond", label: "views.decisionReview.tabRespond" },
  { id: "report", label: "views.decisionReview.tabReport" },
  { id: "judge", label: "views.decisionReview.tabJudge" },
] as const;
const reviewTabIds: ReadonlySet<string> = new Set<DecisionReviewTab>(["review", "respond", "report", "judge"]);

type DecisionDetailTab = (typeof tabs)[number]["id"];

export function DecisionDetailView({
  repoId,
  decisionId,
  decisions,
  tasks = [],
  relations = [],
  loading,
  onBack,
  projectName,
  fromViewLabel,
  onNavigateDecision,
  onNavigateTask,
  onNavigateEntity,
  onFocusGraph,
  onOpenPool,
  reviewLocation = null,
  onLocate,
  onJudge,
  judgeFeedback,
  onCheckReceipt,
}: {
  repoId: string;
  decisionId: string | null;
  /** 路由给出的评审页签与报告定位(decisionreview/<id>/<tab>[/<reviewId>])。 */
  reviewLocation?: { readonly tab: DecisionReviewTab | null; readonly reviewId: string | null } | null;
  /** 页签切换替换当前位置(不推栈),让评审页签可寻址且跨页回链总能落到对应页签。 */
  onLocate?: (ref: string) => void;
  onJudge?: (
    decision: DecisionRow,
    action: DecisionAction,
    input: { readonly rationale: string; readonly judgmentOnlyRationale?: string },
  ) => Promise<DecisionMutationFeedback>;
  judgeFeedback?: DecisionMutationFeedback;
  onCheckReceipt?: () => void;
  decisions: DecisionRow[];
  tasks?: readonly TaskRow[];
  relations?: RelationEdge[];
  loading: boolean;
  onBack: () => void;
  projectName: string;
  fromViewLabel?: string;
  onNavigateDecision: (decisionId: string) => void;
  onNavigateTask?: (taskId: string) => void;
  onNavigateEntity: (ref: string) => void;
  onFocusGraph?: (ref: string) => void;
  onOpenPool?: (decisionId: string) => void;
}) {
  const routeTab = reviewLocation?.tab ?? null,
    routeReviewId = reviewLocation?.reviewId ?? null;
  const [activeTab, setActiveTab] = useState<DecisionDetailTab>(routeTab ?? "body");
  useEffect(() => {
    setActiveTab(routeTab ?? "body");
    // 路由页签只在决策或评审落点变化时生效;同一落点内的页签切换由 selectTab 负责。
  }, [decisionId, routeTab, routeReviewId]);
  const reviewActions = useDecisionReviewActions(repoId, decisionId ?? "");
  const selectTab = (tab: DecisionDetailTab) => {
    setActiveTab(tab);
    if (decisionId)
      onLocate?.(
        reviewTabIds.has(tab)
          ? decisionReviewRef(decisionId, tab as DecisionReviewTab, tab === "report" ? routeReviewId : null)
          : `decision/${decisionId}`,
      );
  };

  // 评审切面、accept 就绪与评审派工都在列表 full 行上(与 decision-show 同值);正文仍按需单体读。
  const decision = useMemo(
    () => decisions.find((row) => row.decisionId === decisionId) ?? null,
    [decisions, decisionId],
  );

  if (!decision) {
    return (
      <aside data-testid="decision-detail-pending" className="flex h-full flex-col items-start gap-3 px-4 py-6">
        {loading ? (
          <p className="font-mono ui-meta text-text-faint">{t("views.entityDetail.loadingProjection")}</p>
        ) : (
          <>
            <div className="flex items-center gap-1 ui-meta font-semibold text-stale">
              <WarningCircle weight="bold" />
              {t("views.entityDetail.notProjected")}
            </div>
            <div className="font-mono ui-micro text-text-faint">{decisionId ?? "—"}</div>
          </>
        )}
      </aside>
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col bg-bg" data-testid="decision-detail-view">
      <header className="shrink-0 border-b border-border bg-surface/80" data-testid="decision-detail-header">
        <div className="flex min-h-14 items-center gap-2.5 px-3 py-2 lg:px-4">
          <button
            type="button"
            onClick={onBack}
            aria-label={t("views.taskDetailView.returnPreviousLevel")}
            className={[
              "grid size-7 shrink-0 place-items-center rounded-md border border-border text-text-muted",
              "hover:border-border-strong hover:bg-surface-raised hover:text-text",
            ].join(" ")}
          >
            <ArrowLeft weight="bold" />
          </button>
          <div className="min-w-0 flex-1">
            <div className="flex min-w-0 items-center gap-1 font-mono ui-micro leading-3 text-text-faint">
              <button type="button" onClick={onBack} className="truncate hover:text-text-muted">
                {projectName}
              </button>
              <CaretRight weight="bold" className="shrink-0" />
              {fromViewLabel && (
                <>
                  <button type="button" onClick={onBack} className="truncate hover:text-text-muted">
                    {fromViewLabel}
                  </button>
                  <CaretRight weight="bold" className="shrink-0" />
                </>
              )}
              <EntityRefLink
                entityRef={`decision/${decision.decisionId}`}
                onNavigate={onNavigateEntity}
                title={decision.decisionId}
                className="truncate font-mono ui-micro leading-3 text-text-muted hover:text-accent hover:underline"
              />
            </div>
            <div className="mt-0.5 flex min-w-0 items-center gap-2">
              <h1 className="truncate ui-title font-semibold leading-5 tracking-[-0.01em] text-text">
                {decision.title}
              </h1>
              <DecisionStateBadge state={decision.state} />
              <RiskTierBadge tier={decision.riskTier} />
              <UrgencyBadge urgency={decision.urgency} />
              <DecisionReviewBadge review={decision.review} />
            </div>
          </div>
          <div className="flex shrink-0 items-center gap-1">
            {decision.review?.readiness && (
              <button
                type="button"
                data-testid="decision-judge-open"
                onClick={() => onNavigateEntity(decisionReviewRef(decision.decisionId, "judge"))}
                className="rounded-md bg-accent px-2 py-1.5 ui-micro font-semibold text-accent-fg hover:bg-accent/85"
              >
                {t("views.decisionReview.judgeThis")}
              </button>
            )}
            <button
              type="button"
              data-testid="decision-review-sessions-open"
              onClick={() => onNavigateEntity(decisionSessionsRef(decision.decisionId))}
              className={[
                "rounded-md border border-border px-2 py-1.5 ui-micro text-text-muted",
                "hover:border-border-strong hover:bg-surface-raised hover:text-text",
              ].join(" ")}
            >
              {t("views.decisionReview.allSessions")}
            </button>
            {onOpenPool && (
              <button
                type="button"
                onClick={() => onOpenPool(decision.decisionId)}
                className={[
                  "rounded-md border border-border px-2 py-1.5 font-mono ui-micro text-text-muted",
                  "hover:border-border-strong hover:bg-surface-raised hover:text-text",
                ].join(" ")}
              >
                {t("views.decisionDetailView.openInPool")}
              </button>
            )}
            {/* 统一「在关系图中查看」入口(task_89d324b5):原特化按钮换成共享件,行为同路。 */}
            <ViewInGraphButton entityRef={`decision/${decision.decisionId}`} onFocusGraph={onFocusGraph} />
          </div>
        </div>
        <details className="group relative z-30">
          <summary
            className={[
              "list-none cursor-pointer border-t border-border px-3 py-1.5 font-mono ui-micro",
              "text-text-faint hover:text-text-muted [&::-webkit-details-marker]:hidden lg:px-4",
            ].join(" ")}
          >
            {t("views.decisionDetailView.identity")}
          </summary>
          <dl
            data-testid="decision-identity-strip"
            className="grid w-full grid-cols-2 gap-px border-t border-border bg-border sm:grid-cols-3 lg:grid-cols-6"
          >
            <IdentityItem
              label={t("views.decisionDetailView.identityDecision")}
              value={decision.legacyId ? `${decision.decisionId} · ${decision.legacyId}` : decision.decisionId}
              onClick={() => onNavigateEntity(`decision/${decision.decisionId}`)}
            />
            <IdentityItem
              label={t("views.decisionDetailView.identityVertical")}
              value={`${decision.vertical ?? "—"} · ${decision.preset ?? "—"}`}
            />
            <IdentityItem
              label={t("views.decisionDetailView.identityScope")}
              value={`${decision.appliesTo?.modules.join(",") || "—"} · ${
                decision.appliesTo?.productLines.join(",") || "—"
              }`}
            />
            <IdentityItem
              label={t("views.decisionDetailView.identityActors")}
              value={actorsLabel(decision)}
              content={
                <span className="flex flex-wrap items-center gap-x-1.5">
                  <ActorRef actor={decision.proposedBy} onNavigateEntity={onNavigateEntity} />
                  <span className="text-text-faint">·</span>
                  <ActorRef actor={decision.arbiter ?? null} onNavigateEntity={onNavigateEntity} />
                </span>
              }
            />
            <IdentityItem
              label={t("views.decisionDetailView.identityTimeline")}
              value={`${formatTime(decision.proposedAt ?? "", { style: "date-time" }) ?? "—"} · ${
                formatTime(decision.decidedAt ?? "", { style: "date-time" }) ?? "—"
              }`}
            />
            <IdentityItem
              label={t("views.decisionDetailView.identityClass")}
              value={`${decision.decisionClass ?? "—"} · rev ${decision.workspaceRevision ?? "—"}`}
            />
          </dl>
        </details>
      </header>
      <AwaitsAskStrip
        repoId={repoId}
        sourceRef={`decision/${decision.decisionId}`}
        onNavigateEntity={onNavigateEntity}
      />

      <div className="shrink-0 px-3 lg:px-4" data-testid="decision-detail-tabs">
        <Tabs
          ariaLabel={t("views.decisionDetailView.sectionsAria")}
          idPrefix="decision"
          value={activeTab}
          onChange={selectTab}
          tabs={tabs.map((tab) => ({ key: tab.id, label: t(tab.label) }))}
        />
      </div>

      {/* 概况是一屏的区域板:面板自己是板的容器量尺,≥900px 时板占满面板高度、区域在自己
          内部滚动,不受正文栏宽限制;其余页签仍是居中的正文栏,随内容往下排。 */}
      <main className="min-h-0 flex-1 overflow-hidden">
        <TabPanel
          idPrefix="decision"
          value={activeTab}
          className={`h-full overflow-y-auto px-3 py-4 sm:px-4 ${
            activeTab === "overview" ? "@container flex flex-col" : ""
          }`}
          data-testid={`decision-panel-${activeTab}`}
        >
          {activeTab === "overview" ? (
            <OverviewPanel decision={decision} />
          ) : (
            <div className="mx-auto h-full w-full max-w-[72rem]">
              {activeTab === "body" ? (
                <DecisionBodyPanel repoId={repoId} decisionId={decision.decisionId} />
              ) : activeTab === "claims" ? (
                <ClaimsPanel decision={decision} />
              ) : activeTab === "review" ? (
                <ReviewPanel
                  decision={decision}
                  dispatchFeedback={reviewActions.feedback?.kind === "dispatch" ? reviewActions.feedback : undefined}
                  onDispatchReview={(digest) => void reviewActions.dispatch(digest)}
                  onNavigateEntity={onNavigateEntity}
                />
              ) : activeTab === "respond" ? (
                <DecisionRespondTab
                  decision={decision}
                  feedback={reviewActions.feedback?.kind === "respond" ? reviewActions.feedback : undefined}
                  onRespond={reviewActions.respond}
                  onNavigateEntity={onNavigateEntity}
                />
              ) : activeTab === "report" ? (
                <DecisionReportTab
                  repoId={repoId}
                  decision={decision}
                  reviewId={routeReviewId}
                  onNavigateEntity={onNavigateEntity}
                />
              ) : activeTab === "judge" ? (
                <DecisionJudgeTab
                  decision={decision}
                  relations={relations}
                  judgeFeedback={judgeFeedback}
                  overrideFeedback={reviewActions.feedback?.kind === "override" ? reviewActions.feedback : undefined}
                  onJudge={onJudge}
                  onCheckReceipt={onCheckReceipt}
                  onOverride={reviewActions.override}
                  onNavigateEntity={onNavigateEntity}
                />
              ) : (
                <RelationsPanel
                  decision={decision}
                  tasks={tasks}
                  relations={relations}
                  onNavigateDecision={onNavigateDecision}
                  onNavigateTask={onNavigateTask}
                  onNavigateEntity={onNavigateEntity}
                />
              )}
            </div>
          )}
        </TabPanel>
      </main>
    </div>
  );
}
