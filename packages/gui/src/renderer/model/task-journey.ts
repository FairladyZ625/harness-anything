import type { TaskDispatchProjectionRow } from "../../api/renderer-dto.ts";
import type { EventEntry, TaskRow } from "./types.ts";
import { dispatchActivity, dispatchDurationMs, dispatchRole, taskActivity } from "./lineage-tree.ts";
import type { AgentActivity } from "../components/agent-ui/AgentTree.tsx";

export interface TaskJourneyNode {
  readonly id: string;
  readonly lane: "control" | "worker";
  readonly kind: "creation" | "execution" | "submit" | "review" | "gate" | "terminal";
  readonly at?: string;
  readonly summary?: string;
  readonly eventKind?: EventEntry["kind"];
  readonly round?: number;
  readonly role?: string;
  readonly activity: AgentActivity;
  readonly durationMs?: number;
  readonly runtimeSessionId?: string;
  readonly recordRefs: readonly string[];
  readonly entityRef?: string;
}
export interface TaskJourney {
  readonly nodes: readonly TaskJourneyNode[];
  readonly edges: readonly { readonly from: string; readonly to: string; readonly reworkLoop: boolean }[];
}

/** Single-cut display only. Paging and canonical state judgments stay at their existing owners.
 * Keyed execution joins + one timeline sort: O((E+D) log(E+D) + B+G), no per-node reads.
 * nowMs is explicit so the model is deterministic (running durations use the observed cut otherwise).
 */
export function buildTaskJourney({
  task,
  dispatches,
  nowMs = Date.parse(task.lastKnownAt),
}: {
  readonly task: TaskRow;
  readonly dispatches: readonly TaskDispatchProjectionRow[];
  readonly nowMs?: number;
}): TaskJourney {
  const events = task.events ?? [];
  const eventsByExecution = new Map<string, EventEntry[]>();
  for (const event of events) {
    if (!event.recordRef?.startsWith("execution/")) continue;
    const bucket = eventsByExecution.get(event.recordRef) ?? [];
    bucket.push(event);
    eventsByExecution.set(event.recordRef, bucket);
  }
  const nodes: TaskJourneyNode[] = [];
  const projectedExecutions = new Set<string>();
  for (const row of dispatches) {
    const reviewer = row.role === "reviewer";
    const recordRef = `execution/${row.executionId}`;
    if (!reviewer) projectedExecutions.add(recordRef);
    nodes.push({
      id: `dispatch:${row.dispatchId}`,
      lane: reviewer ? "control" : "worker",
      kind: reviewer ? "review" : "execution",
      at: row.startedAt,
      role: dispatchRole(row),
      activity: dispatchActivity(row.status),
      durationMs: dispatchDurationMs(row, nowMs),
      runtimeSessionId: row.runtimeSessionId,
      recordRefs: [recordRef],
    });
  }
  // A start and subsequent execution/* events are one execution, not extra rounds.
  const fallbackExecutions = new Map<string, EventEntry>();
  for (const event of [...events].sort((a, b) => a.at.localeCompare(b.at))) {
    const executionRef = event.recordRef?.startsWith("execution/") ? event.recordRef : undefined;
    if (executionRef !== undefined && !projectedExecutions.has(executionRef) && !fallbackExecutions.has(executionRef))
      fallbackExecutions.set(executionRef, event);
    else if (event.kind === "start" && executionRef === undefined)
      fallbackExecutions.set(`event:${event.at}:${event.ref}`, event);
  }
  for (const [key, event] of fallbackExecutions) {
    const history = eventsByExecution.get(key) ?? [event];
    nodes.push({
      id: `execution:${key}`,
      lane: "worker",
      kind: "execution",
      at: event.at,
      summary: event.summary,
      activity:
        key === `execution/${task.activeExecutionId}`
          ? taskActivity(task.canonicalStatus)
          : history.some((entry) => entry.kind === "completed")
            ? "done"
            : history.some((entry) => entry.kind === "returned")
              ? "failed"
              : history.some((entry) => entry.kind === "submit")
                ? "awaiting"
                : "idle",
      recordRefs: event.recordRef === undefined ? [] : [event.recordRef],
    });
  }
  if (task.activeExecutionId !== undefined) {
    const ref = `execution/${task.activeExecutionId}`;
    if (!projectedExecutions.has(ref) && !fallbackExecutions.has(ref))
      nodes.push({
        id: `active:${task.activeExecutionId}`,
        lane: "worker",
        kind: "execution",
        at: task.lastKnownAt,
        activity: "running",
        role: task.leaseHolder,
        recordRefs: [ref],
      });
  }
  const reviews = new Map((task.reviews ?? []).map((review) => [`review/${review.reviewId}`, review]));
  for (const event of events) {
    if (event.kind === "start") continue;
    if (
      event.kind !== "submit" &&
      event.kind !== "approved" &&
      event.kind !== "rejected" &&
      event.kind !== "returned" &&
      event.kind !== "dismissed" &&
      event.kind !== "consent" &&
      event.kind !== "completed" &&
      event.kind !== "gatePass" &&
      event.kind !== "gateFail"
    )
      continue;
    const review = event.recordRef === undefined ? undefined : reviews.get(event.recordRef);
    nodes.push({
      id: `event:${event.recordRef ?? event.ref}:${event.kind}:${event.at}`,
      lane: "control",
      kind: event.kind === "submit" ? "submit" : event.kind.startsWith("gate") ? "gate" : "review",
      eventKind: event.kind,
      at: event.at,
      summary: review?.reason ?? event.summary,
      activity:
        event.kind === "rejected" || event.kind === "returned" || event.kind === "gateFail"
          ? "failed"
          : event.kind === "submit"
            ? "awaiting"
            : "done",
      recordRefs: event.recordRef === undefined ? [] : [event.recordRef],
    });
  }
  nodes.sort((a, b) => (a.at ?? "").localeCompare(b.at ?? "") || a.id.localeCompare(b.id));
  let round = 0;
  const ordered: TaskJourneyNode[] = [
    {
      id: "creation",
      lane: "control",
      kind: "creation",
      at: task.createdAt ?? undefined,
      activity: "idle",
      recordRefs: [],
    },
    ...nodes.map((node) => (node.lane === "worker" ? { ...node, round: ++round } : node)),
  ];
  for (const blocker of task.blockers ?? []) {
    ordered.push({
      id: `blocker:${blocker.relationId}`,
      lane: "control",
      kind: "gate",
      activity: "awaiting",
      summary: blocker.kind === "depends-on" ? (blocker.rationale ?? blocker.kind) : blocker.question,
      entityRef: blocker.kind === "depends-on" ? `task/${blocker.targetTaskId}` : undefined,
      recordRefs: [],
    });
  }
  // Unpassed completion gates are actionable after submission; before it they are future requirements.
  if (task.coordinationStatus === "submitted" || task.coordinationStatus === "in_review") {
    for (const gate of task.gates ?? [])
      if (gate.ok !== true)
        ordered.push({
          id: `gate:${gate.name}`,
          lane: "control",
          kind: "gate",
          activity: gate.ok === false ? "failed" : "awaiting",
          summary: [gate.name, gate.detail].filter(Boolean).join(" · "),
          recordRefs: [],
        });
    ordered.push({ id: "waiting-review", lane: "control", kind: "gate", activity: "awaiting", recordRefs: [] });
  }
  if (task.canonicalStatus === "done" || task.canonicalStatus === "cancelled")
    ordered.push({
      id: "terminal",
      lane: "control",
      kind: "terminal",
      at: task.lastKnownAt,
      activity: taskActivity(task.canonicalStatus),
      recordRefs: [],
    });

  const edges: TaskJourney["edges"][number][] = [];
  let pendingRework: TaskJourneyNode | undefined;
  for (const [index, node] of ordered.entries()) {
    const previous = ordered[index - 1];
    if (previous !== undefined) edges.push({ from: previous.id, to: node.id, reworkLoop: false });
    if (node.eventKind === "rejected" || (node.eventKind === "returned" && pendingRework === undefined))
      pendingRework = node;
    if (node.lane === "worker" && pendingRework !== undefined) {
      edges.push({ from: pendingRework.id, to: node.id, reworkLoop: true });
      pendingRework = undefined;
    }
  }
  return { nodes: ordered, edges };
}
