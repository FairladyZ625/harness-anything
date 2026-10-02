import type { ReactNode } from "react";
import { PushPinSlash } from "@phosphor-icons/react";
import type { AgendaSuccess } from "../api-client.ts";
import type { AwaitsPanelSubject } from "../awaits-answer.ts";
import { AWAITS_KIND_LABEL } from "../awaits-answer.ts";
import { DayDigest, type DayPath } from "../components/primitives/DayDigest";
import { DenseRow } from "../components/primitives/DenseRow";
import { SegBar } from "../components/primitives/SegBar";
import { StatusTag, type StatusTone } from "../components/primitives/StatusTag";
import { StepChain } from "../components/primitives/StepChain";
import { t } from "../i18n/index.tsx";
import { actorDisplayName } from "../model/actor-name.ts";
import { dayKeyOf, formatDayKeyLabel, formatRelative, formatTime } from "../model/time.ts";
import type { CadenceFeedEvent } from "../model/cadence.ts";
import type { WorkDayGroup } from "../model/workspace-narrative.ts";
import { taskReviewRef } from "../navigation/entityRoutes.ts";
import type { CiObservatoryRead, WorkIndexRead } from "../../api/renderer-dto.ts";
import type { AgentRuntimeOverviewResult } from "@harness-anything/daemon/protocol";
import type { RegionKey } from "./overview-layout.ts";
import { DaySummary, STEP_META } from "./workspace/WorkOverview.tsx";
import {
  ATTENTION_META,
  attentionEntries,
  idleInFlightCount,
  mainCiFailingJobs,
  pinnedTaskRows,
  recentDayGroups,
  reviewCounts,
  reviewRows,
  runRows,
  workRows,
  type AttentionEntry,
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
  /** 自绘行体的区域(最近变化的 DayDigest 列表)用它替代 top+renderRow;区域体内与
   * 放大层列表各调一次,inFocus 区分展面(放大层里天全展开、行带选中态)。 */
  readonly renderList?: (options: {
    readonly selectedId: string | null;
    readonly onSelect: (id: string) => void;
    readonly inFocus: boolean;
  }) => ReactNode;
  readonly renderRow: (
    id: string,
    options: {
      readonly relaxed: boolean;
      readonly selected: boolean;
      readonly onSelect: () => void;
      /** 放大层里渲染(与区域体内不同展面,如最近变化的天默认全展开)。 */
      readonly inFocus: boolean;
    },
  ) => ReactNode;
  readonly renderDetail: (id: string) => ReactNode;
}

export interface OverviewRegionDeps {
  readonly agenda: AgendaSuccess | undefined;
  readonly works: WorkIndexRead | undefined;
  readonly runtime: AgentRuntimeOverviewResult | undefined;
  readonly ci: CiObservatoryRead | undefined;
  /** observe.tail 一页事件(升序);最近变化区域与工作页共用 workDayGroups 收束。 */
  readonly events: readonly CadenceFeedEvent[];
  /** `task/<id>` → 标题(App 常驻任务列表投影);路径行显示任务标题而非裸 id。 */
  readonly titles: ReadonlyMap<string, string>;
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
    queue = pinnedTaskRows(deps.agenda, deps.works),
    works = workRows(deps.works, deps.agenda),
    recentDays = recentDayGroups({
      events: deps.events,
      titles: deps.titles,
      dateKeyOf: (iso) => dayKeyOf(iso),
    }),
    recentPaths = recentDays.flatMap((group) => group.paths.map((path) => ({ group, path }))),
    failingRows = mainCiFailingJobs(deps.ci);

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
        rank = region === "mine" ? entries.indexOf(entry) + 1 : undefined;
      return (
        <DenseRow
          key={item.ref}
          index={rank}
          tag={<StatusTag tone={meta.tone} label={KIND_LABEL[item.kind]()} />}
          title={item.title}
          reason={
            entry.source?.kind === "answered"
              ? [
                  workTitle,
                  t("components.awaitsAnswer.answeredBy", {
                    // 答复者是可读名字(与决策详情时间线同一套转换);完整身份串放悬停。
                    actor: actorDisplayName(entry.source.row.answeredBy).name,
                    time: formatRelative(entry.source.row.answeredAt, { now: deps.now }),
                  }),
                ]
                  .filter(Boolean)
                  .join(" · ")
              : workTitle
          }
          hoverTitle={entry.source?.kind === "answered" ? entry.source.row.answeredBy : undefined}
          time={entry.since === null ? null : formatRelative(entry.since, { now: deps.now })}
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
                  <td className="py-1 text-right font-mono ui-meta text-text">
                    {formatTime(run.lastObservedAt, { style: "date-time", now: deps.now }) ?? "—"}
                  </td>
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
      tag: queue.some(({ dispatchable }) => dispatchable) ? (
        <StatusTag tone="plan" label={t("views.overviewView.queueTag")} />
      ) : (
        <StatusTag tone="neutral" label={t("views.overviewView.queueNoDispatchable")} />
      ),
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
      },
    },
    recent: {
      title: t("views.overviewView.regionRecent"),
      tag: <></>,
      big: recentPaths.length,
      bigTone: undefined,
      edge: undefined,
      footer: t("views.overviewView.recentFooter"),
      // 区域体内一天收成一行(最新一天展开),高度预算按可见行折算。
      rowCount: Math.round(recentDays.length * 1.4) + (recentDays[0]?.paths.length ?? 0),
      hasTop: false,
      rowIds: recentPaths.map(({ group, path }) => recentPathId(group, path.taskId)),
      renderList: ({ selectedId, onSelect, inFocus }) => (
        // DayDigest 自己不带左右内边距:贴着区域框时「收起」会顶到右缘,这里留出与行同宽的边距。
        <div className="px-3.5">
          {recentDays.map((group, index) => (
            <DayDigest
              key={group.dateKey}
              day={recentDayLabel(group.dateKey, deps.now)}
              defaultOpen={inFocus || index === 0}
              summary={<DaySummary group={group} />}
              paths={group.paths.map<DayPath>((path) => ({
                time: formatTime(path.firstAt, { style: "time" }) ?? undefined,
                name: path.title ?? path.taskId,
                steps: path.steps.map((step) => ({
                  label: t(STEP_META[step].label),
                  tone: STEP_META[step].tone,
                })),
                selected: selectedId === recentPathId(group, path.taskId),
                onClick: () => onSelect(recentPathId(group, path.taskId)),
              }))}
            />
          ))}
        </div>
      ),
      renderRow: () => null,
      renderDetail: (id) => {
        const held = recentPaths.find(({ group, path }) => recentPathId(group, path.taskId) === id);
        if (held === undefined) return null;
        return (
          <div className="flex flex-col gap-3">
            <span className="font-mono text-text-faint ui-meta">{recentDayLabel(held.group.dateKey, deps.now)}</span>
            <h3 className="text-text ui-title">{held.path.title ?? held.path.taskId}</h3>
            {/* 详情卡里的步骤链与列表行同一 StepChain:单行,超出在链内横滚。 */}
            <StepChain
              steps={held.path.steps.map((step) => ({
                label: t(STEP_META[step].label),
                tone: STEP_META[step].tone,
              }))}
            />
            <p className="font-mono ui-meta text-text-muted">{formatTime(held.path.firstAt, { style: "date-time" })}</p>
            <div className="flex flex-wrap gap-1.5">
              <OverviewActionButton primary onClick={() => deps.onOpenTask(held.path.taskId)}>
                {t("views.overviewView.actionOpenTask")}
              </OverviewActionButton>
            </div>
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
            time={formatRelative(work.lastActivityAt, { now: deps.now })}
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
              {t("views.overviewView.worksLastActivity", {
                age: formatRelative(work.lastActivityAt, { now: deps.now }),
              })}
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

  if (failingRows.length > 0) {
    regions.ci = {
      title: t("views.overviewView.regionCi"),
      tag: <StatusTag tone="bad" label={t("views.overviewView.ciBlocking")} />,
      big: failingRows.length,
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
            time={formatRelative(run.occurredAt, { now: deps.now })}
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
                  <td className="py-1 text-right font-mono ui-meta text-text">
                    {formatTime(run.occurredAt, { style: "date-time", now: deps.now }) ?? "—"}
                  </td>
                </tr>
                <tr>
                  <td className="py-1 pr-2 ui-meta text-text-muted">{t("views.overviewView.ciWindowFailing")}</td>
                  <td className="py-1 text-right font-mono ui-meta text-text">{failingRows.length}</td>
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
      ["decisionNeedsReview", () => t("views.overviewView.reviewDecisionNeedsReview"), "wait"],
      ["decisionReviewing", () => t("views.overviewView.reviewDecisionReviewing"), "wait"],
      ["decisionPending", () => t("views.overviewView.reviewDecisionPending"), "wait"],
    ];
  return {
    title: t("views.overviewView.regionReview"),
    top:
      reviews.length === 0 ? undefined : (
        <div className="grid grid-cols-3 gap-1 border-b border-border px-3 pb-1.5 pt-2">
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
          time={formatRelative(row.since, { now: deps.now })}
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
    },
  };
}

/** main 分支失败的 run(按 job 去重取最新一次)。 */
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

/** 放大层的行 id:同一任务可跨天出现,id 带上天。 */
function recentPathId(group: WorkDayGroup, taskId: string): string {
  return `${group.dateKey}|${taskId}`;
}

/** 天标签与工作页同一口径:今天/昨天/日期。 */
function recentDayLabel(dateKey: string, nowIso: string): string {
  const today = dayKeyOf(nowIso);
  if (dateKey === today) return t("views.workspace.progress.today");
  const yesterday = dayKeyOf(new Date(Date.parse(nowIso) - 24 * 3_600_000).toISOString());
  if (dateKey === yesterday) return t("views.workspace.progress.yesterday");
  return formatDayKeyLabel(dateKey);
}
