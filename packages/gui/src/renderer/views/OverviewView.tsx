import { useMemo, useState, type ReactNode } from "react";
import type { WorkIndexRead, WorkspaceSummaryRead } from "../../api/renderer-dto.ts";
import type { AgendaSuccess } from "../api-client.ts";
import type { AwaitsPanelSubject } from "../awaits-answer.ts";
import { AwaitsAnswerPanel } from "../components/AwaitsAnswerPanel.tsx";
import { PageRegions } from "../components/primitives/page-regions.tsx";
import { Region } from "../components/primitives/Region";
import { StatusTag } from "../components/primitives/StatusTag";
import {
  useOverviewAgentGroups,
  useOverviewAgentMemberPages,
  useOverviewRecentEvents,
  useOverviewRuntime,
  activeAgentIdsOf,
} from "../overview-data.ts";
import { useSettingsQuery } from "../settings-data.ts";
import { useTaskWipQuery } from "../task-data.ts";
import type { RuntimeHealth } from "../model/runtime-health.ts";
import type { TaskRow } from "../model/types.ts";
import { runtimeModelShortLabel } from "../model/runtime-models.ts";
import { t } from "../i18n/index.tsx";
import { dayKeyOf } from "../model/time.ts";
import { deriveAttestationLanes } from "../model/attestation-pool.ts";
import {
  agentLanesOf,
  attestationPendingRows,
  awaitsByTask,
  decisionRows,
  pinnedEntityRows,
  pinnedTaskRows,
  recentDayGroups,
  runRows,
  runningTaskRows,
  watchedRecentPaths,
  watchedWorks,
  workHandlers,
  WATCHED_ACTIVITY_DAYS_DEFAULT,
} from "./overview-model.ts";
import {
  OverviewAwaitsBody,
  OverviewPinsBody,
  OverviewRunningBody,
  OverviewWorksBody,
  decisionsUrgentCount,
  type OverviewBoardDeps,
} from "./overview-regions.tsx";

/**
 * 总览(2026-10-21 业主 13:50 定案:任务列表为主,四块):左上「在跑的任务」窄行高密度
 * 名单(标题、谁在跑、跑了多久、现在哪一步),右上「置顶与议程」把 pin 拿回总览,左下
 * 「关注的工作」只留标题、进度、负责人,右下「等你处理的事」取待办签发前几条。全局
 * Agent 泳道移出总览(组件保留给任务弹层/现场页);最新产物移出总览(产物页仍从侧栏
 * 进)。系统状态弱化成一行小字。数据全部来自已挂载读面,页面不另发第二套请求;区域板
 * 沿用 PageRegions(布局记忆复用其连接+仓+页面槽的本地偏好)。
 */
export function OverviewView({
  repoId,
  connectionId,
  agenda,
  works,
  titles,
  workspaceSummary,
  health,
  tasks,
  collaboration,
  onNavigateEntity,
  onOpenTask,
  onOpenSearch,
  onOpenSessions,
  onOpenWorks,
  onOpenTasks,
  onOpenCollaboration,
  onOpenSignoffs,
  onOpenPool,
  onUnpin,
  onUnpinEntity,
}: {
  readonly repoId: string;
  readonly connectionId: string | null;
  /** `ha agenda` 同一条 repo.agenda.read 投影;undefined = 尚未读到。 */
  readonly agenda: AgendaSuccess | undefined;
  /** daemon 工作索引(repo.works.index):关注工作与「受影响工作」的行。 */
  readonly works: WorkIndexRead | undefined;
  /** `task/<id>` → 标题(App 常驻任务列表投影);最近变化显示任务标题。 */
  readonly titles: ReadonlyMap<string, string>;
  readonly workspaceSummary: WorkspaceSummaryRead;
  /** 侧栏系统运行区同一份派生(App 折算,见 model/runtime-health.ts);这里喂异常状态点。 */
  readonly health: RuntimeHealth;
  /** 非纯本地仓的协作摘要(task_1bafbf09);null/undefined = 纯本地,不显示入口。 */
  readonly collaboration?: { readonly total: number; readonly executing: number } | null;
  readonly onNavigateEntity: (ref: string) => void;
  /** 工作行与任务行的落点:App 按「根任务即工作」分流到工作页或任务详情。 */
  readonly onOpenTask: (taskId: string, docPath?: string | null) => void;
  /** 顶栏全局搜索的落点:⌘K 命令面板。 */
  readonly onOpenSearch: () => void;
  readonly onOpenSessions: () => void;
  /** 「全部工作」入口的落点:工作页(选择关注/置顶也在那里)。 */
  readonly onOpenWorks: () => void;
  /** 「全部任务」入口的落点:看板。 */
  readonly onOpenTasks: () => void;
  /** 紧凑协作入口的落点(总览只给摘要与入口,分工清单在协作页)。 */
  readonly onOpenCollaboration?: () => void;
  /** 任务侧人签的落点:待办签发总池(带任务焦点);总览不复制签发写通道。 */
  readonly onOpenSignoffs: (taskId: string) => void;
  /** 「待办签发」总池的落点:本块没列出的待办(评审中的决策等)从这里进。 */
  readonly onOpenPool: () => void;
  /** 任务投影行(App 常驻):「等你处理的事」的人签行按待办签发同一判据派生。 */
  readonly tasks: readonly TaskRow[];
  /** 取消置顶(pin 写通道,taskActions.setTaskPin)。 */
  readonly onUnpin: (taskId: string) => void;
  /** 置顶区非任务实体的取消置顶(实体级 entity-unpin 写通道)。 */
  readonly onUnpinEntity: (entityRef: string) => void;
}) {
  const [panel, setPanel] = useState<AwaitsPanelSubject | null>(null);
  const runtimeQuery = useOverviewRuntime(repoId);
  const eventsQuery = useOverviewRecentEvents(repoId);
  // WIP 与看板共用同一条 repo.tasks.wip 读面(同一 query key,一处缓存):总览挂载期间
  // 本实例是观察者,台账切面前进由既有失效扇出更新,不建第二份快照。
  const wipQuery = useTaskWipQuery(repoId, true);
  const wipCounted = wipQuery.data?.counted ?? [];
  // 年龄随读面刷新重算:agenda/works/runtime 任一前进都给一帧新时钟,不立单独计时器。
  const now = useMemo(() => new Date().toISOString(), [agenda, works, runtimeQuery.data]);

  const decisions = useMemo(() => decisionRows(agenda), [agenda]);
  // 任务侧人签:与侧栏角标、待办签发总池同一条派生(model/attestation-pool.ts),不重推判据。
  const signoffs = useMemo(() => attestationPendingRows(deriveAttestationLanes(tasks)), [tasks]);
  const pinned = useMemo(() => pinnedTaskRows(agenda, works), [agenda, works]);
  // 置顶的非任务实体(Decision、Schedule…):同一读面派生,行上走实体级解 pin 通道。
  const pinnedOthers = useMemo(() => pinnedEntityRows(agenda), [agenda]);
  // 关注的活动窗口:天数走设置项,读面落定前的 undefined 用声明默认,不猜。
  const settingsQuery = useSettingsQuery(repoId);
  const activityDays = useMemo(() => {
    const value = settingsQuery.data?.values.overviewWatchedActivityDays;
    return typeof value === "number" && Number.isSafeInteger(value) && value >= 1
      ? value
      : WATCHED_ACTIVITY_DAYS_DEFAULT;
  }, [settingsQuery.data]);
  const { watched, pinnedClosed } = useMemo(
    () => watchedWorks(works, agenda, { days: activityDays, now }, runtimeQuery.data),
    [works, agenda, activityDays, now, runtimeQuery.data],
  );
  const recentDays = useMemo(
    () =>
      recentDayGroups({
        events: eventsQuery.data ?? [],
        titles,
        dateKeyOf: (iso) => dayKeyOf(iso),
      }),
    [eventsQuery.data, titles],
  );
  const recentByWork = useMemo(
    () => new Map(watchedRecentPaths(recentDays, watched).map((path) => [path.workTaskId, path] as const)),
    [recentDays, watched],
  );
  // 「在跑的任务」的数据(2026-10-21 定案):泳道块模型(agentLanesOf)是唯一派生——
  // 总览的窄行名单与任务弹层/现场页的泳道是同一份块模型的两个视图;成员派工页同时给
  // 出模型短标签。nowMs 用数据时钟(读面前进才重算,时长相新不随秒针生长)。
  const taskTitlesById = useMemo(
    () => new Map([...titles].map(([ref, title]) => [ref.replace(/^task\//u, ""), title] as const)),
    [titles],
  );
  const awaitsOfTask = useMemo(() => awaitsByTask(agenda), [agenda]);
  const agentGroupsQuery = useOverviewAgentGroups(repoId);
  const activeAgents = useMemo(
    () => activeAgentIdsOf(agentGroupsQuery.data?.groups ?? [], awaitsOfTask),
    [agentGroupsQuery.data, awaitsOfTask],
  );
  const memberPages = useOverviewAgentMemberPages(repoId, activeAgents);
  const lanesNowMs = Date.parse(now);
  const lanesModel = useMemo(
    () =>
      agentLanesOf({
        groups: agentGroupsQuery.data?.groups ?? [],
        memberPages,
        taskTitles: taskTitlesById,
        awaits: awaitsOfTask,
        awaitingFallbackQuestion: t("views.overviewView.drillLanesAwaitingFallback"),
        nowMs: lanesNowMs,
      }),
    [agentGroupsQuery.data, memberPages, taskTitlesById, awaitsOfTask, lanesNowMs],
  );
  const modelOfBlock = useMemo(() => {
    // 模型短标签的收短点(runtimeModelShortLabel):候选清单只给第一个候选加 +N,
    // 元组字符串不进正文(2026-10-21 CEO 截图补充的缺陷)。
    const models = new Map<string, string | null>();
    for (const page of memberPages.values())
      for (const row of page.rows) models.set(row.dispatchId, runtimeModelShortLabel(row.provider?.model));
    return models;
  }, [memberPages]);
  const runningRows = useMemo(() => runningTaskRows(lanesModel, modelOfBlock), [lanesModel, modelOfBlock]);

  const workTitleOf = useMemo(
    () => new Map((works?.works ?? []).map((work) => [work.taskId, work.title] as const)),
    [works],
  );

  const deps: OverviewBoardDeps = {
    now,
    workTitleOf,
    onAnswer: setPanel,
    onNavigateEntity,
    onOpenTask,
    onOpenWorks,
    onOpenTasks,
    onOpenSessions,
    onOpenSignoffs,
    onOpenPool,
    onUnpin,
    onUnpinEntity,
  };

  // 卡点行的「答复」:有未决 awaits 源行才给动作(一等动作,开答复面板);blocked 但没有
  // awaits 边的行不给假入口,行点击直接进任务详情(裁决/查看上下文)。
  const resolveOf = (row: { readonly id: string; readonly awaiting: string | null }) => {
    if (row.awaiting === null) return null;
    const source = lanesModel.blockOf.get(row.id);
    const awaitsRow = source === undefined ? undefined : awaitsOfTask.get(source.taskId);
    return awaitsRow === undefined ? null : () => deps.onAnswer({ mode: "answer", row: awaitsRow });
  };

  const quietLine = health.daemon.state === "responsive" && (health.projection.lag ?? 0) <= 0;

  const worksTag =
    watched.length === 0 ? null : watched.some(({ source }) => source === "pinned") ? (
      <StatusTag
        tone="plan"
        label={t("views.overviewView.worksSourcePinned", {
          count: String(watched.filter(({ source }) => source === "pinned").length),
        })}
      />
    ) : (
      <StatusTag tone="neutral" label={t("views.overviewView.worksSourceRecent", { days: String(activityDays) })} />
    );

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden" data-testid="overview-view">
      <header data-testid="overview-topbar" className="flex flex-none flex-wrap items-center gap-1.5 px-3 pb-2 pt-2">
        {/* 异常提升:daemon 无响应 / 投影落后;正常状态收进弱化小字。 */}
        {health.daemon.state === "unresponsive" && (
          <StatusPill tone="bad">{t("views.overviewView.topDaemonDown")}</StatusPill>
        )}
        {collaboration !== null && collaboration !== undefined && onOpenCollaboration !== undefined && (
          <button
            type="button"
            data-testid="overview-collaboration-entry"
            onClick={onOpenCollaboration}
            className="glass flex h-6 shrink-0 items-center gap-1.5 rounded-xs px-2.5 text-text-muted ui-meta hover:text-text"
          >
            <span className="size-[7px] shrink-0 rounded-full bg-accent" aria-hidden="true" />
            {/* 只报总数:顶栏已有「进行中」(任务生命周期)与「进行中占用」(WIP)两个
                同词计数,再放一个按 lease phase 算的「执行中」就是同一个词指两件事
                (X4);协作页自己去解释舰队执行面。 */}
            {t("views.overviewView.collaborationEntry", { total: String(collaboration.total) })}
          </button>
        )}
        {(health.projection.lag ?? 0) > 0 && (
          <StatusPill tone="warn">
            {t("views.overviewView.topProjectionLag", { lag: String(health.projection.lag) })}
          </StatusPill>
        )}
        {quietLine && (
          <span className="min-w-0 truncate font-mono ui-micro text-text-faint">
            {t("views.overviewView.topQuiet", {
              agents: String(runRows(runtimeQuery.data, undefined).length),
              active: String(workspaceSummary.tasks.byStatus.active ?? 0),
            })}
            {wipQuery.data !== undefined &&
              ` · ${t("views.overviewView.topWipSummary", {
                count: String(wipCounted.length),
                limit: String(wipQuery.data.limit),
              })}`}
          </span>
        )}
        {agenda?.status === "pending" && (
          <span className="font-mono ui-micro text-text-faint">
            {t("views.overviewView.decisionTilesCatchingUp", { revision: String(agenda.sourceRevision) })}
          </span>
        )}
        <button
          type="button"
          data-testid="overview-global-search"
          onClick={onOpenSearch}
          className="ml-auto flex h-6 w-[300px] shrink-0 items-center rounded-xs border border-border bg-bg/30 px-2.5 text-left text-text-faint ui-meta hover:border-border-strong"
        >
          {t("views.overviewView.searchPlaceholder")}
          <span className="ml-auto font-mono ui-micro">⌘K</span>
        </button>
      </header>

      {/* 四块(2026-10-21 定案):左列上「在跑的任务」下「关注的工作」,右列上「置顶与
          议程」下「等你处理的事」;计数并进区域头小字,区域头不再放孤立的大号数字。 */}
      <div className="flex min-h-0 flex-1 flex-col gap-1 p-1" data-testid="overview-scroll">
        <PageRegions
          connectionId={connectionId}
          repoId={repoId}
          slot="overview"
          testId="overview-board"
          defaultRatio={0.6}
          settled={
            // 区域集就绪声明(恢复协调用,不定时猜测):本页读面全部落定后,区域集合才是
            // 完整事实,快照恢复的剪枝才不会把「还没到的区域」提前删掉。
            agenda !== undefined &&
            works !== undefined &&
            !runtimeQuery.isPending &&
            !eventsQuery.isPending &&
            !wipQuery.isPending &&
            !agentGroupsQuery.isPending
          }
          columns={[
            ["running", "works"],
            ["pins", "awaits"],
          ]}
          regions={[
            {
              id: "running",
              title: t("views.overviewView.regionRunning"),
              weight: 2,
              testId: "overview-region-running",
              content: (
                <div className="grid min-h-0 min-w-0">
                  <Region
                    title={t("views.overviewView.regionRunning")}
                    tag={
                      <span className="font-mono tabular-nums text-text-faint ui-meta">
                        {agentGroupsQuery.isPending ? "…" : agentGroupsQuery.isError ? "—" : String(runningRows.length)}
                      </span>
                    }
                    footer={
                      // 全量入口收在页脚:名单在区内滚动,入口保持可达(不随列表滚走)。
                      <>
                        <button
                          type="button"
                          data-testid="overview-running-all-tasks"
                          onClick={onOpenTasks}
                          className="text-accent underline-offset-2 hover:underline"
                        >
                          {t("views.overviewView.drillAllTasks")}
                        </button>
                        <button
                          type="button"
                          data-testid="overview-running-sessions"
                          onClick={onOpenSessions}
                          className="text-accent underline-offset-2 hover:underline"
                        >
                          {t("views.overviewView.actionOpenSessions")}
                        </button>
                      </>
                    }
                  >
                    <OverviewRunningBody
                      rows={runningRows}
                      loading={agentGroupsQuery.isPending}
                      error={agentGroupsQuery.error instanceof Error ? agentGroupsQuery.error.message : null}
                      nowMs={lanesNowMs}
                      resolveOf={resolveOf}
                      onOpenTask={onOpenTask}
                    />
                  </Region>
                </div>
              ),
            },
            {
              id: "pins",
              title: t("views.overviewView.regionPins"),
              weight: 2,
              testId: "overview-region-pins",
              content: (
                <div className="grid min-h-0 min-w-0">
                  <Region
                    title={t("views.overviewView.regionPins")}
                    tag={
                      <span className="font-mono tabular-nums text-text-faint ui-meta">
                        {agenda === undefined ? "…" : String(pinned.length + pinnedOthers.length)}
                      </span>
                    }
                  >
                    <OverviewPinsBody pinned={pinned} pinnedOthers={pinnedOthers} onOpenTask={onOpenTask} deps={deps} />
                  </Region>
                </div>
              ),
            },
            {
              id: "works",
              title: t("views.overviewView.regionWatched"),
              weight: 3,
              testId: "overview-region-works",
              content: (
                <div className="grid min-h-0 min-w-0">
                  <Region
                    title={t("views.overviewView.regionWatched")}
                    tag={
                      <>
                        {worksTag}
                        <span className="font-mono tabular-nums text-text-faint ui-meta"> · {watched.length}</span>
                      </>
                    }
                    footer={
                      <>
                        <span>{t("views.overviewView.worksFooterWatched", { days: String(activityDays) })}</span>
                        <button
                          type="button"
                          data-testid="overview-works-all"
                          onClick={deps.onOpenWorks}
                          className="text-accent underline-offset-2 hover:underline"
                        >
                          {t("views.overviewView.drillAllWorks")}
                        </button>
                      </>
                    }
                  >
                    <OverviewWorksBody
                      watched={watched}
                      pinnedClosed={pinnedClosed}
                      activityDays={activityDays}
                      handlersOf={(entry) => workHandlers(runtimeQuery.data, entry.work.taskId, entry.memberTaskIds)}
                      recentOf={(workTaskId) => recentByWork.get(workTaskId) ?? null}
                      deps={deps}
                    />
                  </Region>
                </div>
              ),
            },
            {
              id: "awaits",
              title: t("views.overviewView.regionAwaits"),
              weight: 3,
              testId: "overview-region-awaits",
              content: (
                <div className="grid min-h-0 min-w-0">
                  <Region
                    title={t("views.overviewView.regionAwaits")}
                    tag={
                      <StatusTag
                        tone={decisions.some(({ kind }) => kind === "awaiting-you") ? "agent-question" : "wait"}
                        label={
                          // 数的是块里列出的两类(本人决策 + 人签),与行数一致;总池里没列出的
                          // 其余待办由块内「待裁池」指针带条数说明,不混进这个数。
                          decisionsUrgentCount(decisions) > 0
                            ? t("views.overviewView.mineUrgentOf", {
                                urgent: String(decisionsUrgentCount(decisions)),
                                count: String(decisions.length + signoffs.length),
                              })
                            : t("views.overviewView.decisionsPendingCount", {
                                count: String(decisions.length + signoffs.length),
                              })
                        }
                      />
                    }
                  >
                    <OverviewAwaitsBody
                      rows={decisions}
                      signoffs={signoffs}
                      decisionInboxCount={workspaceSummary.decisions.inboxCount}
                      deps={deps}
                    />
                  </Region>
                </div>
              ),
            },
          ]}
        />
      </div>

      {panel ? (
        <AwaitsAnswerPanel
          repoId={repoId}
          subject={panel}
          onClose={() => setPanel(null)}
          onNavigateEntity={(ref) => {
            setPanel(null);
            onNavigateEntity(ref);
          }}
        />
      ) : null}
    </div>
  );
}

/** 顶栏异常状态点(原型 .pill):状态点 + 文案;状态色只引 token 类,不写数值。 */
function StatusPill({
  tone = "ok",
  children,
}: {
  readonly tone?: "ok" | "warn" | "bad";
  readonly children: ReactNode;
}) {
  const dot =
    tone === "bad"
      ? "bg-status-blocked shadow-[0_0_8px_var(--color-status-blocked)]"
      : tone === "warn"
        ? "bg-status-submitted"
        : "bg-status-done shadow-[0_0_8px_var(--color-status-done)]";
  return (
    <span className="glass flex h-6 shrink-0 items-center gap-1.5 rounded-xs px-2.5 text-text-muted ui-meta">
      <span className={`size-[7px] shrink-0 rounded-full ${dot}`} aria-hidden="true" />
      {children}
    </span>
  );
}
