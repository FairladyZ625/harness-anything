// dec_499E4E98A3D4754132B3BCA1E6: shared vocabulary authority; no transitions or persistence.
export const cliTimingPhaseWords = ["spawn", "parse", "dispatch", "daemonRoundTrip", "render"] as const;
export type CliTimingPhase = (typeof cliTimingPhaseWords)[number];

export const daemonStopOutcomeWords = ["stopped", "draining", "timeout"] as const;
export type DaemonStopOutcome = (typeof daemonStopOutcomeWords)[number];

export const jsStackStatusWords = ["captured", "not-advertised", "unreachable", "failed"] as const;
export type JsStackStatus = (typeof jsStackStatusWords)[number];

export const probeStateWords = ["up", "slow", "down"] as const;
export type ProbeState = (typeof probeStateWords)[number];

export const repoRegistrationStateWords = ["enabled", "disabled"] as const;
export type RepoRegistrationState = (typeof repoRegistrationStateWords)[number];

export const runtimeReadinessStatusWords = ["macos-local-v1-release-candidate"] as const;
export type RuntimeReadinessStatus = (typeof runtimeReadinessStatusWords)[number];

export const supplyChainReadinessStatusWords = ["release-gate-without-published-artifacts"] as const;
export type SupplyChainReadinessStatus = (typeof supplyChainReadinessStatusWords)[number];

export const migrationPhaseWords = [
  "freezing",
  "prepared",
  "source_sealed",
  "activation_failed",
  "target_activated",
  "abandoned",
  "source_resumed",
] as const;
export type MigrationPhase = (typeof migrationPhaseWords)[number];

export const projectionFreshnesses = ["fresh", "stale-but-usable", "unavailable-no-cache"] as const;
export type ProjectionFreshness = (typeof projectionFreshnesses)[number];

export const runtimeBatchStatusWords = ["succeeded", "failed", "rejected", "unknown", "stopped"] as const;
export type RuntimeBatchStatus = (typeof runtimeBatchStatusWords)[number];

export const doctorCheckStatusWords = ["ok", "warn", "fail", "indeterminate"] as const;
export type DoctorCheckStatus = (typeof doctorCheckStatusWords)[number];

export const observationStatusWords = ["observed", "unobserved"] as const;
export type ObservationStatus = (typeof observationStatusWords)[number];

export const repoCellStateWords = ["warming", "attached", "unavailable", "not_loaded"] as const;
export type RepoCellState = (typeof repoCellStateWords)[number];

export const repoLockStateWords = ["held", "not_applicable", "unknown"] as const;
export type RepoLockState = (typeof repoLockStateWords)[number];

export const daemonControlPhaseWords = ["queued", "draining", "starting", "settled", "failed"] as const;
export type DaemonControlPhase = (typeof daemonControlPhaseWords)[number];

export const runtimeIsolationStateWords = ["enforced", "operator-environment"] as const;
export type RuntimeIsolationState = (typeof runtimeIsolationStateWords)[number];

export const decisionDriftStateWords = ["clear", "drift", "unknown"] as const;
export type DecisionDriftState = (typeof decisionDriftStateWords)[number];

export const decisionConflictStateWords = ["clear", "conflict", "unknown"] as const;
export type DecisionConflictState = (typeof decisionConflictStateWords)[number];

export const materializationReceiptStatusWords = ["visible", "planned"] as const;
export type MaterializationReceiptStatus = (typeof materializationReceiptStatusWords)[number];

export const scaffoldDocumentDispositionWords = ["created", "preserved", "drifted"] as const;
export type ScaffoldDocumentDisposition = (typeof scaffoldDocumentDispositionWords)[number];

export const generationConversionDispositionWords = ["converted", "retained-read-only", "unsupported"] as const;
export type GenerationConversionDisposition = (typeof generationConversionDispositionWords)[number];

export const writerEpochMigrationStateWords = ["not-needed", "already-migrated", "migrated", "partial"] as const;
export type WriterEpochMigrationState = (typeof writerEpochMigrationStateWords)[number];

export const materializationStates = Object.freeze(["ok", "retrying", "failed"] as const);
