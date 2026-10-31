import {
  parseAssignmentExpiry,
  taskAssignmentMatches,
  type TaskAssignment,
  type TaskClaimant,
  type TaskProjection,
} from "@harness-anything/kernel";
import { cellCodedError } from "./repo-cell-errors.ts";
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

export function assignmentFromRelations(
  projection: Pick<TaskProjection, "readRelationQuery">,
  entityRef: string,
): TaskAssignment | null {
  const row = projection.readRelationQuery({ source: entityRef, relationType: "assigned-to", state: "active" }).rows[0];
  return row ? assignmentFromRelation(row) : null;
}

export function assignmentFromRelation(
  relation: Pick<AssignmentRelation, "targetRef" | "rationale">,
): TaskAssignment | null {
  const expiresAt = parseAssignmentExpiry(relation.rationale);
  if (!expiresAt) return null;
  const target = relation.targetRef;
  if (target.startsWith("person/"))
    return { assignee: { kind: "person", personId: target.slice("person/".length) }, expiresAt };
  if (target.startsWith("node/"))
    return { assignee: { kind: "node", nodeId: target.slice("node/".length) }, expiresAt };
  if (target.startsWith("team/"))
    return { assignee: { kind: "team", teamId: target.slice("team/".length) }, expiresAt };
  return null;
}

type AssignmentRelation = ReturnType<TaskProjection["readRelationQuery"]>["rows"][number];
