import type { ReactNode } from "react";
import type { AgendaSuccess } from "../api-client.ts";
import type { AwaitsPanelSubject } from "../awaits-answer.ts";
import { AWAITS_KIND_LABEL } from "../awaits-answer.ts";
import { DenseRow } from "../components/primitives/DenseRow";
import { SegBar } from "../components/primitives/SegBar";
import { StatusTag, type StatusTone } from "../components/primitives/StatusTag";
import { t } from "../i18n/index.tsx";
import { formatTime } from "../model/time.ts";
import { taskReviewRef } from "../navigation/entityRoutes.ts";
import type { CiObservatoryRead, WorkIndexRead } from "../../api/renderer-dto.ts";
import type { AgentRuntimeOverviewResult } from "@harness-anything/daemon/protocol";
import type { RegionKey } from "./overview-layout.ts";
import {
  ATTENTION_META,
  ageOf,
  attentionEntries,
  idleInFlightCount,
  mainCiFailure,
  pinnedDispatchable,
  recentEventRows,
  reviewCounts,
  reviewRows,
  runRows,
  staleDaysOf,
  workRows,
  type AttentionEntry,
  type RecentEventRow,
  type ReviewRow,
} from "./overview-model.ts";

/**
 * 总览区域的内容装配(纯展示层):把 overview-model 的行模型装进 Region 的标题/行/页脚
 * 与 FocusLayer 的列表/详情。动作全部接现有真实动作:答复走 AwaitsAnswerPanel、
 * 裁决/评审落任务详情收口页签、决策与任务落实体导航、取消置顶走 pin 写通道。
 * CI 区域只陈述事实(重跑/看日志没有现成 GUI 动作,不做假按钮)。
 */

const KIND_LABEL: Readonly<Record<AttentionEntry["item"]["kind"], () => string>> = {
  "awaiting-you": () => t("views.overviewView.kindAwaitingYou"),
  rework: () => t("views.overviewView.kindRework"),
  adjudication: () => t("views.overviewView.kindAdjudication"),
  decision: () => t("views.overviewView.kindDecision"),
  blocked: () => t("views.overviewView.kindBlocked"),
  stalled: () => t("views.overviewView.kindStalled"),
  answered: () => t("views.overviewView.kindAnswered"),
  archive: () => t("views.overviewView.kindArchive"),
};

export interface OverviewRegionSpec {
  readonly title: string;
  /** 区域行体上方的整条内容(评审与合并的分组计数条,原型 .flow);占位已计入 need。 */
  readonly top?: ReactNode;
  readonly tag: ReactNode;
  readonly big: number | string;
  readonly bigTone: StatusTone | undefined;
  readonly edge: StatusTone | undefined;
  readonly footer: ReactNode;
  readonly rowCount: number;
  readonly hasTop: boolean;
  readonly rowIds: readonly string[];
  readonly renderRow: (
    id: string,
    options: { readonly relaxed: boolean; readonly selected: boolean; readonly onSelect: () => void },
  ) => ReactNode;
  readonly renderDetail: (id: string) => ReactNode;
}

export interface OverviewRegionDeps {
  readonly agenda: AgendaSuccess | undefined;
  readonly works: WorkIndexRead | undefined;
  readonly runtime: AgentRuntimeOverviewResult | undefined;
  readonly ci: CiObservatoryRead | undefined;
  readonly events: readonly {
    readonly key: string;
    readonly at: string | null;
    readonly type: string;
    readonly summary: string | null;
    readonly taskId: string | null;
    readonly decisionId: string | null;
  }[];
  readonly now: string;
  readonly onAnswer: (subject: AwaitsPanelSubject) => void;
  readonly onNavigateEntity: (ref: string) => void;
  readonly onOpenTask: (taskId: string) => void;
  readonly onOpenSessions: () => void;
  readonly onUnpin: (taskId: string) => void;
}

export function buildOverviewRegions(deps: OverviewRegionDeps): Partial<Record<RegionKey, OverviewRegionSpec>> {
  const workTitleOf = new Map((deps.works?.works ?? []).map((work) => [work.taskId, work.title] as const)),
    mine = deps.agenda === undefined ? [] : attentionEntries(deps.agenda, "mine"),
    stuck = deps.agenda === undefined ? [] : attentionEntries(deps.agenda, "stuck"),
    mineUrgent = mine.filter(({ item }) => item.attention.score >= 80).length,
    stuckBlocked = stuck.filter(({ item }) => item.kind === "blocked").length,
    runs = runRows(deps.runtime, deps.agenda),
    idle = idleInFlightCount(deps.runtime, deps.agenda),
    reviews = reviewRows(deps.agenda),
    queue = pinnedDispatchable(deps.agenda),
    works = workRows(deps.works, deps.agenda),
    recent = recentEventRows(deps.events),
    ciFailure = mainCiFailure(deps.ci);

  const attentionRow =
    (region: "mine" | "stuck", entries: readonly AttentionEntry[]) =>
    (
      id: string,
      {
        relaxed,
        selected,
        onSelect,
      }: { readonly relaxed: boolean; readonly selected: boolean; readonly onSelect: () => void },
    ): ReactNode => {
      const entry = entries.find((candidate) => candidate.item.ref === id);
      if (entry === undefined) return null;
      const { item } = entry,
        meta = ATTENTION_META[item.kind],
        workTitle = item.workTaskId === null ? null : (workTitleOf.get(item.workTaskId) ?? null),
        stale = item.kind === "blocked" || item.kind === "stalled",
        rank = region === "mine" ? entries.indexOf(entry) + 1 : undefined;
      return (
        <DenseRow
          key={item.ref}
          index={rank}
          tag={<StatusTag tone={meta.tone} label={KIND_LABEL[item.kind]()} />}
          title={item.title}
          reason={workTitle}
          time={entry.since === null ? null : stale ? staleDaysOf(entry.since, deps.now) : ageOf(entry.since, deps.now)}
          relaxed={relaxed}
          selected={selected}
          onClick={onSelect}
        />
      );
    };

  const attentionDetail =
    (entries: readonly AttentionEntry[]) =>
    (id: string): ReactNode => {
      const entry = entries.find((candidate) => candidate.item.ref === id);
      if (entry === undefined) return null;
      const { item, source } = entry,
        meta = ATTENTION_META[item.kind],
        workTitle = item.workTaskId === null ? null : (workTitleOf.get(item.workTaskId) ?? null);
      return (
        <div className="flex flex-col gap-3">
          <div className="flex items-center gap-2">
            <StatusTag tone={meta.tone} label={KIND_LABEL[item.kind]()} />
            {workTitle !== null && <span className="ui-meta text-text-muted">{workTitle}</span>}
          </div>
          <h3 className="text-text ui-title">{item.title}</h3>
          {source?.kind === "awaits" && (
            <p className="ui-meta text-text-muted">
              {AWAITS_KIND_LABEL[source.row.askKind]()} · {source.row.question}
            </p>
          )}
          {source?.kind === "answered" && (
            <p className="ui-meta text-text-muted">
              {t("views.overviewView.answeredWith", { answer: source.row.answer })}
            </p>
          )}
          <div className="ui-meta text-text-muted">{t("views.overviewView.whyLabel")}</div>
          <table className="w-full text-left">
            <tbody>
              {item.attention.reasons.map((reason) => (
                <tr key={reason.label} className="border-b border-border">
                  <td className="py-1 pr-2 ui-meta text-text-muted">{reason.label}</td>
                  <td className="py-1 text-right font-mono tabular-nums ui-meta text-text">
                    {reason.contribution > 0 ? "+" : ""}
                    {reason.contribution}
                  </td>
                </tr>
              ))}
              <tr>
                <td className="py-1 pr-2 font-semibold ui-meta text-text">
                  {t("views.overviewView.attentionScoreLabel")}
                </td>
                <td className="py-1 text-right font-mono font-semibold tabular-nums ui-meta text-accent">
                  {item.attention.score}
                </td>
              </tr>
            </tbody>
          </table>
          <div className="flex flex-wrap gap-1.5">
            {source?.kind === "awaits" && (
              <OverviewActionButton primary onClick={() => deps.onAnswer({ mode: "answer", row: source.row })}>
                {t("components.awaitsAnswer.openAnswer")}
              </OverviewActionButton>
            )}
            {source?.kind === "answered" && (
              <OverviewActionButton primary onClick={() => deps.onNavigateEntity(source.row.sourceRef)}>
                {t("components.awaitsAnswer.openSource")}
              </OverviewActionButton>
            )}
            {source?.kind === "rework" && (
              <OverviewActionButton primary onClick={() => deps.onNavigateEntity(taskReviewRef(source.row.taskId))}>
                {t("views.overviewView.actionOpenCloseout")}
              </OverviewActionButton>
            )}
            {source?.kind === "adjudication" && (
              <OverviewActionButton primary onClick={() => deps.onNavigateEntity(taskReviewRef(source.row.taskId))}>
                {t("views.overviewView.actionAdjudicate")}
              </OverviewActionButton>
            )}
            {source?.kind === "decision" && (
              <OverviewActionButton primary onClick={() => deps.onNavigateEntity(`decision/${source.row.decisionId}`)}>
                {t("views.overviewView.actionOpenDecision")}
              </OverviewActionButton>
            )}
            {source?.kind === "task" && (
              <OverviewActionButton primary onClick={() => deps.onOpenTask(source.row.taskId)}>
                {t("views.overviewView.actionOpenTask")}
              </OverviewActionButton>
            )}
            <OverviewActionButton onClick={() => deps.onNavigateEntity(item.ref)}>
              {t("views.overviewView.actionFullDetail")}
            </OverviewActionButton>
          </div>
        </div>
      );
    };

  const mineTone: StatusTone = mine.length === 0 ? "done" : mineUrgent > 0 ? "bad" : "wait";

  const regions: Partial<Record<RegionKey, OverviewRegionSpec>> = {
    mine: {
      title: t("views.overviewView.regionMine"),
      tag: (
        <StatusTag
          tone={mineTone}
          label={
            mine.length === 0
              ? t("views.overviewView.mineClear")
              : mineUrgent > 0
                ? t("views.overviewView.mineUrgent", { count: mineUrgent })
                : t("views.overviewView.minePending")
          }
        />
      ),
      big: mine.length,
      bigTone: mineTone,
      edge: mineTone,
      footer: t("views.overviewView.mineFooter"),
      rowCount: mine.length,
      hasTop: false,
      rowIds: mine.map(({ item }) => item.ref),
      renderRow: attentionRow("mine", mine),
      renderDetail: attentionDetail(mine),
    },
    stuck: {
      title: t("views.overviewView.regionStuck"),
      tag: (
        <>
          <StatusTag tone="bad" label={t("views.overviewView.stuckBlocked", { count: stuckBlocked })} />
          <StatusTag tone="wait" label={t("views.overviewView.stuckStalled", { count: stuck.length - stuckBlocked })} />
        </>
      ),
      big: stuck.length,
      bigTone: stuckBlocked > 0 ? "bad" : "wait",
      edge: stuckBlocked > 0 ? "bad" : "wait",
      footer: t("views.overviewView.stuckFooter"),
      rowCount: stuck.length,
      hasTop: false,
      rowIds: stuck.map(({ item }) => item.ref),
      renderRow: attentionRow("stuck", stuck),
      renderDetail: attentionDetail(stuck),
    },
    run: {
      title: t("views.overviewView.regionRun"),
      tag:
        idle > 0 ? (
          <StatusTag tone="wait" label={t("views.overviewView.runIdle", { count: idle })} />
        ) : (
          <StatusTag tone="done" label={t("views.overviewView.runOk")} />
        ),
      big: runs.length,
      bigTone: "done",
      edge: "done",
      footer: t("views.overviewView.runFooter"),
      rowCount: runs.length + (idle > 0 ? 1 : 0),
      hasTop: false,
      rowIds: [...runs.map((row) => row.runtimeSessionId), ...(idle > 0 ? ["idle"] : [])],
      renderRow: (id, { relaxed, selected, onSelect }) => {
        if (id === "idle") {
          return (
            <DenseRow
              key="idle"
              tag={<StatusTag tone="wait" label={t("views.overviewView.runIdleTag")} />}
              title={t("views.overviewView.runIdleDetail", { count: idle })}
              relaxed={relaxed}
              selected={selected}
              onClick={onSelect}
            />
          );
        }
        const run = runs.find((candidate) => candidate.runtimeSessionId === id);
        if (run === undefined) return null;
        return (
          <DenseRow
            key={run.runtimeSessionId}
            tag={<StatusTag tone="active" label={t("views.overviewView.runLive")} />}
            title={run.taskTitle ?? run.taskId ?? run.who}
            reason={run.taskTitle === null ? null : run.who}
            relaxed={relaxed}
            selected={selected}
            onClick={onSelect}
          />
        );
      },
      renderDetail: (id) => {
        if (id === "idle") {
          return (
            <div className="flex flex-col gap-3">
              <h3 className="text-text ui-title">{t("views.overviewView.runIdleDetail", { count: idle })}</h3>
              <p className="ui-meta text-text-muted">{t("views.overviewView.runIdleHint")}</p>
              <OverviewActionButton primary onClick={deps.onOpenSessions}>
                {t("views.overviewView.actionOpenSessions")}
              </OverviewActionButton>
            </div>
          );
        }
        const run = runs.find((candidate) => candidate.runtimeSessionId === id);
        if (run === undefined) return null;
        return (
          <div className="flex flex-col gap-3">
            <StatusTag tone="active" label={t("views.overviewView.runLive")} />
            <h3 className="text-text ui-title">{run.taskTitle ?? run.who}</h3>
            <table className="w-full text-left">
              <tbody>
                <tr className="border-b border-border">
                  <td className="py-1 pr-2 ui-meta text-text-muted">{t("views.overviewView.runExecutor")}</td>
                  <td className="py-1 text-right font-mono ui-meta text-text">{run.who}</td>
                </tr>
                <tr className="border-b border-border">
                  <td className="py-1 pr-2 ui-meta text-text-muted">{t("views.overviewView.runObserved")}</td>
                  <td className="py-1 text-right font-mono ui-meta text-text">{ageOf(run.lastObservedAt, deps.now)}</td>
                </tr>
              </tbody>
            </table>
            <div className="flex flex-wrap gap-1.5">
              <OverviewActionButton primary onClick={deps.onOpenSessions}>
                {t("views.overviewView.actionOpenSessions")}
              </OverviewActionButton>
              {run.taskId !== null && (
                <OverviewActionButton onClick={() => deps.onOpenTask(run.taskId!)}>
                  {t("views.overviewView.actionOpenTask")}
                </OverviewActionButton>
              )}
            </div>
          </div>
        );
      },
    },
    review: reviewRegion(reviews, deps),
    queue: {
      title: t("views.overviewView.regionQueue"),
      tag: <StatusTag tone="plan" label={t("views.overviewView.queueTag")} />,
      big: queue.length,
      bigTone: undefined,
      edge: undefined,
      footer: t("views.overviewView.queueFooter"),
      rowCount: queue.length,
      hasTop: false,
      rowIds: queue.map(({ taskId }) => taskId),
      renderRow: (id, { relaxed, selected, onSelect }) => {
        const task = queue.find((candidate) => candidate.taskId === id);
        if (task === undefined) return null;
        return (
          <DenseRow
            key={task.taskId}
            tag={<StatusTag tone="plan" label={t("views.overviewView.queuePlanned")} />}
            title={task.title}
            time={ageOf(task.updatedAt, deps.now)}
            relaxed={relaxed}
            selected={selected}
            onClick={onSelect}
          />
        );
      },
      renderDetail: (id) => {
        const task = queue.find((candidate) => candidate.taskId === id);
        if (task === undefined) return null;
        return (
          <div className="flex flex-col gap-3">
            <StatusTag tone="plan" label={t("views.overviewView.queuePlanned")} />
            <h3 className="text-text ui-title">{task.title}</h3>
            <p className="ui-meta text-text-muted">
              {t("views.overviewView.queueUpdatedAt", { age: ageOf(task.updatedAt, deps.now) })}
            </p>
            <div className="flex flex-wrap gap-1.5">
              <OverviewActionButton primary onClick={() => deps.onOpenTask(task.taskId)}>
                {t("views.overviewView.actionDispatch")}
              </OverviewActionButton>
              <OverviewActionButton onClick={() => deps.onUnpin(task.taskId)}>
                {t("views.overviewView.actionUnpin")}
              </OverviewActionButton>
            </div>
          </div>
        );
      },
    },
    recent: {
      title: t("views.overviewView.regionRecent"),
      tag: <></>,
      big: recent.length,
      bigTone: undefined,
      edge: undefined,
      footer: t("views.overviewView.recentFooter"),
      rowCount: recent.length,
      hasTop: false,
      rowIds: recent.map(({ key }) => key),
      renderRow: (id, { relaxed, selected, onSelect }) => {
        const event = recent.find((candidate) => candidate.key === id);
        if (event === undefined) return null;
        return (
          <DenseRow
            key={event.key}
            tag={<StatusTag tone={recentTone(event)} label={recentLabel(event)} />}
            title={event.summary}
            time={formatTime(event.at, { style: "time" }) ?? undefined}
            relaxed={relaxed}
            selected={selected}
            onClick={onSelect}
          />
        );
      },
      renderDetail: (id) => {
        const event = recent.find((candidate) => candidate.key === id);
        if (event === undefined) return null;
        return (
          <div className="flex flex-col gap-3">
            <StatusTag tone={recentTone(event)} label={recentLabel(event)} />
            <h3 className="text-text ui-title">{event.summary}</h3>
            <p className="font-mono ui-meta text-text-muted">{formatTime(event.at, { style: "date-time" })}</p>
            {event.ref !== null && (
              <OverviewActionButton primary onClick={() => deps.onNavigateEntity(event.ref!)}>
                {t("views.overviewView.actionOpenEntity")}
              </OverviewActionButton>
            )}
          </div>
        );
      },
    },
    works: {
      title: t("views.overviewView.regionWorks"),
      tag: (
        <StatusTag
          tone={works.some(({ mineCount }) => mineCount > 0) ? "wait" : "neutral"}
          label={t("views.overviewView.worksMine", {
            count: works.filter(({ mineCount }) => mineCount > 0).length,
          })}
        />
      ),
      big: works.length,
      bigTone: undefined,
      edge: undefined,
      footer: t("views.overviewView.worksFooter"),
      rowCount: works.length,
      hasTop: false,
      rowIds: works.map(({ taskId }) => taskId),
      renderRow: (id, { relaxed, selected, onSelect }) => {
        const work = works.find((candidate) => candidate.taskId === id);
        if (work === undefined) return null;
        return (
          <DenseRow
            key={work.taskId}
            tag={<StatusTag status={work.status} />}
            title={work.title}
            reason={
              work.mineCount > 0
                ? t("views.overviewView.worksMineReason", { count: work.mineCount })
                : t("views.overviewView.worksProgress", { percent: String(Math.round(work.doneRatio * 100)) })
            }
            time={ageOf(work.lastActivityAt, deps.now)}
            relaxed={relaxed}
            selected={selected}
            onClick={onSelect}
          />
        );
      },
      renderDetail: (id) => {
        const work = works.find((candidate) => candidate.taskId === id);
        if (work === undefined) return null;
        const total = Object.values(work.counts).reduce((sum, count) => sum + (count ?? 0), 0),
          done = work.counts.done ?? 0;
        return (
          <div className="flex flex-col gap-3">
            <StatusTag status={work.status} />
            <h3 className="text-text ui-title">{work.title}</h3>
            <SegBar counts={work.counts} />
            <p className="ui-meta text-text-muted">
              {t("views.overviewView.worksDoneOf", { done: String(done), total: String(total) })} ·{" "}
              {t("views.overviewView.worksLastActivity", { age: ageOf(work.lastActivityAt, deps.now) })}
            </p>
            <div className="flex flex-wrap gap-1.5">
              <OverviewActionButton primary onClick={() => deps.onOpenTask(work.taskId)}>
                {t("views.overviewView.actionOpenWork")}
              </OverviewActionButton>
            </div>
          </div>
        );
      },
    },
  };

  if (ciFailure !== null) {
    const failingRows = failingCiRows(deps.ci);
    regions.ci = {
      title: t("views.overviewView.regionCi"),
      tag: <StatusTag tone="bad" label={t("views.overviewView.ciBlocking")} />,
      big: ciFailure.failing,
      bigTone: "bad",
      edge: "bad",
      footer: t("views.overviewView.ciFooter"),
      rowCount: failingRows.length,
      hasTop: false,
      rowIds: failingRows.map(({ runId }) => runId),
      renderRow: (id, { relaxed, selected, onSelect }) => {
        const run = failingRows.find((candidate) => candidate.runId === id);
        if (run === undefined) return null;
        return (
          <DenseRow
            key={run.runId}
            tag={<StatusTag tone="bad" label={t("views.overviewView.ciFailed")} />}
            title={`${run.job} · ${run.sha.slice(0, 8)}`}
            time={ageOf(run.occurredAt, deps.now)}
            relaxed={relaxed}
            selected={selected}
            onClick={onSelect}
          />
        );
      },
      renderDetail: (id) => {
        const run = failingRows.find((candidate) => candidate.runId === id);
        if (run === undefined) return null;
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
                  <td className="py-1 text-right font-mono ui-meta text-text">{ageOf(run.occurredAt, deps.now)}</td>
                </tr>
                <tr>
                  <td className="py-1 pr-2 ui-meta text-text-muted">{t("views.overviewView.ciWindowFailing")}</td>
                  <td className="py-1 text-right font-mono ui-meta text-text">{ciFailure.failing}</td>
                </tr>
              </tbody>
            </table>
            <p className="ui-meta text-text-muted">{t("views.overviewView.ciNoActionHint")}</p>
          </div>
        );
      },
    };
  }

  return regions;
}

/** 评审与合并:打回/待初审/任务评审中/决策评审中/待点头,行落任务收口或决策。 */
function reviewRegion(reviews: readonly ReviewRow[], deps: OverviewRegionDeps): OverviewRegionSpec {
  const counts = reviewCounts(reviews),
    groups: ReadonlyArray<[ReviewRow["group"], () => string, StatusTone]> = [
      ["rework", () => t("views.overviewView.reviewRework"), "wait"],
      ["adjudication", () => t("views.overviewView.reviewAdjudication"), "wait"],
      ["taskReviewing", () => t("views.overviewView.reviewTaskReviewing"), "wait"],
      ["decisionReviewing", () => t("views.overviewView.reviewDecisionReviewing"), "wait"],
      ["decisionPending", () => t("views.overviewView.reviewDecisionPending"), "wait"],
    ];
  return {
    title: t("views.overviewView.regionReview"),
    top:
      reviews.length === 0 ? undefined : (
        <div className="grid grid-cols-5 gap-1 border-b border-border px-3 pb-1.5 pt-2">
          {groups.map(([key, label]) => (
            <div key={key} className="min-w-0 text-center">
              <span className="block font-mono font-semibold leading-none tabular-nums text-text ui-heading">
                {counts[key]}
              </span>
              <span className="block truncate text-text-faint ui-micro">{label()}</span>
            </div>
          ))}
        </div>
      ),
    tag: <StatusTag tone="wait" label={t("views.overviewView.reviewInFlight", { count: reviews.length })} />,
    big: reviews.length,
    bigTone: "wait",
    edge: counts.rework > 0 ? "wait" : undefined,
    footer: t("views.overviewView.reviewFooter"),
    rowCount: reviews.length,
    hasTop: true,
    rowIds: reviews.map(({ id }) => id),
    renderRow: (id, { relaxed, selected, onSelect }) => {
      const row = reviews.find((candidate) => candidate.id === id);
      if (row === undefined) return null;
      const group = groups.find(([key]) => key === row.group)!;
      return (
        <DenseRow
          key={row.id}
          tag={<StatusTag tone={group[2]} label={group[1]()} />}
          title={row.title}
          time={ageOf(row.since, deps.now)}
          relaxed={relaxed}
          selected={selected}
          onClick={onSelect}
        />
      );
    },
    renderDetail: (id) => {
      const row = reviews.find((candidate) => candidate.id === id);
      if (row === undefined) return null;
      const group = groups.find(([key]) => key === row.group)!;
      return (
        <div className="flex flex-col gap-3">
          <StatusTag tone={group[2]} label={group[1]()} />
          <h3 className="text-text ui-title">{row.title}</h3>
          <p className="ui-meta text-text-muted">
            {t("views.overviewView.reviewSince", { age: ageOf(row.since, deps.now) })}
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
    },
  };
}

/** main 分支失败的 run(按 job 去重取最新一次)。 */
function failingCiRows(
  ci: CiObservatoryRead | undefined,
): readonly { runId: string; job: string; sha: string; occurredAt: string }[] {
  if (ci?.status !== "ready") return [];
  const byJob = new Map<string, { runId: string; job: string; sha: string; occurredAt: string }>();
  for (const run of ci.runs.filter((run) => run.branch === "main" && !run.pass)) {
    if (!byJob.has(run.job))
      byJob.set(run.job, { runId: run.runId, job: run.job, sha: run.sha, occurredAt: run.occurredAt });
  }
  return [...byJob.values()].sort((left, right) => Date.parse(right.occurredAt) - Date.parse(left.occurredAt));
}

/** 就地动作按钮(标准 §5:能在当前视图完成的动作直接给按钮,接真实动作)。 */
function OverviewActionButton({
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

const RECENT_TONE: Readonly<Record<string, StatusTone>> = {
  task_completed: "done",
  task_started: "active",
  task_created: "plan",
  task_transitioned: "wait",
  decision_proposed: "wait",
  fact_recorded: "neutral",
  ci_run_observed: "bad",
};

function recentTone(event: RecentEventRow): StatusTone {
  return RECENT_TONE[event.type] ?? "neutral";
}

function recentLabel(event: RecentEventRow): string {
  const labels: Readonly<Record<string, () => string>> = {
    task_completed: () => t("views.overviewView.eventCompleted"),
    task_started: () => t("views.overviewView.eventStarted"),
    task_created: () => t("views.overviewView.eventCreated"),
    task_transitioned: () => t("views.overviewView.eventTransitioned"),
    decision_proposed: () => t("views.overviewView.eventDecision"),
    fact_recorded: () => t("views.overviewView.eventFact"),
  };
  return (labels[event.type] ?? (() => event.type))();
}
