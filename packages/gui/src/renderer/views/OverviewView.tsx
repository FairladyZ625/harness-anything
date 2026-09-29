import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from "react";
import type { AgentRuntimeOverviewResult } from "@harness-anything/daemon/protocol";
import type { CiObservatoryRead, WorkIndexRead, WorkspaceSummaryRead } from "../../api/renderer-dto.ts";
import type { AgendaSuccess } from "../api-client.ts";
import { AwaitsAnswerPanel } from "../components/AwaitsAnswerPanel.tsx";
import { FocusLayer } from "../components/primitives/FocusLayer";
import { Region } from "../components/primitives/Region";
import type { AwaitsPanelSubject } from "../awaits-answer.ts";
import { useOverviewCi, useOverviewRecentEvents, useOverviewRuntime } from "../overview-data.ts";
import type { RuntimeHealth } from "../model/runtime-health.ts";
import { t } from "../i18n/index.tsx";
import { mainCiFailure } from "./overview-model.ts";
import { buildOverviewRegions, type OverviewRegionSpec } from "./overview-regions.tsx";
import { layoutRegions, regionNeed, regionNeedRelaxed, type RegionBox, type RegionKey } from "./overview-layout.ts";

/**
 * 总览(S3,dec_B3D40712 CH1,原型 v4):一屏注意力加权的自适应区域板。区域大小由
 * S1 的区域权重决定,布局照原型 `layout()`(overview-layout.ts 的纯函数移植);点区域或
 * 行原位放大(FocusLayer 与 Region 共享 layoutId,Esc/点背景收回);顶栏只放系统状态与
 * 全局搜索。数据全部来自已挂载读面:agenda(attentionItems/regionWeights)、工作索引、
 * runtime overview、CI 观察窗与事件一页(overview-data),页面不另发请求。
 */
export function OverviewView({
  repoId,
  agenda,
  works,
  workspaceSummary,
  health,
  onNavigateEntity,
  onOpenTask,
  onOpenSearch,
  onOpenSessions,
  onUnpin,
}: {
  readonly repoId: string;
  /** `ha agenda` 同一条 repo.agenda.read 投影;undefined = 尚未读到。 */
  readonly agenda: AgendaSuccess | undefined;
  /** daemon 工作索引(repo.works.index):「工作」区域的行。 */
  readonly works: WorkIndexRead | undefined;
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
  // 年龄随读面刷新重算:agenda/works/ci 任一前进都给一帧新时钟,不立单独计时器。
  const now = useMemo(() => new Date().toISOString(), [agenda, works, ciQuery.data, runtimeQuery.data]);

  const regions = useMemo(
    () =>
      buildOverviewRegions({
        agenda,
        works,
        runtime: runtimeQuery.data,
        ci: ciQuery.data,
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
      runtimeQuery.data,
      ciQuery.data,
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

  const layout = useMemo(() => {
    if (boardSize === null) return null;
    const weights = overviewWeightsOf(agenda, ciQuery.data),
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
      need: need as Record<RegionKey, number>,
      needRelaxed: relaxed as Record<RegionKey, number>,
      board: boardSize,
    });
  }, [boardSize, agenda, ciQuery.data, regions]);

  const openFocus = useCallback(
    (key: RegionKey, rowId?: string) => {
      setSelected((current) => {
        const next = rowId ?? regions[key]?.rowIds[0];
        return next === undefined ? current : { ...current, [key]: next };
      });
      setFocus(key);
    },
    [regions],
  );

  const focusSpec: OverviewRegionSpec | undefined = focus === null ? undefined : regions[focus];
  const focusSelected = focus === null ? null : (selected[focus] ?? regions[focus]?.rowIds[0] ?? null);

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden" data-testid="overview-view">
      <header data-testid="overview-topbar" className="flex flex-none flex-wrap items-center gap-1.5 px-3 pb-2 pt-2">
        <StatusPill tone={health.daemon.state === "unresponsive" ? "bad" : "ok"}>
          {health.daemon.state === "unresponsive"
            ? t("views.overviewView.topDaemonDown")
            : t("views.overviewView.topDaemonOk")}
        </StatusPill>
        <StatusPill tone={ciQuery.isError ? "warn" : mainCiFailure(ciQuery.data) === null ? "ok" : "bad"}>
          {ciQuery.isError
            ? t("views.overviewView.topCiUnknown")
            : mainCiFailure(ciQuery.data) === null
              ? t("views.overviewView.topCiGreen")
              : t("views.overviewView.topCiRed")}
        </StatusPill>
        <StatusPill>
          {t("views.overviewView.topAgentsRunning", { count: String(liveAgents(runtimeQuery.data)) })}
        </StatusPill>
        <StatusPill>
          {t("views.overviewView.topActive", {
            active: String(workspaceSummary.tasks.byStatus.active ?? 0),
            total: String(workspaceSummary.tasks.total),
          })}
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

      <div
        className={layout?.columns === 1 ? "min-h-0 flex-1 overflow-y-auto px-3 pb-3" : "min-h-0 flex-1 px-3 pb-3"}
        data-testid="overview-scroll"
      >
        <div
          ref={boardRef}
          data-testid="overview-board"
          className="relative w-full"
          style={
            layout?.boardHeight !== null && layout?.boardHeight !== undefined
              ? { height: layout.boardHeight }
              : { height: "100%" }
          }
        >
          {layout === null
            ? null
            : layout.order.map((key) => {
                const spec = regions[key],
                  box = layout.boxes[key];
                if (spec === undefined || box === undefined) return null;
                // slim(mine 清空):高度不足 60px 时只留标题行(标准 §1.5:空了就收成一行)。
                const slim = layout.slim.has(key);
                return (
                  <div
                    key={key}
                    data-region={key}
                    data-testid={`overview-region-${key}`}
                    // grid 单元格让 Region 原语被拉伸到精确盒子;visibility:hidden 时
                    // motion 仍能测到它的盒子,FocusLayer 从原位长出(S6 放大层契约)。
                    className={`absolute grid ${focus === key ? "invisible" : ""}`}
                    style={regionStyle(box)}
                  >
                    <Region
                      focusId={key}
                      title={spec.title}
                      tag={slim ? undefined : spec.tag}
                      big={spec.big}
                      bigTone={spec.bigTone}
                      edge={spec.edge}
                      footer={slim ? undefined : spec.footer}
                      onOpen={() => openFocus(key)}
                    >
                      {slim ? null : (
                        <>
                          {spec.top}
                          {spec.rowIds.map((id) =>
                            spec.renderRow(id, {
                              relaxed: layout.tall.has(key),
                              selected: false,
                              onSelect: () => openFocus(key, id),
                            }),
                          )}
                        </>
                      )}
                    </Region>
                  </div>
                );
              })}
        </div>
      </div>

      {focusSpec !== undefined && focus !== null && (
        <FocusLayer
          open
          sourceId={focus}
          title={focusSpec.title}
          tag={focusSpec.tag}
          big={focusSpec.big}
          bigTone={focusSpec.bigTone}
          itemIds={focusSpec.rowIds}
          selectedId={focusSelected}
          onSelect={(id) => setSelected((current) => ({ ...current, [focus]: id }))}
          onClose={() => setFocus(null)}
          list={
            focusSpec.rowIds.length === 0 ? (
              <p className="px-4 py-4 ui-meta text-text-faint">{t("views.overviewView.focusEmpty")}</p>
            ) : (
              <>
                {focusSpec.top}
                {focusSpec.rowIds.map((id) =>
                  focusSpec.renderRow(id, {
                    relaxed: false,
                    selected: focusSelected === id,
                    onSelect: () => setSelected((current) => ({ ...current, [focus!]: id })),
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

/** S1 区域权重 + CI 红时 60(绿时 0,区域不落位)。 */
function overviewWeightsOf(
  agenda: AgendaSuccess | undefined,
  ci: CiObservatoryRead | undefined,
): Record<RegionKey, number> {
  const base = agenda?.regionWeights;
  return {
    ci: mainCiFailure(ci) === null ? 0 : 60,
    mine: base?.mine ?? 0,
    stuck: base?.stuck ?? 0,
    run: base?.run ?? 0,
    review: base?.review ?? 0,
    queue: base?.queue ?? 0,
    recent: base?.recent ?? 0,
    works: base?.works ?? 0,
  };
}

function liveAgents(runtime: AgentRuntimeOverviewResult | undefined): number {
  return (runtime?.sessions ?? []).filter((session) => session.liveness === "live").length;
}

function regionStyle(box: RegionBox): CSSProperties {
  return { left: box.left, top: box.top, width: box.width, height: box.height };
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
