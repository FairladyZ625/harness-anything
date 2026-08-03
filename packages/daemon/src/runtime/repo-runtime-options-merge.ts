import path from "node:path";
import type {
  DaemonRepoRuntimeOptions,
  MultiRepoDaemonRuntimeOptions
} from "./repo-runtime-options.ts";

export function mergeRepoRuntimeDefaults(
  repo: DaemonRepoRuntimeOptions,
  options: MultiRepoDaemonRuntimeOptions
): DaemonRepoRuntimeOptions {
  return {
    ...repo,
    ...(repo.writeOwnership ? {} : options.writeOwnership ? { writeOwnership: options.writeOwnership } : {}),
    ...(repo.operationalActor ? {} : options.operationalActor ? { operationalActor: options.operationalActor } : {}),
    ...(repo.lockProvenance ? {} : options.lockProvenance ? { lockProvenance: options.lockProvenance } : {}),
    ...(repo.lockTtlMs !== undefined ? {} : options.lockTtlMs !== undefined ? { lockTtlMs: options.lockTtlMs } : {}),
    ...(repo.interactiveMicroBatchMs !== undefined ? {} : options.interactiveMicroBatchMs !== undefined ? { interactiveMicroBatchMs: options.interactiveMicroBatchMs } : {}),
    ...(repo.maxInteractiveOpsPerCommit !== undefined ? {} : options.maxInteractiveOpsPerCommit !== undefined ? { maxInteractiveOpsPerCommit: options.maxInteractiveOpsPerCommit } : {}),
    ...(repo.materializerPollMs !== undefined ? {} : options.materializerPollMs !== undefined ? { materializerPollMs: options.materializerPollMs } : {}),
    ...(repo.materializerMaxBranchesPerBatch !== undefined ? {} : options.materializerMaxBranchesPerBatch !== undefined ? { materializerMaxBranchesPerBatch: options.materializerMaxBranchesPerBatch } : {}),
    ...(repo.projectionReconcileIntervalMs !== undefined ? {} : options.projectionReconcileIntervalMs !== undefined ? { projectionReconcileIntervalMs: options.projectionReconcileIntervalMs } : {}),
    ...(repo.admissionMaxOperations !== undefined ? {} : options.admissionMaxOperations !== undefined ? { admissionMaxOperations: options.admissionMaxOperations } : {}),
    ...(repo.admissionMaxBytes !== undefined ? {} : options.admissionMaxBytes !== undefined ? { admissionMaxBytes: options.admissionMaxBytes } : {}),
    ...(repo.admissionReservedOperationsPerPlane !== undefined ? {} : options.admissionReservedOperationsPerPlane !== undefined ? { admissionReservedOperationsPerPlane: options.admissionReservedOperationsPerPlane } : {}),
    ...(repo.admissionReservedBytesPerPlane !== undefined ? {} : options.admissionReservedBytesPerPlane !== undefined ? { admissionReservedBytesPerPlane: options.admissionReservedBytesPerPlane } : {}),
    ...(repo.projectionSourceFenceFactory ? {} : options.projectionSourceFenceFactory ? { projectionSourceFenceFactory: options.projectionSourceFenceFactory } : {}),
    ...(repo.generationAxes ? {} : options.generationAxes ? { generationAxes: options.generationAxes } : {}),
    ...(repo.generationWitness ? {} : options.generationWitness ? { generationWitness: options.generationWitness } : {}),
    ...(repo.generationCapability ? {} : options.generationCapability ? { generationCapability: options.generationCapability } : {})
  };
}

export function sortedRepoOptions(
  repos: ReadonlyArray<DaemonRepoRuntimeOptions>
): ReadonlyArray<DaemonRepoRuntimeOptions> {
  return [...repos].sort((left, right) =>
    left.repoId.localeCompare(right.repoId)
      || path.resolve(left.rootDir).localeCompare(path.resolve(right.rootDir)));
}
