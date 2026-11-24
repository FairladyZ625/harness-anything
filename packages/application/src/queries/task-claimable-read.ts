import {
  canStartExecution,
  isNativeExecution,
  parseAssignmentExpiry,
  type AssignmentRelationLike,
  type SettingsV1,
  type TaskAssignment,
  type TaskClaimScope,
  type TaskProjection,
} from "@harness-anything/kernel";

export interface TaskClaimableResult {
  readonly schema: "task-claimable/v1";
  readonly scope: TaskClaimScope;
  readonly tasks: readonly {
    readonly taskId: string;
    readonly title: string;
    readonly assignment: TaskAssignment | null;
  }[];
}

/** A fresh eligibility hint. Starting still re-evaluates permission, assignment and the canonical lease. */
export async function readClaimableTasks(input: {
  readonly settings: SettingsV1;
  readonly now: string;
  /** A bounded task page. Repository callers route this through guiTasks, which selects
   * scalar index ids before hydrating the requested point set. */
  readonly page: (query: {
    readonly activePackagesOnly: true;
    /** Claimability uses lifecycle status; skip presentation subtree derivation. */
    readonly statusSource: "raw";
    readonly limit: 500;
    readonly cursor?: string;
  }) => Promise<ReturnType<TaskProjection["list"]>>;
  readonly readAssignments?: () => Promise<readonly AssignmentRelationLike[]>;
  readonly claimant: { readonly personId: string; readonly nodeId: string | null; readonly teamIds: readonly string[] };
  readonly authorizeRepository: () => Promise<{ readonly outcome: string; readonly reasonCode?: string }>;
  readonly authorizeTask: (taskId: string) => Promise<{ readonly outcome: string }>;
  readonly codedError: (code: string, message: string) => Error;
}): Promise<TaskClaimableResult> {
  const { now } = input,
    permission = await input.authorizeRepository();
  if (permission.reasonCode === "keycloak_unavailable")
    throw input.codedError("keycloak_unavailable", "Cannot refresh task claim permissions.");
  let sawPermittedTask = permission.outcome === "allowed";
  const scope = input.settings.fleet.claim.scope as TaskClaimScope,
    claimant = input.claimant,
    candidates: {
      taskId: string;
      title: string;
      assignment: TaskClaimableResult["tasks"][number]["assignment"];
      priority: number;
      urgency: number;
      createdAt: string;
    }[] = [];
  const assignmentBySource = new Map(
    (await input.readAssignments?.())?.map((relation) => [relation.sourceRef, relation] as const) ?? [],
  );
  let cursor: string | undefined;
  do {
    const page = await input.page({
      activePackagesOnly: true,
      statusSource: "raw",
      limit: 500,
      ...(cursor ? { cursor } : {}),
    });
    if (page.status !== "ready") throw input.codedError("projection_pending", "Task candidates are not ready.");
    for (const row of page.rows) {
      const snapshot = row.snapshot,
        task = snapshot.task;
      if (!task || task.packageDisposition !== "active") continue;
      if (permission.outcome !== "allowed") {
        const taskPermission = await input.authorizeTask(task.taskId);
        if (taskPermission.outcome !== "allowed") continue;
        sawPermittedTask = true;
      }
      const execution = snapshot.executions.find(
        (entry) => isNativeExecution(entry) && entry.iteration === task.iteration && entry.state === "active",
      );
      const assignment = assignmentBySource.get(`task/${task.taskId}`) ?? null;
      if (
        !canStartExecution(snapshot, execution?.executionId ?? `claimable-${task.taskId}`) ||
        !assignmentMatchesClaimant(assignment, claimant, now, scope)
      )
        continue;
      const visibleAssignment =
        assignment &&
        (() => {
          const expiresAt = parseAssignmentExpiry(assignment.rationale);
          return expiresAt !== null && Date.parse(expiresAt) > Date.parse(now);
        })()
          ? assignmentToTaskAssignment(assignment)
          : null;
      candidates.push({
        taskId: task.taskId,
        title: task.title,
        assignment: visibleAssignment,
        priority: visibleAssignment
          ? assignment?.targetRef.startsWith("node/")
            ? 0
            : assignment?.targetRef.startsWith("person/")
              ? 1
              : 2
          : 3,
        urgency: task.metadata?.urgency === "high" ? 0 : task.metadata?.urgency === "medium" ? 1 : 2,
        createdAt: row.createdAt ?? "",
      });
    }
    cursor = page.page?.nextCursor ?? undefined;
  } while (cursor);
  if (!sawPermittedTask)
    throw input.codedError("authorization_denied", "No permission to start tasks in this repository.");
  candidates.sort(
    (a, b) =>
      a.priority - b.priority ||
      a.urgency - b.urgency ||
      a.createdAt.localeCompare(b.createdAt) ||
      a.taskId.localeCompare(b.taskId),
  );
  return {
    schema: "task-claimable/v1",
    scope,
    tasks: candidates.slice(0, 50).map(({ taskId, title, assignment }) => ({ taskId, title, assignment })),
  };
}

function assignmentMatchesClaimant(
  assignment: AssignmentRelationLike | null,
  claimant: { readonly personId: string; readonly nodeId: string | null; readonly teamIds: readonly string[] },
  now: string,
  scope: TaskClaimScope,
): boolean {
  if (assignment === null) return scope === "startable";
  const expiresAt = parseAssignmentExpiry(assignment.rationale);
  if (expiresAt === null || Date.parse(expiresAt) <= Date.parse(now)) return scope === "startable";
  if (assignment.targetRef.startsWith("node/")) return assignment.targetRef.slice("node/".length) === claimant.nodeId;
  if (assignment.targetRef.startsWith("team/"))
    return scope !== "node" && claimant.teamIds.includes(assignment.targetRef.slice("team/".length));
  return scope !== "node" && assignment.targetRef.slice("person/".length) === claimant.personId;
}

function assignmentToTaskAssignment(assignment: AssignmentRelationLike): TaskAssignment | null {
  const expiresAt = parseAssignmentExpiry(assignment.rationale);
  if (!expiresAt) return null;
  if (assignment.targetRef.startsWith("node/"))
    return { assignee: { kind: "node", nodeId: assignment.targetRef.slice("node/".length) }, expiresAt };
  if (assignment.targetRef.startsWith("team/"))
    return { assignee: { kind: "team", teamId: assignment.targetRef.slice("team/".length) }, expiresAt };
  return { assignee: { kind: "person", personId: assignment.targetRef.slice("person/".length) }, expiresAt };
}
