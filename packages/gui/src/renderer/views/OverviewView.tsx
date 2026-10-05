import { useMemo, useState, type ReactNode } from "react";
import type { WorkIndexRead, WorkspaceSummaryRead } from "../../api/renderer-dto.ts";
import type { AgendaSuccess } from "../api-client.ts";
import { AwaitsAnswerPanel } from "../components/AwaitsAnswerPanel.tsx";
import { FocusLayer } from "../components/primitives/FocusLayer";
import { PageRegions } from "../components/primitives/page-regions.tsx";
import { Region } from "../components/primitives/Region";
import { StatusTag } from "../components/primitives/StatusTag";
import type { AwaitsPanelSubject } from "../awaits-answer.ts";
import { useOverviewArtifacts, useOverviewCi, useOverviewRecentEvents, useOverviewRuntime } from "../overview-data.ts";
import { useTaskWipQuery } from "../task-data.ts";
import type { RuntimeHealth } from "../model/runtime-health.ts";
import { t } from "../i18n/index.tsx";
import { dayKeyOf } from "../model/time.ts";
import {
  attentionSources,
  decisionRows,
  followUpRows,
  inflightTaskRows,
  mainCiFailingJobs,
  pinnedTaskRows,
  recentDayGroups,
  reviewRows,
  runRows,
  watchedRecentPaths,
  watchedWorks,
  workHandlers,
} from "./overview-model.ts";
import {
  CiFocusDetail,
  CiFocusList,
  FollowUpsFocusDetail,
  FollowUpsFocusList,
  OverviewArtifactsShelf,
  OverviewDecisionsBand,
  OverviewDrillBody,
  OverviewInflightBody,
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
import { wipVisibleEntries, type WipFilter } from "./OverviewTaskWip.tsx";

/**
 * 总览(task_8a83698 信息密度重构):页面顶部仍是紧凑决策带——只放真实要本人动手的
 * awaits 问句与待点头决策。首屏主体分两列:左列是在飞任务流(repo.tasks.wip 的
 * active/submitted/in_review 占位,执行者来自 runtime overview 的 live 会话)与最新
 * HTML 产物速览架(repo.artifacts.list,与产物页同一缓存,台账 cut 扇出刷新);右列是
 * 关注的工作(置顶非终态;零置顶回退活跃工作并给选择入口),下钻工具带回到工作列底部
 * (dec_B3D40712 的底部下钻工具条,不另立空列)。WIP/评审执行/跟进返工/置顶承诺的
 * 完整名单仍在各自放大层。系统状态弱化成一行小字,只有影响当前工作的异常(daemon 无
 * 响应、main CI 红、投影落后)才升成显眼状态点;安静行带在飞占用摘要。数据全部来自
 * 已挂载读面,页面不另发第二套请求;注意力/排序只透传 daemon 的分数与已有 Pin。区域板
 * 沿用 PageRegions(连接+仓+槽位的顺序与比例偏好照旧)。
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
  onOpenArtifacts,
  onUnpin,
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
  readonly onOpenTask: (taskId: string) => void;
  /** 顶栏全局搜索的落点:⌘K 命令面板。 */
  readonly onOpenSearch: () => void;
  readonly onOpenSessions: () => void;
  /** 「全部工作」入口的落点:工作页(选择关注/置顶也在那里)。 */
  readonly onOpenWorks: () => void;
  /** 「全部任务」入口的落点:看板。 */
  readonly onOpenTasks: () => void;
  /** 紧凑协作入口的落点(总览只给摘要与入口,分工清单在协作页)。 */
  readonly onOpenCollaboration?: () => void;
  /** 产物速览架「查看全部产物」的落点:产物页;未提供时不渲染该入口。 */
  readonly onOpenArtifacts?: () => void;
  /** 取消置顶(pin 写通道,taskActions.setTaskPin)。 */
  readonly onUnpin: (taskId: string) => void;
}) {
  const [panel, setPanel] = useState<AwaitsPanelSubject | null>(null);
  const [focus, setFocus] = useState<DrillFocusKey | null>(null);
  const [selected, setSelected] = useState<Partial<Record<DrillFocusKey, string>>>({});
  const ciQuery = useOverviewCi(repoId);
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
  const { watched, pinnedClosed } = useMemo(() => watchedWorks(works, agenda), [works, agenda]);
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
  const failing = useMemo(() => mainCiFailingJobs(ciQuery.data), [ciQuery.data]);
  const wipCounted = wipQuery.data?.counted ?? [];
  const wipFull = wipQuery.data !== undefined && wipCounted.length >= wipQuery.data.limit;
  const inflight = useMemo(
    () => inflightTaskRows(wipQuery.data, runtimeQuery.data, agenda),
    [wipQuery.data, runtimeQuery.data, agenda],
  );

  const deps: OverviewBoardDeps = {
    now,
    workTitleOf,
    onAnswer: (subject) => {
      setFocus(null);
      setPanel(subject);
    },
    onNavigateEntity: (ref) => {
      setFocus(null);
      onNavigateEntity(ref);
    },
    onOpenTask: (taskId) => {
      setFocus(null);
      onOpenTask(taskId);
    },
    onOpenWorks: () => {
      setFocus(null);
      onOpenWorks();
    },
    onOpenTasks,
    onOpenSessions,
    onUnpin,
  };

  const openFocus = (key: DrillFocusKey) => {
    setFocus(key);
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
              : failing.map(({ runId }) => runId);
  const focusSelected =
    focus === null ? null : focusIds.includes(selected[focus] ?? "") ? selected[focus]! : (focusIds[0] ?? null);

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
      <StatusTag tone="neutral" label={t("views.overviewView.worksSourceActive")} />
    );

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden" data-testid="overview-view">
      <header data-testid="overview-topbar" className="flex flex-none flex-wrap items-center gap-1.5 px-3 pb-2 pt-2">
        {/* 异常提升:daemon 无响应 / main CI 红(可点开失败名单)/ 投影落后;正常状态收进弱化小字。 */}
        {health.daemon.state === "unresponsive" && (
          <StatusPill tone="bad">{t("views.overviewView.topDaemonDown")}</StatusPill>
        )}
        {failing.length > 0 ? (
          <button
            type="button"
            data-testid="overview-ci-alert"
            onClick={() => openFocus("ci")}
            className="glass flex h-6 shrink-0 items-center gap-1.5 rounded-xs px-2.5 text-text-muted ui-meta hover:text-text"
          >
            <span
              className="size-[7px] shrink-0 rounded-full bg-status-blocked shadow-[0_0_8px_var(--color-status-blocked)]"
              aria-hidden="true"
            />
            {t("views.overviewView.topCiRedCount", { count: String(failing.length) })}
          </button>
        ) : ciQuery.isError ? (
          <StatusPill tone="warn">{t("views.overviewView.topCiUnknown")}</StatusPill>
        ) : null}
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

      {/* 双列信息密度(task_8a83698):紧凑决策带仍是内容定高的普通条(不进区域板);
          左列平铺在飞任务流 + 最新产物速览架,右列是关注的工作、下钻工具带收在其底部。 */}
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
          columns={[
            ["inflight", "artifacts"],
            ["works", "drill"],
          ]}
          regions={[
            {
              id: "inflight",
              title: t("views.overviewView.regionInflight"),
              weight: 3,
              testId: "overview-region-inflight",
              content: (
                <div className="grid min-h-0 min-w-0">
                  <Region
                    title={t("views.overviewView.regionInflight")}
                    big={wipQuery.data === undefined ? (wipErrorText !== null ? "—" : "…") : inflight.length}
                    footer={t("views.overviewView.inflightFooter")}
                  >
                    <OverviewInflightBody
                      rows={inflight}
                      loading={wipQuery.isPending}
                      error={wipErrorText}
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
                    big={
                      artifactsQuery.data === undefined
                        ? artifactsErrorText !== null
                          ? "—"
                          : "…"
                        : String(artifactsQuery.data.counts.html)
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
                        {onOpenArtifacts !== undefined && (
                          <button
                            type="button"
                            data-testid="overview-artifacts-open-all"
                            onClick={onOpenArtifacts}
                            className="text-accent underline-offset-2 hover:underline"
                          >
                            {t("views.overviewView.artifactsOpenAll")}
                          </button>
                        )}
                      </>
                    }
                  >
                    <OverviewArtifactsShelf
                      repoId={repoId}
                      rows={artifactsQuery.data?.artifacts ?? []}
                      total={artifactsQuery.data?.counts.html ?? 0}
                      pending={artifactsQuery.isPending}
                      error={artifactsErrorText}
                      onOpenTask={onOpenTask}
                      onOpenAll={onOpenArtifacts}
                      deps={deps}
                    />
                  </Region>
                </div>
              ),
            },
            {
              id: "drill",
              title: t("views.overviewView.regionDrill"),
              weight: 1,
              testId: "overview-region-drill",
              content: (
                <div className="grid min-h-0 min-w-0">
                  <Region title={t("views.overviewView.regionDrill")}>
                    <OverviewDrillBody
                      wipOccupancy={
                        wipQuery.data === undefined
                          ? wipErrorText !== null
                            ? "—"
                            : "…"
                          : `${wipCounted.length}/${wipQuery.data.limit}`
                      }
                      wipFull={wipFull}
                      reviewRowsAll={reviews}
                      followUps={followUps}
                      pinned={pinned}
                      onOpenFocus={openFocus}
                      deps={deps}
                    />
                  </Region>
                </div>
              ),
            },
            {
              id: "works",
              title: t("views.overviewView.regionWatched"),
              weight: 6,
              testId: "overview-region-works",
              content: (
                <div className="grid min-h-0 min-w-0">
                  <Region
                    title={t("views.overviewView.regionWatched")}
                    tag={worksTag ?? undefined}
                    big={watched.length}
                    footer={t("views.overviewView.worksFooterWatched")}
                  >
                    <OverviewWorksBody
                      watched={watched}
                      pinnedClosed={pinnedClosed}
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
          onSelect={(id) => setSelected((current) => ({ ...current, wip: id }))}
          onClose={() => setFocus(null)}
          list={
            <WipFocusList
              snapshot={wipQuery.data}
              loading={wipQuery.isPending}
              error={wipErrorText}
              selectedId={focusSelected}
              onSelect={(id) => setSelected((current) => ({ ...current, wip: id }))}
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
          onSelect={(id) => setSelected((current) => ({ ...current, review: id }))}
          onClose={() => setFocus(null)}
          list={
            <ReviewFocusList
              rows={reviewDrill}
              selectedId={focusSelected}
              onSelect={(id) => setSelected((current) => ({ ...current, review: id }))}
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
          onSelect={(id) => setSelected((current) => ({ ...current, followups: id }))}
          onClose={() => setFocus(null)}
          list={
            <FollowUpsFocusList
              rows={followUps}
              selectedId={focusSelected}
              onSelect={(id) => setSelected((current) => ({ ...current, followups: id }))}
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
          onSelect={(id) => setSelected((current) => ({ ...current, pinned: id }))}
          onClose={() => setFocus(null)}
          list={
            <PinnedFocusList
              rows={pinned}
              selectedId={focusSelected}
              onSelect={(id) => setSelected((current) => ({ ...current, pinned: id }))}
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
          tag={<StatusTag tone="bad" label={t("views.overviewView.ciBlocking")} />}
          big={failing.length}
          bigTone="bad"
          itemIds={focusIds}
          selectedId={focusSelected}
          onSelect={(id) => setSelected((current) => ({ ...current, ci: id }))}
          onClose={() => setFocus(null)}
          list={
            <CiFocusList
              rows={failing}
              selectedId={focusSelected}
              onSelect={(id) => setSelected((current) => ({ ...current, ci: id }))}
            />
          }
          detail={
            focusSelected === null ? null : (
              <CiFocusDetail run={failing.find(({ runId }) => runId === focusSelected)!} rows={failing} />
            )
          }
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
