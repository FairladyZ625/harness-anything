import { isSameExecution } from "./actor-domain-services.ts";
import { leaseIsEffective, type LeaseV1 } from "./execution.ts";
import type { ActorAxes } from "./task.ts";
import type { OntologyJudgmentDeclaration, OntologyPolicyDeclaration } from "./ontology-source.ts";

export const taskLeaseGuidancePolicy = {
  id: "lease-recovery-guidance",
  ownerRef: "task",
  unit: "projected lease phase and holder",
  bounds:
    "Released or expired leases reconnect; expiry retains the recorded holder. Effective lease guidance names holder release. Return-to-planned retains the existing lifecycle graph and unleased-task guard.",
  defaultValue: null,
  version: 1,
  scope: "task completion, squad continuation and return-to-planned receipts",
  reason: "Receipts narrate one projected lease without changing TTL, reservation CAS or release authority.",
  fixtures: [
    "packages/daemon/test/squad-coordinator.test.ts",
    "packages/daemon/test/lease-dead-zone-recovery.integration.test.ts",
  ],
  sources: [
    {
      candidateId:
        "policy:packages/kernel:packages/kernel/src/domain/task-lease-guidance.ts#taskLeaseGuidance.reason:3e124d1984fd96ac6c6afe995dfc197c",
      route: "taskLeaseGuidance → effective holder narration",
    },
    {
      candidateId:
        "policy:packages/kernel:packages/kernel/src/domain/task-lease-guidance.ts#taskLeaseGuidance.reason:dbe8f2c91d6d44d6a154b1584c100a1e",
      route: "taskLeaseGuidance → expired lease narration",
    },
    {
      candidateId:
        "policy:packages/kernel:packages/kernel/src/domain/task-lease-guidance.ts#taskLeaseGuidance.reason:a5ec5abfaa27dcaa5c543d0245894d47",
      route: "taskLeaseGuidance → released lease narration",
    },
    {
      candidateId:
        "policy:packages/kernel:packages/kernel/src/domain/completion-readiness.ts#releasedLeaseRestartNext:e040e4512fd5228e749cb099d85cda89",
      route: "completion/agenda → active execution reconnection",
    },
    {
      candidateId:
        "policy:packages/kernel:packages/kernel/src/domain/task-lifecycle-command-transitions.ts#validateReturnToPlanned:e78b5db4e2d1bc38db7ac8649122bdc3",
      route: "validateReturnToPlanned → existing lifecycle graph",
    },
  ],
} as const satisfies OntologyPolicyDeclaration;

export const returnToPlannedJudgment = {
  id: "return-to-planned",
  symbol: "packages/kernel/src/domain/task-lifecycle-command-transitions.ts#validateReturnToPlanned",
  inputs: ["TaskLifecycleSnapshot", "TransitionTaskCommand"],
  output: "ContractValidationIssue[]",
  failureCodes: ["invalid_transition", "missing_field"],
  explain:
    "Returning an implementation round to planned requires an unleased active or blocked task and an auditable reason; lease guidance names the existing release command.",
  consumers: ["packages/kernel/src/domain/task-lifecycle-command-transitions.ts"],
  sources: [
    {
      candidateId:
        "judgment:packages/kernel:packages/kernel/src/domain/task-lifecycle-command-transitions.ts#validateReturnToPlanned:ebfac91eb348e82c02f1efa4565bdc9a",
      route: "applyTransition → returnToPlanned.validate",
    },
  ],
} as const satisfies OntologyJudgmentDeclaration;

/** Narrates the projected lease; expiry never implies that a release was recorded. */
export function taskLeaseGuidance(taskId: string, lease: LeaseV1 | null, actor?: ActorAxes) {
  const holder = lease
      ? `${lease.actor.principal.personId}, executor=${lease.actor.executor?.id ?? "none"}, execution=${lease.executionId}`
      : "",
    heldByCaller = actor === undefined || lease === null ? undefined : isSameExecution(lease.actor, actor),
    ownership = actor === undefined ? holder : heldByCaller ? `you (${holder})` : `another actor (${holder})`,
    reason =
      lease === null || lease.phase === "released"
        ? "The execution lease was released."
        : lease.phase === "orphaned"
          ? `The execution lease is orphaned (expired at ${lease.expiresAt}), held by ${ownership}.`
          : `The execution lease is ${lease.phase === "held" ? "" : `${lease.phase}, `}held by ${ownership}.`;
  return {
    reason,
    heldByCaller,
    reconnect: !leaseIsEffective(lease),
    reconnectAction: `ha task start ${taskId}`,
    releaseAction: `ha task release ${taskId}`,
  };
}
