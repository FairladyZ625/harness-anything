import type { ReactNode } from "react";
import { useState } from "react";
import { PushPinSlash } from "@phosphor-icons/react";
import type { AwaitsPanelSubject } from "../awaits-answer.ts";
import { AWAITS_KIND_LABEL } from "../awaits-answer.ts";
import { STATUS_META } from "../components/badges";
import { DenseRow } from "../components/primitives/DenseRow";
import { Empty } from "../components/primitives/Empty";
import { Notice } from "../components/primitives/Notice";
import { SegBar } from "../components/primitives/SegBar";
import { StatusTag } from "../components/primitives/StatusTag";
import { t } from "../i18n/index.tsx";
import type { MessageKey } from "../i18n/core.ts";
import type { SnapshotStatus } from "../model/types.ts";
import { formatDuration, formatRelative, formatTime } from "../model/time.ts";
// 步骤词表随工作页拆分移到 WorkProgressList;总览与工作页共用同一份 STEP_META。
import { STEP_META } from "./workspace/WorkProgressList.tsx";
import type {
  AttestationPendingRow,
  DecisionRow,
  PinnedEntityRow,
  PinnedTaskRow,
  RunningTaskRow,
  WatchedWork,
  WorkRecentPath,
} from "./overview-model.ts";

/**
 * 总览四块的展示层(2026-10-21 业主 13:50 定案,泳道移出总览后的任务列表形态):
 * 左上「在跑的任务」是窄行高密度名单(任务人话标题、谁在跑、跑了多久、现在哪一步),
 * 右上「置顶与议程」把被重构撤下的 pin/agenda 拿回来(不管 pin 什么都在这可见),
 * 左下「关注的工作」只留标题、进度与负责人,右下「等你处理的事」取待办签发前几条。
 * 动作全部接现有真实动作:答复走 AwaitsAnswerPanel、裁决落决策详情、任务/工作走实体
 * 导航、取消置顶走 pin 写通道。没有的字段如实写「未提供」,不生成假推荐。
 */

export interface OverviewBoardDeps {
  readonly now: string;
  /** 工作根 id → 标题(repo.works.index);「等你处理」行说明受影响工作时用,不另发请求。 */
  readonly workTitleOf: ReadonlyMap<string, string>;
  readonly onAnswer: (subject: AwaitsPanelSubject) => void;
  readonly onNavigateEntity: (ref: string) => void;
  readonly onOpenTask: (taskId: string) => void;
  readonly onOpenWorks: () => void;
  readonly onOpenTasks: () => void;
  readonly onOpenSessions: () => void;
  /** 任务侧人签的落点:待办签发总池的任务收口域(可寻址路由)。 */
  readonly onOpenSignoffs: (taskId: string) => void;
  /** 本块没列出的待办(评审中等)落回待办签发总池。 */
  readonly onOpenPool: () => void;
  readonly onUnpin: (taskId: string) => void;
  /** 置顶区非任务实体的取消置顶(实体级 entity-unpin 写通道)。 */
  readonly onUnpinEntity: (entityRef: string) => void;
}

/* ------------------------------------------------------------------ 右下:等你处理的事 */

/** 人签三类的块内标签;门名与同类项计数在行原因里如实给。 */
const SIGNOFF_KIND_LABEL: Readonly<Record<AttestationPendingRow["kind"], MessageKey>> = {
  gate: "views.overviewView.signoffGate",
  breakGlass: "views.overviewView.signoffBreakGlass",
  consent: "views.overviewView.signoffConsent",
};

/** 紧凑默认档:只铺前三条明确事项,其余一键展开;展开后带上限内滚,不挤压工作主体。 */
const COMPACT_AWAITS = 3;

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
  // 裁决请求的答复面是那条派工的任务详情(ruling 产物随归档发布在任务包里),不另造新页。
  if (source?.kind === "ruling")
    return { label: t("views.myAsks.actionOpenTask"), run: () => deps.onOpenTask(source.row.taskId) };
  // 接不回源行(读面切面前进中的瞬态):动作如实缺省,行不给假入口。
  return null;
}

/**
 * 「等你处理的事」的块体(2026-10-21 从顶部决策带移进右下块,判据不变):真实要本人
 * 动手的 awaits 问句与待点头 decision;默认只铺 COMPACT_AWAITS 条,其余一键展开,
 * 展开态在块内滚动。空态收成一行正向信息,不说「没有事项」的绝对话。
 */
export function OverviewAwaitsBody({
  rows,
  signoffs,
  decisionInboxCount,
  deps,
}: {
  readonly rows: readonly DecisionRow[];
  /** 任务侧人签(待办签发前几条):与决策并列为「等你动手」。 */
  readonly signoffs: readonly AttestationPendingRow[];
  /**
   * 待办签发「决策待裁」域的普查数(workspace summary 的 inboxCount,与侧栏角标同一读面
   * 同一判据):它是 proposed 决策全集,含还在评审、议程不算「等你点头」的那些。块里只列
   * 要本人动手的,差额如实指回总池——这就是 2026-10-21 冷眼评估里「空横幅 vs 侧栏 4」
   * 矛盾的根:两处说的不是同一个集合,空态必须带上自己说的是哪一类。
   */
  readonly decisionInboxCount: number;
  readonly deps: OverviewBoardDeps;
}) {
  const [expanded, setExpanded] = useState(false);
  if (rows.length === 0 && signoffs.length === 0) {
    return (
      <div data-testid="overview-awaits" className="px-3.5 py-2">
        <Empty>{t("views.overviewView.decisionsEmpty")}</Empty>
        {decisionInboxCount > 0 && <OverviewPoolPointer count={decisionInboxCount} deps={deps} />}
      </div>
    );
  }
  const needsYou = rows.some(({ kind }) => kind === "awaiting-you" || kind === "ruling"),
    // 决策行与人签行共用紧凑名额:决策先占(带问句/风险),余下名额给人签;展开后全量滚动。
    visible = expanded ? rows : rows.slice(0, COMPACT_AWAITS),
    visibleSignoffs = expanded ? signoffs : signoffs.slice(0, Math.max(0, COMPACT_AWAITS - rows.length)),
    hidden = rows.length + signoffs.length - visible.length - visibleSignoffs.length;
  return (
    <div data-testid="overview-awaits" className="flex min-h-0 flex-1 flex-col">
      {hidden > 0 && (
        <div className="flex flex-none items-center gap-2 px-3.5 pb-1 pt-2">
          <button
            type="button"
            data-testid="overview-awaits-expand"
            onClick={() => setExpanded(true)}
            className="h-6 shrink-0 rounded-xs border border-border bg-text/10 px-2.5 text-text-muted ui-meta hover:text-text"
          >
            {t("views.overviewView.decisionsMore", { count: String(hidden) })}
          </button>
          {needsYou && <StatusTag tone="agent-question" label={t("agentRuntime.smartClassNeedsYou")} />}
        </div>
      )}
      {expanded && (
        <div className="flex flex-none items-center px-3.5 pb-1 pt-2">
          <button
            type="button"
            data-testid="overview-awaits-collapse"
            onClick={() => setExpanded(false)}
            className="h-6 shrink-0 rounded-xs border border-border bg-text/10 px-2.5 text-text-muted ui-meta hover:text-text"
          >
            {t("views.overviewView.decisionsCollapse")}
          </button>
        </div>
      )}
      <div data-testid="overview-awaits-rows" className={expanded ? "min-h-0 overflow-y-auto" : undefined}>
        {visible.map((row) => {
          const workTitle = row.workTaskId === null ? null : (deps.workTitleOf.get(row.workTaskId) ?? null),
            problem =
              row.kind === "awaiting-you"
                ? row.askKind !== null && row.question !== null
                  ? `${AWAITS_KIND_LABEL[row.askKind]()} · ${row.question}`
                  : t("views.overviewView.decisionsAwaitsFallback")
                : row.kind === "ruling"
                  ? [
                      row.question ?? "",
                      ...(row.options.length
                        ? [`${t("views.work.attention.ruling")}: ${row.options.join(" · ")}`]
                        : []),
                    ]
                      .filter((part) => part !== "")
                      .join(" — ")
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
            <div key={row.id} data-awaits-row={row.id}>
              <DenseRow
                tag={
                  <StatusTag
                    // Needs you 用 Orca 独立橙(agent-question,严格区别于等评审的琥珀);
                    // 待点头 decision 维持 wait 档——同为本人动作,但不是提问阻塞。
                    tone={row.kind === "awaiting-you" || row.kind === "ruling" ? "agent-question" : "wait"}
                    label={t(
                      row.kind === "awaiting-you"
                        ? "agentRuntime.smartClassNeedsYou"
                        : row.kind === "ruling"
                          ? "views.work.attention.ruling"
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
        {visibleSignoffs.map((row) => {
          const action = signoffAction(row, deps);
          return (
            <div key={row.id} data-signoff-row={row.id}>
              <DenseRow
                tag={
                  <StatusTag
                    // 人签是本人动作但不是提问阻塞:用 wait 琥珀,不冒充 Needs you 橙。
                    tone="wait"
                    label={t(SIGNOFF_KIND_LABEL[row.kind])}
                  />
                }
                title={row.title}
                reason={
                  row.gateId === null
                    ? t("views.overviewView.signoffConsentReason")
                    : t("views.overviewView.signoffGateReason", {
                        gate: row.gateId,
                        more: row.more > 0 ? t("views.overviewView.signoffMore", { count: String(row.more) }) : "",
                      })
                }
                action={
                  <OverviewActionButton primary onClick={action}>
                    {t("views.overviewView.signoffOpen")}
                  </OverviewActionButton>
                }
                onClick={action}
              />
            </div>
          );
        })}
        {decisionInboxCount > 0 && (
          <div data-testid="overview-awaits-inbox">
            <OverviewPoolPointer count={decisionInboxCount} deps={deps} />
          </div>
        )}
      </div>
    </div>
  );
}

/**
 * 总池指针:块里只列要本人动手的事项,「决策待裁」域里的其余 proposed 决策(还在评审等)
 * 如实给条数与入口,不再让空态和侧栏角标互相矛盾。
 */
function OverviewPoolPointer({ count, deps }: { readonly count: number; readonly deps: OverviewBoardDeps }) {
  return (
    <div className="flex items-center gap-2 px-0.5 py-1 text-text-faint ui-meta">
      <StatusTag tone="neutral" label={t("views.overviewView.awaitsInboxTag")} />
      <span className="min-w-0 flex-1 truncate">{t("views.overviewView.awaitsInbox", { count: String(count) })}</span>
      <button
        type="button"
        data-testid="overview-awaits-inbox-open"
        onClick={deps.onOpenPool}
        className="shrink-0 text-accent underline-offset-2 hover:underline"
      >
        {t("views.overviewView.awaitsInboxOpen")}
      </button>
    </div>
  );
}

/** 人签行的落点:签发动作只在待办签发总池/任务详情里完成,总览不复制写通道。 */
function signoffAction(row: AttestationPendingRow, deps: OverviewBoardDeps): () => void {
  return row.kind === "consent" ? () => deps.onOpenSignoffs(row.taskId) : () => deps.onOpenTask(row.taskId);
}

/** 这一步的人话标签;reviewTarget 的两种评审分开写(任务评审 / 决策评审)。 */
const RUNNING_STAGE_LABEL: Readonly<Record<RunningTaskRow["stage"] & string, MessageKey>> = {
  implementation: "views.overviewView.runningStageImplementation",
  "review-task": "views.overviewView.runningStageReviewTask",
  "review-decision": "views.overviewView.runningStageReviewDecision",
};

/* ------------------------------------------------------------------ 左上:在跑的任务 */

/**
 * 「在跑的任务」的块体(2026-10-21 定案,替换总览全局泳道):窄行高密度名单,一行一个
 * 任务——标题、执行者(agent · 模型短标签)、已跑时长(块起点至今),状态词用会话侧
 * 运行词表(运行中/待拍板);卡点行的问句进悬停与「答复」动作,不挤窄行正文。
 */
export function OverviewRunningBody({
  rows,
  loading,
  error,
  nowMs,
  resolveOf,
  onOpenTask,
}: {
  readonly rows: readonly RunningTaskRow[];
  /** 泳道读面(sessionGroups/成员页)首次取数进行中。 */
  readonly loading: boolean;
  /** 泳道读面失败的可读信息。 */
  readonly error: string | null;
  /** 数据时钟(ms):时长随读面前进重算,不立秒针。 */
  readonly nowMs: number;
  /** 卡点行的「答复」动作(接未决 awaits 源行);null = 无未决问句,行点击直接进任务。 */
  readonly resolveOf: (row: RunningTaskRow) => (() => void) | null;
  readonly onOpenTask: (taskId: string) => void;
}) {
  if (error !== null) {
    return (
      <Notice tone="bad" variant="strip" testId="overview-running-error">
        {t("views.overviewView.runningError")}
        {error}
      </Notice>
    );
  }
  if (rows.length === 0) {
    return (
      <div data-testid="overview-running-empty" className="px-3.5 py-2">
        <Empty>{loading ? t("views.overviewView.runningLoading") : t("views.overviewView.runningEmpty")}</Empty>
      </div>
    );
  }
  return (
    <div data-testid="overview-running">
      {rows.map((row) => {
        const resolve = resolveOf(row),
          who = row.model === null ? row.agent : `${row.agent} · ${row.model}`,
          // 现在哪一步:卡点行给卡点问句,其余给这一步(实现/评审);读面没有这一步就不编。
          step = row.awaiting ?? (row.stage === null ? null : t(RUNNING_STAGE_LABEL[row.stage])),
          reason = step === null ? who : `${who} · ${step}`,
          startedAt = formatTime(new Date(row.startedAt).toISOString(), {
            style: "date-time",
            now: new Date(nowMs).toISOString(),
          });
        return (
          <div key={row.taskId} data-running-row={row.taskId}>
            <DenseRow
              tag={
                <StatusTag
                  tone={row.awaiting === null ? "active" : "agent-question"}
                  label={t(row.awaiting === null ? "agentUi.activity.running" : "agentUi.activity.awaiting")}
                />
              }
              title={row.title}
              reason={reason}
              hoverTitle={`${who} · ${step === null ? startedAt : `${step} · ${startedAt}`}`}
              time={formatDuration(Math.max(0, nowMs - row.startedAt))}
              action={
                resolve === null ? undefined : (
                  <OverviewActionButton primary onClick={resolve}>
                    {t("components.awaitsAnswer.openAnswer")}
                  </OverviewActionButton>
                )
              }
              onClick={() => onOpenTask(row.taskId)}
            />
          </div>
        );
      })}
    </div>
  );
}

/* ------------------------------------------------------------------ 右上:置顶与议程 */

/**
 * 「置顶与议程」的块体(2026-10-21 定案,把重构时撤下的 pin 拿回总览):置顶的非工作
 * 任务与置顶的非任务实体(Decision、Schedule…)各一行,行上可就地取消置顶;可派的
 * 承诺在前。置顶的工作根住「关注的工作」(置顶在前),不在此重复列。
 */
export function OverviewPinsBody({
  pinned,
  pinnedOthers,
  onOpenTask,
  deps,
}: {
  readonly pinned: readonly PinnedTaskRow[];
  readonly pinnedOthers: readonly PinnedEntityRow[];
  readonly onOpenTask: (taskId: string) => void;
  readonly deps: OverviewBoardDeps;
}) {
  if (pinned.length + pinnedOthers.length === 0) {
    return (
      <div data-testid="overview-pins-empty" className="px-3.5 py-2">
        <Empty>{t("views.overviewView.pinsEmpty")}</Empty>
      </div>
    );
  }
  return (
    <div data-testid="overview-pins">
      {pinned.map((task) => (
        <div key={task.taskId} data-pin-row={task.taskId}>
          <DenseRow
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
            onClick={() => onOpenTask(task.taskId)}
          />
        </div>
      ))}
      {/* 非任务实体(Decision、Schedule…)没有任务态与可派档:kind 用协议原词,点行走实体导航。 */}
      {pinnedOthers.map((entity) => (
        <div key={entity.ref} data-pin-row={entity.ref}>
          <DenseRow
            tag={<StatusTag tone="neutral" label={entity.kind} />}
            title={entity.title}
            action={
              <UnpinIconButton
                testId={`overview-unpin-${entity.ref}`}
                onClick={() => deps.onUnpinEntity(entity.ref)}
                label={t("views.overviewView.unpinRowLabel", { title: entity.title })}
              />
            }
            onClick={() => deps.onNavigateEntity(entity.ref)}
          />
        </div>
      ))}
    </div>
  );
}

/* ------------------------------------------------------------------ 左下:关注的工作 */

/** 工作行的阶段/还差枚举序(生命周期序);悬停明细的词表单源在 STATUS_META。 */
const STAGE_ORDER: readonly SnapshotStatus[] = ["done", "active", "submitted", "in_review", "blocked", "planned"];

export function OverviewWorksBody({
  watched,
  activityDays,
  handlersOf,
  recentOf,
  deps,
}: {
  readonly watched: readonly WatchedWork[];
  /** 近期窗口天数(设置项「关注的工作活动天数」);行内展示与列表口径一致。 */
  readonly activityDays: number;
  readonly handlersOf: (entry: WatchedWork) => readonly string[];
  readonly recentOf: (workTaskId: string) => WorkRecentPath | null;
  readonly deps: OverviewBoardDeps;
}) {
  if (watched.length === 0) {
    return (
      <div data-testid="overview-works-empty" className="flex flex-col items-start gap-2 px-3.5 pb-3 pt-1">
        <Empty>{t("views.overviewView.worksNoneRecent", { days: String(activityDays) })}</Empty>
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
      {watched.map((entry) => {
        const { work } = entry,
          effective =
            STAGE_ORDER.reduce((sum, status) => sum + (status === "done" ? 0 : (work.counts[status] ?? 0)), 0) +
            (work.counts.done ?? 0),
          done = work.counts.done ?? 0,
          running = work.counts.active ?? 0,
          remaining = effective - done,
          remainingParts = STAGE_ORDER.filter((status) => status !== "done").flatMap((status) => {
            const count = work.counts[status] ?? 0;
            return count > 0 ? [`${STATUS_META[status].label} ${count}`] : [];
          }),
          handlers = handlersOf(entry),
          recent = recentOf(work.taskId),
          // 悬停给完整明细(视觉基线 v2:主文字收束,原始信息悬停可见):子任务/未完成/最近。
          hoverTitle = [
            t("views.overviewView.worksSubtasks", { done: String(done), total: String(effective) }),
            remaining === 0
              ? t("views.overviewView.worksOutstandingNone")
              : t("views.overviewView.worksOutstanding", {
                  count: String(remaining),
                  breakdown: remainingParts.join(" · "),
                }),
            ...(recent !== null
              ? [
                  `${t("views.overviewView.worksRecentLabel")}: ${recent.title ?? recent.taskId} · ${recent.steps
                    .map((step) => t(STEP_META[step].label))
                    .join(" → ")} · ${formatRelative(recent.firstAt, { now: deps.now })}`,
                ]
              : []),
          ].join(" · ");
        // 第二行是行内信息面(2026-10-21 定案:标题、进度、负责人):分段进度条复用 SegBar
        // (与工作页/看板同一原语),计数退成紧凑 done/total,负责人是可读名(agent · 模型
        // 短标签,候选清单在视图层已收短);尾部名字只拿自己的份额,长名截断,不挤压标题。
        // 空集给「暂无子任务」、全取消给取消计数,不出 0/0 假进度。
        const cancelled = work.counts.cancelled ?? 0,
          second = [
            <span key="progress" className="flex min-w-0 flex-1 items-center gap-1.5">
              <SegBar
                counts={work.counts}
                // 行内档比默认 h-1 加粗一档(任务详情子任务条同档),占行内剩余宽度。
                className="h-[5px]! min-w-[72px] flex-1"
              />
              {effective > 0 ? (
                <span className="shrink-0 font-mono tabular-nums text-text-muted">
                  {done}/{effective}
                </span>
              ) : (
                <span className="shrink-0">
                  {cancelled > 0
                    ? `${STATUS_META.cancelled.label} ${cancelled}`
                    : t("views.overviewView.worksNoSubtasks")}
                </span>
              )}
            </span>,
            running > 0 ? (
              <span key="running" className="shrink-0">
                {t("views.overviewView.worksRunning", { count: String(running) })}
              </span>
            ) : null,
            handlers.length > 0 ? (
              <span key="handlers" className="min-w-0 max-w-[40%] truncate">
                <span className="text-text-faint">{t("views.overviewView.worksHandlersLabel")}</span>{" "}
                <span className="text-text-muted">{handlers.join(" · ")}</span>
              </span>
            ) : null,
          ].filter((part) => part !== null);
        return (
          <div key={work.taskId} data-work-card={work.taskId} className={handlers.length > 0 ? "live-row" : undefined}>
            <DenseRow
              tag={<StatusTag status={work.status} />}
              title={work.title}
              relaxed
              reason={
                <>
                  {second.flatMap((part, index) =>
                    index === 0
                      ? [part]
                      : [
                          <span key={`sep-${index}`} className="text-text-faint">
                            {" · "}
                          </span>,
                          part,
                        ],
                  )}
                </>
              }
              time={
                <span
                  title={formatTime(work.lastActivityAt, { style: "date-time", now: deps.now }) ?? work.lastActivityAt}
                  className="whitespace-nowrap font-mono tabular-nums text-text-muted ui-meta"
                >
                  {formatRelative(work.lastActivityAt, { now: deps.now })}
                </span>
              }
              hoverTitle={hoverTitle}
              onClick={() => deps.onOpenTask(work.taskId)}
            />
          </div>
        );
      })}
    </div>
  );
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
