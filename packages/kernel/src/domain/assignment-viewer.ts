import { parseAssignmentExpiry } from "./entity-relation.ts";
import { parseEntityRef } from "./entity-ref.ts";

export interface AssignmentViewer {
  readonly personId: string;
  readonly nodeId?: string;
  readonly teamIds?: readonly string[];
}

export interface AssignmentRelationLike {
  readonly sourceRef: string;
  readonly targetRef: string;
  readonly relationType: string;
  readonly state: string;
  readonly rationale: string;
}

/** Agenda ownership rule shared by every entity surface. */
export function assignmentMatchesViewer(
  relation: AssignmentRelationLike | null,
  viewer: AssignmentViewer,
  ownerPersonId: string | null | undefined,
  now: string,
): boolean {
  if (relation === null || relation.state !== "active" || relation.relationType !== "assigned-to")
    return ownerPersonId === viewer.personId;
  const expiresAt = parseAssignmentExpiry(relation.rationale);
  if (expiresAt === null || Date.parse(expiresAt) <= Date.parse(now)) return ownerPersonId === viewer.personId;
  const target = parseEntityRef(relation.targetRef);
  if (!target) return false;
  if (target.kind === "person") return target.id === viewer.personId;
  if (target.kind === "node") return target.id === viewer.nodeId;
  return target.kind === "team" && (viewer.teamIds ?? []).includes(target.id);
}
