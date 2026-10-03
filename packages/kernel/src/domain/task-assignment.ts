import { isNonEmptyString, isRecord } from "./contract-validation.ts";
import { timestamp } from "./timestamp.ts";

export type TaskAssignee =
  | { readonly kind: "person"; readonly personId: string; readonly nodeId?: string }
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

export function validTaskAssignment(value: unknown): value is TaskAssignment {
  if (
    !isRecord(value) ||
    Object.keys(value).some((key) => !["assignee", "expiresAt"].includes(key)) ||
    !timestamp(value.expiresAt) ||
    !isRecord(value.assignee)
  )
    return false;
  const assignee = value.assignee;
  if (assignee.kind === "team")
    return isNonEmptyString(assignee.teamId) && Object.keys(assignee).every((key) => ["kind", "teamId"].includes(key));
  return (
    assignee.kind === "person" &&
    isNonEmptyString(assignee.personId) &&
    (assignee.nodeId === undefined || isNonEmptyString(assignee.nodeId)) &&
    Object.keys(assignee).every((key) => ["kind", "personId", "nodeId"].includes(key))
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
  if (assignee.kind === "team") return scope !== "node" && claimant.teamIds.includes(assignee.teamId);
  return (
    assignee.personId === claimant.personId &&
    (assignee.nodeId === undefined ? scope !== "node" : assignee.nodeId === claimant.nodeId)
  );
}
