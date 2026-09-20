import { useMemo, useRef, useState } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { t } from "../../i18n/index.tsx";
import { formatTime } from "../../model/time.ts";
import { formatDurationMs } from "../scheduleRun/runMeta.ts";
import {
  CADENCE_MICRO_EVENTS,
  CADENCE_SEGMENT_ORDER,
  CADENCE_STAGE_ORDER,
  type CadenceFeedEvent,
  type CadenceStageId,
  type TaskRhythmEntry,
} from "../../model/cadence.ts";
import { EntityRefLink } from "../EntityRefLink.tsx";
import { Segmented } from "../ui/widgets.tsx";

/**
 * 任务节奏音轨:以 task 为叙事单元的时序阶梯。窗口化(react-virtual)保证 DOM 行数
 * 只随视口走——千级任务窗口下不整列表挂载;行高由 measureElement 实测收敛(展开行
 * 是深度分析面板,远高于估算)。点击行原地展开(漏斗 + 微型事件链),不直接路由;
 * 展开头部提供独立「进入详情」外链;行内实体 ID 一律走 EntityRefLink(G10)。
 */

export const RHYTHM_ROW_ESTIMATE_PX = 64,
  RHYTHM_OVERSCAN = 8,
  RHYTHM_INITIAL_RECT = { width: 480, height: 640 } as const;

type RhythmFilter = "all" | "inFlight" | "done" | "friction";

const FILTERS: readonly { readonly key: RhythmFilter; readonly label: () => string }[] = [
  { key: "all", label: () => t("views.cadence.rhythmFilterAll") },
  { key: "inFlight", label: () => t("views.cadence.rhythmFilterInFlight") },
  { key: "done", label: () => t("views.cadence.rhythmFilterDone") },
  { key: "friction", label: () => t("views.cadence.rhythmFilterFriction") },
];

function matchesFilter(entry: TaskRhythmEntry, filter: RhythmFilter): boolean {
  if (filter === "inFlight") return entry.status !== "done" && entry.status !== "cancelled";
  if (filter === "done") return entry.status === "done";
  if (filter === "friction") return entry.frictionTotal > 0;
  return true;
}

const STATUS_TONE: Record<string, string> = {
  active: "text-status-active",
  in_review: "text-status-in-review",
  submitted: "text-status-submitted",
  blocked: "text-status-blocked",
  done: "text-status-done",
};

function stageTone(entry: TaskRhythmEntry, stage: CadenceStageId): string {
  if (entry.stages[stage] === null) return "border-border bg-surface text-text-faint";
  if (stage === entry.currentStage && entry.status !== "done" && entry.status !== "cancelled")
    return "border-accent bg-accent/15 text-accent";
  return "border-border-strong bg-surface-raised text-text";
}

export function TaskRhythmTrack({
  entries,
  onNavigateEntity,
}: {
  readonly entries: readonly TaskRhythmEntry[];
  readonly onNavigateEntity: (ref: string) => void;
}) {
  const [filter, setFilter] = useState<RhythmFilter>("all"),
    [expandedIds, setExpandedIds] = useState<ReadonlySet<string>>(() => new Set()),
    scrollRef = useRef<HTMLDivElement>(null),
    visible = useMemo(() => entries.filter((entry) => matchesFilter(entry, filter)), [entries, filter]),
    virtualizer = useVirtualizer({
      count: visible.length,
      getScrollElement: () => scrollRef.current,
      estimateSize: () => RHYTHM_ROW_ESTIMATE_PX,
      overscan: RHYTHM_OVERSCAN,
      getItemKey: (index) => visible[index]!.taskId,
      initialRect: RHYTHM_INITIAL_RECT,
    }),
    toggleExpanded = (taskId: string): void => {
      setExpandedIds((previous) => {
        const next = new Set(previous);
        if (next.has(taskId)) next.delete(taskId);
        else next.add(taskId);
        return next;
      });
    };
  return (
    <section
      data-testid="cadence-rhythm"
      className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-lg border border-border bg-surface"
    >
      <header className="flex flex-wrap items-center justify-between gap-2 border-b border-border px-3 py-2">
        <h2 className="ui-body font-semibold">{t("views.cadence.rhythmTitle")}</h2>
        <Segmented
          value={filter}
          options={FILTERS.map(({ key, label }) => ({ key, label: label() }))}
          onChange={setFilter}
        />
      </header>
      {visible.length === 0 ? (
        <p data-testid="cadence-rhythm-empty" className="px-3 py-3 ui-meta text-text-faint">
          {t("views.cadence.rhythmEmpty")}
        </p>
      ) : (
        <div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto">
          <ol
            data-testid="cadence-rhythm-rows"
            className="relative shrink-0"
            style={{ height: virtualizer.getTotalSize() }}
          >
            {virtualizer.getVirtualItems().map((item) => {
              const entry = visible[item.index]!;
              return (
                <RhythmRow
                  key={item.key}
                  index={item.index}
                  measureRef={virtualizer.measureElement}
                  entry={entry}
                  expanded={expandedIds.has(entry.taskId)}
                  onToggle={toggleExpanded}
                  onNavigateEntity={onNavigateEntity}
                  style={{ transform: `translateY(${item.start}px)` }}
                />
              );
            })}
          </ol>
        </div>
      )}
    </section>
  );
}

function RhythmRow({
  entry,
  index,
  measureRef,
  expanded,
  onToggle,
  onNavigateEntity,
  style,
}: {
  readonly entry: TaskRhythmEntry;
  readonly index: number;
  readonly measureRef: (element: Element | null) => void;
  readonly expanded: boolean;
  readonly onToggle: (taskId: string) => void;
  readonly onNavigateEntity: (ref: string) => void;
  readonly style: React.CSSProperties;
}) {
  const lastAt = formatTime(entry.lastEventAt ?? "", { style: "time" });
  return (
    <li
      data-testid="cadence-rhythm-row"
      data-index={index}
      ref={measureRef}
      className="absolute inset-x-0 top-0 flex flex-col border-b border-border px-3 py-2 hover:bg-surface-raised/40"
      style={style}
    >
      <div className="flex items-start gap-3">
        <div className="flex min-w-0 flex-1 flex-col gap-1">
          <div className="flex min-w-0 items-center gap-2">
            <button
              type="button"
              data-testid="cadence-rhythm-toggle"
              aria-expanded={expanded}
              className="flex min-w-0 items-center gap-1 text-left ui-body text-text hover:text-accent"
              title={entry.title}
              onClick={() => onToggle(entry.taskId)}
            >
              <span
                aria-hidden
                className={`shrink-0 ui-micro text-text-faint transition-transform ${expanded ? "rotate-90" : ""}`}
              >
                ▶
              </span>
              <span className="min-w-0 truncate">{entry.title}</span>
            </button>
            <EntityRefLink
              entityRef={`task/${entry.taskId}`}
              onNavigate={onNavigateEntity}
              title={entry.taskId}
              className="font-mono ui-micro text-text-faint hover:text-accent hover:underline"
            >
              {entry.known ? null : <span className="mr-1">{t("views.cadence.rhythmUnknownRow")}</span>}
              {entry.taskId}
            </EntityRefLink>
            {entry.stalled ? (
              <span className="shrink-0 rounded bg-stale/15 px-1.5 py-0.5 ui-micro text-stale">
                {t("views.cadence.stalledBadge")}
              </span>
            ) : null}
            {entry.frictionTotal > 0 ? (
              <span className="shrink-0 rounded bg-status-blocked/10 px-1.5 py-0.5 ui-micro text-status-blocked">
                {t("views.cadence.frictionBadge", { count: entry.frictionTotal })}
              </span>
            ) : null}
          </div>
          <div className="flex flex-wrap items-center gap-1">
            {CADENCE_STAGE_ORDER.map((stage) => (
              <span
                key={stage}
                title={
                  entry.stages[stage] === null
                    ? undefined
                    : (formatTime(entry.stages[stage]!, { style: "time" }) ?? entry.stages[stage]!)
                }
                className={`rounded border px-1.5 py-0.5 font-mono ui-micro ${stageTone(entry, stage)}`}
              >
                {t(`views.cadence.stage.${stage}`)}
              </span>
            ))}
            <span className={`ml-1 font-mono ui-micro ${STATUS_TONE[entry.status] ?? "text-text-faint"}`}>
              {entry.eventCount === 0
                ? t("views.cadence.rhythmNoEvents")
                : t("views.cadence.rhythmEvents", { count: entry.eventCount })}
            </span>
            {entry.eventCount > 0 ? (
              <span
                className={`ml-1 font-mono ui-micro ${
                  entry.frictionTotal === 0 ? "text-status-done" : "text-status-blocked"
                }`}
              >
                {entry.frictionTotal === 0
                  ? t("views.cadence.rhythmFirstPass")
                  : t("views.cadence.rhythmRework", { count: entry.frictionTotal })}
              </span>
            ) : null}
            {entry.elapsedMs === null ? null : (
              <span className="ml-1 shrink-0 font-mono ui-micro text-text-faint">
                {t("views.cadence.rhythmElapsed", { duration: formatDurationMs(entry.elapsedMs) })}
              </span>
            )}
          </div>
        </div>
        <span className="shrink-0 font-mono ui-micro text-text-faint">{lastAt ?? ""}</span>
      </div>
      {expanded ? <RhythmDetail entry={entry} onNavigateEntity={onNavigateEntity} /> : null}
    </li>
  );
}

/** 展开后的深度分析面板:阶段耗时漏斗(瓶颈诊断)+ 微型事件链 + 进入详情外链。 */
function RhythmDetail({
  entry,
  onNavigateEntity,
}: {
  readonly entry: TaskRhythmEntry;
  readonly onNavigateEntity: (ref: string) => void;
}) {
  const timing = entry.timing,
    bottleneckSharePct = timing.bottleneckShare === null ? null : Math.round(timing.bottleneckShare * 100);
  return (
    <div
      data-testid="cadence-rhythm-detail"
      className="mt-2 flex flex-col gap-2.5 rounded-md border border-border bg-surface-raised/40 p-2.5"
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="font-mono ui-micro uppercase tracking-wide text-text-faint">{t("views.cadence.funnelTitle")}</p>
        <EntityRefLink
          entityRef={`task/${entry.taskId}`}
          onNavigate={onNavigateEntity}
          title={t("views.cadence.rhythmDetail")}
          className="rounded border border-border px-1.5 py-0.5 ui-micro text-text-muted hover:border-accent hover:text-accent"
        >
          {t("views.cadence.rhythmDetail")} ↗
        </EntityRefLink>
      </div>
      {timing.bottleneck === null || bottleneckSharePct === null ? null : (
        <p data-testid="cadence-funnel-bottleneck" className="ui-micro text-status-blocked">
          {t("views.cadence.funnelBottleneckDetail", {
            segment: t(`views.cadence.funnelSegment.${timing.bottleneck}`),
            share: bottleneckSharePct,
          })}
        </p>
      )}
      <ul data-testid="cadence-funnel" className="flex flex-col gap-1">
        {CADENCE_SEGMENT_ORDER.map((segment) => {
          const ms = timing.segments[segment],
            share = ms === null || timing.measuredMs <= 0 ? 0 : ms / timing.measuredMs,
            bottleneck = timing.bottleneck === segment;
          return (
            <li key={segment} className="flex min-w-0 items-center gap-2">
              <span className="w-44 shrink-0 ui-micro text-text-muted">
                {t(`views.cadence.funnelSegment.${segment}`)}
              </span>
              <span
                className={`h-2 min-w-1 shrink rounded-full ${bottleneck ? "bg-status-blocked/70" : "bg-accent/70"}`}
                style={{ width: `${segmentBarWidth(share)}%` }}
              />
              <span className={`shrink-0 font-mono ui-micro ${bottleneck ? "text-status-blocked" : "text-text-faint"}`}>
                {ms === null ? t("views.cadence.funnelSegmentUnknown") : formatDurationMs(ms)}
              </span>
              {bottleneck ? (
                <span
                  data-testid="cadence-funnel-bottleneck-badge"
                  className="shrink-0 rounded bg-status-blocked/10 px-1.5 py-0.5 ui-micro text-status-blocked"
                >
                  {t("views.cadence.funnelBottleneck", { share: Math.round(share * 100) })}
                </span>
              ) : null}
            </li>
          );
        })}
      </ul>
      <p className="flex flex-wrap items-baseline gap-2 ui-micro text-text-muted">
        <span>{t("views.cadence.funnelTurnaround")}</span>
        <span data-testid="cadence-funnel-turnaround" className="font-mono ui-micro text-text">
          {entry.deliveryMs === null ? t("views.cadence.funnelTurnaroundUnknown") : formatDurationMs(entry.deliveryMs)}
        </span>
      </p>
      <div className="flex flex-col gap-1">
        <p className="font-mono ui-micro uppercase tracking-wide text-text-faint">{t("views.cadence.microTitle")}</p>
        {entry.microTruncated > 0 ? (
          <p className="ui-micro text-text-faint">
            {t("views.cadence.microMore", { count: entry.microTruncated, limit: CADENCE_MICRO_EVENTS })}
          </p>
        ) : null}
        {entry.microEvents.length === 0 ? (
          <p className="ui-micro text-text-faint">{t("views.cadence.microEmpty")}</p>
        ) : (
          <ol data-testid="cadence-micro" className="flex flex-col gap-0.5">
            {entry.microEvents.map((event) => (
              <MicroEventRow key={event.key} event={event} onNavigateEntity={onNavigateEntity} />
            ))}
          </ol>
        )}
      </div>
    </div>
  );
}

function segmentBarWidth(share: number): number {
  if (share <= 0) return 0;
  return Math.max(4, Math.round(share * 100));
}

function MicroEventRow({
  event,
  onNavigateEntity,
}: {
  readonly event: CadenceFeedEvent;
  readonly onNavigateEntity: (ref: string) => void;
}) {
  return (
    <li data-testid="cadence-micro-event" className="flex min-w-0 items-baseline gap-2">
      <span className="shrink-0 font-mono ui-micro text-text-faint">
        {formatTime(event.at ?? "", { style: "time" }) ?? ""}
      </span>
      {event.factId === null ? null : (
        <EntityRefLink
          entityRef={`fact/${event.factId}`}
          onNavigate={onNavigateEntity}
          title={event.factId}
          className="shrink-0 font-mono ui-micro text-accent hover:underline"
        >
          {event.factId}
        </EntityRefLink>
      )}
      <span className="shrink-0 font-mono ui-micro text-text-muted">{event.type}</span>
      {event.summary === null ? null : (
        <span className="min-w-0 truncate ui-micro text-text-muted" title={event.summary}>
          {event.summary}
        </span>
      )}
    </li>
  );
}
