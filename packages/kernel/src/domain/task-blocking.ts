import { consentedApprovedReviewForExecution } from "./review.ts";
import type { ExecutionDeliveryBaseline } from "./execution.ts";
import type { TaskLifecycleSnapshot } from "./task-lifecycle-contract-internal-types.ts";
import {
  parseAwaitsRequest,
  relationConsumability,
  relationIsCurrent,
  type AwaitsAskKind,
  type RelationStrength,
} from "./entity-relation.ts";
export type { AwaitsAskKind } from "./entity-relation.ts";
import type { RelationFreshness } from "./entity-freshness.ts";

export interface BlockingTask {
  readonly taskId: string;
  readonly status: string;
}
export interface BlockingRelation {
  readonly relationId: string;
  readonly sourceRef: string;
  readonly targetRef: string;
  readonly relationType: string;
  readonly direction: string;
  readonly state: string;
  readonly strength: RelationStrength;
  readonly freshness: RelationFreshness;
  readonly rationale?: string;
}
export type BlockingContributor =
  | {
      readonly relationId: string;
      readonly kind: "depends-on";
      readonly sourceTaskId: string;
      readonly targetTaskId: string;
      readonly rationale?: string;
    }
  | {
      /** An active `awaits` edge: the task holds until the person answers (dec_DF67F23066BAFE444190A191B5/CH3). */
      readonly relationId: string;
      readonly kind: "awaits";
      readonly sourceTaskId: string;
      readonly personId: string;
      readonly askKind: AwaitsAskKind;
      readonly question: string;
    };
export type BlockingAssessmentState = "blocked" | "clear" | "unknown";
export type BlockingAvailabilityState = "ready" | "loading" | "error";
export const blockingLabels = ["relations", "cycle", "unresolved", "none"] as const;
export type BlockingLabel = (typeof blockingLabels)[number];
export interface BlockingAssessment {
  readonly taskId: string;
  readonly state: BlockingAssessmentState;
  readonly label: BlockingLabel;
  readonly blockers: readonly BlockingContributor[];
  readonly warnings: readonly string[];
}
export interface BlockingProjectionState {
  readonly state?: BlockingAvailabilityState;
  readonly hardFailWarnings?: readonly string[];
}
export interface DispatchDecision {
  readonly decisionId: string;
  readonly state: string;
}
export interface DispatchPrerequisiteAssessment {
  readonly taskId: string;
  readonly state: BlockingAssessmentState;
  readonly proposedDecisionIds: readonly string[];
  readonly unfinishedDependencyIds: readonly string[];
  readonly warnings: readonly string[];
}

/**
 * Canonical direction: `A depends-on B` blocks A until B is done; `A awaits person/P` blocks A until
 * the edge is retired with P's answer.
 */
export function blockingOf(
  tasks: readonly BlockingTask[],
  relations: readonly BlockingRelation[],
  projection: BlockingProjectionState = {},
): readonly BlockingAssessment[] {
  const taskById = new Map(tasks.map((task) => [task.taskId, task])),
    blockers = new Map<string, BlockingContributor[]>(),
    warnings = new Map<string, string[]>(),
    graph = new Map<string, string[]>();
  const global =
    (projection.state !== undefined && projection.state !== "ready") || Boolean(projection.hardFailWarnings?.length);
  if (global)
    for (const task of tasks)
      add(
        warnings,
        task.taskId,
        projection.state === "error"
          ? "relation query failed"
          : projection.state === "loading"
            ? "relation query loading"
            : (projection.hardFailWarnings?.[0] ?? "relation projection hard-fail warning"),
      );
  for (const edge of relations.filter(({ relationType }) => relationType === "awaits")) {
    const sourceId = taskId(edge.sourceRef),
      personId = /^person\/([^/]+)$/u.exec(edge.targetRef)?.[1],
      request = parseAwaitsRequest(edge.rationale ?? "");
    if (!sourceId || !taskById.has(sourceId) || edge.state === "retired") continue;
    if (!relationIsCurrent(edge)) {
      add(warnings, sourceId, `awaits relation ${edge.relationId} is ${edge.freshness}`);
      continue;
    }
    if (!personId || !request || edge.direction !== "directed") {
      add(warnings, sourceId, `invalid awaits relation ${edge.relationId}`);
      continue;
    }
    add(blockers, sourceId, {
      relationId: edge.relationId,
      kind: "awaits",
      sourceTaskId: sourceId,
      personId,
      ...request,
    });
  }
  for (const edge of relations.filter(({ relationType }) => relationType === "depends-on")) {
    if (edge.state === "retired") continue;
    const sourceId = taskId(edge.sourceRef),
      targetId = taskId(edge.targetRef),
      known = [sourceId, targetId].filter((id): id is string => Boolean(id && taskById.has(id)));
    const consumability = relationConsumability(edge);
    if (consumability === "refuse") {
      for (const id of known.length ? known : tasks.map(({ taskId: candidate }) => candidate))
        add(warnings, id, `blocking relation ${edge.relationId} is ${edge.freshness}`);
      continue;
    }
    if (consumability === "warn")
      for (const id of known.length ? known : tasks.map(({ taskId: candidate }) => candidate))
        add(warnings, id, `weak blocking relation ${edge.relationId} is ${edge.freshness}`);
    if (
      !relationIsCurrent(edge) ||
      edge.direction !== "directed" ||
      !sourceId ||
      !targetId ||
      !taskById.has(sourceId) ||
      !taskById.has(targetId)
    ) {
      const message =
        !sourceId || !targetId
          ? `invalid blocking endpoint: ${edge.sourceRef} → ${edge.targetRef}`
          : !taskById.has(sourceId) || !taskById.has(targetId)
            ? `blocking endpoint missing from task snapshot: ${!taskById.has(sourceId) ? sourceId : targetId}`
            : `blocking relation ${edge.relationId} is not active directed`;
      for (const id of known.length ? known : tasks.map(({ taskId: id }) => id)) add(warnings, id, message);
      continue;
    }
    add(graph, sourceId, targetId);
    if (taskById.get(targetId)?.status !== "done")
      add(blockers, sourceId, {
        relationId: edge.relationId,
        kind: "depends-on",
        sourceTaskId: sourceId,
        targetTaskId: targetId,
        ...(edge.rationale ? { rationale: edge.rationale } : {}),
      });
  }
  const cycles = findCycleNodes(graph);
  for (const id of cycles) add(warnings, id, "active blocking relation cycle detected; cycle nodes remain blocked");
  return tasks.map(({ taskId: id }) => {
    const taskBlockers = blockers.get(id) ?? [],
      taskWarnings = [...new Set(warnings.get(id) ?? [])],
      cycle = cycles.has(id);
    return {
      taskId: id,
      state: taskBlockers.length || cycle ? "blocked" : taskWarnings.length ? "unknown" : "clear",
      label: taskBlockers.length ? "relations" : cycle ? "cycle" : taskWarnings.length ? "unresolved" : "none",
      blockers: taskBlockers,
      warnings: taskWarnings,
    };
  });
}

/** Canonical admission judgment for the machine-readable prerequisites of a task dispatch. */
export function dispatchPrerequisitesOf(
  taskId: string,
  tasks: readonly BlockingTask[],
  relations: readonly BlockingRelation[],
  decisions: readonly DispatchDecision[],
  projection: BlockingProjectionState = {},
  snapshots: readonly TaskLifecycleSnapshot[] = [],
): DispatchPrerequisiteAssessment {
  const assessments = blockingOf(tasks, relations, projection),
    reachable = new Set([taskId]),
    snapshotById = new Map(
      snapshots.flatMap((snapshot) => (snapshot.task ? [[snapshot.task.taskId, snapshot] as const] : [])),
    );
  // Each new task is visited once; the closure includes cycles, which blockingOf refuses.
  for (const id of reachable)
    for (const edge of relations)
      if (edge.relationType === "depends-on" && edge.state !== "retired" && edge.sourceRef === `task/${id}`) {
        const target = /^task\/([^/]+)$/u.exec(edge.targetRef)?.[1];
        if (target && tasks.find((task) => task.taskId === target)?.status !== "done") reachable.add(target);
      }
  const blocking = assessments.find((row) => row.taskId === taskId),
    decisionById = new Map(decisions.map((decision) => [decision.decisionId, decision])),
    warnings = [
      ...assessments.filter((row) => reachable.has(row.taskId)).flatMap((row) => row.warnings),
      ...(!tasks.some((task) => task.taskId === taskId) ? [`task ${taskId} is missing from projection`] : []),
    ],
    proposedDecisionIds: string[] = [];
  for (const edge of relations.filter(
    ({ relationType, targetRef }) => relationType === "derives" && targetRef === `task/${taskId}`,
  )) {
    const decisionId = /^decision\/([^/]+)\/[^/]+$/u.exec(edge.sourceRef)?.[1];
    if (edge.state === "retired") continue;
    if (!decisionId || edge.direction !== "directed") {
      warnings.push(`invalid derives relation ${edge.relationId}`);
      continue;
    }
    const decision = decisionById.get(decisionId);
    if (!decision) warnings.push(`deriving decision ${decisionId} is missing from projection`);
    else if (decision.state === "proposed") {
      if (!relationIsCurrent(edge) || relationConsumability(edge) === "refuse")
        warnings.push(`derives relation ${edge.relationId} is ${edge.freshness}`);
      proposedDecisionIds.push(decisionId);
    }
  }
  const stackedTargets = new Map<string, string>();
  for (const id of reachable) {
    const source = snapshotById.get(id),
      execution = source?.executions.findLast((candidate) => candidate.iteration === source.task?.iteration),
      baseline = execution?.schema === "execution/v1" ? execution.deliveryBaseline : undefined;
    if (baseline?.kind !== "commit" || !baseline.stackOn) continue;
    const targetId = baseline.stackOn.taskId,
      target = snapshotById.get(targetId),
      approved = target ? stackedDeliveryBaseline(target) : undefined,
      declared = relations.some(
        (edge) =>
          edge.relationType === "depends-on" &&
          edge.sourceRef === `task/${id}` &&
          edge.targetRef === `task/${targetId}` &&
          edge.direction === "directed" &&
          relationIsCurrent(edge),
      );
    if (
      declared &&
      approved?.kind === "commit" &&
      baseline.commitSha === approved.commitSha &&
      baseline.stackOn.executionId === approved.stackOn?.executionId
    )
      stackedTargets.set(id, targetId);
    else warnings.push(`stacked dependency ${targetId} no longer binds a consented current delivery`);
  }
  const unfinishedDependencyIds = assessments
    .filter((row) => reachable.has(row.taskId))
    .flatMap((row) =>
      row.blockers.flatMap((blocker) =>
        blocker.kind === "depends-on" && stackedTargets.get(blocker.sourceTaskId) !== blocker.targetTaskId
          ? [blocker.targetTaskId]
          : [],
      ),
    );
  return {
    taskId,
    state:
      proposedDecisionIds.length || unfinishedDependencyIds.length
        ? "blocked"
        : warnings.length || blocking?.state === "unknown"
          ? "unknown"
          : "clear",
    proposedDecisionIds: [...new Set(proposedDecisionIds)],
    unfinishedDependencyIds: [...new Set(unfinishedDependencyIds)],
    warnings: [...new Set(warnings)],
  };
}

function taskId(ref: string): string | null {
  return /^task\/([^/]+)$/u.exec(ref)?.[1] ?? null;
}
function add<K, V>(map: Map<K, V[]>, key: K, value: V): void {
  map.set(key, [...(map.get(key) ?? []), value]);
}
function findCycleNodes(graph: ReadonlyMap<string, readonly string[]>): ReadonlySet<string> {
  const cycles = new Set<string>(),
    visited = new Set<string>(),
    active = new Set<string>(),
    stack: string[] = [];
  const visit = (id: string): void => {
    if (active.has(id)) {
      stack.slice(stack.indexOf(id)).forEach((node) => cycles.add(node));
      return;
    }
    if (visited.has(id)) return;
    visited.add(id);
    active.add(id);
    stack.push(id);
    for (const next of graph.get(id) ?? []) visit(next);
    stack.pop();
    active.delete(id);
  };
  for (const id of graph.keys()) visit(id);
  return cycles;
}

/** The current, consented implementation cut is the only admissible explicit stack anchor. */
export function stackedDeliveryBaseline(snapshot: TaskLifecycleSnapshot): ExecutionDeliveryBaseline | undefined {
  if (snapshot.task?.status !== "in_review" && snapshot.task?.status !== "done") return undefined;
  const execution = snapshot.executions.findLast((candidate) => candidate.iteration === snapshot.task?.iteration);
  if (
    execution?.schema !== "execution/v1" ||
    !execution.submission?.commitSha ||
    (execution.state !== "submitted" && execution.state !== "accepted") ||
    !consentedApprovedReviewForExecution(snapshot.reviews, snapshot.consents, execution, snapshot.reviewDispositions)
  )
    return undefined;
  return {
    kind: "commit",
    commitSha: execution.submission.commitSha,
    stackOn: { taskId: snapshot.task.taskId, executionId: execution.executionId },
  };
}
