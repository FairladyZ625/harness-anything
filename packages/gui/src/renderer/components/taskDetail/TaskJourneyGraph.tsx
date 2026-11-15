import { useEffect, useId, useMemo, useRef, useState } from "react";
import { t, type MessageKey } from "../../i18n/index.tsx";
import { formatDuration, formatTime } from "../../model/time.ts";
import { WORK_STEP_LABEL_KEY } from "../../model/workspace-narrative.ts";
import type { TaskJourney, TaskJourneyEntity, TaskJourneyNode } from "../../model/task-journey.ts";
import { useEntryMotion } from "../../motion-config.tsx";
import { ACTIVITY_COLOR, ACTIVITY_KEY, ACTIVITY_TONE } from "../agent-ui/AgentTree.tsx";
import { EntityRefLink } from "../EntityRefLink.tsx";
import { DecisionStateBadge } from "../badges.tsx";
import { Button } from "../primitives/Button.tsx";
import { StatusTag } from "../primitives/StatusTag.tsx";

const CLOSEOUT_LABEL_KEY: Readonly<Record<NonNullable<TaskJourneyNode["closeoutBlocker"]>, MessageKey>> = {
  review_pending: "components.taskJourney.waitingReview",
  review_rejected: "components.taskJourney.reviewRejected",
  consent: "components.taskJourney.waitingConsent",
  execution: "components.taskJourney.executionCut",
  gate: "components.taskJourney.gate",
  lineage: "components.taskJourney.lineage",
  projection_unknown: "components.taskJourney.projectionUnknown",
};
const LABEL_WIDTH = 88;
const yOf = (node: TaskJourneyNode) => (node.lane === "control" ? 14 : 154);
const CONTEXT_LABEL: Partial<Record<TaskJourneyNode["kind"], MessageKey>> = {
  parent: "components.taskJourney.parent",
  authorization: "components.taskJourney.authorization",
  dependency: "components.taskJourney.dependency",
  awaits: "components.taskJourney.awaits",
  fact: "components.taskJourney.fact",
  child: "components.taskJourney.child",
  downstream: "components.taskJourney.downstream",
};
function labelOf(node: TaskJourneyNode): string {
  const contextLabel = CONTEXT_LABEL[node.kind];
  if (contextLabel) return t(contextLabel);
  if (node.lane === "worker") return `R${node.round} · ${node.role ?? t("components.taskJourney.execution")}`;
  if (node.eventKind !== undefined)
    return `${node.eventKind === "rejected" || node.eventKind === "returned" ? "↩ " : ""}${t(WORK_STEP_LABEL_KEY[node.eventKind])}`;
  if (node.kind === "creation") return t("components.taskJourney.creation");
  if (node.kind === "terminal") return t(ACTIVITY_KEY[node.activity]);
  if (node.kind === "gate")
    return `◇ ${node.closeoutBlocker !== undefined ? t(CLOSEOUT_LABEL_KEY[node.closeoutBlocker]) : (node.summary ?? t("components.taskJourney.gate"))}`;
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
  const selected =
    [...journey.nodes, ...journey.upstream, ...journey.attachments, ...journey.downstream].find(
      (node) => node.id === selectedId,
    ) ?? journey.nodes.at(-1);
  const attachments = useMemo(() => {
    const byNode = new Map<string, TaskJourneyEntity[]>();
    for (const item of journey.attachments) {
      const group = byNode.get(item.nodeId!) ?? [];
      group.push(item);
      byNode.set(item.nodeId!, group);
    }
    return byNode;
  }, [journey.attachments]);
  const inspector = useRef<HTMLElement>(null);
  useEffect(() => {
    if (selectedId !== null) inspector.current?.scrollIntoView?.({ block: "nearest", inline: "nearest" });
  }, [selectedId]);
  const markerId = useId().replace(/:/gu, "");
  const { enabled, reduced } = useEntryMotion();
  const nodeWidth = 148;
  const height = Math.max(
    290,
    ...journey.nodes.map((node) => yOf(node) + 84 + (attachments.get(node.id)?.length ?? 0) * 36),
  );
  const step = nodeWidth + 16;
  const width = LABEL_WIDTH + journey.nodes.length * step - 16 + 8;
  const positions = new Map(
    journey.nodes.map((node, index) => [node.id, { x: LABEL_WIDTH + index * step, y: yOf(node) }]),
  );
  return (
    <div data-testid="task-journey-graph" className="@container min-w-0">
      <div
        className={`grid min-w-0 grid-cols-1 gap-3 @[832px]:grid-cols-[var(--upstream)_minmax(0,5fr)_var(--downstream)] ${journey.upstream.length ? "[--upstream:minmax(7rem,1fr)]" : "[--upstream:minmax(4.5rem,auto)]"} ${journey.downstream.length ? "[--downstream:minmax(7rem,1fr)]" : "[--downstream:minmax(4.5rem,auto)]"}`}
      >
        <ContextColumn
          title={t("components.taskJourney.upstream")}
          items={journey.upstream}
          selectedId={selected?.id}
          onSelect={setSelectedId}
          onNavigateEntity={onNavigateEntity}
          targetId="creation"
        />
        <section
          className="min-w-0 border-border @[832px]:border-x @[832px]:px-1"
          aria-label={t("components.taskJourney.rounds")}
        >
          <h3 className="mb-3 ui-meta font-semibold text-text-muted">{t("components.taskJourney.rounds")}</h3>
          <div className={`max-w-full overflow-x-auto ${enabled && !reduced ? "motion-safe:scroll-smooth" : ""}`}>
            <div className="relative" style={{ width: "100%", minWidth: width, height }}>
              <svg width="100%" height={height} aria-hidden="true" className="pointer-events-none absolute inset-0">
                <defs>
                  <marker id={markerId} markerWidth="7" markerHeight="7" refX="6" refY="3.5" orient="auto">
                    <path d="M0 0 L7 3.5 L0 7" fill="currentColor" />
                  </marker>
                </defs>
                {[45, 185].map((y) => (
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
              <span className="absolute left-0 ui-micro font-semibold text-text-muted" style={{ top: 172 }}>
                {t("components.taskJourney.workerLane")}
              </span>
              {journey.nodes.map((node) => {
                const position = positions.get(node.id)!;
                return (
                  <div key={node.id}>
                    <button
                      type="button"
                      data-journey-kind={node.kind}
                      data-journey-round={node.round}
                      aria-label={labelOf(node)}
                      aria-pressed={selected?.id === node.id}
                      onClick={() => setSelectedId(node.id)}
                      title={node.summary}
                      className={`absolute flex flex-col gap-1 rounded-sm border bg-surface px-2 py-1.5 text-left focus-visible:outline-2 focus-visible:outline-accent ${selected?.id === node.id ? "border-accent" : "border-border-strong"}`}
                      style={{ left: position.x, top: position.y, width: nodeWidth, minHeight: 64 }}
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
                    {(attachments.get(node.id) ?? []).map((item, index) => (
                      <div
                        key={item.id}
                        data-journey-attachment={item.entityRef}
                        className="absolute flex min-w-0 flex-col border-l border-dashed border-border pl-2"
                        style={{ left: position.x + 12, top: position.y + 76 + index * 36, width: nodeWidth - 12 }}
                      >
                        {onNavigateEntity && (
                          <EntityRefLink entityRef={item.entityRef} onNavigate={onNavigateEntity}>
                            {labelOf(item)} · {item.summary ?? item.entityRef}
                          </EntityRefLink>
                        )}
                      </div>
                    ))}
                  </div>
                );
              })}
            </div>
          </div>
        </section>
        <ContextColumn
          title={t("components.taskJourney.downstream")}
          items={journey.downstream}
          selectedId={selected?.id}
          onSelect={setSelectedId}
          onNavigateEntity={onNavigateEntity}
          sourceId={journey.nodes.at(-1)?.id}
        />
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

function ContextColumn({
  title,
  items,
  selectedId,
  onSelect,
  onNavigateEntity,
  targetId,
  sourceId,
}: {
  readonly title: string;
  readonly items: readonly TaskJourneyEntity[];
  readonly selectedId?: string;
  readonly onSelect: (id: string) => void;
  readonly onNavigateEntity?: (ref: string) => void;
  readonly targetId?: string;
  readonly sourceId?: string;
}) {
  return (
    <section
      className={`min-w-0 ${items.length === 0 ? "flex items-center gap-2 @[832px]:block" : ""}`}
      aria-label={title}
    >
      <h3 className={`${items.length ? "mb-3" : "@[832px]:mb-3"} ui-meta font-semibold text-text-muted`}>{title}</h3>
      <div className="flex flex-wrap gap-3 @[832px]:flex-col">
        {items.length === 0 && <span className="ui-meta text-text-faint">—</span>}
        {items.map((item) => (
          <article
            key={item.id}
            className="relative w-40 min-w-0 max-w-full rounded-sm border border-border p-2 @[832px]:w-auto"
            data-journey-anchor={item.entityRef}
          >
            <span
              aria-hidden="true"
              className={`absolute text-text-muted ${targetId ? "bottom-0 right-2 rotate-90 @[832px]:bottom-auto @[832px]:-right-3 @[832px]:top-5 @[832px]:rotate-0" : "right-2 top-0 rotate-90 @[832px]:right-auto @[832px]:-left-3 @[832px]:top-5 @[832px]:rotate-0"}`}
              data-causal-from={targetId ? item.id : sourceId}
              data-causal-to={targetId ?? item.id}
            >
              →
            </span>
            <button
              type="button"
              aria-label={`${labelOf(item)} · ${item.summary ?? item.entityRef}`}
              aria-pressed={selectedId === item.id}
              onClick={() => onSelect(item.id)}
              className="mb-2 block w-full text-left ui-micro text-text-muted focus-visible:outline-2 focus-visible:outline-accent"
            >
              {labelOf(item)}
            </button>
            {onNavigateEntity && (
              <EntityRefLink entityRef={item.entityRef} onNavigate={onNavigateEntity}>
                {item.summary ?? item.entityRef}
              </EntityRefLink>
            )}
            <div className="mt-2">
              {item.decisionState ? (
                <DecisionStateBadge state={item.decisionState} />
              ) : (
                <StatusTag tone={ACTIVITY_TONE[item.activity]} label={t(ACTIVITY_KEY[item.activity])} />
              )}
            </div>
          </article>
        ))}
      </div>
    </section>
  );
}
