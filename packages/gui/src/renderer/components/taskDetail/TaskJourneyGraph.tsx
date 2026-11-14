import { useEffect, useId, useRef, useState } from "react";
import { t } from "../../i18n/index.tsx";
import { formatDuration, formatTime } from "../../model/time.ts";
import { WORK_STEP_LABEL_KEY } from "../../model/workspace-narrative.ts";
import type { TaskJourney, TaskJourneyNode } from "../../model/task-journey.ts";
import { useEntryMotion } from "../../motion-config.tsx";
import { ACTIVITY_COLOR, ACTIVITY_KEY, ACTIVITY_TONE } from "../agent-ui/AgentTree.tsx";
import { EntityRefLink } from "../EntityRefLink.tsx";
import { Button } from "../primitives/Button.tsx";
import { StatusTag } from "../primitives/StatusTag.tsx";

const LABEL_WIDTH = 112;
const yOf = (node: TaskJourneyNode) => (node.lane === "control" ? 14 : 94);
function labelOf(node: TaskJourneyNode): string {
  if (node.lane === "worker") return `R${node.round} · ${node.role ?? t("components.taskJourney.execution")}`;
  if (node.eventKind !== undefined)
    return `${node.eventKind === "rejected" || node.eventKind === "returned" ? "↩ " : ""}${t(WORK_STEP_LABEL_KEY[node.eventKind])}`;
  if (node.kind === "creation") return t("components.taskJourney.creation");
  if (node.kind === "terminal") return t(ACTIVITY_KEY[node.activity]);
  if (node.kind === "gate") return `◇ ${node.summary ?? t("components.taskJourney.waitingReview")}`;
  return node.role ?? t("components.taskJourney.review");
}

/** Two lanes share a horizontal coordinate system. Native buttons sit above SVG edges so keyboard
 * activation and entity/record navigation use the same accessible product primitives as other views. */
export function TaskJourneyGraph({
  journey,
  onNavigateEntity,
  onOpenSession,
  onOpenRecord,
}: {
  readonly journey: TaskJourney;
  readonly onNavigateEntity?: (ref: string) => void;
  readonly onOpenSession?: (runtimeSessionId: string) => void;
  readonly onOpenRecord?: (recordRef: string) => void;
}) {
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const selected = journey.nodes.find((node) => node.id === selectedId) ?? journey.nodes.at(-1);
  const inspector = useRef<HTMLElement>(null);
  useEffect(() => {
    if (selectedId !== null) inspector.current?.scrollIntoView?.({ block: "nearest", inline: "nearest" });
  }, [selectedId]);
  const markerId = useId().replace(/:/gu, "");
  const { enabled, reduced } = useEntryMotion();
  const nodeWidth = journey.nodes.length < 3 ? 128 : 156;
  const step = nodeWidth + 24;
  const width = LABEL_WIDTH + journey.nodes.length * step - 24;
  const positions = new Map(
    journey.nodes.map((node, index) => [node.id, { x: LABEL_WIDTH + index * step, y: yOf(node) }]),
  );
  return (
    <div data-testid="task-journey-graph" className="min-w-0">
      <div className={`max-w-full overflow-x-auto ${enabled && !reduced ? "motion-safe:scroll-smooth" : ""}`}>
        <div className="relative" style={{ width: "100%", minWidth: width, height: 166 }}>
          <svg width="100%" height="166" aria-hidden="true" className="pointer-events-none absolute inset-0">
            <defs>
              <marker id={markerId} markerWidth="7" markerHeight="7" refX="6" refY="3.5" orient="auto">
                <path d="M0 0 L7 3.5 L0 7" fill="currentColor" />
              </marker>
            </defs>
            {[45, 125].map((y) => (
              <line key={y} x1={LABEL_WIDTH} x2="100%" y1={y} y2={y} stroke="var(--color-border)" />
            ))}
            {journey.edges.map((edge) => {
              const from = positions.get(edge.from)!,
                to = positions.get(edge.to)!;
              // A rework arch visibly leaves the review lane and enters the next worker round.
              const x1 = from.x + nodeWidth,
                x2 = to.x,
                y1 = from.y + 28,
                y2 = to.y + 28;
              return (
                <path
                  key={`${edge.from}-${edge.to}-${edge.reworkLoop}`}
                  data-rework-loop={edge.reworkLoop || undefined}
                  d={
                    edge.reworkLoop
                      ? `M${x1 - 20} ${y1 + 28} C${x1 - 20} 84 ${x2 - 12} 84 ${x2} ${y2}`
                      : `M${x1} ${y1} C${x1 + 12} ${y1} ${x2 - 12} ${y2} ${x2} ${y2}`
                  }
                  fill="none"
                  stroke={edge.reworkLoop ? "var(--color-danger)" : "var(--color-text-faint)"}
                  strokeDasharray={edge.reworkLoop ? "4 4" : undefined}
                  markerEnd={`url(#${markerId})`}
                />
              );
            })}
          </svg>
          <span className="absolute left-0 ui-micro font-semibold text-text-muted" style={{ top: 32 }}>
            {t("components.taskJourney.controlLane")}
          </span>
          <span className="absolute left-0 ui-micro font-semibold text-text-muted" style={{ top: 112 }}>
            {t("components.taskJourney.workerLane")}
          </span>
          {journey.nodes.map((node) => {
            const position = positions.get(node.id)!;
            return (
              <button
                key={node.id}
                type="button"
                data-journey-kind={node.kind}
                data-journey-round={node.round}
                aria-label={labelOf(node)}
                aria-pressed={selected?.id === node.id}
                onClick={() => setSelectedId(node.id)}
                title={node.summary}
                className={`absolute flex flex-col gap-1 rounded-sm border bg-surface px-2 py-1.5 text-left focus-visible:outline-2 focus-visible:outline-accent ${selected?.id === node.id ? "border-accent" : "border-border-strong"}`}
                style={{ left: position.x, top: position.y, width: nodeWidth, minHeight: 58 }}
              >
                <span className="flex min-w-0 items-center gap-1 font-semibold ui-meta">
                  <span
                    aria-hidden="true"
                    className={`h-1.5 w-1.5 shrink-0 rounded-full ${node.activity === "running" && enabled && !reduced ? "motion-safe:animate-pulse" : ""}`}
                    style={{ background: ACTIVITY_COLOR[node.activity] }}
                  />
                  <span className="truncate">{labelOf(node)}</span>
                </span>
                <StatusTag tone={ACTIVITY_TONE[node.activity]} label={t(ACTIVITY_KEY[node.activity])} />
              </button>
            );
          })}
        </div>
      </div>
      {selected !== undefined && (
        <section
          ref={inspector}
          aria-live="polite"
          data-testid="task-journey-inspector"
          aria-label={t("components.taskJourney.inspector")}
          className="flex min-w-0 flex-col gap-2 border-t border-border py-3 ui-meta"
        >
          <div className="flex flex-wrap items-center gap-2">
            <strong>{labelOf(selected)}</strong>
            {selected.at && (
              <time dateTime={selected.at} className="font-mono ui-micro text-text-muted">
                {formatTime(selected.at, { style: "date-time-seconds" })}
              </time>
            )}
            {selected.durationMs !== undefined && (
              <span className="font-mono ui-micro">{formatDuration(selected.durationMs)}</span>
            )}
          </div>
          {selected.summary && <p className="break-words text-text-muted">{selected.summary}</p>}
          <div className="flex min-w-0 flex-wrap items-center gap-2">
            {selected.entityRef && onNavigateEntity && (
              <EntityRefLink entityRef={selected.entityRef} onNavigate={onNavigateEntity} />
            )}
            {selected.runtimeSessionId && onNavigateEntity && (
              <EntityRefLink entityRef={`session/${selected.runtimeSessionId}`} onNavigate={onNavigateEntity} />
            )}
            {selected.runtimeSessionId && onOpenSession && (
              <Button size="sm" variant="ghost" onClick={() => onOpenSession(selected.runtimeSessionId!)}>
                {t("components.taskJourney.openSession")}
              </Button>
            )}
            {onOpenRecord &&
              selected.recordRefs.map((ref) => (
                <EntityRefLink key={ref} entityRef={ref} onNavigate={onOpenRecord}>
                  {t("components.taskJourney.openRecord")} · {ref}
                </EntityRefLink>
              ))}
          </div>
        </section>
      )}
    </div>
  );
}
