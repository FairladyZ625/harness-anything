import type { ReactNode } from "react";
import { useState } from "react";
import { PushPinSlash } from "@phosphor-icons/react";
import type { AgendaAttentionItem, TaskWipRead } from "../../api/renderer-dto.ts";
import type { AwaitsPanelSubject } from "../awaits-answer.ts";
import { AWAITS_KIND_LABEL } from "../awaits-answer.ts";
import { IdText } from "../components/IdText.tsx";
import { STATUS_META } from "../components/badges";
import { DenseRow } from "../components/primitives/DenseRow";
import { Empty } from "../components/primitives/Empty";
import { SegBar } from "../components/primitives/SegBar";
import { StatusTag, type StatusTone } from "../components/primitives/StatusTag";
import { t } from "../i18n/index.tsx";
import type { MessageKey } from "../i18n/core.ts";
import { actorDisplayName } from "../model/actor-name.ts";
import type { SnapshotStatus } from "../model/types.ts";
import { formatRelative, formatTime } from "../model/time.ts";
import { taskReviewRef } from "../navigation/entityRoutes.ts";
import { OverviewTaskWipBody, type WipFilter } from "./OverviewTaskWip.tsx";
import { STEP_META } from "./workspace/WorkOverview.tsx";
import {
  ATTENTION_META,
  reviewCounts,
  type AttentionSource,
  type DecisionRow,
  type FollowUpKind,
  type FollowUpRow,
  type MainCiFailingJob,
  type PinnedTaskRow,
  type ReviewRow,
  type WatchedWork,
  type WorkRecentPath,
} from "./overview-model.ts";

/**
 * 总览三段的展示层(2026-10-04 视觉返工,纯展示层):「需要你处理」是页面顶部的紧凑
 * 决策带——默认只铺 COMPACT_DECISIONS 条明确事项,其余一键展开,不按条数瓜分列高;
 * 主区「关注的工作」是首屏主体;「执行与下钻」收成横排紧凑工具区(单列布局,不占整列
 * 空容器)。动作全部接现有真实动作:答复走 AwaitsAnswerPanel、裁决落决策详情、任务/
 * 工作走实体导航、取消置顶走 pin 写通道。没有的字段如实写「未提供」,不生成假推荐。
 */

const KIND_LABEL: Readonly<Record<AgendaAttentionItem["kind"], () => string>> = {
  "awaiting-you": () => t("views.overviewView.kindAwaitingYou"),
  rework: () => t("views.overviewView.kindRework"),
  // 待初审住「跟进与返工」:是 owning CEO 的机器双闸,不是用户裁决,用评审词表同一名。
  adjudication: () => t("views.overviewView.reviewAdjudication"),
  decision: () => t("views.overviewView.kindDecision"),
  blocked: () => t("views.overviewView.kindBlocked"),
  stalled: () => t("views.overviewView.kindStalled"),
  answered: () => t("views.overviewView.kindAnswered"),
  archive: () => t("views.overviewView.kindArchive"),
};

/**
 * 跟进与返工的行档:一律 wait/neutral——owning CEO/机器可处理的事不亮红,不冒充需要
 * 用户。返工的说明只陈述事实不断言归属(是否需要人由看的人判断);待初审如实写由
 * owning CEO 处理(CLI 帮助:`ha task adjudicate` 是 owning CEO 的双闸)。
 */
const FOLLOW_UP_META: Readonly<Record<FollowUpKind, { readonly tone: StatusTone; readonly note: MessageKey }>> = {
  answered: { tone: "wait", note: "views.overviewView.followAnsweredNote" },
  adjudication: { tone: "wait", note: "views.overviewView.followAdjudicationNote" },
  rework: { tone: "wait", note: "views.overviewView.followReworkNote" },
  blocked: { tone: "wait", note: "views.overviewView.followBlockedNote" },
  stalled: { tone: "neutral", note: "views.overviewView.followStalledNote" },
};

export interface OverviewBoardDeps {
  readonly now: string;
  /** 工作根 id → 标题(repo.works.index);首块行与工作卡的「受影响工作」用它,不另发请求。 */
  readonly workTitleOf: ReadonlyMap<string, string>;
  readonly onAnswer: (subject: AwaitsPanelSubject) => void;
  readonly onNavigateEntity: (ref: string) => void;
  readonly onOpenTask: (taskId: string) => void;
  readonly onOpenWorks: () => void;
  readonly onOpenTasks: () => void;
  readonly onOpenSessions: () => void;
  readonly onUnpin: (taskId: string) => void;
}

/** 放大层的键:WIP/评审执行/跟进返工/置顶承诺/main CI 红。 */
export type DrillFocusKey = "wip" | "review" | "followups" | "pinned" | "ci";

/* ------------------------------------------------------------------ 顶部:需要你处理(紧凑决策带) */

/** 首块行的急件数(注意力 ≥80):带的标签用它,与旧 mine 区域同一阈值。 */
export function decisionsUrgentCount(rows: readonly DecisionRow[]): number {
  return rows.filter(({ score }) => score >= 80).length;
}

/** 紧凑默认档:只铺前三条明确事项,其余收进一键展开;展开后带上限内滚,不挤压工作主体。 */
const COMPACT_DECISIONS = 3;

const RISK_LABEL: Readonly<Record<"low" | "medium" | "high", MessageKey>> = {
  low: "views.decisionPropose.riskLow",
  medium: "views.decisionPropose.riskMedium",
  high: "views.decisionPropose.riskHigh",
};

function decisionAction(
  row: DecisionRow,
  deps: OverviewBoardDeps,
): { readonly label: string; readonly run: () => void } | null {
  const source = row.source;
  if (source?.kind === "awaits")
    return {
      label: t("components.awaitsAnswer.openAnswer"),
      run: () => deps.onAnswer({ mode: "answer", row: source.row }),
    };
  if (source?.kind === "decision")
    return {
      label: t("views.overviewView.actionAdjudicate"),
      run: () => deps.onNavigateEntity(`decision/${source.row.decisionId}`),
    };
  // 接不回源行(读面切面前进中的瞬态):动作如实缺省,行不给假入口。
  return null;
}

/**
 * 页面顶部的紧凑决策带(2026-10-04 视觉返工):不按条数瓜分列高——默认只铺
 * COMPACT_DECISIONS 条,其余「一键展开」;展开态给 42dvh 上限内部滚动,关注工作始终
 * 是首屏主体。空态收成一行正向信息,不占版面。
 */
export function OverviewDecisionsBand({
  rows,
  deps,
}: {
  readonly rows: readonly DecisionRow[];
  readonly deps: OverviewBoardDeps;
}) {
  const [expanded, setExpanded] = useState(false);
  if (rows.length === 0) {
    return (
      <p
        data-testid="overview-decisions-band"
        className="flex flex-none items-center gap-2 rounded-sm border border-border bg-surface px-3 py-1.5 text-text-faint ui-meta"
      >
        <StatusTag tone="done" label={t("views.overviewView.mineClear")} />
        {t("views.overviewView.decisionsEmpty")}
      </p>
    );
  }
  const urgent = decisionsUrgentCount(rows),
    visible = expanded ? rows : rows.slice(0, COMPACT_DECISIONS),
    hidden = rows.length - visible.length;
  return (
    <section
      data-testid="overview-decisions-band"
      className="flex flex-none flex-col overflow-hidden rounded-sm border border-border bg-surface"
    >
      <div className="flex flex-none flex-wrap items-center gap-2 px-3 pb-1.5 pt-2">
        <h2 className="min-w-0 shrink-0 font-semibold ui-meta">{t("views.overviewView.regionDecisions")}</h2>
        <StatusTag
          tone={urgent > 0 ? "bad" : "wait"}
          label={
            urgent > 0
              ? t("views.overviewView.mineUrgent", { count: String(urgent) })
              : t("views.overviewView.decisionsPending")
          }
        />
        <span className="ml-auto font-mono font-semibold leading-none tabular-nums ui-heading">{rows.length}</span>
        {hidden > 0 && (
          <button
            type="button"
            data-testid="overview-decisions-expand"
            onClick={() => setExpanded(true)}
            className="h-6 shrink-0 rounded-xs border border-border bg-text/10 px-2.5 text-text-muted ui-meta hover:text-text"
          >
            {t("views.overviewView.decisionsMore", { count: String(hidden) })}
          </button>
        )}
        {expanded && (
          <button
            type="button"
            data-testid="overview-decisions-collapse"
            onClick={() => setExpanded(false)}
            className="h-6 shrink-0 rounded-xs border border-border bg-text/10 px-2.5 text-text-muted ui-meta hover:text-text"
          >
            {t("views.overviewView.decisionsCollapse")}
          </button>
        )}
      </div>
      <div
        data-testid="overview-decisions"
        className={expanded ? "min-h-0 overflow-y-auto" : undefined}
        style={expanded ? { maxHeight: "42dvh" } : undefined}
      >
        {visible.map((row) => {
          const workTitle = row.workTaskId === null ? null : (deps.workTitleOf.get(row.workTaskId) ?? null),
            problem =
              row.kind === "awaiting-you"
                ? row.askKind !== null && row.question !== null
                  ? `${AWAITS_KIND_LABEL[row.askKind]()} · ${row.question}`
                  : t("views.overviewView.decisionsAwaitsFallback")
                : t("views.overviewView.decisionsDecisionReason", {
                    risk: row.riskTier === null ? "—" : t(RISK_LABEL[row.riskTier]),
                  }),
            reason = [
              problem,
              workTitle === null
                ? t("views.overviewView.decisionsNoWork")
                : t("views.overviewView.decisionsWorkOf", { title: workTitle }),
              t("views.overviewView.decisionsNoRecommendation"),
            ].join(" · "),
            action = decisionAction(row, deps);
          return (
            <div key={row.id} data-decision={row.id}>
              <DenseRow
                tag={
                  <StatusTag
                    tone={row.kind === "decision" ? "wait" : "bad"}
                    label={t(
                      row.kind === "awaiting-you"
                        ? "views.overviewView.kindAwaitingYou"
                        : "views.overviewView.kindDecision",
                    )}
                  />
                }
                title={row.title}
                reason={reason}
                hoverTitle={reason}
                time={row.since === null ? null : formatRelative(row.since, { now: deps.now })}
                action={
                  action === null ? undefined : (
                    <OverviewActionButton primary onClick={action.run}>
                      {action.label}
                    </OverviewActionButton>
                  )
                }
                onClick={action === null ? undefined : action.run}
              />
            </div>
          );
        })}
      </div>
      <p className="flex flex-none items-center gap-1.5 px-3 pb-1.5 pt-1 text-text-faint ui-meta">
        {t("views.overviewView.decisionsFooter")}
      </p>
    </section>
  );
}

/* ------------------------------------------------------------------ 主区:关注的工作 */

/** 工作卡的阶段/还差枚举序(生命周期序);标签词表单源在 STATUS_META。 */
const STAGE_ORDER: readonly SnapshotStatus[] = ["done", "active", "submitted", "in_review", "blocked", "planned"];

/** 注意力项的落点:答复/收口/决策/任务,与首块动作同一映射;接不回源行的项不可点。 */
function attentionTarget(
  item: AgendaAttentionItem,
  source: AttentionSource | null,
  deps: OverviewBoardDeps,
): (() => void) | null {
  if (source?.kind === "awaits") return () => deps.onAnswer({ mode: "answer", row: source.row });
  if (source?.kind === "answered") return () => deps.onNavigateEntity(source.row.sourceRef);
  if (source?.kind === "rework" || source?.kind === "adjudication")
    return () => deps.onNavigateEntity(taskReviewRef(source.row.taskId));
  if (source?.kind === "decision") return () => deps.onNavigateEntity(`decision/${source.row.decisionId}`);
  if (source?.kind === "task") return () => deps.onOpenTask(source.row.taskId);
  return null;
}

export function OverviewWorksBody({
  watched,
  pinnedClosed,
  attentionOf,
  handlersOf,
  recentOf,
  deps,
}: {
  readonly watched: readonly WatchedWork[];
  /** 已收尾的置顶工作数:不进列表,如实计数提及(收尾工作去侧栏置顶块管理)。 */
  readonly pinnedClosed: number;
  /** 工作根 id → 名下的注意力项(卡点行;全部类别,首块三类也会在此汇合)。 */
  readonly attentionOf: (
    workTaskId: string,
  ) => readonly { readonly item: AgendaAttentionItem; readonly source: AttentionSource | null }[];
  readonly handlersOf: (entry: WatchedWork) => readonly string[];
  readonly recentOf: (workTaskId: string) => WorkRecentPath | null;
  readonly deps: OverviewBoardDeps;
}) {
  if (watched.length === 0) {
    return (
      <div data-testid="overview-works-empty" className="flex flex-col items-start gap-2 px-3.5 pb-3 pt-1">
        <Empty>{t("views.overviewView.worksNoneHint")}</Empty>
        <OverviewActionButton primary onClick={deps.onOpenWorks}>
          {t("views.overviewView.worksPickAction")}
        </OverviewActionButton>
      </div>
    );
  }
  const pinnedCount = watched.filter(({ source }) => source === "pinned").length;
  return (
    <div data-testid="overview-works">
      {pinnedCount === 0 && (
        <div className="border-b border-border px-3.5 py-2">
          <Empty>{t("views.overviewView.worksPickHint")}</Empty>
          <button
            type="button"
            onClick={deps.onOpenWorks}
            className="text-accent underline-offset-2 ui-meta hover:underline"
          >
            {t("views.overviewView.worksPickAction")}
          </button>
        </div>
      )}
      {pinnedClosed > 0 && (
        <p className="px-3.5 pb-1 pt-2 text-text-faint ui-micro">
          {t("views.overviewView.worksPinnedClosed", { count: pinnedClosed })}
        </p>
      )}
      {watched.map((entry) => {
        const { work } = entry,
          effective =
            STAGE_ORDER.reduce((sum, status) => sum + (status === "done" ? 0 : (work.counts[status] ?? 0)), 0) +
            (work.counts.done ?? 0),
          done = work.counts.done ?? 0,
          remaining = effective - done,
          stageParts = STAGE_ORDER.flatMap((status) => {
            const count = work.counts[status] ?? 0;
            return count > 0 ? [`${STATUS_META[status].label} ${count}`] : [];
          }),
          remainingParts = STAGE_ORDER.filter((status) => status !== "done").flatMap((status) => {
            const count = work.counts[status] ?? 0;
            return count > 0 ? [`${STATUS_META[status].label} ${count}`] : [];
          }),
          handlers = handlersOf(entry),
          blockers = attentionOf(work.taskId),
          recent = recentOf(work.taskId);
        return (
          <article
            key={work.taskId}
            data-work-card={work.taskId}
            className="flex flex-col gap-1.5 border-t border-border px-3.5 py-3"
          >
            <div className="flex min-w-0 items-center gap-2">
              <StatusTag status={work.status} />
              <h3 className="min-w-0 flex-1 truncate text-text ui-title">{work.title}</h3>
              <button
                type="button"
                onClick={() => deps.onOpenTask(work.taskId)}
                className="h-6 shrink-0 rounded-xs border border-border bg-text/10 px-2.5 text-text-muted ui-meta hover:text-text"
              >
                {t("views.overviewView.actionOpenWork")}
              </button>
            </div>
            <div className="flex min-w-0 flex-wrap items-center gap-2">
              <SegBar counts={work.counts} className="h-1.5 w-28 shrink-0" />
              <span className="min-w-0 flex-1 truncate ui-meta text-text-muted">{stageParts.join(" · ")}</span>
              <span className="font-mono ui-meta text-text-faint">{Math.round(work.doneRatio * 100)}%</span>
            </div>
            <p className="ui-meta text-text-muted">
              {t("views.overviewView.worksSubtasks", { done: String(done), total: String(effective) })} ·{" "}
              {remaining === 0
                ? t("views.overviewView.worksOutstandingNone")
                : t("views.overviewView.worksOutstanding", {
                    count: String(remaining),
                    breakdown: remainingParts.join(" · "),
                  })}
            </p>
            <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
              <span className="text-text-faint ui-meta">{t("views.overviewView.worksBlockersLabel")}</span>
              {blockers.length === 0 ? (
                <span className="text-text-faint ui-meta">{t("views.overviewView.worksBlockersNone")}</span>
              ) : (
                blockers.map(({ item, source }) => {
                  const target = attentionTarget(item, source, deps);
                  return (
                    <button
                      key={item.ref}
                      type="button"
                      disabled={target === null}
                      onClick={target ?? undefined}
                      data-blocker={item.ref}
                      className={`inline-flex min-w-0 max-w-full items-center gap-1 rounded-xs border border-border px-1.5 py-px ui-micro ${
                        target === null ? "text-text-faint" : "text-text-muted hover:text-text"
                      }`}
                    >
                      <StatusTag tone={ATTENTION_META[item.kind].tone} label={KIND_LABEL[item.kind]()} />
                      <span className="truncate">{item.title}</span>
                    </button>
                  );
                })
              )}
            </div>
            <p className="min-w-0 ui-meta">
              <span className="text-text-faint">{t("views.overviewView.worksHandlersLabel")}</span>{" "}
              {handlers.length > 0 ? (
                <span className="text-text-muted">{handlers.join(" · ")}</span>
              ) : (
                <span className="text-text-faint">{t("views.overviewView.worksHandlersNone")}</span>
              )}
              {(work.counts.active ?? 0) > 0 && handlers.length === 0 && (
                <span className="text-status-submitted"> · {t("views.overviewView.worksNoAgent")}</span>
              )}
            </p>
            {recent !== null && (
              <p className="min-w-0 truncate ui-meta text-text-faint">
                {t("views.overviewView.worksRecentLabel")}:{recent.title ?? recent.taskId} ·{" "}
                {recent.steps.map((step) => t(STEP_META[step].label)).join(" → ")} ·{" "}
                {formatRelative(recent.firstAt, { now: deps.now })}
              </p>
            )}
          </article>
        );
      })}
    </div>
  );
}

/* ------------------------------------------------------------------ 紧凑下钻入口 */

/** 评审执行 = 正在被评审的三组(打回/待初审/待点头住首块与跟进,不在此重复计)。 */
const REVIEW_DRILL_GROUPS: readonly ReviewRow["group"][] = [
  "taskReviewing",
  "decisionReviewing",
  "decisionNeedsReview",
];

const REVIEW_GROUP_LABEL: Readonly<Record<ReviewRow["group"], () => string>> = {
  rework: () => t("views.overviewView.reviewRework"),
  adjudication: () => t("views.overviewView.reviewAdjudication"),
  taskReviewing: () => t("views.overviewView.reviewTaskReviewing"),
  decisionNeedsReview: () => t("views.overviewView.reviewDecisionNeedsReview"),
  decisionReviewing: () => t("views.overviewView.reviewDecisionReviewing"),
  decisionPending: () => t("views.overviewView.reviewDecisionPending"),
};

/** 评审执行下钻的行集(条面计数、放大层 itemIds 与列表必须同源)。 */
export function reviewDrillRows(rows: readonly ReviewRow[]): readonly ReviewRow[] {
  const groups = new Set(REVIEW_DRILL_GROUPS);
  return rows.filter(({ group }) => groups.has(group));
}

function reviewBreakdown(rows: readonly ReviewRow[]): string {
  const counts = reviewCounts(rows);
  return REVIEW_DRILL_GROUPS.flatMap((group) => {
    const count = counts[group];
    return count > 0 ? [`${REVIEW_GROUP_LABEL[group]()} ${count}`] : [];
  }).join(" · ");
}

function followUpBreakdown(rows: readonly FollowUpRow[]): string {
  const order: readonly FollowUpKind[] = ["answered", "adjudication", "rework", "blocked", "stalled"];
  return order
    .flatMap((kind) => {
      const count = rows.filter((row) => row.kind === kind).length;
      return count > 0 ? [`${KIND_LABEL[kind]()} ${count}`] : [];
    })
    .join(" · ");
}

/** 工具区条目:标签 + 计数一枚可点芯片;分组明细挂悬停说明,完整名单在放大层。 */
function DrillEntry({
  testId,
  label,
  value,
  alert = false,
  hoverTitle,
  onClick,
}: {
  readonly testId: string;
  readonly label: string;
  readonly value: string;
  readonly alert?: boolean;
  readonly hoverTitle?: string;
  readonly onClick: () => void;
}) {
  return (
    <button
      type="button"
      data-testid={testId}
      data-drill-entry
      data-drill-alert={alert || undefined}
      title={hoverTitle}
      onClick={onClick}
      className="flex h-6 max-w-full shrink-0 items-center gap-1.5 rounded-xs border border-border bg-bg/30 px-2.5 text-text-muted ui-meta hover:border-border-strong hover:text-text"
    >
      {alert && (
        <span
          className="size-[7px] shrink-0 rounded-full bg-status-blocked shadow-[0_0_8px_var(--color-status-blocked)]"
          aria-hidden="true"
        />
      )}
      <span className="min-w-0 truncate">{label}</span>
      <span className="font-mono tabular-nums text-text">{value}</span>
    </button>
  );
}

/**
 * 「执行与下钻」的紧凑工具区(2026-10-04 视觉返工):WIP 占用、评审执行、跟进返工、
 * 置顶承诺收成横排芯片,和全部工作/任务/会话入口同住一条工具带——不再独占整列给几行
 * 列表留白。WIP 是常驻观察面,空/未知也保留入口;其余条目有数据才出现,分组明细挂
 * 悬停,名单住各自的放大层。
 */
export function OverviewDrillBody({
  wipOccupancy,
  wipFull,
  reviewRowsAll,
  followUps,
  pinned,
  onOpenFocus,
  deps,
}: {
  /** 占用/上限(快照未到给「…/—」,失败给破折号);WIP 是常驻观察面,入口恒在。 */
  readonly wipOccupancy: string;
  readonly wipFull: boolean;
  readonly reviewRowsAll: readonly ReviewRow[];
  readonly followUps: readonly FollowUpRow[];
  readonly pinned: readonly PinnedTaskRow[];
  readonly onOpenFocus: (key: DrillFocusKey) => void;
  readonly deps: OverviewBoardDeps;
}) {
  const review = reviewDrillRows(reviewRowsAll),
    dispatchable = pinned.filter(({ dispatchable }) => dispatchable).length;
  return (
    <div data-testid="overview-drill" className="flex min-h-0 flex-wrap items-center gap-x-2 gap-y-1.5 px-3 py-2">
      <DrillEntry
        testId="overview-drill-wip"
        label={t("views.overviewTaskWip.title")}
        value={wipOccupancy}
        alert={wipFull}
        hoverTitle={
          wipFull
            ? `${t("views.overviewTaskWip.fullTag")} · ${t("views.overviewView.drillWipReason")}`
            : t("views.overviewView.drillWipReason")
        }
        onClick={() => onOpenFocus("wip")}
      />
      {review.length > 0 && (
        <DrillEntry
          testId="overview-drill-review"
          label={t("views.overviewView.drillReview")}
          value={String(review.length)}
          hoverTitle={reviewBreakdown(review)}
          onClick={() => onOpenFocus("review")}
        />
      )}
      {followUps.length > 0 && (
        <DrillEntry
          testId="overview-drill-followups"
          label={t("views.overviewView.drillFollowUps")}
          value={String(followUps.length)}
          hoverTitle={followUpBreakdown(followUps)}
          onClick={() => onOpenFocus("followups")}
        />
      )}
      {pinned.length > 0 && (
        <DrillEntry
          testId="overview-drill-pinned"
          label={t("views.overviewView.drillPinned")}
          value={String(pinned.length)}
          hoverTitle={
            dispatchable > 0
              ? t("views.overviewView.drillPinnedDispatchable", { count: dispatchable })
              : t("views.overviewView.queueFooter")
          }
          onClick={() => onOpenFocus("pinned")}
        />
      )}
      <span className="h-4 w-px shrink-0 bg-border" aria-hidden="true" />
      <button
        type="button"
        data-testid="overview-drill-all-works"
        onClick={deps.onOpenWorks}
        className="text-accent underline-offset-2 ui-meta hover:underline"
      >
        {t("views.overviewView.drillAllWorks")}
      </button>
      <button
        type="button"
        data-testid="overview-drill-all-tasks"
        onClick={deps.onOpenTasks}
        className="text-accent underline-offset-2 ui-meta hover:underline"
      >
        {t("views.overviewView.drillAllTasks")}
      </button>
      <button
        type="button"
        data-testid="overview-drill-sessions"
        onClick={deps.onOpenSessions}
        className="text-accent underline-offset-2 ui-meta hover:underline"
      >
        {t("views.overviewView.actionOpenSessions")}
      </button>
    </div>
  );
}

/* ------------------------------------------------------------------ 放大层列表与详情 */

/** 评审执行放大层的列表:三组混排,组标签区分。 */
export function ReviewFocusList({
  rows,
  selectedId,
  onSelect,
  deps,
}: {
  readonly rows: readonly ReviewRow[];
  readonly selectedId: string | null;
  readonly onSelect: (id: string) => void;
  readonly deps: OverviewBoardDeps;
}) {
  return (
    <>
      {rows.map((row) => (
        <DenseRow
          key={row.id}
          tag={<StatusTag tone="wait" label={REVIEW_GROUP_LABEL[row.group]()} />}
          title={row.title}
          time={formatRelative(row.since, { now: deps.now })}
          selected={selectedId === row.id}
          onClick={() => onSelect(row.id)}
        />
      ))}
    </>
  );
}

export function ReviewFocusDetail({ row, deps }: { readonly row: ReviewRow; readonly deps: OverviewBoardDeps }) {
  return (
    <div className="flex flex-col gap-3">
      <StatusTag tone="wait" label={REVIEW_GROUP_LABEL[row.group]()} />
      <h3 className="text-text ui-title">{row.title}</h3>
      <p className="ui-meta text-text-muted">
        {t("views.overviewView.reviewSince", { age: formatRelative(row.since, { now: deps.now }) })}
      </p>
      <div className="flex flex-wrap gap-1.5">
        {row.taskId !== null && (
          <OverviewActionButton primary onClick={() => deps.onNavigateEntity(taskReviewRef(row.taskId!))}>
            {t("views.overviewView.actionOpenCloseout")}
          </OverviewActionButton>
        )}
        {row.decisionId !== null && (
          <OverviewActionButton primary onClick={() => deps.onNavigateEntity(`decision/${row.decisionId}`)}>
            {t("views.overviewView.actionOpenDecision")}
          </OverviewActionButton>
        )}
      </div>
    </div>
  );
}

/** 跟进与返工放大层:不冒充需要用户——琥珀/中性档,行内说明由谁处理。 */
export function FollowUpsFocusList({
  rows,
  selectedId,
  onSelect,
  deps,
}: {
  readonly rows: readonly FollowUpRow[];
  readonly selectedId: string | null;
  readonly onSelect: (id: string) => void;
  readonly deps: OverviewBoardDeps;
}) {
  return (
    <>
      {rows.map((row) => (
        <DenseRow
          key={row.id}
          tag={<StatusTag tone={FOLLOW_UP_META[row.kind].tone} label={KIND_LABEL[row.kind]()} />}
          title={row.title}
          reason={t(FOLLOW_UP_META[row.kind].note)}
          time={row.since === null ? null : formatRelative(row.since, { now: deps.now })}
          selected={selectedId === row.id}
          onClick={() => onSelect(row.id)}
        />
      ))}
    </>
  );
}

export function FollowUpsFocusDetail({ row, deps }: { readonly row: FollowUpRow; readonly deps: OverviewBoardDeps }) {
  const source = row.source,
    target =
      source?.kind === "answered"
        ? { label: t("components.awaitsAnswer.openSource"), run: () => deps.onNavigateEntity(source.row.sourceRef) }
        : source?.kind === "rework" || source?.kind === "adjudication"
          ? {
              label: t("views.overviewView.actionOpenCloseout"),
              run: () => deps.onNavigateEntity(taskReviewRef(source.row.taskId)),
            }
          : source?.kind === "task"
            ? { label: t("views.overviewView.actionOpenTask"), run: () => deps.onOpenTask(source.row.taskId) }
            : null;
  return (
    <div className="flex flex-col gap-3">
      <StatusTag tone={FOLLOW_UP_META[row.kind].tone} label={KIND_LABEL[row.kind]()} />
      <h3 className="text-text ui-title">{row.title}</h3>
      <p className="ui-meta text-text-muted">{t(FOLLOW_UP_META[row.kind].note)}</p>
      {source?.kind === "answered" && (
        <p className="ui-meta text-text-muted">
          {t("views.overviewView.answeredWith", { answer: source.row.answer })} ·{" "}
          {t("components.awaitsAnswer.answeredBy", {
            actor: actorDisplayName(source.row.answeredBy).name,
            time: row.since === null ? "" : formatRelative(row.since, { now: deps.now }),
          })}
        </p>
      )}
      {row.since !== null && (
        <p className="ui-meta text-text-faint">{formatTime(row.since, { style: "date-time", now: deps.now }) ?? "—"}</p>
      )}
      {target !== null && (
        <div className="flex flex-wrap gap-1.5">
          <OverviewActionButton primary onClick={target.run}>
            {target.label}
          </OverviewActionButton>
        </div>
      )}
    </div>
  );
}

/** 置顶承诺放大层:可派在前,行上可就地取消置顶(pin 写通道)。 */
export function PinnedFocusList({
  rows,
  selectedId,
  onSelect,
  deps,
}: {
  readonly rows: readonly PinnedTaskRow[];
  readonly selectedId: string | null;
  readonly onSelect: (id: string) => void;
  readonly deps: OverviewBoardDeps;
}) {
  return (
    <>
      {rows.map((task) => (
        <DenseRow
          key={task.taskId}
          tag={
            task.dispatchable ? (
              <StatusTag tone="plan" label={t("views.overviewView.queuePlanned")} />
            ) : (
              <StatusTag status={task.status} />
            )
          }
          title={task.title}
          time={task.updatedAt === null ? undefined : formatRelative(task.updatedAt, { now: deps.now })}
          action={
            <UnpinIconButton
              testId={`overview-unpin-${task.taskId}`}
              onClick={() => deps.onUnpin(task.taskId)}
              label={t("views.overviewView.unpinRowLabel", { title: task.title })}
            />
          }
          selected={selectedId === task.taskId}
          onClick={() => onSelect(task.taskId)}
        />
      ))}
    </>
  );
}

export function PinnedFocusDetail({ task, deps }: { readonly task: PinnedTaskRow; readonly deps: OverviewBoardDeps }) {
  return (
    <div className="flex flex-col gap-3">
      {task.dispatchable ? (
        <StatusTag tone="plan" label={t("views.overviewView.queuePlanned")} />
      ) : (
        <StatusTag status={task.status} />
      )}
      <h3 className="text-text ui-title">{task.title}</h3>
      {task.updatedAt !== null && (
        <p className="ui-meta text-text-muted">
          {t("views.overviewView.queueUpdatedAt", { age: formatRelative(task.updatedAt, { now: deps.now }) })}
        </p>
      )}
      <div className="flex flex-wrap gap-1.5">
        <OverviewActionButton primary onClick={() => deps.onOpenTask(task.taskId)}>
          {task.dispatchable ? t("views.overviewView.actionDispatch") : t("views.overviewView.actionOpenTask")}
        </OverviewActionButton>
        <OverviewActionButton onClick={() => deps.onUnpin(task.taskId)}>
          {t("views.overviewView.actionUnpin")}
        </OverviewActionButton>
      </div>
    </div>
  );
}

/** main CI 红放大层:只陈述事实(重跑/看日志没有现成 GUI 动作,不做假按钮)。 */
export function CiFocusList({
  rows,
  selectedId,
  onSelect,
}: {
  readonly rows: readonly MainCiFailingJob[];
  readonly selectedId: string | null;
  readonly onSelect: (id: string) => void;
}) {
  return (
    <>
      {rows.map((run) => (
        <DenseRow
          key={run.runId}
          tag={<StatusTag tone="bad" label={t("views.overviewView.ciFailed")} />}
          title={`${run.job} · ${run.sha.slice(0, 8)}`}
          onClick={() => onSelect(run.runId)}
          selected={selectedId === run.runId}
        />
      ))}
    </>
  );
}

export function CiFocusDetail({
  run,
  rows,
}: {
  readonly run: MainCiFailingJob;
  readonly rows: readonly MainCiFailingJob[];
}) {
  return (
    <div className="flex flex-col gap-3">
      <StatusTag tone="bad" label={t("views.overviewView.ciFailed")} />
      <h3 className="text-text ui-title">{run.job}</h3>
      <table className="w-full text-left">
        <tbody>
          <tr className="border-b border-border">
            <td className="py-1 pr-2 ui-meta text-text-muted">{t("views.overviewView.ciCommit")}</td>
            <td className="py-1 text-right font-mono ui-meta text-text">{run.sha.slice(0, 8)}</td>
          </tr>
          <tr className="border-b border-border">
            <td className="py-1 pr-2 ui-meta text-text-muted">{t("views.overviewView.ciAt")}</td>
            <td className="py-1 text-right font-mono ui-meta text-text">
              {formatTime(run.occurredAt, { style: "date-time" }) ?? "—"}
            </td>
          </tr>
          <tr>
            <td className="py-1 pr-2 ui-meta text-text-muted">{t("views.overviewView.ciWindowFailing")}</td>
            <td className="py-1 text-right font-mono ui-meta text-text">{rows.length}</td>
          </tr>
        </tbody>
      </table>
      <p className="ui-meta text-text-muted">{t("views.overviewView.ciNoActionHint")}</p>
    </div>
  );
}

/* ------------------------------------------------------------------ WIP 放大层详情 */

/** WIP 放大层右侧详情:名单在 OverviewTaskWipBody(条面/放大层同一组件),详情给占用上下文与导航。 */
export function WipFocusDetail({
  entry,
  wip,
  onOpenTask,
}: {
  readonly entry: TaskWipRead["counted"][number];
  readonly wip: TaskWipRead;
  readonly onOpenTask: (taskId: string) => void;
}) {
  return (
    <div className="flex flex-col gap-3">
      <StatusTag status={entry.status} />
      <h3 className="text-text ui-title">{entry.title}</h3>
      <IdText value={`task/${entry.taskId}`} title={entry.title === "" ? undefined : entry.title} />
      <p className="ui-meta text-text-muted">
        {t("views.overviewTaskWip.occupancyTitle", {
          count: wip.counted.length,
          limit: wip.limit,
          limitLabel: wip.limitLabel,
          threshold: wip.threshold,
        })}
      </p>
      <div className="flex flex-wrap gap-1.5">
        <OverviewActionButton primary onClick={() => onOpenTask(entry.taskId)}>
          {t("views.overviewView.actionOpenTask")}
        </OverviewActionButton>
      </div>
    </div>
  );
}

/** WIP 放大层左侧列表:OverviewTaskWipBody 的放大层展面(分组/搜索 + 名单)。 */
export function WipFocusList(props: {
  readonly snapshot: TaskWipRead | undefined;
  readonly loading: boolean;
  readonly error: string | null;
  readonly selectedId: string | null;
  readonly onSelect: (taskId: string) => void;
  readonly onOpenTask: (taskId: string) => void;
  readonly filter: WipFilter;
  readonly onFilterChange: (filter: WipFilter) => void;
}) {
  return <OverviewTaskWipBody {...props} inFocus />;
}

/* ------------------------------------------------------------------ 共享小件 */

/** 就地动作按钮(标准 §5:能在当前视图完成的动作直接给按钮,接真实动作)。 */
export function OverviewActionButton({
  primary = false,
  onClick,
  children,
}: {
  readonly primary?: boolean;
  readonly onClick: () => void;
  readonly children: ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={
        primary
          ? "h-7 rounded-xs border border-accent/40 bg-accent/20 px-3 text-accent ui-meta hover:bg-accent/30"
          : "h-7 rounded-xs border border-border bg-text/10 px-3 text-text-muted ui-meta hover:text-text"
      }
    >
      {children}
    </button>
  );
}

/**
 * 置顶行的取消置顶图标:无边框小图标,常驻可见(标准 §1.9③:关键操作不依赖悬停才出现),
 * 颜色退到弱档、悬停提亮——与侧栏置顶块(空间更紧,悬停浮现)同一图标两种展面。
 */
function UnpinIconButton({
  testId,
  onClick,
  label,
}: {
  readonly testId: string;
  readonly onClick: () => void;
  readonly label: string;
}) {
  return (
    <button
      type="button"
      data-testid={testId}
      onClick={(event) => {
        event.stopPropagation();
        onClick();
      }}
      aria-label={label}
      title={label}
      className="grid size-6 shrink-0 place-items-center rounded text-text-faint hover:bg-surface-raised hover:text-text"
    >
      <PushPinSlash weight="bold" className="size-3.5" aria-hidden />
    </button>
  );
}
