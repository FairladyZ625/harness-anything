import { parseAssignmentExpiry, type TaskAssignment, type TaskProjection } from "@harness-anything/kernel";

type AssignmentRelation = ReturnType<TaskProjection["readRelationQuery"]>["rows"][number];

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
