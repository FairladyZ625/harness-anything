import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ArrowLineDown, ChartLine, Funnel, Pause, Play, X } from "@phosphor-icons/react";
import { harnessClient } from "../../api-client.ts";
import { consumeKnownError } from "../../../api/error-consumption.ts";
import type { ObserveTailRead } from "../../../api/renderer-dto.ts";
import { t } from "../../i18n/index.tsx";
import { formatTime } from "../../model/time.ts";
import { EntityRefLink } from "../EntityRefLink.tsx";
import { ObserveAnomalyCluster } from "./ObserveAnomalyCluster.tsx";
import { ObserveCallVolumeBoard } from "./ObserveCallVolumeBoard.tsx";
import { ObserveHudStrip, type ObserveHudWindow, type ObserveTimeSelection } from "./ObserveHudStrip.tsx";
import { ObserveSlowOpsBoard } from "./ObserveSlowOpsBoard.tsx";
import { ObserveSnifferStrip } from "./ObserveSnifferStrip.tsx";
import { ObserveTopTalkersBoard } from "./ObserveTopTalkersBoard.tsx";
import {
  applyObserveTailError,
  applyObserveTailPage,
  applyObserveViewing,
  filterObserveRowsLog,
  initialObserveTail,
  observePaneCursor,
  observeRowPasses,
  observeTailRequest,
  type ObserveFilterCache,
  type ObserveRow,
  type ObserveRowFilter,
  type ObserveTailCursor,
  type ObserveTailKind,
  type ObserveTailMode,
  type ObserveTailSnapshot,
} from "../../daemon-observe-model.ts";
import {
  observeStatsLog,
  type ObserveLensValue,
  type ObserveStats,
  type ObserveStatsCache,
} from "../../daemon-observe-stats.ts";

/**
 * One `observe.tail` pane: a self-following, pausable, filterable log/event stream.
 *
 * Extracted from DaemonObserveView so the System tab can mount the same stream without a
 * second polling mechanism. All data comes from the `observe.tail` RPC; the GUI reads no
 * files. Auto-tail scrolling, pause, keyword filter, and clickable entity refs on event
 * rows; `unavailable` / `gap` are rendered from their contract reasons and never faked as
 * an empty list.
 *
 * 行流可无限上翻(history 翻页不裁剪),挂 DOM 的行数由窗口化保证有界:行是等高 monospace
 * 单行,只渲染视口 ± overscan 的一段,上下各留等高 spacer 占位;翻页锚定用「新增头部行 ×
 * 固定行高」恢复视口(与 previousHeight/previousTop 高度差锚定等价,但不依赖布局回读)。
 */

/** 可切的日志来源:词表由 daemon 的 observe.tail kind 决定,GUI 不另写一份来源清单。 */
export type ObserveLogKind = Exclude<ObserveTailKind, "events">;

const TAIL_FOLLOW_MS = 1_000,
  TAIL_CATCHUP_MS = 0,
  TAIL_PENDING_MS = 500,
  TAIL_UNAVAILABLE_MS = 2_500,
  TAIL_ERROR_MS = 1_500;

const MODE_LABEL: Record<ObserveTailMode, () => string> = {
  local: () => t("views.daemonObserve.modeLocal"),
  "remote-proxy": () => t("views.daemonObserve.modeProxy"),
  "remote-center": () => t("views.daemonObserve.modeCenter"),
  "remote-edge": () => t("views.daemonObserve.modeEdge"),
};

// G36:长 Tailwind 串按段拼装,单行不超过 120 列;两处共用的工具按钮类只留一份。
export const PANE_TOOL_BUTTON = [
  "inline-flex items-center gap-1 rounded-md border border-border px-2 py-1 ui-meta",
  "text-text-muted hover:border-border-strong hover:text-text",
].join(" ");
const PANE_STATUS_STRIP = [
  "flex items-center justify-between border-b border-border px-3 py-1",
  "font-mono ui-micro text-text-faint",
].join(" ");
const PANE_FILTER_INPUT = [
  "w-36 rounded border border-border-strong bg-surface px-2 py-1 font-mono ui-micro",
  "text-text outline-none focus-visible:border-accent",
].join(" ");
const PANE_JUMP_BUTTON = [
  "inline-flex items-center justify-center gap-1 border-t border-border px-2 py-1",
  "ui-micro text-accent hover:bg-surface-raised",
].join(" ");
const PANE_LENS_CHIP = [
  "inline-flex max-w-[18ch] items-center gap-1 rounded border border-accent/40",
  "bg-accent/10 px-1.5 py-1 font-mono ui-micro text-accent",
].join(" ");
const PANE_LENS_PANEL = [
  "absolute right-0 z-20 mt-1 flex max-h-64 w-80 flex-col gap-2 overflow-y-auto",
  "rounded border border-border bg-surface p-2 shadow-lg",
].join(" ");
const PANE_LENS_CANDIDATE = [
  "inline-flex max-w-full items-baseline gap-1 rounded border border-border",
  "px-1.5 py-0.5 text-left font-mono ui-micro hover:border-accent hover:text-accent",
].join(" ");
const kindOptionClass = (selected: boolean) =>
  [
    "px-2.5 py-0.5 ui-micro",
    selected ? "bg-accent font-semibold text-accent-fg" : "text-text-muted hover:bg-surface",
  ].join(" ");

/**
 * 窗口化:每行高度由内联 style 固定(单行 truncate 内容,ui-micro 最大字号也留有余量),
 * 视口上下各多渲染 OBSERVE_WINDOW_OVERSCAN 行,滚动时只挂这一段;DOM 行数上界 =
 * ceil(viewport/行高) + 2×overscan(视口未量出时兜底 OBSERVE_WINDOW_MIN 行),与累计
 * 加载行数无关。上/下 spacer 撑出完整滚动高度,触顶取历史与滚动锚定照常工作。
 */
export const OBSERVE_ROW_HEIGHT = 24,
  OBSERVE_WINDOW_OVERSCAN = 24,
  OBSERVE_WINDOW_MIN = 32;

/** 纯函数:当前滚动位置应渲染的行区间 [start, end)。空列表返回 {0, 0}。 */
export function observeWindowRange(input: {
  readonly total: number;
  readonly scrollTop: number;
  readonly viewportHeight: number;
}): { readonly start: number; readonly end: number } {
  const { total, scrollTop, viewportHeight } = input;
  if (total <= 0) return { start: 0, end: 0 };
  const first = Math.max(0, Math.floor(scrollTop / OBSERVE_ROW_HEIGHT) - OBSERVE_WINDOW_OVERSCAN),
    last = Math.min(
      total,
      Math.ceil((scrollTop + Math.max(viewportHeight, 0)) / OBSERVE_ROW_HEIGHT) + OBSERVE_WINDOW_OVERSCAN,
    ),
    // 视口高度未知(初始/测试环境)时至少渲染 MIN 行,小列表整表可见,大列表仍常数有界。
    start = Math.min(first, Math.max(0, total - OBSERVE_WINDOW_MIN)),
    end = Math.max(last, Math.min(total, start + OBSERVE_WINDOW_MIN));
  return { start, end };
}

/** 行类型列的成败色:失败红、成功绿、事件行(无成败位)用强调色。 */
function rowTone(ok: boolean | null): string {
  if (ok === false) return "text-status-blocked";
  if (ok === true) return "text-status-done";
  return "text-accent";
}

/** 窗口化消费的最小行序列:ObserveRowLog 与过滤后的普通数组都结构满足。 */
interface ObserveRowSequence {
  readonly length: number;
  at(index: number): ObserveRow | undefined;
  slice(start?: number, end?: number): readonly ObserveRow[];
}

export function DaemonTailPane({
  repoId,
  kind,
  title,
  kindOptions,
  onKindChange,
  onNavigateEntity,
  lens,
  onLensChange,
}: {
  readonly repoId: string;
  readonly kind: ObserveTailKind;
  /** Overrides the default pane heading; the System tab names the sink it is showing. */
  readonly title?: string;
  readonly kindOptions?: readonly { readonly value: ObserveLogKind; readonly label: string; readonly tip?: string }[];
  readonly onKindChange?: (kind: ObserveLogKind) => void;
  readonly onNavigateEntity: (ref: string) => void;
  /** 双栏联动的透镜词(视图级持有):命中行才可见,点行内方法/透镜候选时由视图写入。 */
  readonly lens?: string | null;
  readonly onLensChange?: (lens: string | null) => void;
}) {
  const [paused, setPaused] = useState(false),
    [query, setQuery] = useState(""),
    [following, setFollowing] = useState(true),
    // 分析透镜模式:顶部 HUD + 慢操作/异常聚类面板(可折叠);时段来自 HUD 框选。
    [analytics, setAnalytics] = useState(true),
    [hudWindow, setHudWindow] = useState<ObserveHudWindow>("15m"),
    [timeRange, setTimeRange] = useState<ObserveTimeSelection | null>(null),
    [boardTab, setBoardTab] = useState<"ops" | "volume" | "anomalies" | "talkers">(
      kind === "events" ? "volume" : "ops",
    ),
    [lensOpen, setLensOpen] = useState(false),
    // 窗口化输入:滚动体的 scrollTop 与 clientHeight,随 scroll 事件/贴底写入/尺寸变化更新。
    [scroll, setScroll] = useState({ top: 0, height: 0 }),
    bodyRef = useRef<HTMLDivElement>(null),
    selfScroll = useRef(false),
    // 增量过滤缓存:同一 query 只扫新增行(见 filterObserveRowsLog),follow 轮询不重扫全量。
    filterRef = useRef<ObserveFilterCache | null>(null),
    // 增量统计缓存:HUD/慢操作/异常聚类的数据面(见 observeStatsLog),同版本零重算。
    statsRef = useRef<ObserveStatsCache | null>(null),
    tail = useObserveTail(repoId, kind, paused),
    snapshot = tail.snapshot,
    rows = useMemo(() => {
      const next = filterObserveRowsLog(snapshot.rows, query, filterRef.current);
      filterRef.current = next;
      return next.result;
    }, [snapshot.rows, snapshot.rows.version, query]),
    stats = useMemo(() => {
      // 面板折叠时不计算;重新展开时缓存按水位增量续用(丢行后自动全量重建)。
      if (!analytics) return null;
      const next = observeStatsLog(snapshot.rows, statsRef.current);
      statsRef.current = next;
      return next.stats;
    }, [snapshot.rows, snapshot.rows.version, analytics]),
    isLogPane = kind !== "events",
    lensNeedle = lens !== undefined && lens !== null ? lens.trim().toLowerCase() : "",
    lensActive = lensNeedle === "" ? null : lensNeedle,
    // 透镜与时段是行集之上的正交过滤:rows 已含 query 命中,这里只追加透镜/时段判定;
    // 备忘在 [rows 版本, lens, 时段] 上,滚动不触发重算。
    effective: ObserveRowSequence = useMemo(() => {
      if (lensActive === null && timeRange === null) return rows;
      const filter: ObserveRowFilter = {
        needle: "",
        lens: lensActive,
        fromMs: timeRange?.fromMs ?? null,
        toMs: timeRange?.toMs ?? null,
      };
      const hits: ObserveRow[] = [];
      for (const row of rows) if (observeRowPasses(row, filter)) hits.push(row);
      return hits;
    }, [rows, rows.version, lensActive, timeRange]),
    // 尾随的触发键是「最后一行」而不是行数:加载历史只改第一行,不应把视口拉到底;
    // 只有 live follow 改变最后一行时才触发贴底(时段过滤下的行外追加同样不拉视口)。
    lastKey = effective.length > 0 ? effective.at(-1)!.key : null,
    // 只渲染视口附近的行;DOM 行数上界与累计加载行数无关(见 observeWindowRange)。
    rowWindow = observeWindowRange({
      total: effective.length,
      scrollTop: scroll.top,
      viewportHeight: scroll.height,
    }),
    visible = effective.slice(rowWindow.start, rowWindow.end),
    focusMethod = useCallback(
      (method: string) => {
        onLensChange?.(method);
        setLensOpen(false);
      },
      [onLensChange],
    ),
    // 行内方法列的透镜出口:只在日志栏且有视图级 lens 通道时挂;事件行一律文本列。
    methodFocusHandler = onLensChange === undefined ? undefined : focusMethod,
    focusCluster = useCallback((matchText: string) => setQuery(matchText), []),
    // 异味 Tag / Top Talker 的一键下钻:有视图级透镜通道时收敛双栏,否则退到本栏过滤框。
    focusLensOrQuery = useCallback(
      (text: string) => {
        if (onLensChange === undefined) setQuery(text);
        else focusMethod(text);
      },
      [focusMethod, onLensChange],
    ),
    selectRange = useCallback((selection: ObserveTimeSelection | null) => setTimeRange(selection), []),
    changeWindow = useCallback((next: ObserveHudWindow) => setHudWindow(next), []);
  useEffect(() => {
    // 用户视角进数据面:上滚回看历史期间 live 增长不裁剪,回到贴底恢复内存上限。
    tail.setViewing(following ? "follow" : "history");
  }, [following, tail.setViewing]);
  useEffect(() => {
    const body = bodyRef.current;
    if (!body) return;
    const measure = () => setScroll((current) => ({ ...current, height: body.clientHeight }));
    measure();
    window.addEventListener("resize", measure);
    return () => window.removeEventListener("resize", measure);
  }, []);
  useEffect(() => {
    const body = bodyRef.current;
    if (!body || !following) return;
    // 自己写入的 scrollTop 派生的 scroll 事件不算用户上滚:贴底那一跳的 scroll
    // 事件派发前,下一批行可能已经落进 DOM,dist 会瞬时读出 >48 而误停尾随。
    // 同帧内(scroll 事件先于 rAF 回调)用标志位盖掉,帧末清除。窗口随之移到底部。
    selfScroll.current = true;
    body.scrollTop = body.scrollHeight;
    setScroll({ top: body.scrollTop, height: body.clientHeight });
    requestAnimationFrame(() => {
      selfScroll.current = false;
    });
  }, [lastKey, following]);
  const pause = () => {
    // 继续即恢复贴底跟随;暂停只冻结轮询与滚动,已到行保持可读。
    if (paused) setFollowing(true);
    setPaused((value) => !value);
  };
  return (
    <section
      data-testid={`observe-pane-${kind}`}
      className="flex min-h-0 flex-col overflow-hidden rounded-lg border border-border bg-surface"
    >
      <header className="flex flex-wrap items-center gap-2 border-b border-border px-3 py-2">
        <h2 className="ui-body font-semibold">
          {title ?? (isLogPane ? t("views.daemonObserve.logTitle") : t("views.daemonObserve.eventsTitle"))}
        </h2>
        {kindOptions && onKindChange ? (
          <span role="group" className="inline-flex overflow-hidden rounded border border-border-strong">
            {kindOptions.map((option) => (
              <button
                key={option.value}
                type="button"
                data-tip={option.tip}
                data-testid={`observe-kind-${option.value}`}
                aria-pressed={option.value === kind}
                onClick={() => onKindChange(option.value)}
                className={kindOptionClass(option.value === kind)}
              >
                {option.label}
              </button>
            ))}
          </span>
        ) : null}
        {snapshot.mode === null ? null : (
          <span className="font-mono ui-micro text-text-faint" title={snapshot.mode}>
            {MODE_LABEL[snapshot.mode]()}
          </span>
        )}
        <span className="ml-auto flex items-center gap-2">
          {onLensChange === undefined || lensActive === null ? null : (
            <span
              data-testid={`observe-lens-chip-${kind}`}
              className={PANE_LENS_CHIP}
              title={t("views.daemonObserve.lensActive", { value: lensActive })}
            >
              <Funnel />
              <span className="truncate">{lensActive}</span>
              <button
                type="button"
                data-testid={`observe-lens-clear-${kind}`}
                onClick={() => onLensChange(null)}
                title={t("views.daemonObserve.lensClear")}
                aria-label={t("views.daemonObserve.lensClear")}
                className="rounded p-0.5 hover:bg-accent/20"
              >
                <X />
              </button>
            </span>
          )}
          <input
            type="text"
            aria-label={t("views.daemonObserve.filterLabel")}
            data-testid={`observe-filter-${kind}`}
            value={query}
            placeholder={t("views.daemonObserve.filterPlaceholder")}
            onChange={(event) => setQuery(event.target.value)}
            className={PANE_FILTER_INPUT}
          />
          <button
            type="button"
            data-testid={`observe-analytics-toggle-${kind}`}
            aria-pressed={analytics}
            onClick={() => setAnalytics((value) => !value)}
            title={t("views.daemonObserve.analyticsTip")}
            className={PANE_TOOL_BUTTON}
          >
            <ChartLine />
            {t("views.daemonObserve.analytics")}
          </button>
          <button
            type="button"
            data-testid={`observe-pause-${kind}`}
            aria-pressed={paused}
            onClick={pause}
            title={paused ? t("views.daemonObserve.resume") : t("views.daemonObserve.pause")}
            className={PANE_TOOL_BUTTON}
          >
            {paused ? <Play /> : <Pause />}
            {paused ? t("views.daemonObserve.resume") : t("views.daemonObserve.pause")}
          </button>
        </span>
      </header>
      <div className={PANE_STATUS_STRIP}>
        <span data-testid={`observe-status-${kind}`}>
          {snapshot.status === "idle"
            ? t("views.daemonObserve.loading")
            : snapshot.caughtUp
              ? t("views.daemonObserve.caughtUp")
              : t("views.daemonObserve.following")}
        </span>
        <span data-testid={`observe-count-${kind}`}>
          {effective.length === snapshot.rows.length
            ? t("views.daemonObserve.rowCount", { loaded: String(snapshot.rows.length) })
            : t("views.daemonObserve.rowCountFiltered", {
                shown: String(effective.length),
                loaded: String(snapshot.rows.length),
              })}
          {" · "}
          {snapshot.historyDone ? t("views.daemonObserve.historyDone") : t("views.daemonObserve.historyMore")}
          {" · "}
          {following ? t("views.daemonObserve.tailFollowing") : t("views.daemonObserve.tailBrowsing")}
        </span>
      </div>
      {snapshot.status === "unavailable" ? (
        <p
          data-testid={`observe-unavailable-${kind}`}
          className="border-b border-border bg-status-blocked/5 px-3 py-2 ui-meta text-status-blocked"
        >
          {t("views.daemonObserve.unavailableTitle")} {unavailableText(snapshot)}
        </p>
      ) : null}
      {snapshot.status === "gap" ? (
        <p
          data-testid={`observe-gap-${kind}`}
          className="border-b border-border bg-stale/10 px-3 py-2 ui-meta text-stale"
        >
          {t("views.daemonObserve.gapTitle")} {gapText(snapshot)}
        </p>
      ) : null}
      {snapshot.status === "error" ? (
        <p
          data-testid={`observe-error-${kind}`}
          className="border-b border-border bg-status-blocked/5 px-3 py-2 ui-meta text-status-blocked"
        >
          {t("views.daemonObserve.errorTitle")} {snapshot.error}
        </p>
      ) : null}
      {analytics && stats !== null ? (
        <div data-testid={`observe-analytics-${kind}`} className="border-b border-border bg-surface-raised/30">
          <ObserveHudStrip
            testId={`observe-hud-${kind}`}
            stats={stats}
            window={hudWindow}
            onWindowChange={changeWindow}
            selection={timeRange}
            onSelectRange={selectRange}
          />
          <ObserveSnifferStrip
            testId={`observe-sniffer-${kind}`}
            stats={stats}
            window={hudWindow}
            isLogPane={isLogPane}
            onFocusSmell={focusLensOrQuery}
          />
          <div className="flex flex-wrap items-center gap-2 px-3 py-1">
            {isLogPane ? (
              <button
                type="button"
                data-testid={`observe-tab-ops-${kind}`}
                aria-pressed={boardTab === "ops"}
                onClick={() => setBoardTab("ops")}
                className={kindOptionClass(boardTab === "ops")}
              >
                {t("views.daemonObserve.tabSlowOps")}
              </button>
            ) : null}
            <button
              type="button"
              data-testid={`observe-tab-volume-${kind}`}
              aria-pressed={boardTab === "volume"}
              onClick={() => setBoardTab("volume")}
              className={kindOptionClass(boardTab === "volume")}
            >
              {isLogPane ? t("views.daemonObserve.tabVolumeOps") : t("views.daemonObserve.tabVolumeEvents")}
            </button>
            <button
              type="button"
              data-testid={`observe-tab-anomalies-${kind}`}
              aria-pressed={boardTab === "anomalies"}
              onClick={() => setBoardTab("anomalies")}
              className={kindOptionClass(boardTab === "anomalies")}
            >
              {t("views.daemonObserve.tabAnomalies")}
            </button>
            <button
              type="button"
              data-testid={`observe-tab-talkers-${kind}`}
              aria-pressed={boardTab === "talkers"}
              onClick={() => setBoardTab("talkers")}
              className={kindOptionClass(boardTab === "talkers")}
            >
              {t("views.daemonObserve.tabTalkers")}
            </button>
            {onLensChange === undefined ? null : (
              <span className="relative ml-auto shrink-0">
                <button
                  type="button"
                  data-testid={`observe-lens-${kind}`}
                  aria-expanded={lensOpen}
                  onClick={() => setLensOpen((value) => !value)}
                  className={PANE_TOOL_BUTTON}
                >
                  <Funnel />
                  {t("views.daemonObserve.lensLabel")}
                </button>
                {lensOpen ? (
                  <span data-testid={`observe-lens-panel-${kind}`} className={PANE_LENS_PANEL}>
                    {lensGroupsOf(stats).map(([label, values]) => (
                      <span key={label} className="flex flex-col gap-1">
                        <span className="ui-micro text-text-faint">{label}</span>
                        <span className="flex flex-wrap gap-1">
                          {values.map((candidate) => (
                            <button
                              key={candidate.value}
                              type="button"
                              data-testid={`observe-lens-candidate-${kind}`}
                              onClick={() => focusMethod(candidate.value)}
                              title={t("views.daemonObserve.lensCandidateTip")}
                              className={PANE_LENS_CANDIDATE}
                            >
                              <span className="truncate">{candidate.value}</span>
                              <span className="shrink-0 text-text-faint">×{candidate.count}</span>
                            </button>
                          ))}
                        </span>
                      </span>
                    ))}
                    {lensGroupsOf(stats).length === 0 ? (
                      <span className="px-1 py-0.5 font-mono ui-micro text-text-faint">
                        {t("views.daemonObserve.lensEmpty")}
                      </span>
                    ) : null}
                  </span>
                ) : null}
              </span>
            )}
          </div>
          {boardTab === "ops" && isLogPane ? (
            <ObserveSlowOpsBoard testId={`observe-slowops-${kind}`} stats={stats} onFocusMethod={focusMethod} />
          ) : null}
          {boardTab === "volume" ? (
            <ObserveCallVolumeBoard
              testId={`observe-volume-${kind}`}
              isLogPane={isLogPane}
              stats={stats}
              onFocusItem={(name) => (isLogPane ? focusMethod(name) : setQuery(name))}
            />
          ) : null}
          {boardTab === "anomalies" ? (
            <ObserveAnomalyCluster
              testId={`observe-anomalies-${kind}`}
              clusters={stats.clusters}
              onFocusCluster={focusCluster}
            />
          ) : null}
          {boardTab === "talkers" ? (
            <ObserveTopTalkersBoard
              testId={`observe-talkers-${kind}`}
              stats={stats}
              window={hudWindow}
              onFocusSubject={focusLensOrQuery}
            />
          ) : null}
        </div>
      ) : null}
      <div
        ref={bodyRef}
        data-testid={`observe-body-${kind}`}
        onScroll={(event) => {
          const el = event.currentTarget;
          // 窗口跟随滚动前进(自己写入的 scrollTop 也在此同步,不等被盖掉的 scroll 事件)。
          setScroll({ top: el.scrollTop, height: el.clientHeight });
          if (selfScroll.current) return;
          setFollowing(el.scrollHeight - el.scrollTop - el.clientHeight <= 48);
          if (el.scrollTop <= 48 && !snapshot.historyDone) {
            const previousTop = el.scrollTop;
            void tail.loadHistory().then((headRows) => {
              if (headRows.length === 0 || bodyRef.current !== el) return;
              requestAnimationFrame(() => {
                selfScroll.current = true;
                // 触顶翻页锚定:头部新插入的行 × 固定行高 = 视口应下移的高度
                // (等高行下与 previousHeight/previousTop 的高度差锚定等价,但免布局回读)。
                // 可见行按当前全部过滤条件(query+透镜+时段)计,与锚定前的可视集一致。
                const filter: ObserveRowFilter = {
                  needle: query.trim().toLowerCase(),
                  lens: lensActive,
                  fromMs: timeRange?.fromMs ?? null,
                  toMs: timeRange?.toMs ?? null,
                };
                const delta = headRows.filter((row) => observeRowPasses(row, filter)).length * OBSERVE_ROW_HEIGHT;
                el.scrollTop = previousTop + delta;
                setScroll({ top: el.scrollTop, height: el.clientHeight });
                requestAnimationFrame(() => {
                  selfScroll.current = false;
                });
              });
            });
          }
        }}
        // 历史页在顶部插入后由上面的行高差显式恢复视口;关闭浏览器锚定以免双重补偿。
        className="min-h-0 flex-1 overflow-y-auto py-1 font-mono ui-micro [overflow-anchor:none]"
      >
        {effective.length === 0 ? (
          snapshot.status === "live" || snapshot.status === "idle" ? (
            <p data-testid={`observe-empty-${kind}`} className="px-3 py-2 text-text-faint">
              {snapshot.status === "idle" || !snapshot.caughtUp
                ? t("views.daemonObserve.loading")
                : snapshot.rows.length > 0
                  ? t("views.daemonObserve.noMatch")
                  : t("views.daemonObserve.waitingNew")}
            </p>
          ) : null
        ) : (
          <ol data-testid={`observe-rows-${kind}`}>
            {rowWindow.start === 0 ? null : <li aria-hidden style={{ height: rowWindow.start * OBSERVE_ROW_HEIGHT }} />}
            {visible.map((row) => (
              <ObserveRowView
                key={row.key}
                row={row}
                onNavigateEntity={onNavigateEntity}
                onFocusMethod={methodFocusHandler}
              />
            ))}
            {rowWindow.end >= effective.length ? null : (
              <li aria-hidden style={{ height: (effective.length - rowWindow.end) * OBSERVE_ROW_HEIGHT }} />
            )}
          </ol>
        )}
      </div>
      {!following ? (
        <button
          type="button"
          data-testid={`observe-jump-${kind}`}
          onClick={() => setFollowing(true)}
          className={PANE_JUMP_BUTTON}
        >
          <ArrowLineDown />
          {t("views.daemonObserve.jumpLatest")}
        </button>
      ) : null}
    </section>
  );
}

/**
 * 单行渲染:memo 化后行对象在快照间保持同一引用,窗口平移只挂/卸进出窗口的行,
 * 留在窗口内的行不重渲。高度由内联 style 固定为 OBSERVE_ROW_HEIGHT(窗口化的前提)。
 * 日志行的方法列可点(透镜收敛双栏过滤);事件行的实体 chip 仍是实体导航出口。
 */
const ObserveRowView = memo(function ObserveRowView({
  row,
  onNavigateEntity,
  onFocusMethod,
}: {
  readonly row: ObserveRow;
  readonly onNavigateEntity: (ref: string) => void;
  readonly onFocusMethod: ((method: string) => void) | undefined;
}) {
  if (row.gapMarker !== null)
    return (
      <li
        data-testid="observe-gap-marker"
        style={{ height: OBSERVE_ROW_HEIGHT }}
        className={
          "flex items-center overflow-hidden border-y border-dashed border-stale/50 " +
          "bg-stale/5 px-2 ui-micro text-stale"
        }
      >
        {t("views.daemonObserve.gapMarker", { fileId: row.gapMarker.requestedFileId })}
      </li>
    );
  const time = row.at === null ? "—" : (formatTime(row.at, { style: "time-seconds" }) ?? row.at);
  return (
    <li
      data-testid="observe-row"
      title={row.detail}
      style={{ height: OBSERVE_ROW_HEIGHT }}
      className="flex items-center gap-2 overflow-hidden px-2 hover:bg-surface-raised/60"
    >
      <span className="shrink-0 text-text-faint">{time}</span>
      {row.revision === null ? null : <span className="shrink-0 text-text-faint">#{row.revision}</span>}
      {onFocusMethod !== undefined && row.durationMs !== null ? (
        <button
          type="button"
          data-testid="observe-method-focus"
          title={t("views.daemonObserve.methodFocusTip")}
          onClick={() => onFocusMethod(row.type)}
          className={`shrink-0 ${rowTone(row.ok)} hover:underline`}
        >
          {row.type}
        </button>
      ) : (
        <span className={`shrink-0 ${rowTone(row.ok)}`}>{row.type}</span>
      )}
      <span className="min-w-0 flex-1 truncate text-text-muted">{row.text}</span>
      <span className="flex shrink-0 items-baseline gap-1.5">
        {row.refs.map((chip) => (
          <EntityRefLink
            key={chip.ref}
            entityRef={chip.ref}
            onNavigate={onNavigateEntity}
            title={chip.ref}
            className="inline-flex items-baseline gap-0.5 font-mono ui-micro text-accent hover:underline"
          >
            <span className="text-text-faint">{chip.kind}</span>
            <span className="max-w-[16ch] truncate">{chip.label}</span>
          </EntityRefLink>
        ))}
      </span>
    </li>
  );
});

/** 透镜候选分组:空组剔除;候选点击写入视图级 lens,双栏一起收敛。 */
function lensGroupsOf(stats: ObserveStats): readonly (readonly [string, readonly ObserveLensValue[]])[] {
  return (
    [
      [t("views.daemonObserve.lensTasks"), stats.lens.tasks],
      [t("views.daemonObserve.lensSessions"), stats.lens.sessions],
      [t("views.daemonObserve.lensMethods"), stats.lens.methods],
      [t("views.daemonObserve.lensNodes"), stats.lens.nodes],
    ] as const
  ).filter((group) => group[1].length > 0);
}

function unavailableText(snapshot: ObserveTailSnapshot): string {
  const detail = snapshot.unavailable;
  if (detail === null) return "";
  if (detail.reason === "center-request-log-not-wired") return t("views.daemonObserve.unavailableCenterLog");
  const revision =
    detail.centerRevision === null
      ? ""
      : ` ${t("views.daemonObserve.centerRevision", { revision: String(detail.centerRevision) })}`;
  return `${t("views.daemonObserve.unavailableEdge")}${revision}`;
}

function gapText(snapshot: ObserveTailSnapshot): string {
  const detail = snapshot.gap;
  if (detail === null) return "";
  const reason =
    detail.reason === "cursor-offset-out-of-range"
      ? t("views.daemonObserve.gapOutOfRange")
      : t("views.daemonObserve.gapNotRetained");
  return `${reason} fileId=${detail.requestedFileId} · ${t("views.daemonObserve.gapResync")}`;
}

/** 初始反向读最新页;live cursor 向前轮询,history cursor 只在触顶时向后翻页。 */
function useObserveTail(
  repoId: string,
  kind: ObserveTailKind,
  paused: boolean,
): {
  readonly snapshot: ObserveTailSnapshot;
  readonly loadHistory: () => Promise<readonly ObserveRow[]>;
  readonly setViewing: (viewing: "follow" | "history") => void;
} {
  const [snapshot, setSnapshot] = useState<ObserveTailSnapshot>(initialObserveTail),
    snapshotRef = useRef<ObserveTailSnapshot>(snapshot),
    historyCursorRef = useRef<ObserveTailCursor>(null),
    liveCursorRef = useRef<ObserveTailCursor>(null),
    initializedRef = useRef(false),
    historyLoadingRef = useRef(false),
    requestEpochRef = useRef(0);

  useEffect(() => {
    const initial = initialObserveTail();
    requestEpochRef.current += 1;
    snapshotRef.current = initial;
    historyCursorRef.current = null;
    liveCursorRef.current = null;
    initializedRef.current = false;
    historyLoadingRef.current = false;
    setSnapshot(initial);
  }, [repoId, kind]);

  // snapshotRef 是唯一事实源:先同步算出 next 再 setSnapshot,任何 await 后读 ref 都是最新。
  const commit = useCallback((next: ObserveTailSnapshot) => {
    snapshotRef.current = next;
    setSnapshot(next);
  }, []);

  const applyPage = useCallback(
    (page: ObserveTailRead) => {
      if (page.status === "unavailable") {
        historyCursorRef.current = null;
        liveCursorRef.current = null;
        initializedRef.current = false;
      } else if (page.status === "gap") {
        if (page.direction === "history") historyCursorRef.current = null;
        else {
          liveCursorRef.current = null;
          initializedRef.current = false;
        }
      } else if (page.direction === "history") {
        historyCursorRef.current = observePaneCursor(page.historyCursor);
        if (!initializedRef.current) {
          liveCursorRef.current = observePaneCursor(page.liveCursor);
          initializedRef.current = page.liveCursor !== null;
        }
      } else {
        liveCursorRef.current = observePaneCursor(page.liveCursor);
      }
      commit(applyObserveTailPage(snapshotRef.current, page));
    },
    [commit],
  );

  /** 视图按滚动位置写入用户视角(贴底追尾 / 回看历史),只影响 follow 增长是否裁剪。 */
  const setViewing = useCallback(
    (viewing: "follow" | "history") => {
      commit(applyObserveViewing(snapshotRef.current, viewing));
    },
    [commit],
  );

  /**
   * 触顶向后翻一页历史;返回新插入行头的行(空数组 = 没有新增),供视图按
   * 「新增行 × 固定行高」锚定滚动位置。
   */
  const loadHistory = useCallback(async (): Promise<readonly ObserveRow[]> => {
    const cursor = historyCursorRef.current;
    if (!initializedRef.current || snapshotRef.current.historyDone || cursor === null || historyLoadingRef.current)
      return [];
    const epoch = requestEpochRef.current;
    historyLoadingRef.current = true;
    try {
      const page = await harnessClient.tailObservability(observeTailRequest(repoId, kind, "history", cursor));
      if (epoch !== requestEpochRef.current) return [];
      const before = snapshotRef.current.rows.length;
      applyPage(page);
      const grown = snapshotRef.current.rows.length - before;
      return grown > 0 ? snapshotRef.current.rows.slice(0, grown) : [];
    } catch (error) {
      consumeKnownError(error);
      if (epoch !== requestEpochRef.current) return [];
      const message = error instanceof Error ? error.message : String(error);
      commit(applyObserveTailError(snapshotRef.current, message));
      return [];
    } finally {
      if (epoch === requestEpochRef.current) historyLoadingRef.current = false;
    }
  }, [applyPage, commit, kind, repoId]);

  useEffect(() => {
    if (paused) return;
    let cancelled = false,
      timer: ReturnType<typeof setTimeout> | undefined;
    const run = async () => {
      while (!cancelled) {
        let delay = TAIL_FOLLOW_MS;
        try {
          const bootstrapping = !initializedRef.current,
            page: ObserveTailRead = await harnessClient.tailObservability(
              bootstrapping
                ? observeTailRequest(repoId, kind, "history", null)
                : observeTailRequest(repoId, kind, "follow", liveCursorRef.current),
            );
          if (cancelled) return;
          applyPage(page);
          delay =
            page.status === "unavailable"
              ? TAIL_UNAVAILABLE_MS
              : page.direction === "history"
                ? page.status === "pending"
                  ? TAIL_PENDING_MS
                  : TAIL_FOLLOW_MS
                : page.done
                  ? TAIL_FOLLOW_MS
                  : page.status === "pending" || page.status === "gap"
                    ? TAIL_PENDING_MS
                    : TAIL_CATCHUP_MS;
        } catch (error) {
          // 失败被投影为可读横幅(applyObserveTailError),不是吞掉;显式标记以满足门。
          consumeKnownError(error);
          if (cancelled) return;
          const message = error instanceof Error ? error.message : String(error);
          commit(applyObserveTailError(snapshotRef.current, message));
          delay = TAIL_ERROR_MS;
        }
        await new Promise<void>((resolve) => {
          timer = setTimeout(resolve, delay);
        });
      }
    };
    void run();
    return () => {
      cancelled = true;
      if (timer !== undefined) clearTimeout(timer);
    };
  }, [applyPage, commit, repoId, kind, paused]);
  return { snapshot, loadHistory, setViewing };
}
