import type { TaskDispatchProjectionRow } from "../../api/renderer-dto.ts";
import type { DecisionRow, EventEntry, FactRef, RelationEdge, TaskRow } from "./types.ts";
import { dispatchActivity, dispatchDurationMs, dispatchRole, taskActivity } from "./lineage-tree.ts";
import type { AgentActivity } from "../components/agent-ui/AgentTree.tsx";

export interface TaskJourneyNode {
  readonly id: string;
  readonly lane: "control" | "worker";
  readonly kind:
    | "creation"
    | "execution"
    | "submit"
    | "review"
    | "gate"
    | "terminal"
    | "parent"
    | "authorization"
    | "dependency"
    | "awaits"
    | "fact"
    | "child"
    | "downstream";
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
  readonly decisionState?: DecisionRow["state"];
  readonly closeoutBlocker?: NonNullable<TaskRow["closeoutBlocker"]>;
}
export interface TaskJourneyEntity extends TaskJourneyNode {
  readonly entityRef: string;
  readonly nodeId?: string;
}
export interface TaskJourney {
  readonly upstream: readonly TaskJourneyEntity[];
  readonly attachments: readonly TaskJourneyEntity[];
  readonly downstream: readonly TaskJourneyEntity[];
  readonly nodes: readonly TaskJourneyNode[];
  readonly edges: readonly { readonly from: string; readonly to: string; readonly reworkLoop: boolean }[];
}

/** Single-cut display only. Paging and canonical state judgments stay at their existing owners.
 * Keyed execution joins + one timeline sort: O((E+D) log(E+D) + B+G), no per-node reads.
 * nowMs is the caller's observation clock, never the task modification timestamp.
 */
export function buildTaskJourney({
  task,
  dispatches,
  nowMs,
  tasks = [],
  decisions = [],
  facts = [],
  relations = [],
}: {
  readonly task: TaskRow;
  readonly dispatches: readonly TaskDispatchProjectionRow[];
  readonly nowMs: number;
  readonly tasks?: readonly TaskRow[];
  readonly decisions?: readonly Pick<DecisionRow, "decisionId" | "title" | "state">[];
  readonly facts?: readonly FactRef[];
  readonly relations?: readonly RelationEdge[];
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
              : history.some((entry) => entry.kind === "abandoned")
                ? "cancelled"
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
    const blocker = task.closeoutBlocker;
    if (blocker !== undefined && !(blocker === "gate" && (task.gates ?? []).some((gate) => gate.ok !== true)))
      ordered.push({
        id: `closeout:${blocker}`,
        lane: "control",
        kind: "gate",
        closeoutBlocker: blocker,
        activity: blocker === "review_rejected" ? "failed" : "awaiting",
        recordRefs: [],
      });
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
  return { nodes: ordered, edges, ...causalContext(task, ordered, tasks, decisions, facts, relations) };
}

/** Incident edges only. Resident rows are indexed once, attachments use binary time lookup:
 * O(T + D + F + E + N log N + A log N), with no repository graph read or per-entity fetch. */
function causalContext(
  task: TaskRow,
  nodes: readonly TaskJourneyNode[],
  tasks: readonly TaskRow[],
  decisions: readonly Pick<DecisionRow, "decisionId" | "title" | "state">[],
  facts: readonly FactRef[],
  relations: readonly RelationEdge[],
): Pick<TaskJourney, "upstream" | "attachments" | "downstream"> {
  const focus = `task/${task.taskId}`;
  const taskByRef = new Map(tasks.map((row) => [`task/${row.taskId}`, row]));
  const decisionByRef = new Map(decisions.map((row) => [`decision/${row.decisionId}`, row]));
  const factByRef = new Map(facts.map((row) => [row.anchor, row]));
  const upstream = new Map<string, TaskJourneyEntity>(),
    downstream = new Map<string, TaskJourneyEntity>();
  const attachments = new Map<string, TaskJourneyEntity>();
  const timed = nodes.filter((node) => node.at !== undefined).sort((a, b) => a.at!.localeCompare(b.at!));
  const nodeAt = (at?: string) => {
    if (at === undefined) return nodes.at(-1)!.id;
    let low = 0,
      high = timed.length;
    while (low < high) {
      const mid = (low + high) >>> 1;
      if (timed[mid]!.at! <= at) low = mid + 1;
      else high = mid;
    }
    return timed[low - 1]?.id ?? "creation";
  };
  const entity = (ref: string, kind: TaskJourneyNode["kind"]): TaskJourneyEntity => {
    const row = taskByRef.get(ref),
      decision = decisionByRef.get(ref),
      fact = factByRef.get(ref);
    return {
      id: `${kind}:${ref}`,
      kind,
      entityRef: ref,
      lane: "control",
      recordRefs: [],
      summary: row?.title ?? decision?.title ?? fact?.text,
      at: row?.createdAt ?? fact?.at,
      activity: row ? taskActivity(row.canonicalStatus) : "idle",
      decisionState: decision?.state,
    };
  };
  const attach = (ref: string, kind: TaskJourneyNode["kind"]) => {
    const item = entity(ref, kind);
    attachments.set(ref, { ...item, nodeId: nodeAt(item.at) });
  };
  for (const id of new Set([task.parentTaskId, task.workId]))
    if (id && id !== task.taskId) upstream.set(`task/${id}`, entity(`task/${id}`, "parent"));
  for (const id of task.spawningDecisionIds ?? [])
    upstream.set(`decision/${id}`, entity(`decision/${id}`, "authorization"));
  for (const blocker of task.blockers ?? []) {
    if (blocker.kind === "depends-on") {
      const ref = `task/${blocker.targetTaskId}`;
      upstream.set(ref, entity(ref, "dependency"));
    } else {
      const ref = `relation/${blocker.relationId}`;
      attachments.set(ref, {
        ...entity(ref, "awaits"),
        summary: blocker.question,
        activity: "awaiting",
        nodeId: `blocker:${blocker.relationId}`,
      });
    }
  }
  for (const edge of relations) {
    if (edge.to === focus && edge.kind === "derives" && edge.from.startsWith("decision/")) {
      const ref = edge.from.split("/").slice(0, 2).join("/");
      upstream.set(ref, entity(ref, "authorization"));
    }
    if (edge.from === focus) {
      if (edge.kind === "depends-on" && edge.to.startsWith("task/"))
        upstream.set(edge.to, entity(edge.to, "dependency"));
      if (edge.kind === "produces" && edge.to.startsWith("fact/")) attach(edge.to, "fact");
      if (edge.kind === "derives" && edge.to.startsWith("task/")) attach(edge.to, "child");
      if (edge.kind === "awaits" && edge.relationId) {
        const ref = `relation/${edge.relationId}`;
        if (!attachments.has(ref))
          attachments.set(ref, {
            ...entity(ref, "awaits"),
            summary: edge.rationale,
            activity: "awaiting",
            nodeId: nodeAt(),
          });
      }
    }
    if (edge.to === focus && edge.kind === "depends-on" && edge.from.startsWith("task/"))
      downstream.set(edge.from, entity(edge.from, "downstream"));
  }
  for (const child of tasks) if (child.parentTaskId === task.taskId) attach(`task/${child.taskId}`, "child");
  return {
    upstream: [...upstream.values()],
    attachments: [...attachments.values()],
    downstream: [...downstream.values()],
  };
}
