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
    "policy:packages/daemon:packages/daemon/src/doc-sync-reads.ts#readProjectedDocumentAtCut:2100e31b96bf22742faa1e2ab00cf090",
    "policy:packages/daemon:packages/daemon/src/doc-sync-reads.ts#observeExecution:0866d3bf693724b70845c19fb0662556",
    "policy:packages/daemon:packages/daemon/src/repo-cell-authorization.ts#bindVerifiedExecutorClaim.claimedActor:2411b7d38d06b949e664a60e2b21fb4a",
    "policy:packages/daemon:packages/daemon/src/repo-cell-authorization.ts#bindVerifiedExecutorClaim:f80807f9fa6ef7a6e4c474e28c7504dc",
    "policy:packages/daemon:packages/daemon/src/repo-cell-authorization.ts#invalidExecutorBindingFor.expectation:48691842f86a9108a4cfa61cfc3a72b4",
    "policy:packages/daemon:packages/daemon/src/repo-cell-command-run.ts#makeRepoCellCommandRunner.run:6e65ca130f22442a031eff284a0e7018",
    "policy:packages/daemon:packages/daemon/src/repo-cell-command-run.ts#makeRepoCellCommandRunner.run.enqueuePublication.pending:613de2c725ad8782829b7221fd2d4e7b",
    "policy:packages/daemon:packages/daemon/src/repo-cell-open.ts#openRepoWriterCell.heldRuntimeSessionId:eadfd0b36100b9fbec0a573ae4543411",
    "policy:packages/daemon:packages/daemon/src/repo-cell-open.ts#openRepoWriterCell:28953a4ac08dc37ce7bb05f434cb608a",
    "policy:packages/daemon:packages/daemon/src/repo-cell-open.ts#openRepoWriterCell.releaseAction:f7b16a592328236d439d01b14b1a6fed",
    "policy:packages/daemon:packages/daemon/src/repo-cell-open.ts#openRepoWriterCell.releaseBinding:3f766b45e20478bc2822a89aa3113fe3",
    "policy:packages/daemon:packages/daemon/src/repo-cell-open.ts#openRepoWriterCell:14f3d9075eae879f34b4a5a385c27894",
    "policy:packages/daemon:packages/daemon/src/repo-cell-open.ts#openRepoWriterCell:eb837e703c9fef500c087bef7e47e22f",
    "policy:packages/daemon:packages/daemon/src/repo-cell-open.ts#openRepoWriterCell:e52dc87590da4c3bd457dedb2e69b387",
    "policy:packages/daemon:packages/daemon/src/repo-cell-proof.ts#proofFor:6091bf995cf37c5804fdb7f643f85478",
    "policy:packages/daemon:packages/daemon/src/repo-cell-proof.ts#completeProof.noActiveLease:7a2d1202b14404915124f1fd3c39de29",
    "policy:packages/daemon:packages/daemon/src/repo-cell-proof.ts#completeProof.noActiveLease:7a2d1202b14404915124f1fd3c39de29:2",
    "policy:packages/daemon:packages/daemon/src/repo-cell-proof.ts#completeProof.noActiveLease:7a2d1202b14404915124f1fd3c39de29:3",
    "policy:packages/daemon:packages/daemon/src/repo-cell-squad-child.ts#settleSquadChildAssignment.release:2991c295bc25420e69d71f74c505b837",
    "policy:packages/daemon:packages/daemon/src/repo-cell-squad-child.ts#settleSquadChildAssignment:a4f0a8f9f7c5d827695be49cd05073e6",
    "policy:packages/daemon:packages/daemon/src/repo-cell-task-maintenance.ts#supersedeWithNewTask:81c4b83f01cadd693b648e6f8420a82a",
    "policy:packages/daemon:packages/daemon/src/repo-cell-task-mutation.ts#terminalExecutionRuntimeBinding:ea5eac8b5b51037492fb4ab946496412",
    "policy:packages/daemon:packages/daemon/src/repo-cell-task-progress.ts#appendProgress.recoverySnapshot:a22f1b86a9270d69a51019d7fab3c976",
  ].map((candidateId) => ({ candidateId, route: "taskLeasePolicy" })),
} as const satisfies OntologyPolicyDeclaration;
// dec_7E44897ECDCAEF2B92EC66A260/CH1: lease phase reads across task commands, progress and replay.
export const taskLeasePhasePolicy = {
  id: "task-lease-phase",
  ownerRef: "task",
  unit: "lease phase / broker slots",
  bounds:
    "Leases move reserving -> held -> released or orphaned. Execution mutations, progress and review completion require the held lease of the acting execution; reserving and orphaned leases report their own guidance; only disposition and reopen tolerate a lapsed lease. Replay accepts lease events only in that order, conflicts surface lease_conflict, and the broker holds at most 32 live leases.",
  defaultValue: { brokerSlots: 32 },
  version: 1,
  scope: "Task lifecycle commands, capability evaluation, progress, doc writes and replay",
  reason: "Every consumer reads the same lease phase vocabulary; no lease transition or capacity is changed.",
  fixtures: [
    "packages/kernel/test/contracts/task-lifecycle-replay.test.ts",
    "packages/kernel/test/contracts/task-action-contract.test.ts",
    "packages/storage/test/store/runtime-lease-history-replay.test.ts",
  ],
  sources: [
    "policy:packages/kernel:packages/kernel/src/domain/doc-sync-writer.ts#decideDocWriteInternal:c7bcc12af9439d6b603616c4b45a0cb3",
    "policy:packages/kernel:packages/kernel/src/domain/errors.ts#coreDomainErrorCodes.LeaseConflictError:b9e44f44d015c9fc0fa301d305f72b75",
    "policy:packages/kernel:packages/kernel/src/domain/execution.ts#TASK_LEASE_BROKER_CONTRACT.capacity:3c0cf3874135200d6419771bb4ffe83d",
    "policy:packages/kernel:packages/kernel/src/domain/task-action-capability.ts#taskCapabilityEvaluators:4b9f002e93c6d227aa891d6bdfcb670e",
    "policy:packages/kernel:packages/kernel/src/domain/task-action-capability.ts#activeDispositionInvocation:95133af8805374dbb58305d65139a9c2",
    "policy:packages/kernel:packages/kernel/src/domain/task-action-capability.ts#reopenInvocation:a046a2996ad1725cae3f8e8106271128",
    "policy:packages/kernel:packages/kernel/src/domain/task-action-capability.ts#startAvailability.nextActions:da0aae9ac75a1581cdfd5af6b45ff9d6",
    "policy:packages/kernel:packages/kernel/src/domain/task-lifecycle-command-transitions.ts#start.reduce.lease:17276916c62f37f921e983c352002ef1",
    "policy:packages/kernel:packages/kernel/src/domain/task-lifecycle-command-transitions.ts#reinstate.validate:646f8a53a89f67e004c7a03559a2d60b",
    "policy:packages/kernel:packages/kernel/src/domain/task-lifecycle-command-transitions.ts#rework.validate:d18f1d6a4450a85018a55dc0d232e723",
    "policy:packages/kernel:packages/kernel/src/domain/task-lifecycle-contract-support.ts#heldLeaseForExecutionActor:62cbba868174c4123c22e3ab3419a920",
    "policy:packages/kernel:packages/kernel/src/domain/task-lifecycle-contract-support.ts#executionExecutorDeclarationCandidates:1223472d53dbdae15124b2ff8c17615d",
    "policy:packages/kernel:packages/kernel/src/domain/task-lifecycle-event.ts#validateTaskEventFields:aa4776f9fb6bafcad62225fe927e1aa0",
    "policy:packages/kernel:packages/kernel/src/domain/task-lifecycle-replay.ts#assertAtomic:5ed1fa3254ae0f867045f9464faa0c4b",
    "policy:packages/kernel:packages/kernel/src/domain/task-lifecycle-replay.ts#assertAtomic:8b552c12d7afeb19620df9eae60cf4cc",
    "policy:packages/kernel:packages/kernel/src/domain/task-lifecycle-replay.ts#assertAtomic:6d4b1a623abbbe5c332ca523902269d2",
    "policy:packages/kernel:packages/kernel/src/domain/task-lifecycle-replay.ts#assertAtomic:a077cc49a1ed12c222a6883f783de6e5",
    "policy:packages/kernel:packages/kernel/src/domain/task-lifecycle-replay.ts#assertAtomic:5fdd71746d82bbdca395ee97e7c35412",
    "policy:packages/kernel:packages/kernel/src/domain/task-lifecycle-replay.ts#assertReplay:3123189500e597304f8e1a07744ff9f6",
    "policy:packages/kernel:packages/kernel/src/domain/task-lifecycle-replay.ts#assertReplay:f631afa3b1978d00fddefdeeaf4f872f",
    "policy:packages/kernel:packages/kernel/src/domain/task-lifecycle-replay.ts#assertReplay:b0feec1619d194d090128eacc33d72b3",
    "policy:packages/kernel:packages/kernel/src/domain/task-lifecycle-replay.ts#assertReplay:f2f364256c499a8bc33577a489af86d3",
    "policy:packages/kernel:packages/kernel/src/domain/task-lifecycle-replay.ts#assertReplay:0c163d818362965927649155f10269a3",
    "policy:packages/kernel:packages/kernel/src/domain/task-lifecycle-replay.ts#assertReplay:771be71d257546e78452a7babe7b5c9a",
    "policy:packages/kernel:packages/kernel/src/domain/task-lifecycle-review-transitions.ts#complete.validate:4e1e70527930ebab328f8c8eee80dc8c",
    "policy:packages/kernel:packages/kernel/src/domain/task-lifecycle-review-transitions.ts#complete.validate:4e1e70527930ebab328f8c8eee80dc8c:2",
    "policy:packages/kernel:packages/kernel/src/domain/task-progress-event.ts#progressLeaseRequiredMessage:c3897041a7efbfef59d7029ec082ef08",
    "policy:packages/kernel:packages/kernel/src/domain/task-progress-event.ts#progressLeaseRequiredMessage:cc190b58b896a4f4f977da85f47e7a1b",
    "policy:packages/kernel:packages/kernel/src/domain/task-progress-event.ts#compileTaskProgress:0f41fb819c106c7099ee1ab47daae58a",
  ].map((candidateId) => ({ candidateId, route: "task lease phase" })),
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
