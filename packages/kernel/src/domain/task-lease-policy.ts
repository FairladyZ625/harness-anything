import type { TaskEventV1 } from "./task-lifecycle.contract.ts";
import { TASK_LEASE_BROKER_CONTRACT, validateLeaseV1, type LeaseV1 } from "./execution.ts";
import type { OntologyPolicyDeclaration, OntologyJudgmentDeclaration } from "./ontology-source.ts";

export function assertLeaseReservation(lease: LeaseV1, current: LeaseV1 | null, activeCount: number): void {
  checkedLease(lease);
  if (current !== null && current.phase !== "orphaned" && current.phase !== "released")
    throw new Error(`lease conflict for task ${lease.taskId}`);
  if (activeCount >= TASK_LEASE_BROKER_CONTRACT.capacity)
    throw new Error(
      `lease capacity ${TASK_LEASE_BROKER_CONTRACT.capacity} exhausted; wait for a lease to be released or expire`,
    );
  const expectedVersion = current === null ? 0 : current.version + 1;
  if (lease.phase !== "reserving" || lease.version !== expectedVersion)
    throw new Error(`stale lease reservation for task ${lease.taskId}`);
}

export function checkedLease(lease: LeaseV1, historical = false): LeaseV1 {
  const issues = validateLeaseV1(lease, historical);
  if (issues.length > 0) throw new Error(issues.map((issue) => issue.message).join("; "));
  return lease;
}

export const taskLeasePolicy = {
  id: "task-lease-reservation",
  ownerRef: "task",
  unit: "admission constraints",
  bounds:
    "Reserve only the next version in reserving phase, within the existing lease broker capacity, and without a live conflicting lease.",
  defaultValue: null,
  version: 1,
  scope: "task-lease-reservation",
  reason: "Keep the existing admission rule and its unique pure implementation together.",
  fixtures: ["packages/storage/test/store/runtime-lease-history-replay.test.ts"],
  sources: [
    "policy:packages/kernel:packages/kernel/src/domain/task-lease-policy.ts#assertLeaseReservation:70ea4017a2be5cd69d8cccb06b9f4005",
    "policy:packages/kernel:packages/kernel/src/domain/task-lease-policy.ts#decideRawTaskLease:dfd5eb621e0e684bfa80524edea23545",
    "policy:packages/kernel:packages/kernel/src/domain/task-lease-policy.ts#decideReadableTaskLease:604b0c933f01414f14bbc867d23eb635",
  ].map((candidateId) => ({ candidateId, route: "taskLeasePolicy" })),
} as const satisfies OntologyPolicyDeclaration;
export const taskLeasePolicyJudgments = [
  {
    id: "assertLeaseReservation",
    symbol: "packages/kernel/src/domain/task-lease-policy.ts#assertLeaseReservation",
    inputs: ["lease, current lease and active count"],
    output: "void or original admission error",
    failureCodes: [],
    explain:
      "Reserve only the next version in reserving phase, within the existing lease broker capacity, and without a live conflicting lease.",
    consumers: [
      "packages/storage/src/projection/rebuildable-task-projection-runtime.ts",
      "packages/storage/src/pg/pg-lease-cas.ts",
    ],
    sources: [
      {
        candidateId:
          "judgment:packages/kernel:packages/kernel/src/domain/task-lease-policy.ts#assertLeaseReservation:2e52dd1b202375ab41dc14f56ef2ec8d",
        route: "task-lease-policy",
      },
    ],
  },
  {
    id: "decideRawTaskLease",
    symbol: "packages/kernel/src/domain/task-lease-policy.ts#decideRawTaskLease",
    inputs: ["previous raw lease and TaskEventV1"],
    output: "LeaseV1 or null",
    failureCodes: [],
    explain: "Preserve the existing decideRawTaskLease verdict at one canonical definition.",
    consumers: ["packages/storage/src/pg/pg-task-event-materialize.ts"],
    sources: [
      {
        candidateId:
          "judgment:packages/kernel:packages/kernel/src/domain/task-lease-policy.ts#decideRawTaskLease:561967bda3d86b4abc151b5cde28515c",
        route: "task-lease-policy",
      },
    ],
  },
  {
    id: "decideReadableTaskLease",
    symbol: "packages/kernel/src/domain/task-lease-policy.ts#decideReadableTaskLease",
    inputs: ["LeaseV1 or null"],
    output: "LeaseV1 or null",
    failureCodes: [],
    explain: "Preserve the existing decideReadableTaskLease verdict at one canonical definition.",
    consumers: [
      "packages/storage/src/projection/rebuildable-task-projection-runtime.ts",
      "packages/storage/src/migration/projection.ts",
    ],
    sources: [
      {
        candidateId:
          "judgment:packages/kernel:packages/kernel/src/domain/task-lease-policy.ts#decideReadableTaskLease:ee4fe5c873e3904fbedadd2b9859627f",
        route: "task-lease-policy",
      },
    ],
  },
] as const satisfies readonly OntologyJudgmentDeclaration[];

/** Raw CAS versions remain visible after the lifecycle snapshot clears a released lease. */
export function decideRawTaskLease(previous: LeaseV1 | null, event: TaskEventV1): LeaseV1 | null {
  let rawLease = previous;
  if (event.type === "execution_started") rawLease = { ...event.payload.lease, phase: "held" };
  else if (event.type === "lease_renewed") rawLease = event.payload.lease;
  else if (
    ((event.type === "execution_submitted" && event.payload.supersedesSubmissionId === undefined) ||
      event.type === "lease_released" ||
      event.type === "task_completion_generation_retired") &&
    rawLease !== null &&
    rawLease.executionId === event.payload.execution.executionId
  )
    rawLease = { ...rawLease, phase: "released", version: rawLease.version + 1 };
  return rawLease;
}

export function decideReadableTaskLease(lease: LeaseV1 | null): LeaseV1 | null {
  return lease?.phase === "released" ? null : lease;
}
