import { createHash, randomBytes } from "node:crypto";
import { ExecutionLeaseCollisionError, TaskLeaseRequiredError } from "./task-holder-errors.ts";
import type { ExecutionLeaseRecord, TaskHolderPrincipal, TaskHolderRecord } from "./task-holder-state.ts";

type AnyTaskHolderRecord = TaskHolderRecord | ExecutionLeaseRecord;

export function sameTaskHolderPrincipal(left: TaskHolderPrincipal, right: TaskHolderPrincipal): boolean {
  return left.principal.personId === right.principal.personId;
}

export function sameExecutionLeaseActor(left: TaskHolderPrincipal, right: TaskHolderPrincipal): boolean {
  return sameTaskHolderPrincipal(left, right) &&
    left.executor?.kind === right.executor?.kind &&
    left.executor?.id === right.executor?.id;
}

export function hashExecutionLeaseToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export function leaseDurationMs(
  record: Pick<AnyTaskHolderRecord, "leaseExpiresAt" | "updatedAt">,
  fallback: number
): number {
  if (!record.leaseExpiresAt) return fallback;
  const duration = Date.parse(record.leaseExpiresAt) - Date.parse(record.updatedAt);
  return Number.isFinite(duration) && duration > 0 ? duration : fallback;
}

export function renewExecutionLeaseCredential(
  record: ExecutionLeaseRecord,
  input: { readonly principal: TaskHolderPrincipal; readonly leaseDurationMs: number },
  at: Date
): { readonly record: ExecutionLeaseRecord; readonly leaseToken: string } {
  if (record.phase !== "active" ||
      Date.parse(record.leaseExpiresAt) <= at.getTime() ||
      !sameExecutionLeaseActor(record.holder, input.principal)) {
    throw new ExecutionLeaseCollisionError({
      taskId: record.taskId,
      principal: input.principal,
      executionId: record.executionId,
      holder: record.holder,
      leaseExpiresAt: record.leaseExpiresAt
    });
  }
  const updatedAt = at.toISOString();
  const leaseToken = randomBytes(32).toString("hex");
  return {
    leaseToken,
    record: {
      ...record,
      tokenHash: hashExecutionLeaseToken(leaseToken),
      leaseExpiresAt: new Date(at.getTime() + input.leaseDurationMs).toISOString(),
      updatedAt,
      version: `${updatedAt}-${randomBytes(6).toString("hex")}`
    }
  };
}

export function requireExecutionCredential(
  record: AnyTaskHolderRecord | null,
  input: { readonly taskId: string; readonly executionId: string; readonly leaseToken: string; readonly principal: TaskHolderPrincipal },
  at: Date
): ExecutionLeaseRecord {
  const valid = record?.schema === "task-holder/v2" &&
    Date.parse(record.leaseExpiresAt) > at.getTime() &&
    record.executionId === input.executionId &&
    record.tokenHash === hashExecutionLeaseToken(input.leaseToken) &&
    sameExecutionLeaseActor(record.holder, input.principal);
  if (!valid) throw new TaskLeaseRequiredError({
    taskId: input.taskId,
    principal: input.principal,
    holder: record?.holder ?? null,
    leaseExpiresAt: record?.leaseExpiresAt ?? null,
    orphan: Boolean(record?.holder && !effectiveLeaseCredentialHolder(record, at))
  });
  return record;
}

function effectiveLeaseCredentialHolder(record: AnyTaskHolderRecord, at: Date): TaskHolderPrincipal | null {
  if (!record.holder || !record.leaseExpiresAt || record.releasedAt) return null;
  return Date.parse(record.leaseExpiresAt) > at.getTime() ? record.holder : null;
}
