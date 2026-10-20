import { useEffect, useMemo, useState } from "react";
import { motion, useReducedMotion } from "motion/react";
import { ChatCircleDots } from "@phosphor-icons/react";
import { formatDuration } from "../../model/time.ts";
import { ACTIVITY_COLOR, ACTIVITY_LABEL, type AgentActivity } from "./AgentTree.tsx";

/**
 * 多 Agent 实时水平时间线泳道(dec_C0AF8CBBFFECF71F4F34FB76F9 CH2 / Affect UI
 * AgentLanes):每个 Agent/Worker 一条泳道,任务块按时间比例定位;运行中任务块随
 * now 生长(1s tick,nowMs 可注入);跨 Agent 派工/交接画 handoff 连线;阻塞块直接
 * 展示待拍板徽标与快捷动作。
 *
 * 时间轴窗口由数据推导:min(start) → max(end, now),两侧 5% 余量。连线用 SVG
 * preserveAspectRatio="none" + vector-effect="non-scaling-stroke":横向百分比定位,
 * 纵向按泳道固定行高,窗口缩放只拉伸曲线横向控制点,笔宽不受非均匀缩放影响。
 * 计时器纪律:注入 nowMs 时不建 interval;未注入时仅存在运行中任务块才 tick,
 * 卸载或全部收口即清理。
 */

export interface AgentLaneTask {
  readonly id: string;
  readonly label: string;
  /** 开始时间(ms epoch)。 */
  readonly startAt: number;
  /** 结束时间;null=运行中,任务块随 now 生长。 */
  readonly endAt: number | null;
  readonly status: AgentActivity;
  /** 阻塞待拍板:块上挂徽标与快捷动作(Orca:提问/阻塞必须一眼可分)。 */
  readonly awaiting?: { readonly question: string };
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

const ROW_H = 48;
const RULER_H = 22;
const PAD_RATIO = 0.05;
/** 连线 SVG 的逻辑横向分辨率;真实容器宽度按百分比拉伸。 */
const SVG_W = 1000;

export function AgentLanes({
  lanes,
  handoffs = [],
  nowMs,
  onResolveAwaiting,
  testId,
}: {
  readonly lanes: readonly AgentLane[];
  readonly handoffs?: readonly AgentHandoff[];
  /** 测试注入的基准时间;给出时不建 interval,布局完全确定。 */
  readonly nowMs?: number;
  /** 待拍板快捷动作;缺省时徽标退化为纯展示。 */
  readonly onResolveAwaiting?: (taskId: string) => void;
  readonly testId?: string;
}) {
  const reducedMotion = useReducedMotion();
  const [liveNow, setLiveNow] = useState(() => nowMs ?? Date.now());
  const now = nowMs ?? liveNow;
  const hasRunning = useMemo(() => lanes.some((lane) => lane.tasks.some((task) => task.endAt === null)), [lanes]);

  useEffect(() => {
    if (nowMs !== undefined || !hasRunning) return;
    const timer = setInterval(() => setLiveNow(Date.now()), 1_000);
    return () => clearInterval(timer);
  }, [nowMs, hasRunning]);

  const taskIndex = useMemo(() => {
    const index = new Map<string, { lane: number; task: AgentLaneTask }>();
    lanes.forEach((lane, laneIndex) => {
      for (const task of lane.tasks) index.set(task.id, { lane: laneIndex, task });
    });
    return index;
  }, [lanes]);

  const { t0, t1 } = useMemo(() => {
    const starts = lanes.flatMap((lane) => lane.tasks.map((task) => task.startAt));
    const ends = lanes.flatMap((lane) => lane.tasks.map((task) => task.endAt ?? now));
    if (starts.length === 0) return { t0: now - 300_000, t1: now };
    const rawT0 = Math.min(...starts);
    const rawT1 = Math.max(...ends, now);
    const pad = Math.max((rawT1 - rawT0) * PAD_RATIO, 1_000);
    return { t0: rawT0 - pad, t1: rawT1 + pad };
  }, [lanes, now]);
  const span = t1 - t0;
  const pct = (at: number) => ((at - t0) / span) * 100;
  const svgX = (at: number) => (pct(at) / 100) * SVG_W;
  const laneCenterY = (lane: number) => RULER_H + lane * ROW_H + ROW_H / 2;
  const totalH = RULER_H + lanes.length * ROW_H;

  const ticks = useMemo(() => {
    const count = 5;
    return Array.from({ length: count + 1 }, (_, index) => {
      const at = t0 + (span / count) * index;
      const delta = at - now;
      return {
        at,
        left: pct(at),
        label:
          Math.abs(delta) < span / count / 2 ? "现在" : `${delta < 0 ? "−" : "+"}${formatDuration(Math.abs(delta))}`,
      };
    });
  }, [t0, span, now]);

  const connections = useMemo(
    () =>
      handoffs
        .map((handoff) => {
          const from = taskIndex.get(handoff.fromTaskId);
          const to = taskIndex.get(handoff.toTaskId);
          if (from === undefined || to === undefined) return null;
          const x1 = svgX(from.task.endAt ?? now);
          const y1 = laneCenterY(from.lane);
          const x2 = svgX(to.task.startAt);
          const y2 = laneCenterY(to.lane);
          const dx = (x2 - x1) * 0.45;
          return {
            key: `${handoff.fromTaskId}->${handoff.toTaskId}`,
            label: handoff.label,
            d: `M ${x1} ${y1} C ${x1 + dx} ${y1}, ${x2 - dx} ${y2}, ${x2} ${y2}`,
            fromLeft: pct(from.task.endAt ?? now),
            fromTop: laneCenterY(from.lane),
            toLeft: pct(to.task.startAt),
            toTop: laneCenterY(to.lane),
          };
        })
        .filter((connection): connection is NonNullable<typeof connection> => connection !== null),
    [handoffs, taskIndex, now, span, t0],
  );

  const scaleBarWidthPct = (60_000 / span) * 100;
  const showScaleBar = scaleBarWidthPct >= 2 && scaleBarWidthPct <= 50;

  return (
    <div data-testid={testId} className="flex min-w-0 flex-col gap-1.5">
      <div className="overflow-x-auto">
        <div className="relative min-w-[640px]">
          <div className="flex">
            <div className="w-36 shrink-0" />
            <div className="relative min-w-0 flex-1" style={{ height: totalH }}>
              {/* 时间轴比例尺 */}
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
              {/* handoff 连线 */}
              <svg
                aria-hidden
                viewBox={`0 0 ${SVG_W} ${totalH}`}
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
                      <title>{connection.label ?? "派工 / 交接"}</title>
                    </path>
                  </g>
                ))}
              </svg>
              {/* 连线端点(HTML 圆点,避免非均匀缩放压扁) */}
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
              {/* 泳道 */}
              {lanes.map((lane, laneIndex) => (
                <div key={lane.agentId}>
                  <div
                    aria-hidden
                    className="absolute left-0 w-full border-t border-border"
                    style={{ top: RULER_H + laneIndex * ROW_H, height: ROW_H }}
                  />
                  {lane.tasks.map((task) => {
                    const startPct = pct(task.startAt);
                    const endAt = task.endAt ?? now;
                    const widthPct = Math.max(pct(endAt) - startPct, 0.6);
                    const color = ACTIVITY_COLOR[task.status];
                    const running = task.endAt === null;
                    return (
                      <div
                        key={task.id}
                        tabIndex={0}
                        role="group"
                        aria-label={`${lane.role}：${task.label}，${ACTIVITY_LABEL[task.status]}${task.awaiting !== undefined ? "，阻塞待拍板" : ""}`}
                        data-testid={testId !== undefined ? `${testId}-task-${task.id}` : undefined}
                        data-lane-status={task.status}
                        className="absolute flex min-w-0 items-center gap-1.5 overflow-hidden rounded-sm border px-2"
                        style={{
                          left: `${startPct}%`,
                          width: `${widthPct}%`,
                          top: RULER_H + laneIndex * ROW_H + 7,
                          height: ROW_H - 16,
                          borderColor:
                            task.awaiting !== undefined
                              ? "color-mix(in oklch, var(--color-agent-question) 52%, transparent)"
                              : `color-mix(in oklch, ${color} 45%, transparent)`,
                          background: `color-mix(in oklch, ${color} 14%, transparent)`,
                        }}
                      >
                        {running && (
                          <motion.span
                            aria-hidden
                            className="size-[5px] shrink-0 rounded-full"
                            style={{ background: color }}
                            animate={reducedMotion ? undefined : { opacity: [0.45, 1, 0.45] }}
                            transition={{ duration: 1.6, repeat: Infinity, ease: "easeInOut" }}
                          />
                        )}
                        <span className="min-w-0 truncate ui-micro">{task.label}</span>
                        {task.awaiting !== undefined && (
                          <button
                            type="button"
                            data-tip={task.awaiting.question}
                            data-testid={testId !== undefined ? `${testId}-resolve-${task.id}` : undefined}
                            onClick={onResolveAwaiting !== undefined ? () => onResolveAwaiting(task.id) : undefined}
                            disabled={onResolveAwaiting === undefined}
                            className="ml-auto inline-flex shrink-0 items-center gap-1 rounded-xs px-1 py-px font-semibold ui-micro"
                            style={{
                              color: "var(--color-agent-question-text)",
                              background: "var(--color-agent-question-surface)",
                            }}
                          >
                            <ChatCircleDots aria-hidden />
                            待拍板
                          </button>
                        )}
                      </div>
                    );
                  })}
                </div>
              ))}
            </div>
          </div>
          {/* 泳道标签列(叠在轨道左侧,随轨道同滚) */}
          <div className="pointer-events-none absolute left-0 top-0 w-36">
            {lanes.map((lane, laneIndex) => (
              <div
                key={lane.agentId}
                className="absolute flex items-center pr-2"
                style={{ top: RULER_H + laneIndex * ROW_H, height: ROW_H }}
              >
                <span className="min-w-0 truncate font-semibold ui-micro text-text-muted">{lane.role}</span>
              </div>
            ))}
          </div>
        </div>
      </div>
      {/* 比例尺与图例 */}
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 ui-micro text-text-faint">
        {showScaleBar && (
          <span className="inline-flex items-center gap-1" aria-hidden>
            <i className="inline-block h-px w-10 border-t border-border-strong" />
            1m
          </span>
        )}
        {(["running", "awaiting", "done", "failed", "idle"] as const).map((status) => (
          <span key={status} className="inline-flex items-center gap-1">
            <i
              aria-hidden
              className="inline-block size-2 rounded-[2px]"
              style={{ background: ACTIVITY_COLOR[status] }}
            />
            {ACTIVITY_LABEL[status]}
          </span>
        ))}
        <span className="inline-flex items-center gap-1">
          <i aria-hidden className="inline-block h-px w-6 border-t border-dashed border-border-strong" />
          派工 / 交接
        </span>
        <span className="inline-flex items-center gap-1">
          <i aria-hidden className="inline-block h-3 w-px bg-accent" />
          现在
        </span>
      </div>
    </div>
  );
}
