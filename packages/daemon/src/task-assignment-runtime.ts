import {
  taskAssignmentMatches,
  validTaskAssignment,
  type TaskAssignment,
  type TaskClaimant,
  type SettingsV1,
} from "@harness-anything/kernel";
import { KeycloakPolicyAdapter } from "./keycloak-policy-adapter.ts";
import { cellCodedError } from "./repo-cell-errors.ts";
import type { RepoCellBinding, RepoTaskAction } from "./repo-cell-types.ts";

async function directory(binding: RepoCellBinding) {
  const centerAuthority = binding.keycloakAuthorization?.center;
  if (!centerAuthority)
    throw cellCodedError("authorization_denied", "Keycloak center credentials are required for task assignments.");
  const center = await centerAuthority();
  return {
    adapter: new KeycloakPolicyAdapter({
      url: center.url,
      realm: center.realm,
      resourceServerClientId: center.clientId,
    }),
    token: center.accessToken,
  };
}
export async function resolveTaskAssignment(
  action: RepoTaskAction,
  binding: RepoCellBinding,
  settings: SettingsV1,
  now: string,
): Promise<TaskAssignment> {
  const { adapter, token } = await directory(binding);
  let assignee: TaskAssignment["assignee"];
  if (typeof action.nodeId === "string") {
    const node = await adapter.readNode(token, action.nodeId);
    if (!node) throw cellCodedError("node_unregistered", "The selected node is not registered.");
    assignee = { kind: "person", personId: node.personId, nodeId: node.nodeId };
  } else if (typeof action.teamId === "string") {
    await adapter.readTeam(token, action.teamId);
    assignee = { kind: "team", teamId: action.teamId };
  } else {
    if (typeof action.personId !== "string" || !(await adapter.findUserId(token, action.personId)))
      throw cellCodedError("person_not_found", "The selected person does not exist.");
    assignee = { kind: "person", personId: action.personId };
  }
  const assignment = {
    assignee,
    expiresAt: action.expiresAt ?? new Date(Date.parse(now) + settings.tasks.assignmentTtlMs).toISOString(),
  };
  if (!validTaskAssignment(assignment))
    throw cellCodedError("invalid_command", "Assignment expiry must be a timestamp.");
  return assignment;
}
export async function assertTaskAssignment(
  assignment: TaskAssignment | null | undefined,
  binding: RepoCellBinding,
  now: string,
): Promise<TaskClaimant> {
  const personId = binding.actor.principal.personId,
    nodeId = typeof binding.source === "object" && binding.source.kind === "node" ? binding.source.nodeId : null;
  let teamIds: readonly string[] = [];
  if (assignment?.assignee.kind === "team" && Date.parse(assignment.expiresAt) > Date.parse(now)) {
    const { adapter, token } = await directory(binding);
    teamIds = await adapter.readPersonTeams(token, personId);
  }
  const claimant = { personId, nodeId, teamIds };
  if (!taskAssignmentMatches(assignment, claimant, now))
    throw cellCodedError("task_assignee_mismatch", "This task is assigned to a different person, node or work team.");
  return claimant;
}
