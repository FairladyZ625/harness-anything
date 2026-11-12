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

export const authoredDispositionWords = ["migrated", "excluded", "required"] as const;
export type AuthoredDisposition = (typeof authoredDispositionWords)[number];

export const migrationDispositionWords = ["archived", "retired"] as const;
export type MigrationDisposition = (typeof migrationDispositionWords)[number];

export const taskRestatementDispositionWords = [
  "retired-preset-to-standard-task",
  "renamed-preset",
  "preset-task-class-aligned",
] as const;
export type TaskRestatementDisposition = (typeof taskRestatementDispositionWords)[number];

export const daemonOperationOutcomeWords = ["ok", "error"] as const;
export type DaemonOperationOutcome = (typeof daemonOperationOutcomeWords)[number];

export const decisionActionStatusWords = ["applied", "failed"] as const;
export type DecisionActionStatus = (typeof decisionActionStatusWords)[number];

export const decisionAnnotationStatusWords = ["pending", "succeeded", "failed"] as const;
export type DecisionAnnotationStatus = (typeof decisionAnnotationStatusWords)[number];

export const incidentHeadStatusWords = ["unchanged", "changed", "unavailable", "no-previous-run"] as const;
export type IncidentHeadStatus = (typeof incidentHeadStatusWords)[number];

export const reviewPromptPhaseWords = ["first", "re-review"] as const;
export type ReviewPromptPhase = (typeof reviewPromptPhaseWords)[number];

export const bootstrapDocumentDispositionWords = ["created", "preserved", "updated"] as const;
export type BootstrapDocumentDisposition = (typeof bootstrapDocumentDispositionWords)[number];

export const repoBootstrapOutcomeWords = ["applied", "noop", "partial", "indeterminate"] as const;
export type RepoBootstrapOutcome = (typeof repoBootstrapOutcomeWords)[number];

export const repoCellAttachmentStateWords = ["warming", "attached", "unavailable", "closed"] as const;
export type RepoCellAttachmentState = (typeof repoCellAttachmentStateWords)[number];

export const repoRecoveryStatusWords = ["none", "indeterminate"] as const;
export type RepoRecoveryStatus = (typeof repoRecoveryStatusWords)[number];

export const skillPublicationStatusWords = ["draft", "published"] as const;
export type SkillPublicationStatus = (typeof skillPublicationStatusWords)[number];

export const deliveryFileStatusWords = ["added", "modified", "deleted", "renamed", "copied", "type-changed"] as const;
export type DeliveryFileStatus = (typeof deliveryFileStatusWords)[number];

export const legacyWorktreeStatusWords = ["worktree-rename", "worktree-renamed"] as const;
export type LegacyWorktreeStatus = (typeof legacyWorktreeStatusWords)[number];

export const workTopologyStateWords = [
  "done",
  "cancelled",
  "in-flight",
  "awaiting-ruling",
  "blocked",
  "ready",
  "unknown",
  "boundary",
] as const;
export type WorkTopologyState = (typeof workTopologyStateWords)[number];

export const scheduleExecutionAvailabilities = ["local", "claimed-elsewhere", "not-on-this-node"] as const;
export type ScheduleExecutionAvailability = (typeof scheduleExecutionAvailabilities)[number];

export const homeRepoStatusWords = ["online", "warming", "unavailable", "offline"] as const;
export type HomeRepoStatus = (typeof homeRepoStatusWords)[number];

export const taskWorkspaceStateWords = ["bound", "materialized", "reclaimed", "retained"] as const;
export type TaskWorkspaceState = (typeof taskWorkspaceStateWords)[number];

export const repoAttachPhaseWords = ["opening", "recovering", "catching-up", "restoring-runtimes"] as const;
export type RepoAttachPhase = (typeof repoAttachPhaseWords)[number];

export const dispatchFallbackStateWords = ["scheduled", "dispatched", "exhausted"] as const;
export type DispatchFallbackState = (typeof dispatchFallbackStateWords)[number];

export const agentDeclarationMigrationOutcomeWords = ["converted", "current", "rejected"] as const;
export type AgentDeclarationMigrationOutcome = (typeof agentDeclarationMigrationOutcomeWords)[number];

export const runtimeAuthStateWords = ["configured", "authenticated", "unauthenticated", "unknown"] as const;
export type RuntimeAuthState = (typeof runtimeAuthStateWords)[number];

export const runtimeAuthReadinessStatusWords = ["ready", "not-ready"] as const;
export type RuntimeAuthReadinessStatus = (typeof runtimeAuthReadinessStatusWords)[number];

export const runtimeEndpointAvailabilities = ["none", "optional", "required"] as const;
export type RuntimeEndpointAvailability = (typeof runtimeEndpointAvailabilities)[number];

export const dispatchEvidenceStateWords = ["pending", "stored", "not-required"] as const;
export type DispatchEvidenceState = (typeof dispatchEvidenceStateWords)[number];

export const dispatchExitNotificationPhaseWords = ["started", "finished"] as const;
export type DispatchExitNotificationPhase = (typeof dispatchExitNotificationPhaseWords)[number];

export const runtimeRecoveryOutcomeWords = ["ready", "settled", "failed", "foreign"] as const;
export type RuntimeRecoveryOutcome = (typeof runtimeRecoveryOutcomeWords)[number];

export const runtimeSteerLivenessWords = ["running", "starting", "stopped"] as const;
export type RuntimeSteerLiveness = (typeof runtimeSteerLivenessWords)[number];

export const providerGroupSweepVerdictWords = ["running", "proven_stopped", "unknown_unreachable"] as const;
export type ProviderGroupSweepVerdict = (typeof providerGroupSweepVerdictWords)[number];

export const relayCostStatusWords = ["reported", "estimated"] as const;
export type RelayCostStatus = (typeof relayCostStatusWords)[number];

export const scheduleMissedSettlementOutcomeWords = ["settled", "rejected", "human-blocked"] as const;
export type ScheduleMissedSettlementOutcome = (typeof scheduleMissedSettlementOutcomeWords)[number];

export const squadControlOutcomeWords = ["completed", "op_rejected"] as const;
export type SquadControlOutcome = (typeof squadControlOutcomeWords)[number];

export const reviewDispatchStepOutcomeWords = [
  "dispatched",
  "already_dispatched",
  "already_reviewed",
  "pending",
  "failed",
] as const;
export type ReviewDispatchStepOutcome = (typeof reviewDispatchStepOutcomeWords)[number];
