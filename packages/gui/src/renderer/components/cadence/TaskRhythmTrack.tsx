import { useMemo, useRef, useState } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { t } from "../../i18n/index.tsx";
import { formatTime } from "../../model/time.ts";
import { CADENCE_STAGE_ORDER, type CadenceStageId, type TaskRhythmEntry } from "../../model/cadence.ts";
import { EntityRefLink } from "../EntityRefLink.tsx";
import { Segmented } from "../ui/widgets.tsx";

/**
 * 任务节奏音轨:以 task 为叙事单元的时序阶梯。窗口化(react-virtual)保证 DOM 行数
 * 只随视口走——千级任务窗口下不整列表挂载;行内实体 ID 一律走 EntityRefLink(G10)。
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
    scrollRef = useRef<HTMLDivElement>(null),
    visible = useMemo(() => entries.filter((entry) => matchesFilter(entry, filter)), [entries, filter]),
    virtualizer = useVirtualizer({
      count: visible.length,
      getScrollElement: () => scrollRef.current,
      estimateSize: () => RHYTHM_ROW_ESTIMATE_PX,
      overscan: RHYTHM_OVERSCAN,
      getItemKey: (index) => visible[index]!.taskId,
      initialRect: RHYTHM_INITIAL_RECT,
    });
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
            {virtualizer.getVirtualItems().map((item) => (
              <RhythmRow
                key={item.key}
                entry={visible[item.index]!}
                style={{ transform: `translateY(${item.start}px)` }}
                onNavigateEntity={onNavigateEntity}
              />
            ))}
          </ol>
        </div>
      )}
    </section>
  );
}

function RhythmRow({
  entry,
  style,
  onNavigateEntity,
}: {
  readonly entry: TaskRhythmEntry;
  readonly style: React.CSSProperties;
  readonly onNavigateEntity: (ref: string) => void;
}) {
  const lastAt = formatTime(entry.lastEventAt ?? "", { style: "time" });
  return (
    <li
      data-testid="cadence-rhythm-row"
      className={
        "absolute inset-x-0 top-0 flex items-start gap-3 border-b border-border px-3 py-2 " +
        "hover:bg-surface-raised/40"
      }
      style={style}
    >
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <div className="flex min-w-0 items-center gap-2">
          <button
            type="button"
            className="min-w-0 truncate text-left ui-body text-text hover:text-accent"
            title={entry.title}
            onClick={() => onNavigateEntity(`task/${entry.taskId}`)}
          >
            {entry.title}
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
        </div>
      </div>
      <span className="shrink-0 font-mono ui-micro text-text-faint">{lastAt ?? ""}</span>
    </li>
  );
}
