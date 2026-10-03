import {
  canStartExecution,
  isNativeExecution,
  taskAssignmentMatches,
  effectivePolicyGroupScopes,
  type SettingsV1,
  type TaskClaimScope,
  type TaskProjection,
} from "@harness-anything/kernel";
import { KeycloakPolicyAdapter } from "./keycloak-policy-adapter.ts";
import { evaluateKeycloakPerson } from "./repo-cell-authorization.ts";
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
}): Promise<TaskClaimableResult> {
  const { binding, repoId, now } = input,
    source = binding.source,
    center = binding.keycloakAuthorization?.center;
  if (typeof source !== "object" || source.kind !== "node" || !center)
    throw cellCodedError("authentication_required", "Claimable tasks require an authenticated execution node.");
  const adapter = new KeycloakPolicyAdapter({
      url: center.url,
      realm: center.realm,
      resourceServerClientId: center.clientId,
    }),
    personId = binding.actor.principal.personId,
    permission = await evaluateKeycloakPerson({
      credential: binding.keycloakAuthorization!,
      personId,
      action: "task-start",
      resource: { kind: "repository", repoId },
    });
  if (permission.reasonCode === "keycloak_unavailable")
    throw cellCodedError("keycloak_unavailable", "Cannot refresh task claim permissions.");
  const teamIds = await adapter.readPersonTeams(center.accessToken, personId),
    permitted = new Set<string>();
  if (permission.outcome !== "allowed") {
    // The same effective-permissions read as access management; never persisted or used to accept a write.
    const [userId, grants, groups] = await Promise.all([
      adapter.findUserId(center.accessToken, personId),
      adapter.readGrants(center.accessToken),
      adapter.readPolicyGroups(center.accessToken),
    ]);
    for (const grant of grants)
      if (
        userId &&
        grant.userIds.includes(userId) &&
        groups.some((group) => group.id === grant.groupId) &&
        effectivePolicyGroupScopes(groups, grant.groupId).includes("task-start") &&
        grant.resource.startsWith(`${repoId}:task/`)
      )
        permitted.add(grant.resource.slice(`${repoId}:task/`.length));
    if (permitted.size === 0)
      throw cellCodedError("authorization_denied", "No permission to start tasks in this repository.");
  }
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
  let cursor: string | undefined;
  do {
    const page = await input.page(cursor);
    if (page.status !== "ready") throw cellCodedError("projection_pending", "Task candidates are not ready.");
    for (const row of page.rows) {
      const snapshot = row.snapshot,
        task = snapshot.task;
      if (
        !task ||
        task.packageDisposition !== "active" ||
        (permission.outcome !== "allowed" && !permitted.has(task.taskId))
      )
        continue;
      const execution = snapshot.executions.find(
        (entry) => isNativeExecution(entry) && entry.iteration === task.iteration && entry.state === "active",
      );
      if (
        !canStartExecution(snapshot, execution?.executionId ?? `claimable-${task.taskId}`) ||
        !taskAssignmentMatches(task.assignment, claimant, now, scope)
      )
        continue;
      const assignment =
          task.assignment && Date.parse(task.assignment.expiresAt) > Date.parse(now) ? task.assignment : null,
        assignee = assignment?.assignee;
      candidates.push({
        taskId: task.taskId,
        title: task.title,
        assignment,
        priority: assignee?.kind === "person" ? (assignee.nodeId ? 0 : 1) : assignee ? 2 : 3,
        urgency: task.metadata?.urgency === "high" ? 0 : task.metadata?.urgency === "medium" ? 1 : 2,
        createdAt: row.createdAt ?? "",
      });
    }
    cursor = page.page?.nextCursor ?? undefined;
  } while (cursor);
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
