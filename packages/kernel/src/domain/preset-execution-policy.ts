import type { OntologyPolicyDeclaration } from "./ontology-source.ts";

/** Bounds of the existing preset child process and template materialization contracts. */
export const presetExecutionPolicy = {
  id: "preset-execution",
  ownerRef: "task",
  unit: "milliseconds / bytes / locale selection / completion gate",
  bounds:
    "Child termination allows 100ms before SIGKILL; results are bounded to 64KiB and requests to 5000ms. Explicit discovery uses the requested locale; project overlays fall back to en-US. Manual completion sources cannot request additional signoff or override; replacement/path admission is retained.",
  defaultValue: {
    terminationGraceMs: 100,
    resultBytes: 64 * 1024,
    timeoutMs: 5000,
    explainer: { minimalRisk: "low", minimalProfile: "lightweight", workClass: "work" },
    manualCompletionSource: "manual",
    discoveryLocalePreference: "explicit",
    overlayLocale: { prefer: "project", fallback: "en-US" },
  },
  version: 1,
  scope: "Preset process execution, bootstrap, completion and scaffolding",
  reason:
    "Keep the existing process budgets and template/governance admission at one declaration, preserving all existing rejection codes.",
  fixtures: [
    "packages/preset/test/preset-process-service.test.ts",
    "packages/preset/test/preset-process-settlement.test.ts",
    "packages/preset/test/preset-extension-model.test.ts",
    "packages/preset/test/preset-resolver-scaffolding-overlays.test.ts",
    "packages/preset/test/preset-bootstrap.test.ts",
    "packages/preset/test/preset-contract.test.ts",
  ],
  sources: [
    "policy:packages/preset:packages/preset/src/preset-bootstrap.ts#compileTaskBootstrap.snapshotClaim:dc27abf722904ecdd392c751a36eef30",
    "policy:packages/preset:packages/preset/src/preset-bootstrap.ts#compilePresetSnapshotUpgrade.snapshotClaim:0abc968d5ef1113b9fd7b92399290e67",
    "policy:packages/preset:packages/preset/src/preset-bootstrap.ts#compilePresetSnapshotUpgrade.taskContractClaim:2dc8e7ed1dfc1352a4cce1353cf6cac9",
    "policy:packages/preset:packages/preset/src/preset-system.ts#oneOf:9d1802512e49851d1670e986feabf2f7",
    "policy:packages/preset:packages/preset/src/preset.contract.ts#validatePresetManifestV3:4f9916fd6fbad05175a64c6b1ba410a1",
    "policy:packages/preset:packages/preset/src/preset.contract.ts#validatePresetSnapshotV1:0279a3bf2654102240651138d06f8020",
    "policy:packages/preset:packages/preset/src/preset.contract.ts#validatePresetRunReceiptV1:f396a5caf1818d7b075f0b7485e3c4c5",
    "policy:packages/preset:packages/preset/src/preset.contract.ts#selectionErrors:de8d6ddf0682488b194d4b1d6cf9f1b6",
    "policy:packages/preset:packages/preset/src/scaffold-overlay.ts#mergeScaffoldOverlay:fcf6bbdd542cfd132928fe27345369e0",
    "policy:packages/preset:packages/preset/src/scaffold-overlay.ts#safePath:4ecb2b131f30e089365ef8b0f4895617",
    "policy:packages/kernel:packages/kernel/src/domain/preset-execution-policy.ts#presetExecutionPolicy.defaultValue.terminationGraceMs:7043cdfa9b9d725fccf148f14da274cb",
    "policy:packages/kernel:packages/kernel/src/domain/preset-execution-policy.ts#presetExecutionPolicy.defaultValue.timeoutMs:08b0a8a64d90c6ee0feb0e9b7d52b2ae",
  ].map((candidateId) => ({ candidateId, route: "presetExecutionPolicy" })),
} as const satisfies OntologyPolicyDeclaration;

/** Generated preset projections consume this via the canonical Task Action execution catalog. */
export const taskRemoteEdgePolicy = {
  id: "task-remote-edge-admission",
  ownerRef: "task",
  unit: "Task Action execution topology",
  bounds:
    "The create and eight lifecycle Action projections require via-center-forward admission; local arbiters and writer coordination remain defined by each Action.",
  defaultValue: "via-center-forward",
  version: 1,
  scope: "Task Action execution catalog and generated preset protocol projections",
  reason:
    "Generated copies have the same Policy owner as the kernel Action catalog, rather than choosing admission independently.",
  fixtures: [
    "packages/kernel/test/contracts/task-action-contract.test.ts",
    "tools/generate-task-action-protocol.test.mjs",
  ],
  sources: [
    "policy:packages/preset:packages/preset/src/task-action-projection.generated.ts#taskActionDescriptorProjection.actions.execution.remoteEdgeAdmission:bf99c6a9525d65cfaf71403ea19c77d6",
    "policy:packages/preset:packages/preset/src/task-action-projection.generated.ts#taskActionDescriptorProjection.actions.execution.remoteEdgeAdmission:bf99c6a9525d65cfaf71403ea19c77d6:2",
    "policy:packages/preset:packages/preset/src/task-action-projection.generated.ts#taskActionDescriptorProjection.actions.execution.remoteEdgeAdmission:bf99c6a9525d65cfaf71403ea19c77d6:3",
    "policy:packages/preset:packages/preset/src/task-action-projection.generated.ts#taskActionDescriptorProjection.actions.execution.remoteEdgeAdmission:bf99c6a9525d65cfaf71403ea19c77d6:4",
    "policy:packages/preset:packages/preset/src/task-action-projection.generated.ts#taskActionDescriptorProjection.actions.execution.remoteEdgeAdmission:bf99c6a9525d65cfaf71403ea19c77d6:5",
    "policy:packages/preset:packages/preset/src/task-action-projection.generated.ts#taskActionDescriptorProjection.actions.execution.remoteEdgeAdmission:bf99c6a9525d65cfaf71403ea19c77d6:6",
    "policy:packages/preset:packages/preset/src/task-action-projection.generated.ts#taskActionDescriptorProjection.actions.execution.remoteEdgeAdmission:bf99c6a9525d65cfaf71403ea19c77d6:7",
    "policy:packages/preset:packages/preset/src/task-action-projection.generated.ts#taskActionDescriptorProjection.actions.execution.remoteEdgeAdmission:bf99c6a9525d65cfaf71403ea19c77d6:8",
    "policy:packages/preset:packages/preset/src/task-create-projection.generated.ts#taskCreateDescriptorProjection.action.execution.remoteEdgeAdmission:bf99c6a9525d65cfaf71403ea19c77d6",
  ].map((candidateId) => ({ candidateId, route: "taskRemoteEdgePolicy" })),
} as const satisfies OntologyPolicyDeclaration;
