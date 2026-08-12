// @slice-activation P4 W2 delegates every replay/v1 Lease mutation to the sole WriteCoordinator.
import { createHash } from "node:crypto";
import type { Effect } from "effect";
import { TASK_LEASE_BROKER_CONTRACT, type LeaseV1 } from "../domain/execution.ts";
import { taskEntityId } from "../domain/entity-id.ts";
import type { WriteError } from "../domain/errors.ts";
import { canonicalizeContractValue, type ActorAxes } from "../domain/task.ts";
import type { WriteSource } from "../domain/write-chain.contract.ts";
import type { LeaseCasPayload, WriteCoordinator } from "../ports/write-coordinator.ts";
export class TaskLeaseConflictError extends Error {
  readonly code: string; readonly origin = "task-lease-broker";
  constructor(message: string, code = "lease_conflict") { super(message); this.name = "TaskLeaseConflictError"; this.code = code; }
}
interface LeaseCasInput { readonly taskId: string; readonly executionId: string; readonly actor: ActorAxes; readonly source: WriteSource; readonly version: number }
export interface TaskLeaseStore {
  readonly current: (taskId: string) => LeaseV1 | null;
  readonly reserve: (input: Omit<LeaseCasInput, "version"> & { readonly expiresAt: string; readonly ttlMs: number }) => Promise<LeaseV1>;
  readonly activate: (input: LeaseCasInput) => Promise<LeaseV1>;
  readonly renew: (input: LeaseCasInput & { readonly expiresAt: string; readonly ttlMs: number }) => Promise<LeaseV1>;
  readonly release: (input: LeaseCasInput) => Promise<LeaseV1>;
}
export interface TaskLeaseStoreOptions { readonly rootDir: string; readonly coordinator: WriteCoordinator;
  readonly runEffect: <A>(effect: Effect.Effect<A, WriteError>) => Promise<A>; readonly now?: () => string;
  readonly readEffectiveLease: (rootDir: string, taskId: string, now: string) => LeaseV1 | null;
  readonly readStoredLease: (rootDir: string, taskId: string) => LeaseV1 | null }
export function makeTaskLeaseStoreAdapter(options: TaskLeaseStoreOptions): TaskLeaseStore {
  const now = options.now ?? (() => new Date().toISOString());
  const mutate = async (payload: Omit<LeaseCasPayload, "now" | "capacity">): Promise<LeaseV1> => {
    const mutation = { ...payload, now: now(), capacity: TASK_LEASE_BROKER_CONTRACT.capacity } satisfies LeaseCasPayload;
    const opId = `lease-${payload.operation}-${createHash("sha256").update(JSON.stringify(canonicalizeContractValue(mutation))).digest("hex")}`;
    try {
      await options.runEffect(options.coordinator.enqueue({ opId, entityId: taskEntityId(payload.taskId), kind: "lease_cas", payload: mutation }));
      await options.runEffect(options.coordinator.flush("explicit"));
    } catch (error) { throw leaseError(error); }
    const lease = options.readStoredLease(options.rootDir, payload.taskId);
    if (lease === null || lease.executionId !== payload.executionId
      || JSON.stringify(canonicalizeContractValue([lease.actor, lease.source])) !== JSON.stringify(canonicalizeContractValue([payload.actor, payload.source]))) {
      throw new TaskLeaseConflictError(`lease coordinator did not publish the requested ${payload.operation} for task ${payload.taskId}`, "lease_publication_unknown");
    }
    return lease;
  };
  return { current: (taskId) => options.readEffectiveLease(options.rootDir, taskId, now()),
    reserve: (input) => mutate({ operation: "reserve", ...input }), activate: (input) => mutate({ operation: "activate", ...input }),
    renew: (input) => mutate({ operation: "renew", ...input }), release: (input) => mutate({ operation: "release", ...input }) };
}
function leaseError(error: unknown): TaskLeaseConflictError {
  const cause = isWriteError(error) && error._tag === "JournalUnavailable" ? error.cause : error;
  if (typeof cause === "object" && cause !== null && "code" in cause && typeof cause.code === "string"
    && "message" in cause && typeof cause.message === "string") return new TaskLeaseConflictError(cause.message, cause.code);
  return new TaskLeaseConflictError(cause instanceof Error ? cause.message : String(cause));
}
function isWriteError(error: unknown): error is WriteError { return typeof error === "object" && error !== null && "_tag" in error; }
