import { useMemo, useState, type ReactNode } from "react";
import type { WorkIndexRead, WorkspaceSummaryRead } from "../../api/renderer-dto.ts";
import type { AgendaSuccess } from "../api-client.ts";
import { AwaitsAnswerPanel } from "../components/AwaitsAnswerPanel.tsx";
import { FocusLayer } from "../components/primitives/FocusLayer";
import { PageRegions } from "../components/primitives/page-regions.tsx";
import { Region } from "../components/primitives/Region";
import { StatusTag } from "../components/primitives/StatusTag";
import type { AppLocation, OverviewFocusLocation } from "../navigation/viewHistory.ts";
import type { AwaitsPanelSubject } from "../awaits-answer.ts";
import { useOverviewArtifacts, useOverviewCi, useOverviewRecentEvents, useOverviewRuntime } from "../overview-data.ts";
import { useSettingsQuery } from "../settings-data.ts";
import { useTaskWipQuery } from "../task-data.ts";
import type { RuntimeHealth } from "../model/runtime-health.ts";
import { t } from "../i18n/index.tsx";
import { dayKeyOf } from "../model/time.ts";
import {
  attentionSources,
  decisionRows,
  drillWipRows,
  followUpRows,
  pinnedTaskRows,
  recentDayGroups,
  reviewRows,
  runRows,
  watchedRecentPaths,
  watchedWorks,
  workHandlers,
  WATCHED_ACTIVITY_DAYS_DEFAULT,
} from "./overview-model.ts";
import { OverviewArtifactsPage, OverviewArtifactsShelf, artifactRowKey } from "./overview-artifacts.tsx";
import {
  FollowUpsFocusDetail,
  FollowUpsFocusList,
  OverviewDecisionsBand,
  OverviewDrillBody,
  OverviewWorksBody,
  PinnedFocusDetail,
  PinnedFocusList,
  ReviewFocusDetail,
  ReviewFocusList,
  reviewDrillRows,
  WipFocusDetail,
  WipFocusList,
  type DrillFocusKey,
  type OverviewBoardDeps,
} from "./overview-regions.tsx";
import { CiFocusDetail, CiFocusList } from "./overview-ci.tsx";
import { wipVisibleEntries, type WipFilter } from "./OverviewTaskWip.tsx";

/**
 * 总览(2026-10-11 业主意见返工):页面顶部仍是紧凑决策带(计数并入标签)。首屏主体
 * 左列上格是「执行与下钻」(放左上角;「进行中的任务」行并进原在飞任务流的执行者与
 * 最近活动信息,「在飞任务」区块已删除),下格是最新 HTML 产物速览架;右列是关注的工作
 * (默认列最近 N 天内有活动的工作,N 是设置项「关注的工作活动天数」,置顶工作保留在
 * 前;行内给进度、进行中子任务数、最近活动与等你处理数)。点产物行或「查看全部」进
 * 接近全屏的产物二级页:左窄列表、右大预览、默认选中最新;二级页与各名单的放大层都
 * 走全局导航历史(开层推栈、后退回原位)。系统状态弱化成一行小字。
 * 数据全部来自已挂载读面,页面不另发第二套请求;区域板沿用 PageRegions。
 */
export function OverviewView({
  repoId,
  connectionId,
  agenda,
  works,
  titles,
  workspaceSummary,
  health,
  collaboration,
  onNavigateEntity,
  onOpenTask,
  onOpenSearch,
  onOpenSessions,
  onOpenWorks,
  onOpenTasks,
  onOpenCollaboration,
  onUnpin,
  overviewLayer,
  onOverviewLayerNavigate,
  onOverviewLayerPatch,
  onOverviewLayerClose,
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
  /** 工作行与任务行的落点:App 按「根任务即工作」分流到工作页或任务详情;产物二级页
   *  「跳到所属 task」额外带该产物的包内相对路径,任务详情直接选中该文档。 */
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
  /** 取消置顶(pin 写通道,taskActions.setTaskPin)。 */
  readonly onUnpin: (taskId: string) => void;
  /** 总览页内层位置(AppLocation 的总览层字段子集,App 从 location 派生):null = 层关着。 */
  readonly overviewLayer: {
    readonly overviewArtifactId: string | null;
    readonly overviewFocus: OverviewFocusLocation | null;
  };
  /** 开层/换层(导航性):推栈,后退回到开层前的位置。 */
  readonly onOverviewLayerNavigate: (
    fields: Partial<Pick<AppLocation, "overviewArtifactId" | "overviewFocus">>,
  ) => void;
  /** 层内精修(换选中行):原地改当前位置,不占历史条目。 */
  readonly onOverviewLayerPatch: (fields: Partial<Pick<AppLocation, "overviewArtifactId" | "overviewFocus">>) => void;
  /** 关层:能退则弹栈回上一位置,栈底(会话恢复的孤立层条目)原地收层。 */
  readonly onOverviewLayerClose: (fields: Partial<Pick<AppLocation, "overviewArtifactId" | "overviewFocus">>) => void;
}) {
  const [panel, setPanel] = useState<AwaitsPanelSubject | null>(null);
  // 放大层与产物二级页的开关/选中都在全局导航历史(AppLocation 的总览层字段):
  // 开层推栈、层内换选中原地改、关层弹栈——原地 useState 会让后退失灵(业主
  // 2026-10-11 全局导航返工)。焦点键与选中行从层位置派生,不再各持一份。
  const focus = overviewLayer.overviewFocus?.key ?? null;
  const layerSelectedId = overviewLayer.overviewFocus?.selectedId ?? null;
  const artifactFocus = overviewLayer.overviewArtifactId;
  const [fetchCiDetails, setFetchCiDetails] = useState(false);
  const ciQuery = useOverviewCi(repoId, fetchCiDetails);
  const runtimeQuery = useOverviewRuntime(repoId);
  const eventsQuery = useOverviewRecentEvents(repoId);
  const artifactsQuery = useOverviewArtifacts(repoId);
  // WIP 与看板共用同一条 repo.tasks.wip 读面(同一 query key,一处缓存):总览挂载期间
  // 本实例是观察者,台账切面前进由既有失效扇出更新,不建第二份快照。
  const wipQuery = useTaskWipQuery(repoId, true);
  const wipErrorText = wipQuery.error instanceof Error ? wipQuery.error.message : null;
  const artifactsErrorText = artifactsQuery.error instanceof Error ? artifactsQuery.error.message : null;
  // WIP 放大层的分组/搜索过滤态放在这里:FocusLayer 的 ↑↓ 只在可见集合里移动,itemIds
  // 与名单渲染必须出自同一份 wipVisibleEntries,组件内部各持一份会各自漂移。
  const [wipFilter, setWipFilter] = useState<WipFilter>({ group: "all", search: "" });
  // 年龄随读面刷新重算:agenda/works/ci 任一前进都给一帧新时钟,不立单独计时器。
  const now = useMemo(() => new Date().toISOString(), [agenda, works, ciQuery.data, runtimeQuery.data]);

  const workTitleOf = useMemo(
    () => new Map((works?.works ?? []).map((work) => [work.taskId, work.title] as const)),
    [works],
  );
  const decisions = useMemo(() => decisionRows(agenda), [agenda]);
  const followUps = useMemo(() => followUpRows(agenda), [agenda]);
  const reviews = useMemo(() => reviewRows(agenda), [agenda]);
  const reviewDrill = useMemo(() => reviewDrillRows(reviews), [reviews]);
  const pinned = useMemo(() => pinnedTaskRows(agenda, works), [agenda, works]);
  // 关注的活动窗口(意见 4):天数走设置项,读面落定前的 undefined 用声明默认,不猜。
  const settingsQuery = useSettingsQuery(repoId);
  const activityDays = useMemo(() => {
    const value = settingsQuery.data?.values.overviewWatchedActivityDays;
    return typeof value === "number" && Number.isSafeInteger(value) && value >= 1
      ? value
      : WATCHED_ACTIVITY_DAYS_DEFAULT;
  }, [settingsQuery.data]);
  const { watched, pinnedClosed } = useMemo(
    () => watchedWorks(works, agenda, { days: activityDays, now }),
    [works, agenda, activityDays, now],
  );
  // 卡点行接回源行的映射(一次构建,attentionOf 逐项查;行上动作需要源读面的完整行)。
  const attentionSourceMap = useMemo(() => (agenda === undefined ? null : attentionSources(agenda)), [agenda]);
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
  const ciRuns = ciQuery.data?.runs ?? [];
  const failing = ciRuns.filter((run) => run.branch === "main" && run.pass === false);
  const wipCounted = wipQuery.data?.counted ?? [];
  const wipFull = wipQuery.data !== undefined && wipCounted.length >= wipQuery.data.limit;
  // 「执行与下钻 → 进行中的任务」的内联名单(注意力分降序;行内含执行者与最近活动)。
  const drillWip = useMemo(
    () => drillWipRows(wipQuery.data, runtimeQuery.data, agenda),
    [wipQuery.data, runtimeQuery.data, agenda],
  );
  // 产物二级页:列表 = 全部产物行(不只架上的 6 条),打开时收敛到首个存在的键
  // (daemon 已按时间倒序给出,首个即最新——意见 1 的「默认选中最新一个产物」)。
  const artifactRows = artifactsQuery.data?.artifacts ?? [];
  const artifactKeys = useMemo(() => artifactRows.map(artifactRowKey), [artifactsQuery.data]);
  const artifactSelected =
    artifactFocus !== null && artifactKeys.includes(artifactFocus)
      ? artifactFocus
      : artifactFocus !== null
        ? (artifactKeys[0] ?? null)
        : null;

  const deps: OverviewBoardDeps = {
    now,
    workTitleOf,
    // 答复卡点:收放大层(能退则弹栈)再开答复面板;其余导航直接透传——推栈后层留在
    // 原条目里,后退自然回到带着层的总览,不需要(也不应该)先把层就地清掉。
    onAnswer: (subject) => {
      onOverviewLayerClose({ overviewFocus: null });
      setPanel(subject);
    },
    onNavigateEntity,
    onOpenTask,
    onOpenWorks,
    onOpenTasks,
    onOpenSessions,
    onUnpin,
  };

  // 点行开层(推栈):内联名单把被点的行直接带成放大层的选中(id 不在集合时由层收敛到首行)。
  const openFocus = (key: DrillFocusKey, selectedId?: string) => {
    // WIP 层的可见集合出自 wipFilter:上次遗留的分组/搜索会把被点行滤出集合,选中被
    // focusSelected 复算回首行、详情显示错任务——进入即重置,被点行必然可见且被选中。
    if (selectedId !== undefined && key === "wip") setWipFilter({ group: "all", search: "" });
    onOverviewLayerNavigate({ overviewFocus: { key, selectedId: selectedId ?? null } });
  };

  // 键盘导航的可选中集合:WIP 用当前过滤后的可见名单(过滤隐藏的行不可被 ↑↓ 选中),
  // 其余入口用各自全量行;选中行不在集合时收敛到首行,详情与选中同源。
  const focusIds: readonly string[] =
    focus === null
      ? []
      : focus === "wip"
        ? wipVisibleEntries(wipQuery.data?.counted, wipFilter).map(({ taskId }) => taskId)
        : focus === "review"
          ? reviewDrill.map(({ id }) => id)
          : focus === "followups"
            ? followUps.map(({ id }) => id)
            : focus === "pinned"
              ? pinned.map(({ taskId }) => taskId)
              : ciRuns.map(({ eventId }) => eventId);
  const focusSelected =
    focus === null ? null : focusIds.includes(layerSelectedId ?? "") ? layerSelectedId! : (focusIds[0] ?? null);

  const quietLine =
    health.daemon.state === "responsive" &&
    failing.length === 0 &&
    !ciQuery.isError &&
    (health.projection.lag ?? 0) <= 0;

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
        {/* 异常提升:daemon 无响应 / main CI 红(可点开失败名单)/ 投影落后;正常状态收进弱化小字。 */}
        {health.daemon.state === "unresponsive" && (
          <StatusPill tone="bad">{t("views.overviewView.topDaemonDown")}</StatusPill>
        )}
        <button
          type="button"
          data-testid="overview-ci-alert"
          onClick={() => openFocus("ci")}
          className="glass flex h-6 shrink-0 items-center gap-1.5 rounded-xs px-2.5 text-text-muted ui-meta hover:text-text"
        >
          {t("views.overviewView.regionCi")} ·{" "}
          {failing.length > 0
            ? t("views.overviewView.topCiRedCount", { count: failing.length })
            : t(
                ciQuery.isError || ciQuery.data === undefined || ciQuery.data.status === "pending"
                  ? "views.ci.unknown"
                  : "views.ci.inspect",
              )}
        </button>
        {collaboration !== null && collaboration !== undefined && onOpenCollaboration !== undefined && (
          <button
            type="button"
            data-testid="overview-collaboration-entry"
            onClick={onOpenCollaboration}
            className="glass flex h-6 shrink-0 items-center gap-1.5 rounded-xs px-2.5 text-text-muted ui-meta hover:text-text"
          >
            <span className="size-[7px] shrink-0 rounded-full bg-accent" aria-hidden="true" />
            {t("views.overviewView.collaborationEntry", {
              total: String(collaboration.total),
              executing: String(collaboration.executing),
            })}
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

      {/* 双列信息密度(2026-10-11 返工):紧凑决策带仍是内容定高的普通条(不进区域板);
          左列上格是「执行与下钻」(左上角),下格最新产物速览架,右列是关注的工作。
          计数并进标题小字(意见 2),区域头不再放孤立的大号数字。 */}
      <div className="flex min-h-0 flex-1 flex-col gap-1 p-1" data-testid="overview-scroll">
        <OverviewDecisionsBand rows={decisions} deps={deps} />
        <PageRegions
          connectionId={connectionId}
          repoId={repoId}
          slot="overview"
          testId="overview-board"
          defaultRatio={0.38}
          settled={
            // 区域集就绪声明(恢复协调用,不定时猜测):本页读面全部落定后,区域集合才是
            // 完整事实,快照恢复的剪枝才不会把「还没到的区域」提前删掉。
            agenda !== undefined &&
            works !== undefined &&
            !ciQuery.isPending &&
            !runtimeQuery.isPending &&
            !eventsQuery.isPending &&
            !wipQuery.isPending &&
            !artifactsQuery.isPending
          }
          columns={[["drill", "artifacts"], ["works"]]}
          regions={[
            {
              id: "drill",
              title: t("views.overviewView.regionDrill"),
              weight: 3,
              testId: "overview-region-drill",
              content: (
                <div className="grid min-h-0 min-w-0">
                  <Region
                    title={t("views.overviewView.regionDrill")}
                    footer={
                      // 全量入口收在页脚:名单在区内滚动,入口保持可达(不随列表滚走)。
                      <>
                        <button
                          type="button"
                          data-testid="overview-drill-all-works"
                          onClick={deps.onOpenWorks}
                          className="text-accent underline-offset-2 hover:underline"
                        >
                          {t("views.overviewView.drillAllWorks")}
                        </button>
                        <button
                          type="button"
                          data-testid="overview-drill-all-tasks"
                          onClick={deps.onOpenTasks}
                          className="text-accent underline-offset-2 hover:underline"
                        >
                          {t("views.overviewView.drillAllTasks")}
                        </button>
                        <button
                          type="button"
                          data-testid="overview-drill-sessions"
                          onClick={deps.onOpenSessions}
                          className="text-accent underline-offset-2 hover:underline"
                        >
                          {t("views.overviewView.actionOpenSessions")}
                        </button>
                      </>
                    }
                  >
                    <OverviewDrillBody
                      wipRows={drillWip}
                      wipOccupancy={
                        wipQuery.data === undefined
                          ? wipErrorText !== null
                            ? "—"
                            : "…"
                          : `${wipCounted.length}/${wipQuery.data.limit}`
                      }
                      wipFull={wipFull}
                      wipLoading={wipQuery.isPending}
                      wipError={wipErrorText}
                      reviewRowsAll={reviews}
                      followUps={followUps}
                      pinned={pinned}
                      onOpenFocus={openFocus}
                      onOpenTask={onOpenTask}
                      deps={deps}
                    />
                  </Region>
                </div>
              ),
            },
            {
              id: "artifacts",
              title: t("views.overviewView.regionArtifacts"),
              weight: 2,
              testId: "overview-region-artifacts",
              content: (
                <div className="grid min-h-0 min-w-0">
                  <Region
                    title={t("views.overviewView.regionArtifacts")}
                    tag={
                      <span className="font-mono tabular-nums text-text-faint ui-meta">
                        {artifactsQuery.data === undefined
                          ? artifactsErrorText !== null
                            ? "—"
                            : "…"
                          : t("views.overviewView.regionCountOf", {
                              count: String(artifactsQuery.data.counts.html),
                            })}
                      </span>
                    }
                    footer={
                      <>
                        {artifactsQuery.data !== undefined && (
                          <span className="min-w-0 truncate">
                            {t("views.overviewView.artifactsShelfNote", {
                              shown: String(Math.min(artifactsQuery.data.artifacts.length, 6)),
                              total: String(artifactsQuery.data.counts.html),
                            })}
                          </span>
                        )}
                        <button
                          type="button"
                          data-testid="overview-artifacts-open-all"
                          onClick={() => onOverviewLayerNavigate({ overviewArtifactId: artifactKeys[0] ?? "" })}
                          className="text-accent underline-offset-2 hover:underline"
                        >
                          {t("views.overviewView.artifactsOpenPage")}
                        </button>
                      </>
                    }
                  >
                    <OverviewArtifactsShelf
                      repoId={repoId}
                      rows={artifactsQuery.data?.artifacts ?? []}
                      pending={artifactsQuery.isPending}
                      error={artifactsErrorText}
                      onOpenArtifact={(row) => onOverviewLayerNavigate({ overviewArtifactId: artifactRowKey(row) })}
                    />
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
                    footer={t("views.overviewView.worksFooterWatched", { days: String(activityDays) })}
                  >
                    <OverviewWorksBody
                      watched={watched}
                      pinnedClosed={pinnedClosed}
                      activityDays={activityDays}
                      attentionOf={(workTaskId) =>
                        (agenda?.attentionItems ?? [])
                          .filter((item) => item.workTaskId === workTaskId)
                          .map((item) => ({ item, source: attentionSourceMap?.get(item.ref) ?? null }))
                      }
                      handlersOf={(entry) => workHandlers(runtimeQuery.data, entry.work.taskId, entry.memberTaskIds)}
                      recentOf={(workTaskId) => recentByWork.get(workTaskId) ?? null}
                      deps={deps}
                    />
                  </Region>
                </div>
              ),
            },
          ]}
        />
      </div>

      {focus === "wip" && (
        <FocusLayer
          open
          title={t("views.overviewTaskWip.title")}
          tag={wipFull ? <StatusTag tone="bad" label={t("views.overviewTaskWip.fullTag")} /> : undefined}
          big={
            wipQuery.data === undefined
              ? wipErrorText !== null
                ? "—"
                : "…"
              : `${wipCounted.length}/${wipQuery.data.limit}`
          }
          itemIds={focusIds}
          selectedId={focusSelected}
          onSelect={(id) => onOverviewLayerPatch({ overviewFocus: { key: "wip", selectedId: id } })}
          onClose={() => onOverviewLayerClose({ overviewFocus: null })}
          list={
            <WipFocusList
              snapshot={wipQuery.data}
              loading={wipQuery.isPending}
              error={wipErrorText}
              selectedId={focusSelected}
              onSelect={(id) => onOverviewLayerPatch({ overviewFocus: { key: "wip", selectedId: id } })}
              onOpenTask={onOpenTask}
              filter={wipFilter}
              onFilterChange={setWipFilter}
            />
          }
          detail={
            wipQuery.data !== undefined && focusSelected !== null ? (
              <WipFocusDetail
                entry={
                  wipQuery.data.counted.find(({ taskId }) => taskId === focusSelected) ?? wipQuery.data.counted[0]!
                }
                wip={wipQuery.data}
                onOpenTask={onOpenTask}
              />
            ) : (
              <p className="ui-meta text-text-faint">{wipErrorText ?? t("views.overviewTaskWip.loading")}</p>
            )
          }
        />
      )}
      {focus === "review" && (
        <FocusLayer
          open
          title={t("views.overviewView.drillReview")}
          tag={<StatusTag tone="wait" label={t("views.overviewView.reviewInFlight", { count: reviewDrill.length })} />}
          big={reviewDrill.length}
          itemIds={focusIds}
          selectedId={focusSelected}
          onSelect={(id) => onOverviewLayerPatch({ overviewFocus: { key: "review", selectedId: id } })}
          onClose={() => onOverviewLayerClose({ overviewFocus: null })}
          list={
            <ReviewFocusList
              rows={reviewDrill}
              selectedId={focusSelected}
              onSelect={(id) => onOverviewLayerPatch({ overviewFocus: { key: "review", selectedId: id } })}
              deps={deps}
            />
          }
          detail={
            focusSelected === null ? null : (
              <ReviewFocusDetail row={reviewDrill.find(({ id }) => id === focusSelected)!} deps={deps} />
            )
          }
        />
      )}
      {focus === "followups" && (
        <FocusLayer
          open
          title={t("views.overviewView.drillFollowUps")}
          tag={<StatusTag tone="neutral" label={t("views.overviewView.followTotalTag", { count: followUps.length })} />}
          big={followUps.length}
          itemIds={focusIds}
          selectedId={focusSelected}
          onSelect={(id) => onOverviewLayerPatch({ overviewFocus: { key: "followups", selectedId: id } })}
          onClose={() => onOverviewLayerClose({ overviewFocus: null })}
          list={
            <FollowUpsFocusList
              rows={followUps}
              selectedId={focusSelected}
              onSelect={(id) => onOverviewLayerPatch({ overviewFocus: { key: "followups", selectedId: id } })}
              deps={deps}
            />
          }
          detail={
            focusSelected === null ? null : (
              <FollowUpsFocusDetail row={followUps.find(({ id }) => id === focusSelected)!} deps={deps} />
            )
          }
        />
      )}
      {focus === "pinned" && (
        <FocusLayer
          open
          title={t("views.overviewView.regionQueue")}
          tag={
            pinned.some(({ dispatchable }) => dispatchable) ? (
              <StatusTag tone="plan" label={t("views.overviewView.queueTag")} />
            ) : (
              <StatusTag tone="neutral" label={t("views.overviewView.queueNoDispatchable")} />
            )
          }
          big={pinned.length}
          itemIds={focusIds}
          selectedId={focusSelected}
          onSelect={(id) => onOverviewLayerPatch({ overviewFocus: { key: "pinned", selectedId: id } })}
          onClose={() => onOverviewLayerClose({ overviewFocus: null })}
          list={
            <PinnedFocusList
              rows={pinned}
              selectedId={focusSelected}
              onSelect={(id) => onOverviewLayerPatch({ overviewFocus: { key: "pinned", selectedId: id } })}
              deps={deps}
            />
          }
          detail={
            focusSelected === null ? null : (
              <PinnedFocusDetail task={pinned.find(({ taskId }) => taskId === focusSelected)!} deps={deps} />
            )
          }
        />
      )}
      {focus === "ci" && (
        <FocusLayer
          open
          title={t("views.overviewView.regionCi")}
          emphasis="detail"
          tag={<StatusTag tone="neutral" label={ciQuery.data?.statisticsAvailability ?? "pending"} />}
          big={ciRuns.length}
          itemIds={focusIds}
          selectedId={focusSelected}
          onSelect={(id) => onOverviewLayerPatch({ overviewFocus: { key: "ci", selectedId: id } })}
          onClose={() => onOverviewLayerClose({ overviewFocus: null })}
          list={
            <CiFocusList
              ci={ciQuery.data}
              selectedId={focusSelected}
              onSelect={(id) => onOverviewLayerPatch({ overviewFocus: { key: "ci", selectedId: id } })}
            />
          }
          detail={
            <CiFocusDetail
              ci={ciQuery.data}
              run={ciRuns.find(({ eventId }) => eventId === focusSelected)}
              error={ciQuery.error?.message ?? null}
              fetching={ciQuery.isFetching}
              onFetch={() => {
                if (fetchCiDetails) void ciQuery.refetch();
                else setFetchCiDetails(true);
              }}
            />
          }
        />
      )}

      {/* 产物二级页面(2026-10-11 意见 1):接近全屏,左窄列表、右大预览,默认选中最新
          一条(daemon 倒序首行);开层/换选中/关层走全局历史(开层推栈、层内换选中原地
          改、关层弹栈)。「跳到所属 task」保留 task_15b1bb96 的落点并直接推栈——后退
          回到带着产物页的总览位置。 */}
      {artifactFocus !== null && (
        <OverviewArtifactsPage
          open
          repoId={repoId}
          rows={artifactRows}
          total={artifactsQuery.data?.counts.html ?? artifactRows.length}
          selectedId={artifactSelected}
          onSelect={(key) => onOverviewLayerPatch({ overviewArtifactId: key })}
          onClose={() => onOverviewLayerClose({ overviewArtifactId: null })}
          onOpenTask={(taskId, docPath) => onOpenTask(taskId, docPath)}
        />
      )}

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
