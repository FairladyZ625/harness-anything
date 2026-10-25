import {
  blockingOf,
  isDomainStatus,
  isTerminalStatus,
  relationIsCurrent,
  type TaskIndexProjectionRow,
  type TaskProjection,
} from "@harness-anything/kernel";

const TASK_INDEX_PAGE_LIMIT = 500;
const TASK_REF = /^task\/([^/]+)$/u;

type TopologyState =
  | "done"
  | "cancelled"
  | "in-flight"
  | "awaiting-ruling"
  | "blocked"
  | "ready"
  | "unknown"
  | "boundary";
type BlockingAssessment = ReturnType<typeof blockingOf>[number];

export interface WorkTopologyNode {
  readonly taskId: string;
  readonly title: string;
  readonly canonicalStatus: TaskIndexProjectionRow["status"] | null;
  readonly topologyState: TopologyState;
  readonly parentTaskId: string | null;
  readonly pinned: boolean;
  readonly boundary: boolean;
  readonly blockers: BlockingAssessment["blockers"];
  readonly warnings: readonly string[];
}

export interface WorkTopologyEdge {
  readonly relationId: string;
  readonly from: string;
  readonly to: string;
  readonly kind: "depends-on";
  readonly direction: string;
  readonly state: string;
  readonly rationale: string;
}

export interface WorkTopologyRead {
  readonly schema: "daemon.work-topology/v1";
  readonly ok: true;
  readonly status: "ready" | "pending";
  readonly workRootTaskId: string;
  readonly members: readonly WorkTopologyNode[];
  /** Direct prerequisite task endpoints outside the subtree; never expanded recursively. */
  readonly boundaryTasks: readonly WorkTopologyNode[];
  readonly edges: readonly WorkTopologyEdge[];
  readonly frontier: readonly string[];
  /** Prerequisite-first task ids; null means a complete path cannot be established. */
  readonly criticalPath: readonly string[] | null;
  readonly completeness: "complete" | "partial";
  readonly warnings: readonly string[];
  readonly watermark: number;
  readonly sourceRevision: number;
}

/**
 * Derive one work's task topology from indexed projection reads. Each parent lookup is bounded to
 * that parent's children, each dependency lookup to member relation sources, and direct external
 * prerequisites are loaded by id without following their own dependencies.
 */
export function workTopologyFromProjection(
  projection: TaskProjection,
  input: { readonly workRootTaskId: string },
): WorkTopologyRead {
  const cut = projection.readCut(),
    warnings = new Set<string>(),
    rootRead = projection.readTaskIndex({ taskIds: [input.workRootTaskId], limit: 1 });
  assertSameCut(cut, rootRead);
  if (rootRead.status !== "ready") warnings.add("task projection is pending");
  for (const warning of rootRead.warnings) warnings.add(warning);
  const root = rootRead.rows[0];
  if (!root) throw new Error(`Work topology root task not found: ${input.workRootTaskId}`);

  const rows = new Map<string, TaskIndexProjectionRow>([[root.taskId, root]]),
    pending = [root.taskId];
  for (let pendingIndex = 0; pendingIndex < pending.length; pendingIndex += 1) {
    const parentTaskId = pending[pendingIndex]!;
    let cursor: string | undefined;
    do {
      const read = projection.readTaskIndex({
        parentTaskId,
        limit: TASK_INDEX_PAGE_LIMIT,
        ...(cursor === undefined ? {} : { cursor }),
      });
      assertSameCut(cut, read);
      if (read.status !== "ready") warnings.add("task projection is pending");
      for (const warning of read.warnings) warnings.add(warning);
      for (const row of read.rows) {
        if (rows.has(row.taskId)) {
          warnings.add(`task parent cycle or duplicate membership at ${row.taskId}`);
          continue;
        }
        rows.set(row.taskId, row);
        pending.push(row.taskId);
      }
      cursor = read.page?.nextCursor ?? undefined;
    } while (cursor !== undefined);
  }

  const memberIds = [...rows.keys()],
    memberRefs = memberIds.map((taskId) => `task/${taskId}`),
    dependencyRead = projection.readTaskRelationsBySources(memberRefs, "depends-on"),
    awaitsRead = projection.readTaskRelationsBySources(memberRefs, "awaits");
  assertSameCut(cut, dependencyRead);
  assertSameCut(cut, awaitsRead);
  if (dependencyRead.status !== "ready" || awaitsRead.status !== "ready")
    warnings.add("relation projection is pending");

  const externalTaskIds = new Set<string>();
  for (const edge of dependencyRead.rows) {
    if (edge.state !== "active") continue;
    const match = TASK_REF.exec(edge.targetRef);
    if (match && !rows.has(match[1]!)) externalTaskIds.add(match[1]!);
  }
  const externalRead =
    externalTaskIds.size === 0 ? null : projection.readTaskIndex({ taskIds: [...externalTaskIds].sort() });
  if (externalRead) {
    assertSameCut(cut, externalRead);
    if (externalRead.status !== "ready") warnings.add("external task projection is pending");
    for (const warning of externalRead.warnings) warnings.add(warning);
  }
  const externalRows = new Map((externalRead?.rows ?? []).map((row) => [row.taskId, row]));
  for (const taskId of externalTaskIds)
    if (!externalRows.has(taskId)) warnings.add(`dependency endpoint task/${taskId} is missing from the projection`);

  const allTaskRows = [...rows.values(), ...externalRows.values()],
    relationRows = [...dependencyRead.rows, ...awaitsRead.rows],
    blocking = blockingOf(
      allTaskRows.map(({ taskId, status }) => ({ taskId, status })),
      relationRows.map((edge) => ({
        relationId: edge.relationId,
        sourceRef: edge.sourceRef,
        targetRef: edge.targetRef,
        relationType: edge.relationType,
        direction: edge.direction,
        state: edge.state,
        strength: edge.strength,
        freshness: edge.freshness,
        rationale: edge.rationale,
      })),
      {
        state: cut.status === "ready" && warnings.size === 0 ? "ready" : "loading",
        ...(warnings.size === 0 ? {} : { hardFailWarnings: [...warnings] }),
      },
    ),
    assessments = new Map(blocking.map((assessment) => [assessment.taskId, assessment]));

  for (const assessment of blocking) for (const warning of assessment.warnings) warnings.add(warning);
  const incomplete = cut.status !== "ready" || warnings.size > 0,
    members = [...rows.values()]
      .sort((left, right) =>
        left.taskId === root.taskId ? -1 : right.taskId === root.taskId ? 1 : left.taskId.localeCompare(right.taskId),
      )
      .map((row) => topologyNode(row, false, assessments.get(row.taskId), incomplete)),
    boundaryTasks = [...externalRows.values()]
      .sort((left, right) => left.taskId.localeCompare(right.taskId))
      .map((row) => topologyNode(row, true, assessments.get(row.taskId), incomplete)),
    edges = dependencyRead.rows
      .filter((edge) => edge.state === "active")
      .map(
        (edge): WorkTopologyEdge => ({
          relationId: edge.relationId,
          from: edge.sourceRef,
          to: edge.targetRef,
          kind: "depends-on",
          direction: edge.direction,
          state: edge.state,
          rationale: edge.rationale,
        }),
      )
      .sort((left, right) => left.from.localeCompare(right.from) || left.relationId.localeCompare(right.relationId)),
    frontier = members
      .filter((node) => !isTerminalStatus(node.canonicalStatus!) && assessments.get(node.taskId)?.state === "clear")
      .map(({ taskId }) => taskId)
      .sort();
  const criticalPath = incomplete ? null : longestRemainingDependencyPath(members, dependencyRead.rows);
  if (!incomplete && criticalPath === null) warnings.add("active depends-on cycle detected");

  return {
    schema: "daemon.work-topology/v1",
    ok: true,
    status: cut.status,
    workRootTaskId: root.taskId,
    members,
    boundaryTasks,
    edges,
    frontier,
    criticalPath,
    completeness: warnings.size === 0 ? "complete" : "partial",
    warnings: [...warnings].sort(),
    watermark: cut.watermark,
    sourceRevision: cut.sourceRevision,
  };
}

function topologyNode(
  row: TaskIndexProjectionRow,
  boundary: boolean,
  assessment: BlockingAssessment | undefined,
  incomplete: boolean,
): WorkTopologyNode {
  const status = isDomainStatus(row.status) ? row.status : null,
    blockers = assessment?.blockers ?? [],
    warnings = assessment?.warnings ?? [];
  let topologyState: TopologyState;
  if (boundary) topologyState = status === null ? "unknown" : "boundary";
  else if (status === "done") topologyState = "done";
  else if (status === "cancelled") topologyState = "cancelled";
  else if (blockers.some((blocker) => blocker.kind === "awaits")) topologyState = "awaiting-ruling";
  else if (assessment?.warnings.some((warning) => warning.includes("cycle"))) topologyState = "blocked";
  else if (status === "active") topologyState = "in-flight";
  else if (assessment?.state === "blocked" || status === "blocked") topologyState = "blocked";
  else if (incomplete || status === null || assessment?.state === "unknown") topologyState = "unknown";
  else topologyState = "ready";
  return {
    taskId: row.taskId,
    title: row.title,
    canonicalStatus: status,
    topologyState,
    parentTaskId: row.parentTaskId,
    pinned: row.pinned,
    boundary,
    blockers,
    warnings,
  };
}

function longestRemainingDependencyPath(
  members: readonly WorkTopologyNode[],
  edges: ReturnType<TaskProjection["readTaskRelationsBySources"]>["rows"],
): readonly string[] | null {
  const openIds = new Set(
      members.flatMap((node) =>
        node.canonicalStatus !== null && !isTerminalStatus(node.canonicalStatus) ? [node.taskId] : [],
      ),
    ),
    successors = new Map([...openIds].map((taskId) => [taskId, [] as string[]])),
    indegree = new Map([...openIds].map((taskId) => [taskId, 0]));
  for (const edge of edges) {
    const source = TASK_REF.exec(edge.sourceRef)?.[1],
      target = TASK_REF.exec(edge.targetRef)?.[1];
    if (
      edge.relationType !== "depends-on" ||
      !relationIsCurrent(edge) ||
      edge.direction !== "directed" ||
      !source ||
      !target ||
      !openIds.has(source) ||
      !openIds.has(target)
    )
      continue;
    // Relation direction is blocked task → prerequisite; the path is returned prerequisite first.
    successors.get(target)!.push(source);
    indegree.set(source, indegree.get(source)! + 1);
  }
  const ready = [...openIds].filter((taskId) => indegree.get(taskId) === 0).sort(),
    order: string[] = [];
  for (let readyIndex = 0; readyIndex < ready.length; readyIndex += 1) {
    const taskId = ready[readyIndex]!;
    order.push(taskId);
    for (const successor of successors.get(taskId)!.sort()) {
      indegree.set(successor, indegree.get(successor)! - 1);
      if (indegree.get(successor) === 0) ready.push(successor);
    }
  }
  if (order.length !== openIds.size) return null;
  const best = new Map<string, readonly string[]>();
  for (const taskId of order.toReversed()) {
    let path: readonly string[] = [taskId];
    for (const successor of successors.get(taskId)!) {
      const candidate = [taskId, ...best.get(successor)!];
      if (
        candidate.length > path.length ||
        (candidate.length === path.length && candidate.join("\0") < path.join("\0"))
      )
        path = candidate;
    }
    best.set(taskId, path);
  }
  return (
    [...best.values()].sort(
      (left, right) => right.length - left.length || left.join("\0").localeCompare(right.join("\0")),
    )[0] ?? []
  );
}

function assertSameCut(
  expected: ReturnType<TaskProjection["readCut"]>,
  actual: { readonly watermark: number; readonly sourceRevision: number },
): void {
  if (actual.watermark !== expected.watermark || actual.sourceRevision !== expected.sourceRevision)
    throw new Error("Work topology projection reads crossed a cut.");
}
