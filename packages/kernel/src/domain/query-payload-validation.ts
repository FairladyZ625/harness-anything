/** @slice-activation G4 registers the authority before the C phase-2 query
 * cutover removes the two in-flight consumers. */
import { relationStates } from "./entity-relation.ts";
import { isRecord } from "./write-chain.contract.ts";
import { domainStatuses } from "./lifecycle-status.ts";
import { timestamp } from "./timestamp.ts";

export type QueryPayloadKind = "task-list" | "relation-graph";

export type QueryPayloadValidationIssue =
  | "payload_not_object"
  | "status_invalid"
  | "changed_after_revision_invalid"
  | "time_window_invalid"
  | "limit_invalid"
  | "cursor_invalid";

/** Canonical domain constraints shared by query transport and execution adapters. */
export function queryPayloadValidation(kind: QueryPayloadKind, value: unknown): readonly QueryPayloadValidationIssue[] {
  if (value === undefined) return [];
  if (!isRecord(value)) return ["payload_not_object"];
  const issues: QueryPayloadValidationIssue[] = [],
    status = value.status,
    changedAfterRevision = value.changedAfterRevision,
    after = value.updatedAfter,
    before = value.updatedBefore,
    limit = value.limit,
    cursor = value.cursor,
    statusWords = kind === "task-list" ? domainStatuses : relationStates;
  if (status !== undefined && !(statusWords as readonly unknown[]).includes(status)) issues.push("status_invalid");
  if (
    kind === "task-list" &&
    changedAfterRevision !== undefined &&
    (!Number.isInteger(changedAfterRevision) || Number(changedAfterRevision) < 0)
  )
    issues.push("changed_after_revision_invalid");
  if (
    [after, before].some((item) => item !== undefined && !timestamp(item)) ||
    (typeof after === "string" && typeof before === "string" && after > before)
  )
    issues.push("time_window_invalid");
  if (limit !== undefined && (!Number.isInteger(limit) || Number(limit) < 1 || Number(limit) > 500))
    issues.push("limit_invalid");
  if (cursor !== undefined && (typeof cursor !== "string" || cursor.length === 0)) issues.push("cursor_invalid");
  return issues;
}
