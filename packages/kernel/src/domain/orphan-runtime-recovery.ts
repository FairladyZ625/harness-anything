import type { ActorIdentity } from "./actor-identity.ts";
import type { AgentRuntimeEventV1 } from "./agent-runtime.ts";
import type { DispatchLifecycleView } from "./dispatch-lifecycle.ts";
import type { LeaseV1 } from "./execution.ts";
import { hasOnlyFields, isNonEmptyString, isRecord } from "./contract-validation.ts";

export interface OrphanRuntimeRecoveryAudit {
  readonly originalPersonId: string;
  readonly adminPersonId: string;
  readonly reason: string;
}

export function isOrphanRuntimeRecoveryAudit(value: unknown): value is OrphanRuntimeRecoveryAudit {
  return (
    isRecord(value) &&
    hasOnlyFields(value, ["originalPersonId", "adminPersonId", "reason"]) &&
    isNonEmptyString(value.originalPersonId) &&
    isNonEmptyString(value.adminPersonId) &&
    value.originalPersonId !== value.adminPersonId &&
    typeof value.reason === "string" &&
    value.reason.trim().length > 0
  );
}

/** CH1 requires positive repository authority and a definitive current-directory absence. */
export function orphanRuntimeRecoveryAudit(input: {
  readonly originalPersonId: string;
  readonly actor: ActorIdentity;
  readonly repositoryAdmin: boolean;
  readonly originalPersonExists: boolean;
  readonly reason: string;
}): OrphanRuntimeRecoveryAudit | null {
  const audit = {
    originalPersonId: input.originalPersonId,
    adminPersonId: input.actor.principal.personId,
    reason: input.reason,
  };
  return input.actor.executor === null &&
    input.repositoryAdmin &&
    !input.originalPersonExists &&
    isOrphanRuntimeRecoveryAudit(audit)
    ? audit
    : null;
}

export function orphanRuntimeStopDisposition(input: {
  readonly hasLiveOwner: boolean;
  readonly stopProven: boolean;
  readonly unreachableRuling: boolean;
}): "stopped" | "ruled_unreachable" | null {
  if (input.hasLiveOwner) return null;
  if (input.stopProven) return "stopped";
  return input.unreachableRuling ? "ruled_unreachable" : null;
}

/** Only the terminal attempt holding this lease generation can authorize its release. */
export function orphanRuntimeLeaseStop(
  lease: Pick<LeaseV1, "taskId" | "executionId" | "version" | "actor">,
  view: DispatchLifecycleView | undefined,
  outcome: Extract<AgentRuntimeEventV1, { readonly type: "runtime_session_outcome_observed" }> | undefined,
): "stopped" | "ruled_unreachable" | null {
  const attempt = view?.attempt,
    task = attempt?.task;
  if (
    !attempt?.fence.verified ||
    view?.groupPhase === "waiting_backoff" ||
    view?.controlLeafDispatchId !== attempt.dispatchId ||
    task?.taskId !== lease.taskId ||
    task.executionId !== lease.executionId ||
    task.leaseVersion !== lease.version ||
    task.leaseReleased ||
    attempt.outcome === null
  )
    return null;
  return orphanRuntimeStopDisposition({
    hasLiveOwner: false,
    stopProven: attempt.stopProof === "proven_stopped",
    unreachableRuling:
      outcome?.payload.reasonCode === "ruling_resolved" &&
      outcome.payload.orphanRecovery?.originalPersonId === lease.actor.principal.personId,
  });
}
