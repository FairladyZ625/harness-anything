import { hasOnlyFields, hasRequiredFields, isNonEmptyString, isRecord } from "./contract-validation.ts";
import { timestamp } from "./timestamp.ts";

export type TaskAssignee =
  | { readonly kind: "person"; readonly personId: string; readonly nodeId?: string }
  | { readonly kind: "node"; readonly nodeId: string }
  | { readonly kind: "team"; readonly teamId: string };
export interface TaskAssignment {
  readonly assignee: TaskAssignee;
  readonly expiresAt: string;
}
export interface TaskClaimant {
  readonly personId: string;
  readonly nodeId: string | null;
  readonly teamIds: readonly string[];
}
export const taskClaimScopes = ["node", "reserved", "startable"] as const;
export type TaskClaimScope = (typeof taskClaimScopes)[number];

export function validTaskAssignment(value: unknown, allowUnknownFields = false): value is TaskAssignment {
  const hasFields = allowUnknownFields ? hasRequiredFields : hasOnlyFields;
  if (
    !isRecord(value) ||
    !hasFields(value, ["assignee", "expiresAt"]) ||
    !timestamp(value.expiresAt) ||
    !isRecord(value.assignee)
  )
    return false;
  const assignee = value.assignee;
  if (assignee.kind === "node") return hasFields(assignee, ["kind", "nodeId"]) && isNonEmptyString(assignee.nodeId);
  if (assignee.kind === "team") return hasFields(assignee, ["kind", "teamId"]) && isNonEmptyString(assignee.teamId);
  return (
    assignee.kind === "person" &&
    isNonEmptyString(assignee.personId) &&
    (assignee.nodeId === undefined || isNonEmptyString(assignee.nodeId)) &&
    hasFields(assignee, ["kind", "personId", ...(assignee.nodeId === undefined ? [] : ["nodeId"])])
  );
}

/** Expiry removes eligibility restrictions; it never changes an execution lease. */
export function taskAssignmentMatches(
  assignment: TaskAssignment | null | undefined,
  claimant: TaskClaimant,
  now: string,
  scope: TaskClaimScope = "startable",
): boolean {
  if (!assignment || Date.parse(assignment.expiresAt) <= Date.parse(now)) return scope === "startable";
  const assignee = assignment.assignee;
  if (assignee.kind === "node")
    return scope !== "node" ? assignee.nodeId === claimant.nodeId : assignee.nodeId === claimant.nodeId;
  if (assignee.kind === "team") return scope !== "node" && claimant.teamIds.includes(assignee.teamId);
  return (
    assignee.personId === claimant.personId &&
    (assignee.nodeId === undefined ? scope !== "node" : assignee.nodeId === claimant.nodeId)
  );
}
