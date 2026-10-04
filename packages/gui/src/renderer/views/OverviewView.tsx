import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { AgentRuntimeOverviewResult } from "@harness-anything/daemon/protocol";
import type { CiObservatoryRead, TaskWipRead, WorkIndexRead, WorkspaceSummaryRead } from "../../api/renderer-dto.ts";
import type { AgendaSuccess } from "../api-client.ts";
import { AwaitsAnswerPanel } from "../components/AwaitsAnswerPanel.tsx";
import { FocusLayer } from "../components/primitives/FocusLayer";
import { PageRegions } from "../components/primitives/page-regions.tsx";
import { Region } from "../components/primitives/Region";
import type { AwaitsPanelSubject } from "../awaits-answer.ts";
import { useOverviewCi, useOverviewRecentEvents, useOverviewRuntime } from "../overview-data.ts";
import { useTaskWipQuery } from "../task-data.ts";
import type { RuntimeHealth } from "../model/runtime-health.ts";
import { t } from "../i18n/index.tsx";
import { mainCiFailingJobs } from "./overview-model.ts";
import { buildOverviewRegions, type OverviewRegionSpec } from "./overview-regions.tsx";
import { layoutRegions, regionNeed, regionNeedRelaxed, type RegionKey } from "./overview-layout.ts";
import { wipVisibleEntries, type WipFilter } from "./OverviewTaskWip.tsx";
import { regionMinimumHeight } from "../components/primitives/region-minimum.ts";

/**
 * 总览(S3,dec_B3D40712 CH1,原型 v4):一屏注意力加权的自适应区域板。区域大小由
 * S1 的区域权重决定,布局照原型 `layout()`(overview-layout.ts 的纯函数移植);点区域或
 * 行原位放大(FocusLayer 与 Region 共享 layoutId,Esc/点背景收回);顶栏只放系统状态与
 * 全局搜索。数据全部来自已挂载读面:agenda(attentionItems/regionWeights)、工作索引、
 * 常驻任务列表的标题索引、runtime overview、CI 观察窗与事件一页(overview-data)、
 * 工作台占用(repo.tasks.wip,与看板共用 useTaskWipQuery 同一条快照),页面不另发请求。
 * 空了就消失(标准 §1.5):行数为 0 的区域权重归 0 不落位,例外是 mine 空集收成 slim
 * 一行「清空」(v4 样张)与 WIP 常驻观察面(0 占位也落位并如实显示 0/上限);最近变化
 * 与工作页 DayDigest 同一派生
 * (workDayGroups)与同一原语,按任务收束成一行,原始事件类型名不进总览。
 */
export function OverviewView({
  repoId,
  connectionId,
  agenda,
  works,
  titles,
  workspaceSummary,
  health,
  onNavigateEntity,
  onOpenTask,
  onOpenSearch,
  onOpenSessions,
  onUnpin,
}: {
  readonly repoId: string;
  readonly connectionId: string | null;
  /** `ha agenda` 同一条 repo.agenda.read 投影;undefined = 尚未读到。 */
  readonly agenda: AgendaSuccess | undefined;
  /** daemon 工作索引(repo.works.index):「工作」区域的行。 */
  readonly works: WorkIndexRead | undefined;
  /** `task/<id>` → 标题(App 常驻任务列表投影);最近变化的路径行显示任务标题。 */
  readonly titles: ReadonlyMap<string, string>;
  readonly workspaceSummary: WorkspaceSummaryRead;
  /** 侧栏系统运行区同一份派生(App 折算,见 model/runtime-health.ts);这里喂顶栏状态。 */
  readonly health: RuntimeHealth;
  readonly onNavigateEntity: (ref: string) => void;
  /** 工作行与任务行的落点:App 按「根任务即工作」分流到工作页或任务详情。 */
  readonly onOpenTask: (taskId: string) => void;
  /** 顶栏全局搜索的落点:⌘K 命令面板。 */
  readonly onOpenSearch: () => void;
  readonly onOpenSessions: () => void;
  /** 取消置顶(pin 写通道,taskActions.setTaskPin)。 */
  readonly onUnpin: (taskId: string) => void;
}) {
  const [panel, setPanel] = useState<AwaitsPanelSubject | null>(null);
  const [focus, setFocus] = useState<RegionKey | null>(null);
  const [selected, setSelected] = useState<Partial<Record<RegionKey, string>>>({});
  const ciQuery = useOverviewCi(repoId);
  const runtimeQuery = useOverviewRuntime(repoId);
  const eventsQuery = useOverviewRecentEvents(repoId);
  // WIP 与看板共用同一条 repo.tasks.wip 读面(同一 query key,一处缓存):总览挂载期间
  // 本实例是观察者,台账切面前进由既有失效扇出更新,不建第二份快照。
  const wipQuery = useTaskWipQuery(repoId, true);
  const wipErrorText = wipQuery.error instanceof Error ? wipQuery.error.message : null;
  // WIP 放大层的分组/搜索过滤态放在这里:FocusLayer 的 ↑↓ 只在可见集合里移动,itemIds
  // 与名单渲染必须出自同一份 wipVisibleEntries,组件内部各持一份会各自漂移。
  const [wipFilter, setWipFilter] = useState<WipFilter>({ group: "all", search: "" });
  // 年龄随读面刷新重算:agenda/works/ci 任一前进都给一帧新时钟,不立单独计时器。
  const now = useMemo(() => new Date().toISOString(), [agenda, works, ciQuery.data, runtimeQuery.data]);

  const regions = useMemo(
    () =>
      buildOverviewRegions({
        agenda,
        works,
        titles,
        runtime: runtimeQuery.data,
        ci: ciQuery.data,
        wip: wipQuery.data,
        wipLoading: wipQuery.isPending,
        wipError: wipErrorText,
        wipFilter,
        onWipFilterChange: setWipFilter,
        events: eventsQuery.data ?? [],
        now,
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
        onOpenSessions: () => {
          setFocus(null);
          onOpenSessions();
        },
        onUnpin: (taskId) => onUnpin(taskId),
      }),
    [
      agenda,
      works,
      titles,
      runtimeQuery.data,
      ciQuery.data,
      wipQuery.data,
      wipQuery.isPending,
      wipErrorText,
      wipFilter,
      eventsQuery.data,
      now,
      onNavigateEntity,
      onOpenTask,
      onOpenSessions,
      onUnpin,
    ],
  );

  const boardRef = useRef<HTMLDivElement | null>(null);
  const [boardSize, setBoardSize] = useState<{ readonly width: number; readonly height: number } | null>(null);
  useEffect(() => {
    const board = boardRef.current;
    if (board === null) return;
    const observer = new ResizeObserver((entries) => {
      const box = entries[0]?.contentRect;
      if (box !== undefined && box.width > 0) setBoardSize({ width: box.width, height: box.height });
    });
    observer.observe(board);
    return () => observer.disconnect();
  }, []);

  const [minimum, setMinimum] = useState<Partial<Record<RegionKey, number>>>({});

  // Measure natural content, not the allocated body height: a short tile must not
  // make its own minimum smaller. ResizeObserver also catches font/width changes.
  useEffect(() => {
    const board = boardRef.current;
    if (board === null) return;
    const measure = () => {
      const next: Partial<Record<RegionKey, number>> = {};
      for (const region of board.querySelectorAll<HTMLElement>("[data-region]")) {
        const key = region.dataset.region as RegionKey;
        const spec = regions[key];
        if (spec === undefined || spec.rowCount === 0) continue;
        const section = region.querySelector("section");
        if (section === null) continue;
        const height = regionMinimumHeight(section, (body) =>
          spec.renderList === undefined
            ? [...body.children].slice(spec.top === undefined ? 0 : 1)
            : // 自绘行体的区域按各自的行标记量:DayDigest 的天路径与 WIP 名单的 DenseRow。
              [...body.querySelectorAll("[data-day] > div > button, [data-day] > div > div, [data-dense-row]")],
        );
        if (height !== undefined) next[key] = height;
      }
      setMinimum((current) => (JSON.stringify(current) === JSON.stringify(next) ? current : next));
    };
    const observer = new ResizeObserver(measure);
    observer.observe(board);
    for (const element of board.querySelectorAll("[data-region] section > div, [data-region] section > div > div > *"))
      observer.observe(element);
    measure();
    return () => observer.disconnect();
  }, [regions, boardSize]);

  const layout = useMemo(() => {
    if (boardSize === null) return null;
    const weights = overviewWeightsOf(agenda, ciQuery.data, regions, wipQuery.data),
      need: Partial<Record<RegionKey, number>> = {},
      relaxed: Partial<Record<RegionKey, number>> = {};
    for (const key of Object.keys(weights) as RegionKey[]) {
      const spec = regions[key];
      if (spec === undefined) continue;
      need[key] = regionNeed(spec.rowCount, { top: spec.hasTop });
      relaxed[key] = key === "mine" || key === "stuck" ? regionNeedRelaxed(spec.rowCount) : need[key]!;
    }
    return layoutRegions({
      weights,
      minimum,
      need: need as Record<RegionKey, number>,
      needRelaxed: relaxed as Record<RegionKey, number>,
      board: boardSize,
    });
  }, [boardSize, agenda, ciQuery.data, regions, minimum, wipQuery.data]);

  const openFocus = useCallback(
    (key: RegionKey, rowId?: string) => {
      const spec = regions[key];
      // 没有行的区域不放大(返工 1 第 4 点):空壳不进聚焦层,slim 的 mine 同理。
      if (spec === undefined || spec.rowIds.length === 0) return;
      setSelected((current) => {
        const next = rowId ?? spec.rowIds[0];
        return next === undefined ? current : { ...current, [key]: next };
      });
      setFocus(key);
    },
    [regions],
  );

  const focusSpec: OverviewRegionSpec | undefined = focus === null ? undefined : regions[focus];
  // 键盘导航的可选中集合:WIP 用当前过滤后的可见名单(过滤隐藏的行不可被 ↑↓ 选中),
  // 其余区域仍是各自的全量 rowIds。选中行被过滤隐藏时收敛到首个可见行,详情同源。
  const focusIds: readonly string[] =
    focus === null
      ? []
      : focus === "wip"
        ? wipVisibleEntries(wipQuery.data?.counted, wipFilter).map(({ taskId }) => taskId)
        : (regions[focus]?.rowIds ?? []);
  const focusSelected =
    focus === null ? null : focusIds.includes(selected[focus] ?? "") ? selected[focus]! : (focusIds[0] ?? null);

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden" data-testid="overview-view">
      <header data-testid="overview-topbar" className="flex flex-none flex-wrap items-center gap-1.5 px-3 pb-2 pt-2">
        <StatusPill tone={health.daemon.state === "unresponsive" ? "bad" : "ok"}>
          {health.daemon.state === "unresponsive"
            ? t("views.overviewView.topDaemonDown")
            : t("views.overviewView.topDaemonOk")}
        </StatusPill>
        <StatusPill tone={ciQuery.isError ? "warn" : mainCiFailingJobs(ciQuery.data).length === 0 ? "ok" : "bad"}>
          {ciQuery.isError
            ? t("views.overviewView.topCiUnknown")
            : mainCiFailingJobs(ciQuery.data).length === 0
              ? t("views.overviewView.topCiGreen")
              : t("views.overviewView.topCiRed")}
        </StatusPill>
        <StatusPill>
          {t("views.overviewView.topAgentsRunning", { count: String(liveAgents(runtimeQuery.data)) })}
        </StatusPill>
        <StatusPill>
          {t("views.overviewView.topActive", { active: String(workspaceSummary.tasks.byStatus.active ?? 0) })}
        </StatusPill>
        {(health.projection.lag ?? 0) > 0 && (
          <StatusPill tone="warn">
            {t("views.overviewView.topProjectionLag", { lag: String(health.projection.lag) })}
          </StatusPill>
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

      <div ref={boardRef} className="flex min-h-0 flex-1 p-1" data-testid="overview-scroll">
        {layout !== null && (
          <PageRegions
            connectionId={connectionId}
            repoId={repoId}
            slot="overview"
            testId="overview-board"
            settled={
              // 区域集就绪声明(恢复协调用,不定时猜测):本页读面全部落定后,区域集合才是
              // 完整事实,快照恢复的剪枝才不会把「还没到的区域」提前删掉。
              agenda !== undefined &&
              works !== undefined &&
              !ciQuery.isPending &&
              !runtimeQuery.isPending &&
              !eventsQuery.isPending &&
              !wipQuery.isPending
            }
            defaultRatio={
              layout.order.length === 0 ? 0.6 : layout.boxes[layout.order[0]!]!.width / Math.max(1, boardSize!.width)
            }
            columns={[...new Set(layout.order.map((key) => layout.boxes[key]!.left))].map((left) =>
              layout.order.filter((key) => layout.boxes[key]!.left === left),
            )}
            regions={layout.order.flatMap((key) => {
              const spec = regions[key];
              if (spec === undefined) return [];
              const slim = layout.slim.has(key);
              return [
                {
                  id: key,
                  title: spec.title,
                  weight: layout.boxes[key]!.height,
                  testId: `overview-region-${key}`,
                  content: (
                    <div className={`grid min-h-0 min-w-0 ${focus === key ? "invisible" : ""}`}>
                      <Region
                        focusId={key}
                        focusOpen={focus === key}
                        title={spec.title}
                        tag={spec.tag}
                        big={spec.big}
                        bigTone={spec.bigTone}
                        edge={spec.edge}
                        footer={slim ? undefined : spec.footer}
                        onOpen={spec.rowIds.length > 0 ? () => openFocus(key) : undefined}
                      >
                        {slim ? null : spec.renderList !== undefined ? (
                          spec.renderList({ selectedId: null, onSelect: (id) => openFocus(key, id), inFocus: false })
                        ) : (
                          <>
                            {spec.top}
                            {spec.rowIds.map((id) =>
                              spec.renderRow(id, {
                                relaxed: layout.tall.has(key),
                                selected: false,
                                onSelect: () => openFocus(key, id),
                                inFocus: false,
                              }),
                            )}
                          </>
                        )}
                      </Region>
                    </div>
                  ),
                },
              ];
            })}
          />
        )}
      </div>

      {focusSpec !== undefined && focus !== null && (
        <FocusLayer
          open
          sourceId={focus}
          title={focusSpec.title}
          tag={focusSpec.tag}
          big={focusSpec.big}
          bigTone={focusSpec.bigTone}
          itemIds={focusIds}
          selectedId={focusSelected}
          onSelect={(id) => setSelected((current) => ({ ...current, [focus]: id }))}
          onClose={() => setFocus(null)}
          list={
            focusSpec.renderList !== undefined ? (
              focusSpec.renderList({
                selectedId: focusSelected,
                onSelect: (id) => setSelected((current) => ({ ...current, [focus!]: id })),
                inFocus: true,
              })
            ) : (
              <>
                {focusSpec.top}
                {focusSpec.rowIds.map((id) =>
                  focusSpec.renderRow(id, {
                    relaxed: false,
                    selected: focusSelected === id,
                    onSelect: () => setSelected((current) => ({ ...current, [focus!]: id })),
                    inFocus: true,
                  }),
                )}
              </>
            )
          }
          detail={focusSpec.renderDetail(focusSelected ?? "")}
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

/**
 * S1 区域权重 → 落位权重:main CI 红时 60(绿时 0,区域不落位)。空了就消失(标准 §1.5):
 * 行数为 0 的区域权重归 0 不落位——daemon 对空区域也给最小权重(mine 1.5、stuck 3、
 * works 8…),直接透传会让空区域占大框;mine 是唯一例外,空集时保持 1.5 收成 slim 一行
 * 「清空」(原型 v4 的样张,表达「一切正常」;与 daemon 空集公式同值)。
 *
 * WIP 是第二个例外,方向相反:用户要求的常驻观察面,0 占位/首读/失败都保持落位并如实
 * 显示 0/上限(或 …/—),只有满额(占用 ≥ 上限)升权重——满额是可行动信号,权重对齐
 * works 档;平时与 mine 带注意力同档。
 */
function overviewWeightsOf(
  agenda: AgendaSuccess | undefined,
  ci: CiObservatoryRead | undefined,
  regions: Partial<Record<RegionKey, OverviewRegionSpec>>,
  wip: TaskWipRead | undefined,
): Record<RegionKey, number> {
  const base = agenda?.regionWeights;
  const empty = (key: RegionKey): boolean => (regions[key]?.rowIds.length ?? 0) === 0;
  return {
    ci: mainCiFailingJobs(ci).length === 0 ? 0 : 60,
    mine: empty("mine") ? 1.5 : (base?.mine ?? 0),
    stuck: empty("stuck") ? 0 : (base?.stuck ?? 0),
    run: empty("run") ? 0 : (base?.run ?? 0),
    review: empty("review") ? 0 : (base?.review ?? 0),
    queue: empty("queue") ? 0 : (base?.queue ?? 0),
    recent: empty("recent") ? 0 : (base?.recent ?? 0),
    works: empty("works") ? 0 : (base?.works ?? 0),
    wip: wip !== undefined && wip.counted.length >= wip.limit ? 12 : 6,
  };
}

function liveAgents(runtime: AgentRuntimeOverviewResult | undefined): number {
  return (runtime?.sessions ?? []).filter((session) => session.liveness === "live").length;
}

/** 顶栏状态点(原型 .pill):状态点 + 文案;状态色只引 token 类,不写数值。 */
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
