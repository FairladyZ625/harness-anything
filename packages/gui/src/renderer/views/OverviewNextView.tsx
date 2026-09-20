import { useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowsClockwise,
  CheckCircle,
  Clock,
  Flag,
  Graph,
  Lightning,
  MagnifyingGlassPlus,
  Pause,
  PushPin,
  Scales,
  SignIn,
} from "@phosphor-icons/react";
import type { TaskRow } from "../model/types.ts";
import type { Project } from "../model/types.ts";
import type { RuntimeHealth } from "../model/runtime-health.ts";
import type { AgendaSuccess } from "../api-client.ts";
import type { AgentRuntimeSessionDto } from "@harness-anything/daemon/protocol";
import { t } from "../i18n/index.tsx";
import { formatTime } from "../model/time.ts";
import { Card } from "../components/overview/parts.tsx";
import { seg } from "../components/overview/streamParts.tsx";
import { useCadenceFeed } from "../cadence-feed.ts";
import { CADENCE_EVENT_LIMIT, type CadenceFeedEvent } from "../model/cadence.ts";
import {
  ATTENTION_GROUP_ORDER,
  CHANGE_CATEGORY_ORDER,
  attentionItemsOf,
  changeCategoryOf,
  keyWorkRowsOf,
  type AttentionGroup,
  type AttentionItem,
  type ChangeCategory,
  type KeyWorkRow,
} from "../model/overview-next.ts";

/**
 * 总览(新)(S3,task_66c85101):按业主认可的阅读顺序并列新增一页——需要你处理 /
 * 重点工作 / 当前执行 / 最近变化。旧「总览」不动、不隐藏、不改向(已批准实施
 * 要求第 3 条)。数据全部来自既有只读面:repo.agenda.read、repo.tasks.list/wip、
 * repo.agentRuntime.overview、observe.tail events(与研发态势同一 follow 循环);
 * 不新增 daemon 读面、不在渲染层重算全仓计数。缺口(组目标摘要、按组待办数、
 * 组工作页下钻)按任务契约留诚实空态/单点切换,清单见任务包报告。
 */

/** G5 单屏展示的变化行数;窗口总量与滚动上限另在页脚如实标注。 */
const CHANGES_ROWS = 40,
  /** G4/G3/G2 各自的单屏行上限;超出部分用现有全量页承接,不在首页静默截断。 */
  ATTENTION_ROWS = 12,
  KEYWORK_ROWS = 8,
  EXECUTION_ROWS = 8;

const timeOf = (iso: string | null | undefined) => (iso ? (formatTime(iso, { style: "month-day-time" }) ?? "—") : "—");

export function OverviewNextView({
  repoId,
  project,
  tasks,
  agenda,
  agendaError,
  activeSessions,
  runtimeError,
  health,
  daemonReadFailed,
  ledgerRevision,
  onNavigateEntity,
  onOpenGroup,
  onSelectRuntimeEntity,
  onOpenPool,
  onOpenSessions,
}: {
  repoId: string;
  project: Project;
  tasks: readonly TaskRow[];
  /** `repo.agenda.read` 同一条投影(App 按 view 挂载);undefined = 尚未读到。 */
  agenda?: AgendaSuccess;
  agendaError: string | null;
  activeSessions: readonly AgentRuntimeSessionDto[];
  runtimeError: string | null;
  health: RuntimeHealth;
  daemonReadFailed: boolean;
  ledgerRevision: { readonly watermark: number; readonly sourceRevision: number } | null;
  onNavigateEntity: (ref: string) => void;
  /** 组点击下钻的单点切换位:S1 组工作页未合入,当前 = 现有任务详情。 */
  onOpenGroup: (taskId: string) => void;
  onSelectRuntimeEntity: (ref: string) => void;
  onOpenPool: () => void;
  onOpenSessions: () => void;
}) {
  const feed = useCadenceFeed(repoId),
    taskTitles = useMemo(() => new Map(tasks.map((task) => [task.taskId, task.title])), [tasks]);

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden" data-testid="overview-next-view">
      <OverviewNextHeader
        project={project}
        health={health}
        daemonReadFailed={daemonReadFailed}
        ledgerRevision={ledgerRevision}
      />
      <div
        className={[
          "grid min-h-0 flex-1 grid-cols-1 auto-rows-[minmax(15rem,1fr)] gap-4 overflow-y-auto p-5",
          "xl:grid-cols-[minmax(0,3fr)_minmax(0,2fr)] xl:overflow-hidden",
        ].join(" ")}
      >
        <AttentionRegion
          agenda={agenda}
          agendaError={agendaError}
          onNavigateEntity={onNavigateEntity}
          onOpenPool={onOpenPool}
        />
        <ExecutionRegion
          tasks={tasks}
          taskTitles={taskTitles}
          activeSessions={activeSessions}
          runtimeError={runtimeError}
          onSelectRuntimeEntity={onSelectRuntimeEntity}
          onOpenGroup={onOpenGroup}
          onOpenSessions={onOpenSessions}
        />
        <KeyWorkRegion agenda={agenda} tasks={tasks} onOpenGroup={onOpenGroup} />
        <ChangesRegion feed={feed} taskTitles={taskTitles} onNavigateEntity={onNavigateEntity} />
      </div>
    </div>
  );
}

/** G1:工作范围与入口。顶部只留工作区名、路径、更新时间与连接异常;正常态不占版面。 */
function OverviewNextHeader({
  project,
  health,
  daemonReadFailed,
  ledgerRevision,
}: {
  project: Project;
  health: RuntimeHealth;
  daemonReadFailed: boolean;
  ledgerRevision: { readonly watermark: number; readonly sourceRevision: number } | null;
}) {
  const anomalies: string[] = [];
  if (health.daemon.state === "unresponsive") anomalies.push(t("views.overviewNext.statusDaemonDown"));
  if ((health.projection.lag ?? 0) > 0)
    anomalies.push(t("views.overviewNext.statusProjectionLag", { lag: String(health.projection.lag) }));
  if (daemonReadFailed) anomalies.push(t("views.overviewNext.statusReadFailed"));
  return (
    <header className="shrink-0 border-b border-border bg-surface/40 px-5 py-4" data-testid="overview-next-header">
      <div className="flex items-baseline gap-2">
        <h1 className="ui-title font-mono font-semibold">{project.name}</h1>
        <span className="truncate font-mono ui-meta text-text-faint">{project.path}</span>
        <span className="ml-auto shrink-0 font-mono ui-meta text-text-faint">
          {t("views.overviewNext.updatedAt", { time: timeOf(project.watermarkAt) })}
        </span>
      </div>
      <div className="mt-1 flex items-center gap-2 ui-meta text-text-muted">
        {anomalies.length === 0 ? (
          <span className="inline-flex items-center gap-1">
            <CheckCircle weight="bold" className="text-accent" aria-hidden />
            {t("views.overviewNext.statusOk")}
          </span>
        ) : (
          <details className="min-w-0">
            <summary className="inline-flex cursor-pointer list-none items-center gap-1 text-status-blocked">
              <Pause weight="bold" aria-hidden />
              {t("views.overviewNext.statusAnomalyCount", { count: anomalies.length })}
            </summary>
            <ul className="mt-1 space-y-0.5 pl-4 ui-micro text-text-muted">
              {anomalies.map((anomaly) => (
                <li key={anomaly}>{anomaly}</li>
              ))}
            </ul>
          </details>
        )}
        {ledgerRevision ? (
          <span className="ml-auto shrink-0 font-mono ui-micro text-text-faint">
            w{ledgerRevision.watermark} · r{ledgerRevision.sourceRevision}
          </span>
        ) : null}
      </div>
    </header>
  );
}

const ATTENTION_GROUP_LABEL: Record<AttentionGroup, () => string> = {
  reviewReturned: () => t("views.overviewNext.attentionGroup.reviewReturned"),
  initialReview: () => t("views.overviewNext.attentionGroup.initialReview"),
  underReview: () => t("views.overviewNext.attentionGroup.underReview"),
  decision: () => t("views.overviewNext.attentionGroup.decision"),
};

const ATTENTION_GROUP_ICON: Record<AttentionGroup, React.ReactNode> = {
  reviewReturned: <ArrowsClockwise weight="bold" aria-hidden />,
  initialReview: <SignIn weight="bold" aria-hidden />,
  underReview: <MagnifyingGlassPlus weight="bold" aria-hidden />,
  decision: <Scales weight="bold" aria-hidden />,
};

/** G2:需要你处理。点击行只进详情;不在主行放一键接受按钮(spec §2)。 */
function AttentionRegion({
  agenda,
  agendaError,
  onNavigateEntity,
  onOpenPool,
}: {
  agenda: AgendaSuccess | undefined;
  agendaError: string | null;
  onNavigateEntity: (ref: string) => void;
  onOpenPool: () => void;
}) {
  const items = attentionItemsOf(agenda);
  return (
    <Card
      title={t("views.overviewNext.attentionTitle")}
      className="xl:col-start-1 xl:row-start-1"
      bodyClassName="p-3"
      dataTestId="overview-next-attention"
    >
      {agendaError ? (
        <RegionError label={t("views.overviewNext.attentionError")} message={agendaError} />
      ) : items === null ? (
        <RegionPending label={t("views.overviewNext.attentionLoading")} />
      ) : (
        <div className="flex min-h-0 flex-1 flex-col gap-2">
          {agenda?.status === "pending" ? (
            <p className="font-mono ui-micro text-text-faint" data-testid="overview-next-attention-pending">
              {t("views.overviewNext.attentionCatchingUp", { revision: String(agenda.sourceRevision) })}
            </p>
          ) : null}
          {items.length === 0 ? (
            <RegionEmpty label={t("views.overviewNext.attentionEmpty")} />
          ) : (
            <div className="min-h-0 flex-1 space-y-0.5 overflow-y-auto pr-1" data-testid="overview-next-attention-rows">
              {ATTENTION_GROUP_ORDER.map((group) => {
                const rows = items.filter((item) => item.group === group);
                if (rows.length === 0) return null;
                return (
                  <div key={group} className="space-y-0.5">
                    <p className="flex items-center gap-1 pt-1 font-mono ui-micro uppercase tracking-wide text-text-faint">
                      {ATTENTION_GROUP_ICON[group]}
                      {ATTENTION_GROUP_LABEL[group]()} {rows.length}
                    </p>
                    {rows.slice(0, ATTENTION_ROWS).map((item) => (
                      <AttentionRow key={item.key} item={item} onNavigateEntity={onNavigateEntity} />
                    ))}
                    {rows.length > ATTENTION_ROWS ? (
                      <p className="pl-2 ui-micro text-text-faint">
                        {t("views.overviewNext.rowsOverflow", { shown: ATTENTION_ROWS, total: rows.length })}
                      </p>
                    ) : null}
                  </div>
                );
              })}
              <button
                type="button"
                onClick={onOpenPool}
                className="mt-auto shrink-0 self-start rounded border border-border px-2 py-1 font-mono ui-micro text-accent transition-colors duration-150 hover:bg-surface-raised"
              >
                {t("views.overviewNext.attentionGoPool")}
              </button>
            </div>
          )}
        </div>
      )}
    </Card>
  );
}

function AttentionRow({ item, onNavigateEntity }: { item: AttentionItem; onNavigateEntity: (ref: string) => void }) {
  return (
    <button
      type="button"
      onClick={() => onNavigateEntity(item.ref)}
      title={item.ref}
      className="flex w-full items-center gap-2 rounded-md border border-border bg-surface-raised px-2 py-1 text-left transition-colors duration-150 hover:border-accent/60"
    >
      {item.pinned ? <PushPin weight="bold" className="shrink-0 text-accent" aria-hidden /> : null}
      {item.blocking ? <Flag weight="bold" className="shrink-0 text-status-blocked" aria-hidden /> : null}
      <span className="min-w-0 flex-1">
        <span className="block truncate ui-body text-text">{item.title}</span>
        {item.meta ? <span className="block truncate font-mono ui-micro text-text-faint">{item.meta}</span> : null}
      </span>
      <span className="shrink-0 font-mono ui-micro text-text-faint">{timeOf(item.queuedAt)}</span>
    </button>
  );
}

/** G3:重点工作。置顶(共享 pin)与 Milestone/任务组分列;组目标摘要读面缺位 → 诚实空态。 */
function KeyWorkRegion({
  agenda,
  tasks,
  onOpenGroup,
}: {
  agenda: AgendaSuccess | undefined;
  tasks: readonly TaskRow[];
  onOpenGroup: (taskId: string) => void;
}) {
  const { pinned, groups } = useMemo(() => keyWorkRowsOf(agenda, tasks), [agenda, tasks]);
  return (
    <Card
      title={t("views.overviewNext.keyWorkTitle")}
      className="xl:col-start-1 xl:row-start-2"
      bodyClassName="p-3"
      dataTestId="overview-next-keywork"
    >
      <div className="min-h-0 flex-1 space-y-0.5 overflow-y-auto pr-1" data-testid="overview-next-keywork-rows">
        {pinned.length > 0 ? (
          <>
            <p className="flex items-center gap-1 font-mono ui-micro uppercase tracking-wide text-text-faint">
              <PushPin weight="bold" aria-hidden />
              {t("views.overviewNext.keyWorkPinned")} {pinned.length}
            </p>
            {pinned.map((row) => (
              <KeyWorkRowView key={row.key} row={row} onOpenGroup={onOpenGroup} pinned />
            ))}
          </>
        ) : null}
        <p className="flex items-center gap-1 pt-1 font-mono ui-micro uppercase tracking-wide text-text-faint">
          <Graph weight="bold" aria-hidden />
          {t("views.overviewNext.keyWorkGroups")} {groups.length}
        </p>
        {groups.length === 0 ? (
          <RegionEmpty label={t("views.overviewNext.keyWorkEmpty")} />
        ) : (
          <>
            {groups.slice(0, KEYWORK_ROWS).map((row) => (
              <KeyWorkRowView key={row.key} row={row} onOpenGroup={onOpenGroup} />
            ))}
            {groups.length > KEYWORK_ROWS ? (
              <p className="pl-2 ui-micro text-text-faint">
                {t("views.overviewNext.rowsOverflow", { shown: KEYWORK_ROWS, total: groups.length })}
              </p>
            ) : null}
          </>
        )}
      </div>
    </Card>
  );
}

function KeyWorkRowView({
  row,
  onOpenGroup,
  pinned = false,
}: {
  row: KeyWorkRow;
  onOpenGroup: (taskId: string) => void;
  pinned?: boolean;
}) {
  const clickable = row.taskId !== null;
  const body = (
    <>
      {pinned ? <PushPin weight="bold" className="shrink-0 text-accent" aria-hidden /> : null}
      <span className="min-w-0 flex-1">
        <span className="block truncate ui-body text-text">{row.title}</span>
        <span className="block truncate ui-micro text-text-faint">
          {t("views.overviewNext.keyWorkGoalPending")}
          {row.note ? <span className="ml-1 font-mono">{row.note}</span> : null}
        </span>
      </span>
      {row.status ? (
        <span className="shrink-0 rounded bg-surface px-1.5 py-0.5 font-mono ui-micro text-text-muted">
          {row.status}
        </span>
      ) : null}
      <span className="shrink-0 font-mono ui-micro text-text-faint">{timeOf(row.updatedAt)}</span>
    </>
  );
  return clickable ? (
    <button
      type="button"
      onClick={() => row.taskId && onOpenGroup(row.taskId)}
      title={row.ref}
      className="flex w-full items-center gap-2 rounded-md border border-border bg-surface-raised px-2 py-1 text-left transition-colors duration-150 hover:border-accent/60"
    >
      {body}
    </button>
  ) : (
    <div className="flex w-full items-center gap-2 rounded-md border border-border bg-surface-raised px-2 py-1 text-left">
      {body}
    </div>
  );
}

/** G4:当前执行。任务 active 与运行 live 分列(spec:active≠有活进程,live≠有进展)。 */
function ExecutionRegion({
  tasks,
  taskTitles,
  activeSessions,
  runtimeError,
  onSelectRuntimeEntity,
  onOpenGroup,
  onOpenSessions,
}: {
  tasks: readonly TaskRow[];
  taskTitles: ReadonlyMap<string, string>;
  activeSessions: readonly AgentRuntimeSessionDto[];
  runtimeError: string | null;
  onSelectRuntimeEntity: (ref: string) => void;
  onOpenGroup: (taskId: string) => void;
  onOpenSessions: () => void;
}) {
  const liveSessions = activeSessions.filter((session) => session.liveness === "live"),
    notLiveCount = activeSessions.length - liveSessions.length,
    activeTasks = tasks.filter((task) => task.activeExecutionId !== undefined);
  return (
    <Card
      title={t("views.overviewNext.executionTitle")}
      className="xl:col-start-2 xl:row-start-1"
      bodyClassName="p-3"
      dataTestId="overview-next-executions"
    >
      {runtimeError ? (
        <RegionError label={t("views.overviewNext.executionError")} message={runtimeError} />
      ) : (
        <div className="min-h-0 flex-1 space-y-0.5 overflow-y-auto pr-1" data-testid="overview-next-execution-rows">
          <p className="flex items-center gap-1 font-mono ui-micro uppercase tracking-wide text-text-faint">
            <Lightning weight="bold" aria-hidden />
            {t("views.overviewNext.executionLive")} {liveSessions.length}
          </p>
          {liveSessions.length === 0 ? (
            <RegionEmpty label={t("views.overviewNext.executionLiveEmpty")} />
          ) : (
            liveSessions.slice(0, EXECUTION_ROWS).map((session) => (
              <button
                key={session.runtimeSessionId}
                type="button"
                onClick={() => onSelectRuntimeEntity(`session/${session.runtimeSessionId}`)}
                title={session.runtimeSessionId}
                className="flex w-full items-center gap-2 rounded-md border border-border bg-surface-raised px-2 py-1 text-left transition-colors duration-150 hover:border-accent/60"
              >
                <span className="min-w-0 flex-1">
                  <span className="block truncate font-mono ui-body text-text">{session.kindId}</span>
                  <span className="block truncate ui-micro text-text-faint">
                    {sessionTaskLabel(session, taskTitles) ?? t("views.overviewNext.executionNoTask")}
                  </span>
                </span>
                <span className="shrink-0 font-mono ui-micro text-text-faint">
                  {t("views.overviewNext.executionObservedAt", { time: timeOf(session.activity.lastObservedAt) })}
                </span>
              </button>
            ))
          )}
          <p className="flex items-center gap-1 pt-1 font-mono ui-micro uppercase tracking-wide text-text-faint">
            <Clock weight="bold" aria-hidden />
            {t("views.overviewNext.executionActive")} {activeTasks.length}
          </p>
          {activeTasks.length === 0 ? (
            <RegionEmpty label={t("views.overviewNext.executionActiveEmpty")} />
          ) : (
            activeTasks.slice(0, EXECUTION_ROWS).map((task) => (
              <button
                key={task.taskId}
                type="button"
                onClick={() => onOpenGroup(task.taskId)}
                title={task.taskId}
                className="flex w-full items-center gap-2 rounded-md border border-border bg-surface-raised px-2 py-1 text-left transition-colors duration-150 hover:border-accent/60"
              >
                <span className="min-w-0 flex-1">
                  <span className="block truncate ui-body text-text">{task.title}</span>
                  <span className="block truncate font-mono ui-micro text-text-faint">{task.activeExecutionId}</span>
                </span>
                <span className="shrink-0 font-mono ui-micro text-text-faint">{timeOf(task.lastKnownAt)}</span>
              </button>
            ))
          )}
          {notLiveCount > 0 ? (
            <button
              type="button"
              onClick={onOpenSessions}
              className="mt-1 self-start rounded border border-border px-2 py-1 font-mono ui-micro text-accent transition-colors duration-150 hover:bg-surface-raised"
            >
              {t("views.overviewNext.executionNotLive", { count: notLiveCount })}
            </button>
          ) : null}
        </div>
      )}
    </Card>
  );
}

/** 会话行的任务绑定:associations 是 runtime 读面自带的 task binding,不在渲染层猜。 */
function sessionTaskLabel(session: AgentRuntimeSessionDto, taskTitles: ReadonlyMap<string, string>): string | null {
  const binding = session.associations.find((association) => taskTitles.has(association.taskId));
  return binding ? (taskTitles.get(binding.taskId) ?? binding.taskId) : null;
}

const CHANGE_CATEGORY_LABEL: Record<ChangeCategory, () => string> = {
  new: () => t("views.overviewNext.changeCategory.new"),
  progress: () => t("views.overviewNext.changeCategory.progress"),
  complete: () => t("views.overviewNext.changeCategory.complete"),
  blocked: () => t("views.overviewNext.changeCategory.blocked"),
  decision: () => t("views.overviewNext.changeCategory.decision"),
  delivery: () => t("views.overviewNext.changeCategory.delivery"),
};

/** G5:最近变化。新事件只计数不抢焦点,用户点「查看」才插入已展示列表。 */
function ChangesRegion({
  feed,
  taskTitles,
  onNavigateEntity,
}: {
  feed: ReturnType<typeof useCadenceFeed>;
  taskTitles: ReadonlyMap<string, string>;
  onNavigateEntity: (ref: string) => void;
}) {
  const [filter, setFilter] = useState<ChangeCategory | "all">("all"),
    // settledCount = 用户已确认展示的事件数;初始窗口落地时整批结算,之后的 follow 增量才算「新变化」。
    [settledCount, setSettledCount] = useState(0),
    initialWindowSettled = useRef(false);
  useEffect(() => {
    if (!initialWindowSettled.current && feed.events.length > 0) {
      initialWindowSettled.current = true;
      setSettledCount(feed.events.length);
    }
  }, [feed.events.length]);
  const settled = feed.events.slice(0, settledCount),
    settledDescending = useMemo(() => [...settled].reverse(), [settled]),
    newCount = Math.max(0, feed.events.length - settledCount),
    counts = useMemo(() => {
      const byCategory = new Map<ChangeCategory, number>();
      for (const event of settled) {
        const category = changeCategoryOf(event);
        if (category !== null) byCategory.set(category, (byCategory.get(category) ?? 0) + 1);
      }
      return byCategory;
    }, [settled]),
    rows = useMemo(
      () =>
        settledDescending
          .filter((event) => filter === "all" || changeCategoryOf(event) === filter)
          .slice(0, CHANGES_ROWS),
      [settledDescending, filter],
    );
  return (
    <Card
      title={t("views.overviewNext.changesTitle")}
      className="xl:col-start-2 xl:row-start-2"
      bodyClassName="p-3"
      dataTestId="overview-next-changes"
    >
      {feed.status === "loading" ? (
        <RegionPending label={t("views.overviewNext.changesLoading")} />
      ) : feed.status === "unavailable" ? (
        <RegionError label={t("views.overviewNext.changesUnavailable")} message={feed.unavailableReason} />
      ) : (
        <div className="flex min-h-0 flex-1 flex-col gap-2">
          {feed.status === "error" ? (
            <p
              className="rounded border border-border bg-status-blocked/5 px-2 py-1 ui-micro text-status-blocked"
              data-testid="overview-next-changes-error"
            >
              {t("views.overviewNext.changesError")} {feed.error}
            </p>
          ) : null}
          {newCount > 0 ? (
            <button
              type="button"
              onClick={() => setSettledCount(feed.events.length)}
              data-testid="overview-next-changes-new"
              className="flex shrink-0 items-center gap-1 self-start rounded border border-accent/50 bg-accent/10 px-2 py-1 font-mono ui-micro text-accent transition-colors duration-150 hover:bg-accent/20"
            >
              <MagnifyingGlassPlus weight="bold" aria-hidden />
              {t("views.overviewNext.changesNewCount", { count: newCount })}
            </button>
          ) : null}
          <div className="flex flex-wrap items-center gap-0.5 rounded-md border border-border p-0.5" role="tablist">
            <button
              type="button"
              role="tab"
              aria-selected={filter === "all"}
              onClick={() => setFilter("all")}
              className={seg(filter === "all")}
            >
              {t("views.overviewNext.changeFilterAll")} {settled.length}
            </button>
            {CHANGE_CATEGORY_ORDER.map((category) => (
              <button
                key={category}
                type="button"
                role="tab"
                aria-selected={filter === category}
                onClick={() => setFilter(category)}
                className={seg(filter === category)}
              >
                {CHANGE_CATEGORY_LABEL[category]()} {counts.get(category) ?? 0}
              </button>
            ))}
          </div>
          {rows.length === 0 ? (
            <RegionEmpty label={t("views.overviewNext.changesEmpty")} />
          ) : (
            <div className="min-h-0 flex-1 space-y-0.5 overflow-y-auto pr-1" data-testid="overview-next-changes-rows">
              {rows.map((event) => (
                <ChangeRow key={event.key} event={event} taskTitles={taskTitles} onNavigateEntity={onNavigateEntity} />
              ))}
            </div>
          )}
          <p className="shrink-0 ui-micro text-text-faint">
            {t("views.overviewNext.changesWindowNote", {
              count: settled.length,
              limit: CADENCE_EVENT_LIMIT,
            })}
          </p>
        </div>
      )}
    </Card>
  );
}

/** 单条变化:事件词 + 摘要 + 时间;有实体归属才可点,进详情保留来源事件位置。 */
function ChangeRow({
  event,
  taskTitles,
  onNavigateEntity,
}: {
  event: CadenceFeedEvent;
  taskTitles: ReadonlyMap<string, string>;
  onNavigateEntity: (ref: string) => void;
}) {
  const ref =
    event.taskId !== null
      ? `task/${event.taskId}`
      : event.decisionId !== null
        ? `decision/${event.decisionId}`
        : event.factId !== null
          ? `fact/${event.factId}`
          : null;
  const subject =
    event.taskId !== null ? (taskTitles.get(event.taskId) ?? event.taskId) : (event.decisionId ?? event.factId);
  const body = (
    <>
      <span className="shrink-0 rounded bg-surface px-1.5 py-0.5 font-mono ui-micro text-text-muted">{event.type}</span>
      <span className="min-w-0 flex-1">
        {subject ? <span className="block truncate ui-body text-text">{subject}</span> : null}
        {event.summary ? <span className="block truncate ui-micro text-text-faint">{event.summary}</span> : null}
      </span>
      <span className="shrink-0 font-mono ui-micro text-text-faint">{timeOf(event.at)}</span>
    </>
  );
  return ref !== null ? (
    <button
      type="button"
      onClick={() => onNavigateEntity(ref)}
      title={ref}
      className="flex w-full items-center gap-2 rounded-md border border-border bg-surface-raised px-2 py-1 text-left transition-colors duration-150 hover:border-accent/60"
    >
      {body}
    </button>
  ) : (
    <div className="flex w-full items-center gap-2 rounded-md border border-border bg-surface-raised px-2 py-1 text-left">
      {body}
    </div>
  );
}

function RegionPending({ label }: { label: string }) {
  return (
    <p className="flex items-center gap-2 px-1 py-3 ui-meta text-text-muted" data-testid="overview-next-pending">
      <span className="rt-pulse inline-block size-2 rounded-full bg-accent" aria-hidden />
      {label}
    </p>
  );
}

function RegionEmpty({ label }: { label: string }) {
  return <p className="rounded-md border border-border bg-surface-raised px-3 py-3 ui-meta text-text-muted">{label}</p>;
}

function RegionError({ label, message }: { label: string; message: string | null }) {
  return (
    <div className="rounded-md border border-border bg-status-blocked/5 px-3 py-3" data-testid="overview-next-error">
      <p className="ui-meta text-status-blocked">{label}</p>
      {message ? <p className="mt-1 break-all font-mono ui-micro text-text-faint">{message}</p> : null}
    </div>
  );
}
