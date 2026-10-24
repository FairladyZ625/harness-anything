import {
  canStartExecution,
  isNativeExecution,
  parseAssignmentExpiry,
  type SettingsV1,
  type TaskClaimScope,
  type TaskProjection,
  type TaskV2,
  type AssignmentRelationLike,
} from "@harness-anything/kernel";
import { KeycloakPolicyAdapter } from "./keycloak-policy-adapter.ts";
import { canonicalResourceAncestors, evaluateKeycloakPerson } from "./repo-cell-authorization.ts";
import { cellCodedError } from "./repo-cell-errors.ts";
import type { RepoCellBinding } from "./repo-cell-types.ts";
import type { TaskClaimableResult } from "./protocol/daemon-protocol-gui-types.ts";

/** A fresh eligibility hint. Starting still re-evaluates permission, assignment and the canonical lease. */
export async function readClaimableTasks(input: {
  readonly repoId: string;
  readonly binding: RepoCellBinding;
  readonly settings: SettingsV1;
  readonly now: string;
  readonly page: (cursor?: string) => Promise<ReturnType<TaskProjection["list"]>>;
  readonly readTask?: (taskId: string) => Promise<TaskV2 | null>;
  readonly readAssignments?: () => Promise<readonly AssignmentRelationLike[]>;
}): Promise<TaskClaimableResult> {
  const { binding, repoId, now } = input,
    source = binding.source,
    centerAuthority = binding.keycloakAuthorization?.center;
  if (typeof source !== "object" || source.kind !== "node" || !centerAuthority)
    throw cellCodedError("authentication_required", "Claimable tasks require an authenticated execution node.");
  const center = await centerAuthority(),
    adapter = new KeycloakPolicyAdapter({
      url: center.url,
      realm: center.realm,
      resourceServerClientId: center.clientId,
    }),
    personId = binding.actor.principal.personId,
    permission = await evaluateKeycloakPerson({
      // Read hints use the device session; the eventual write also evaluates center authority.
      credential: { session: binding.keycloakAuthorization!.session },
      personId,
      action: "task-start",
      resource: { kind: "repository", repoId },
    });
  if (permission.reasonCode === "keycloak_unavailable")
    throw cellCodedError("keycloak_unavailable", "Cannot refresh task claim permissions.");
  const teamIds = await adapter.readPersonTeams(center.accessToken, personId);
  let sawPermittedTask = permission.outcome === "allowed";
  const scope = input.settings.fleet.claim.scope as TaskClaimScope,
    claimant = { personId, nodeId: source.nodeId, teamIds },
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
    const page = await input.page(cursor);
    if (page.status !== "ready") throw cellCodedError("projection_pending", "Task candidates are not ready.");
    for (const row of page.rows) {
      const snapshot = row.snapshot,
        task = snapshot.task;
      if (!task || task.packageDisposition !== "active") continue;
      if (permission.outcome !== "allowed") {
        const taskPermission = await evaluateKeycloakPerson({
          credential: { session: binding.keycloakAuthorization!.session },
          personId,
          action: "task-start",
          resource: { kind: "entity", repoId, entityRef: `task/${task.taskId}` },
          resourceAncestors: await canonicalResourceAncestors(input.readTask, {
            kind: "entity",
            repoId,
            entityRef: `task/${task.taskId}`,
          }),
        });
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
    throw cellCodedError("authorization_denied", "No permission to start tasks in this repository.");
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

function assignmentToTaskAssignment(
  assignment: AssignmentRelationLike,
): TaskClaimableResult["tasks"][number]["assignment"] {
  const expiresAt = parseAssignmentExpiry(assignment.rationale);
  if (!expiresAt) return null;
  if (assignment.targetRef.startsWith("node/"))
    return { assignee: { kind: "node", nodeId: assignment.targetRef.slice("node/".length) }, expiresAt };
  if (assignment.targetRef.startsWith("team/"))
    return { assignee: { kind: "team", teamId: assignment.targetRef.slice("team/".length) }, expiresAt };
  return { assignee: { kind: "person", personId: assignment.targetRef.slice("person/".length) }, expiresAt };
}
