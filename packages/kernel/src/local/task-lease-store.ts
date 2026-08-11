// @slice-activation P4 W2 delegates every replay/v1 Lease mutation to the sole WriteCoordinator.
import { createHash } from "node:crypto";
import type { Effect } from "effect";
import { TASK_LEASE_BROKER_CONTRACT, type LeaseV1 } from "../domain/execution.ts";
import { taskEntityId } from "../domain/entity-id.ts";
import type { WriteError } from "../domain/errors.ts";
import { canonicalizeContractValue, type ActorAxes } from "../domain/task.ts";
import type { WriteCoordinator } from "../ports/index.ts";
import { readEffectiveTaskLease, readStoredTaskLease, TaskLeaseCasRejected, type LeaseCasPayload } from "../store/task-lease-cas.ts";
export class TaskLeaseConflictError extends Error {
  readonly code: string; readonly origin = "task-lease-broker";
  constructor(message: string, code = "lease_conflict") { super(message); this.name = "TaskLeaseConflictError"; this.code = code; }
}
interface LeaseCasInput { readonly taskId: string; readonly executionId: string; readonly actor: ActorAxes; readonly version: number }
export interface TaskLeaseStore {
  readonly current: (taskId: string) => LeaseV1 | null;
  readonly reserve: (input: Omit<LeaseCasInput, "version"> & { readonly expiresAt: string }) => Promise<LeaseV1>;
  readonly activate: (input: LeaseCasInput) => Promise<LeaseV1>;
  readonly renew: (input: LeaseCasInput & { readonly expiresAt: string }) => Promise<LeaseV1>;
  readonly release: (input: LeaseCasInput) => Promise<LeaseV1>;
}
export function makeTaskLeaseStore(options: { readonly rootDir: string; readonly coordinator: WriteCoordinator;
  readonly runEffect: <A>(effect: Effect.Effect<A, WriteError>) => Promise<A>; readonly now?: () => string }): TaskLeaseStore {
  const now = options.now ?? (() => new Date().toISOString());
  const mutate = async (payload: Omit<LeaseCasPayload, "now" | "capacity">): Promise<LeaseV1> => {
    const mutation = { ...payload, now: now(), capacity: TASK_LEASE_BROKER_CONTRACT.capacity } satisfies LeaseCasPayload;
    const opId = `lease-${payload.operation}-${createHash("sha256").update(JSON.stringify(canonicalizeContractValue(mutation))).digest("hex")}`;
    try {
      await options.runEffect(options.coordinator.enqueue({ opId, entityId: taskEntityId(payload.taskId), kind: "lease_cas", payload: mutation }));
      await options.runEffect(options.coordinator.flush("explicit"));
    } catch (error) { throw leaseError(error); }
    const lease = readStoredTaskLease(options.rootDir, payload.taskId);
    if (lease === null || lease.executionId !== payload.executionId
      || JSON.stringify(canonicalizeContractValue(lease.actor)) !== JSON.stringify(canonicalizeContractValue(payload.actor))) {
      throw new TaskLeaseConflictError(`lease coordinator did not publish the requested ${payload.operation} for task ${payload.taskId}`, "lease_publication_unknown");
    }
    return lease;
  };
  return { current: (taskId) => readEffectiveTaskLease(options.rootDir, taskId, now()),
    reserve: (input) => mutate({ operation: "reserve", ...input }), activate: (input) => mutate({ operation: "activate", ...input }),
    renew: (input) => mutate({ operation: "renew", ...input }), release: (input) => mutate({ operation: "release", ...input }) };
}
function leaseError(error: unknown): TaskLeaseConflictError {
  const cause = isWriteError(error) && error._tag === "JournalUnavailable" ? error.cause : error;
  if (cause instanceof TaskLeaseCasRejected) return new TaskLeaseConflictError(cause.message, cause.code);
  if (typeof cause === "object" && cause !== null && "code" in cause && typeof cause.code === "string"
    && "message" in cause && typeof cause.message === "string") return new TaskLeaseConflictError(cause.message, cause.code);
  return new TaskLeaseConflictError(cause instanceof Error ? cause.message : String(cause));
}
function isWriteError(error: unknown): error is WriteError { return typeof error === "object" && error !== null && "_tag" in error; }
