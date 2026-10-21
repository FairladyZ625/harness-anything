import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { motion, useReducedMotion } from "motion/react";
import { ChatCircleDots } from "@phosphor-icons/react";
import { t } from "../../i18n/index.tsx";
import { Button } from "../primitives/Button.tsx";
import { SegCtl } from "../primitives/SegCtl.tsx";
import { StatusTag } from "../primitives/StatusTag.tsx";
import { CacheTimer, type PromptCacheTtlState } from "./CacheTimer.tsx";
import { ACTIVITY_COLOR, ACTIVITY_KEY, ACTIVITY_TONE, type AgentActivity } from "./AgentTree.tsx";

/**
 * 多 Agent 实时水平时间线泳道:同一 Agent 的任务按开始时间贪心分配到第一个空闲子轨,
 * 时间窗默认覆盖近期活动,窗口外但仍相交的任务从边缘截断。跨 Agent 派工/交接使用
 * 实际子轨中心连线;阻塞徽标、缓存倒计时与状态词继续复用现有原语。
 */

export interface AgentLaneTask {
  /** 块 id:派工/运行会话 id,不是任务 id。 */
  readonly id: string;
  /** 块背后的任务 id;缺省表示该块没有可打开的任务(纯展示)。 */
  readonly taskId?: string;
  readonly label: string;
  /** 开始时间(ms epoch)。 */
  readonly startAt: number;
  /** 结束时间;null=运行中,任务块随 now 生长。 */
  readonly endAt: number | null;
  readonly status: AgentActivity;
  /** 阻塞待拍板:块上挂徽标与快捷动作(Orca:提问/阻塞必须一眼可分)。 */
  readonly awaiting?: { readonly question: string };
  /** Prompt Cache TTL 三态由模型层算好传入;无触达证据时缺省。 */
  readonly cacheTtl?: { readonly state: PromptCacheTtlState; readonly remainingMs: number };
}

export interface AgentLane {
  readonly agentId: string;
  readonly role: string;
  readonly tasks: readonly AgentLaneTask[];
}

export interface AgentHandoff {
  /** 派工/交接源任务块 id。 */
  readonly fromTaskId: string;
  readonly toTaskId: string;
  readonly label?: string;
}

const ROW_H = 40;
const RULER_H = 22;
const LABEL_COLUMN_W = 144;
const MIN_BLOCK_WIDTH_PX = 8;
const READABLE_BLOCK_WIDTH_PX = 96;
/** 连线 SVG 的逻辑横向分辨率;真实容器宽度按百分比拉伸。 */
const SVG_W = 1000;
const MINUTES = 60_000;

const TIME_RANGES = [
  { key: "15m", ms: 15 * MINUTES, label: "agentUi.lanes.range15m" },
  { key: "30m", ms: 30 * MINUTES, label: "agentUi.lanes.range30m" },
  { key: "1h", ms: 60 * MINUTES, label: "agentUi.lanes.range1h" },
  { key: "3h", ms: 3 * 60 * MINUTES, label: "agentUi.lanes.range3h" },
  { key: "6h", ms: 6 * 60 * MINUTES, label: "agentUi.lanes.range6h" },
] as const;

type LaneRange = (typeof TIME_RANGES)[number]["key"];

const RANGE_MS: Readonly<Record<LaneRange, number>> = {
  "15m": 15 * MINUTES,
  "30m": 30 * MINUTES,
  "1h": 60 * MINUTES,
  "3h": 3 * 60 * MINUTES,
  "6h": 6 * 60 * MINUTES,
};

interface TaskPlacement {
  readonly laneIndex: number;
  readonly laneTop: number;
  readonly trackIndex: number;
  readonly trackCenterY: number;
  readonly startAt: number;
  readonly endAt: number;
  readonly task: AgentLaneTask;
}

interface LanePlacement {
  readonly top: number;
  readonly height: number;
  readonly trackCount: number;
}

function defaultRangeFor(lanes: readonly AgentLane[], now: number): LaneRange {
  const ages = lanes
    .flatMap((lane) => lane.tasks.map((task) => Math.max(0, now - task.startAt)))
    .sort((left, right) => left - right);
  if (ages.length === 0) return "1h";

  // Cover most recent work while a single old dispatch cannot expand the overview for every agent.
  const typicalAge = ages[Math.floor((ages.length - 1) * 0.75)]!;
  const desiredWindow = Math.max(15 * MINUTES, typicalAge);
  return TIME_RANGES.find((range) => range.ms >= desiredWindow)?.key ?? "6h";
}

function tickStepFor(span: number): number {
  const target = span / 5.5;
  return (
    [MINUTES, 5 * MINUTES, 10 * MINUTES, 15 * MINUTES, 30 * MINUTES, 60 * MINUTES].find((step) => step >= target) ??
    60 * MINUTES
  );
}

function minuteLabel(deltaMs: number): string {
  const totalMinutes = Math.max(1, Math.round(Math.abs(deltaMs) / MINUTES));
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  const body = hours === 0 ? `${totalMinutes}m` : minutes === 0 ? `${hours}h` : `${hours}h ${minutes}m`;
  return `${deltaMs < 0 ? "−" : "+"}${body}`;
}

function layoutsFor(
  lanes: readonly AgentLane[],
  now: number,
  t0: number,
  t1: number,
  trackWidth: number,
): {
  readonly lanes: readonly LanePlacement[];
  readonly tasks: ReadonlyMap<string, TaskPlacement>;
  readonly totalHeight: number;
} {
  const span = t1 - t0;
  const minimumDuration = Math.min(span, (span * MIN_BLOCK_WIDTH_PX) / Math.max(trackWidth, MIN_BLOCK_WIDTH_PX));
  const laneLayouts: LanePlacement[] = [];
  const taskLayouts = new Map<string, TaskPlacement>();
  let laneTop = 0;

  lanes.forEach((lane, laneIndex) => {
    const visibleTasks = lane.tasks
      .map((task, inputIndex) => ({ task, inputIndex, endAt: Math.max(task.startAt, task.endAt ?? now) }))
      .filter(({ task, endAt }) => endAt >= t0 && task.startAt <= t1)
      .map(({ task, inputIndex, endAt }) => {
        const startAt = Math.max(task.startAt, t0);
        const renderStart = Math.min(startAt, t1 - minimumDuration);
        const renderEnd = Math.min(t1, Math.max(Math.min(endAt, t1), renderStart + minimumDuration));
        return { task, inputIndex, startAt: renderStart, endAt: renderEnd };
      })
      .sort((left, right) => left.startAt - right.startAt || left.inputIndex - right.inputIndex);
    const trackEnds: number[] = [];

    for (const { task, startAt, endAt } of visibleTasks) {
      let trackIndex = trackEnds.findIndex((trackEnd) => trackEnd <= startAt);
      if (trackIndex < 0) {
        trackIndex = trackEnds.length;
        trackEnds.push(endAt);
      } else {
        trackEnds[trackIndex] = endAt;
      }
      taskLayouts.set(task.id, {
        laneIndex,
        laneTop,
        trackIndex,
        trackCenterY: RULER_H + laneTop + trackIndex * ROW_H + ROW_H / 2,
        startAt,
        endAt,
        task,
      });
    }

    const trackCount = Math.max(trackEnds.length, 1);
    const height = trackCount * ROW_H;
    laneLayouts.push({ top: laneTop, height, trackCount });
    laneTop += height;
  });

  return { lanes: laneLayouts, tasks: taskLayouts, totalHeight: RULER_H + laneTop };
}

export function AgentLanes({
  lanes,
  handoffs = [],
  nowMs,
  onResolveAwaiting,
  onOpenTask,
  testId,
}: {
  readonly lanes: readonly AgentLane[];
  readonly handoffs?: readonly AgentHandoff[];
  /** 测试注入的基准时间;给出时不建 interval,布局完全确定。 */
  readonly nowMs?: number;
  /** 待拍板快捷动作;缺省时徽标退化为纯展示。 */
  readonly onResolveAwaiting?: (taskId: string) => void;
  /** 点任务块跳转对应任务详情;缺省(或块无 taskId)时块保持纯展示。 */
  readonly onOpenTask?: (taskId: string) => void;
  readonly testId?: string;
}) {
  const reducedMotion = useReducedMotion();
  const [liveNow, setLiveNow] = useState(() => nowMs ?? Date.now());
  const now = nowMs ?? liveNow;
  const [rangeOverride, setRangeOverride] = useState<LaneRange | null>(null);
  const autoRange = useMemo(() => defaultRangeFor(lanes, now), [lanes, now]);
  const range = rangeOverride ?? autoRange;
  const t1 = now;
  const t0 = now - RANGE_MS[range];
  const span = t1 - t0;
  const trackRef = useRef<HTMLDivElement>(null);
  const [trackWidth, setTrackWidth] = useState(640 - LABEL_COLUMN_W);
  const hasRunning = useMemo(() => lanes.some((lane) => lane.tasks.some((task) => task.endAt === null)), [lanes]);

  useEffect(() => {
    if (nowMs !== undefined || !hasRunning) return;
    const timer = setInterval(() => setLiveNow(Date.now()), 1_000);
    return () => clearInterval(timer);
  }, [nowMs, hasRunning]);

  useEffect(() => {
    const element = trackRef.current;
    if (element === null) return;
    const measure = () => {
      const width = element.getBoundingClientRect().width || element.clientWidth;
      if (width > 0) setTrackWidth(Math.round(width));
    };
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  const layout = useMemo(() => layoutsFor(lanes, now, t0, t1, trackWidth), [lanes, now, t0, t1, trackWidth]);
  const pct = (at: number) => ((at - t0) / span) * 100;

  const ticks = useMemo(() => {
    const step = tickStepFor(span);
    const stepMs = step;
    const first = Math.ceil(t0 / stepMs) * stepMs;
    const output: { readonly at: number; readonly left: number; readonly label: string }[] = [];
    for (let at = first; at <= now; at += stepMs) {
      const delta = at - now;
      output.push({
        at,
        left: ((at - t0) / span) * 100,
        label: Math.abs(delta) < stepMs / 2 ? t("agentUi.lanes.now") : minuteLabel(delta),
      });
    }
    return output;
  }, [t0, span, now]);

  const connections = useMemo(
    () =>
      handoffs
        .map((handoff) => {
          const from = layout.tasks.get(handoff.fromTaskId);
          const to = layout.tasks.get(handoff.toTaskId);
          if (from === undefined || to === undefined) return null;
          const fromAt = from.task.endAt ?? now;
          const toAt = to.task.startAt;
          const positionPct = (at: number) => Math.max(0, Math.min(100, ((at - t0) / span) * 100));
          const fromLeft = positionPct(fromAt);
          const toLeft = positionPct(toAt);
          const x1 = (fromLeft / 100) * SVG_W;
          const y1 = from.trackCenterY;
          const x2 = (toLeft / 100) * SVG_W;
          const y2 = to.trackCenterY;
          const dx = (x2 - x1) * 0.45;
          return {
            key: `${handoff.fromTaskId}->${handoff.toTaskId}`,
            label: handoff.label,
            d: `M ${x1} ${y1} C ${x1 + dx} ${y1}, ${x2 - dx} ${y2}, ${x2} ${y2}`,
            fromLeft,
            fromTop: from.trackCenterY,
            toLeft,
            toTop: to.trackCenterY,
          };
        })
        .filter((connection): connection is NonNullable<typeof connection> => connection !== null),
    [handoffs, layout, now, span, t0],
  );

  const scaleBarWidthPct = (MINUTES / span) * 100;
  const showScaleBar = scaleBarWidthPct >= 2 && scaleBarWidthPct <= 50;
  const rangeOptions = TIME_RANGES.map((option) => ({
    value: option.key,
    label: t(option.label),
    testId: testId !== undefined ? `${testId}-range-${option.key}` : undefined,
  }));

  return (
    <div data-testid={testId} className="flex min-w-0 flex-col gap-1.5">
      <SegCtl label={t("agentUi.lanes.rangeLabel")} value={range} onChange={setRangeOverride} options={rangeOptions} />
      <div className="overflow-x-auto">
        <div className="relative min-w-[640px]">
          <div className="flex">
            <div
              data-testid={testId !== undefined ? `${testId}-labels` : undefined}
              className="w-36 shrink-0"
              style={{ width: LABEL_COLUMN_W, height: layout.totalHeight }}
            >
              <div aria-hidden style={{ height: RULER_H }} />
              {lanes.map((lane, laneIndex) => {
                const laneLayout = layout.lanes[laneIndex]!;
                return (
                  <div key={lane.agentId} className="flex items-center pr-2" style={{ height: laneLayout.height }}>
                    <span className="min-w-0 truncate font-semibold ui-micro text-text-muted">{lane.role}</span>
                  </div>
                );
              })}
            </div>
            <div
              ref={trackRef}
              data-testid={testId !== undefined ? `${testId}-track` : undefined}
              data-height={layout.totalHeight}
              data-lane-track-count={Math.max(0, ...layout.lanes.map((lane) => lane.trackCount))}
              className="relative min-w-0 flex-1"
              style={{ height: layout.totalHeight }}
            >
              {/* 时间轴:刻度落在整分钟边界,窗口外区间从容器边缘开始/结束。 */}
              {ticks.map((tick) => (
                <div
                  key={tick.at}
                  aria-hidden
                  className="absolute top-0 border-l border-border"
                  style={{ left: `${tick.left}%`, height: 6 }}
                />
              ))}
              <div aria-hidden className="absolute top-0 h-px w-full border-t border-border" style={{ marginTop: 6 }} />
              <div
                aria-hidden
                className="absolute left-0 w-full font-mono tabular-nums ui-micro text-text-faint"
                style={{ top: 8 }}
              >
                {ticks.map((tick) => (
                  <span
                    key={tick.at}
                    data-testid={testId !== undefined ? `${testId}-tick-label` : undefined}
                    className="absolute -translate-x-1/2 whitespace-nowrap"
                    style={{ left: `${tick.left}%` }}
                  >
                    {tick.label}
                  </span>
                ))}
              </div>
              {/* now 游标 */}
              <div
                aria-hidden
                className="absolute w-px bg-accent"
                style={{ left: `${pct(now)}%`, top: RULER_H - 4, bottom: 0, opacity: 0.55 }}
              />
              {/* handoff 连线按任务实际子轨中心定位 */}
              <svg
                aria-hidden
                viewBox={`0 0 ${SVG_W} ${layout.totalHeight}`}
                preserveAspectRatio="none"
                className="absolute inset-0 size-full"
              >
                {connections.map((connection) => (
                  <g key={connection.key}>
                    <path
                      d={connection.d}
                      fill="none"
                      stroke="var(--color-text-faint)"
                      strokeWidth={1.5}
                      strokeDasharray="6 4"
                      vectorEffect="non-scaling-stroke"
                    />
                    <path
                      d={connection.d}
                      fill="none"
                      stroke="transparent"
                      strokeWidth={14}
                      vectorEffect="non-scaling-stroke"
                      style={{ pointerEvents: "stroke" }}
                    >
                      <title>{connection.label ?? t("agentUi.lanes.handoff")}</title>
                    </path>
                  </g>
                ))}
              </svg>
              {connections.flatMap((connection) => [
                <span
                  key={`${connection.key}-from`}
                  aria-hidden
                  className="absolute size-1.5 -translate-x-1/2 -translate-y-1/2 rounded-full bg-text-faint"
                  style={{ left: `${connection.fromLeft}%`, top: connection.fromTop }}
                />,
                <span
                  key={`${connection.key}-to`}
                  aria-hidden
                  className="absolute size-1.5 -translate-x-1/2 -translate-y-1/2 rounded-full bg-text-faint"
                  style={{ left: `${connection.toLeft}%`, top: connection.toTop }}
                />,
              ])}
              {lanes.map((lane, laneIndex) => {
                const laneLayout = layout.lanes[laneIndex]!;
                return (
                  <div key={lane.agentId}>
                    <div
                      aria-hidden
                      className="absolute left-0 w-full border-t border-border"
                      style={{ top: RULER_H + laneLayout.top, height: laneLayout.height }}
                    />
                    {lane.tasks.map((task) => {
                      const placement = layout.tasks.get(task.id);
                      if (placement === undefined) return null;
                      const widthPct = Math.max(
                        ((placement.endAt - placement.startAt) / span) * 100,
                        (MIN_BLOCK_WIDTH_PX / Math.max(trackWidth, MIN_BLOCK_WIDTH_PX)) * 100,
                      );
                      const leftPct = Math.min(pct(placement.startAt), 100 - widthPct);
                      const widthPx = (widthPct / 100) * trackWidth;
                      const showDetails = widthPx >= READABLE_BLOCK_WIDTH_PX;
                      const color = ACTIVITY_COLOR[task.status];
                      const running = task.endAt === null;
                      const baseAria = t("agentUi.lanes.blockAria", {
                        agent: lane.role,
                        task: task.label,
                        status: t(ACTIVITY_KEY[task.status]),
                      });
                      const ariaLabel =
                        baseAria +
                        (task.awaiting !== undefined
                          ? `${t("agentUi.lanes.awaitingSuffix")}: ${task.awaiting.question}`
                          : "");
                      // 块 id 是派工/运行会话 id,不是任务 id:只有带真 taskId 的块才能跳转,
                      // 没有任务的块保持可聚焦的分组(纯展示),不给假入口。
                      const blockTaskId = task.taskId;
                      const openTask = onOpenTask;
                      const openDetail =
                        blockTaskId === undefined || openTask === undefined ? undefined : () => openTask(blockTaskId);
                      const resolveAwaiting = onResolveAwaiting;
                      return (
                        <div
                          key={task.id}
                          tabIndex={0}
                          role={openDetail === undefined ? "group" : "button"}
                          onClick={openDetail}
                          onKeyDown={
                            openDetail === undefined
                              ? undefined
                              : (event: KeyboardEvent<HTMLDivElement>) => {
                                  // 只认块自身发起的键事件:块内「待拍板」是原生 button,自带激活。
                                  if (event.target !== event.currentTarget) return;
                                  if (event.key === "Enter" || event.key === " ") {
                                    event.preventDefault();
                                    openDetail();
                                  }
                                }
                          }
                          title={ariaLabel}
                          aria-label={ariaLabel}
                          data-testid={testId !== undefined ? `${testId}-task-${task.id}` : undefined}
                          data-lane-status={task.status}
                          data-lane-track={placement.trackIndex}
                          className={`absolute flex min-w-0 items-center gap-1.5 overflow-hidden rounded-sm border ${openDetail === undefined ? "" : "cursor-pointer hover:brightness-110 active:brightness-95 focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent"} ${showDetails ? "px-2" : "justify-center px-0"}`}
                          style={{
                            left: `${leftPct}%`,
                            width: `${widthPct}%`,
                            minWidth: `${MIN_BLOCK_WIDTH_PX}px`,
                            top: RULER_H + placement.laneTop + placement.trackIndex * ROW_H + 7,
                            height: ROW_H - 14,
                            borderColor:
                              task.awaiting !== undefined
                                ? "color-mix(in oklch, var(--color-agent-question) 52%, transparent)"
                                : `color-mix(in oklch, ${color} 45%, transparent)`,
                            background: `color-mix(in oklch, ${color} 14%, transparent)`,
                          }}
                        >
                          {running ? (
                            <motion.span
                              aria-hidden
                              className="size-[5px] shrink-0 rounded-full"
                              style={{ background: color }}
                              animate={reducedMotion ? undefined : { opacity: [0.45, 1, 0.45] }}
                              transition={{ duration: 1.6, repeat: Infinity, ease: "easeInOut" }}
                            />
                          ) : (
                            <span
                              aria-hidden
                              className="size-[5px] shrink-0 rounded-full"
                              style={{ background: color }}
                            />
                          )}
                          {showDetails && <span className="min-w-0 truncate ui-micro">{task.label}</span>}
                          {showDetails && task.cacheTtl !== undefined && (
                            <CacheTimer
                              state={task.cacheTtl.state}
                              remainingMs={task.cacheTtl.remainingMs}
                              testId={testId !== undefined ? `${testId}-cache-${task.id}` : undefined}
                            />
                          )}
                          {showDetails && task.awaiting !== undefined && (
                            // 待拍板是块内的一等动作:点它只开答复面板,不冒泡成「打开任务」。
                            <span className="ml-auto inline-flex shrink-0" onClick={(event) => event.stopPropagation()}>
                              <Button
                                size="sm"
                                tip={task.awaiting.question}
                                testId={testId !== undefined ? `${testId}-resolve-${task.id}` : undefined}
                                onClick={resolveAwaiting === undefined ? undefined : () => resolveAwaiting(task.id)}
                                disabled={resolveAwaiting === undefined}
                              >
                                <ChatCircleDots aria-hidden />
                                {t("agentUi.lanes.awaiting")}
                              </Button>
                            </span>
                          )}
                        </div>
                      );
                    })}
                  </div>
                );
              })}
            </div>
          </div>
        </div>
      </div>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 ui-micro text-text-faint">
        {showScaleBar && (
          <span className="inline-flex items-center gap-1" aria-hidden>
            <i className="inline-block h-px w-10 border-t border-border-strong" />
            {t("agentUi.lanes.scaleOneMinute")}
          </span>
        )}
        {(["running", "awaiting", "done", "failed", "idle"] as const).map((status) => (
          <StatusTag key={status} tone={ACTIVITY_TONE[status]} label={t(ACTIVITY_KEY[status])} />
        ))}
        <span className="inline-flex items-center gap-1">
          <i aria-hidden className="inline-block h-px w-6 border-t border-dashed border-border-strong" />
          {t("agentUi.lanes.handoff")}
        </span>
        <span className="inline-flex items-center gap-1">
          <i aria-hidden className="inline-block h-3 w-px bg-accent" />
          {t("agentUi.lanes.now")}
        </span>
      </div>
    </div>
  );
}
