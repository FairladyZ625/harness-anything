import { taskAssignmentMatches, type TaskAssignment, type TaskClaimant } from "@harness-anything/kernel";
import { cellCodedError } from "./repo-cell-errors.ts";
export { assignmentFromRelation, assignmentFromRelations } from "@harness-anything/application/internal/queries/task-assignment-read.ts";
import type { RepoCellBinding } from "./repo-cell-types.ts";

async function principalDirectory(binding: RepoCellBinding) {
  const centerAuthority = binding.keycloakAuthorization?.center;
  if (!centerAuthority)
    throw cellCodedError("authorization_denied", "Assignment target resolution requires the center directory.");
  const center = await centerAuthority();
  return {
    adapter: center.provider,
    token: center.accessToken,
  };
}

export async function assertEntityAssignment(
  assignment: TaskAssignment | null | undefined,
  binding: RepoCellBinding,
  now: string,
): Promise<TaskClaimant> {
  const personId = binding.actor.principal.personId,
    nodeId = typeof binding.source === "object" && binding.source.kind === "node" ? binding.source.nodeId : null;
  let teamIds = binding.taskClaimant?.teamIds ?? [];
  if (assignment?.assignee.kind === "team" && Date.parse(assignment.expiresAt) > Date.parse(now)) {
    const { adapter, token } = await principalDirectory(binding);
    teamIds = await adapter.readPersonTeams(token, personId);
  }
  const claimant = { personId, nodeId, teamIds };
  if (!taskAssignmentMatches(assignment, claimant, now))
    throw cellCodedError("task_assignee_mismatch", "This entity is assigned to a different person, node or work team.");
  return claimant;
}
