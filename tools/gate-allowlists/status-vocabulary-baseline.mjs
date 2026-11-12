// Frozen status-vocabulary declarations outside the kernel domain that are not yet
// owned by a declared state store (dec_499E4E98A3D4754132B3BCA1E6 CH1).
//
// A baseline entry is not an exemption: it freezes the current words of one
// declaration so the vocabulary cannot grow silently. Ownership is declared by
// registering the anchor with mirrorOf / ownerStore / scope: "view-local"; the
// entry then becomes stale and the gate refuses it until it is deleted.
export const statusVocabularyBaseline = Object.freeze([
  {
    key: "packages/daemon/src/agent-entities.ts#AgentState",
    words: Object.freeze(["configured", "active", "retired"]),
  },
  {
    key: "packages/daemon/src/agent-runtime-contract.ts#agentRuntimeSessionGroupStatusWords",
    words: Object.freeze([
      "running",
      "succeeded",
      "failed",
      "cancelled",
      "stopped",
      "ended-indeterminate",
      "unavailable",
      "unknown",
      "blocked",
      "lost",
    ]),
  },
  {
    key: "packages/daemon/src/agent-runtime-token-usage-insights.ts#tokenUsageOutcomeWords",
    words: Object.freeze(["succeeded", "failed", "cancelled", "stopped", "running", "unknown"]),
  },
  {
    key: "packages/daemon/src/dispatch-activity.ts#DispatchActivityStatus",
    words: Object.freeze(["thinking", "tool", "waiting", "silent", "stalled", "unknown"]),
  },
  {
    key: "packages/daemon/src/dispatch-evidence-state.ts#DispatchEvidenceState",
    words: Object.freeze(["pending", "stored", "not-required"]),
  },
  {
    key: "packages/daemon/src/runtime-permissions.ts#RuntimeIsolationState",
    words: Object.freeze(["enforced", "operator-environment"]),
  },
  {
    key: "packages/daemon/src/runtime-provider-fault.ts#RuntimeExitOutcome",
    words: Object.freeze(["succeeded", "failed", "unknown", "cancelled", "stopped"]),
  },
  {
    key: "packages/daemon/src/runtime-steer-target.ts#RuntimeSteerLiveness",
    words: Object.freeze(["running", "starting", "stopped"]),
  },
  {
    key: "packages/daemon/src/runtime/process-group-reconciler.ts#ProviderGroupSweepVerdict",
    words: Object.freeze(["running", "proven_stopped", "unknown_unreachable"]),
  },
  {
    key: "packages/daemon/src/schedule-scheduler.ts#MissedOutcome",
    words: Object.freeze(["settled", "rejected", "human-blocked"]),
  },
  {
    key: "packages/daemon/src/squad-run-contract.ts#SquadRunTurnStatus",
    words: Object.freeze(["running", "succeeded", "failed", "unknown", "cancelled", "stopped", "lost"]),
  },
  {
    key: "packages/daemon/src/runtime-inventory-types.ts#RuntimeEndpointAvailability",
    words: Object.freeze(["none", "optional", "required"]),
  },
  {
    key: "packages/daemon/src/agent-declaration-migration.ts##AgentDeclarationMigrationEntry.outcome",
    inline: true,
    words: Object.freeze(["converted", "current", "rejected"]),
  },
  {
    key: "packages/daemon/src/agent-declaration-migration.ts##ConvertedDeclaration.outcome",
    inline: true,
    words: Object.freeze(["current", "converted"]),
  },
  {
    key: "packages/daemon/src/agent-declaration-resolution.ts##ProjectedAgentDeclaration.lifecycleState",
    inline: true,
    words: Object.freeze(["configured", "active", "retired"]),
  },
  {
    key: "packages/daemon/src/agent-entities.ts##AgentEntityGuiDegradedRow.state",
    inline: true,
    words: Object.freeze(["invalid", "missing"]),
  },
  {
    key: "packages/daemon/src/agent-runtime-contract.ts##AgentRuntimeInstanceCommonDto.authState",
    inline: true,
    words: Object.freeze(["configured", "authenticated", "unauthenticated", "unknown"]),
  },
  {
    key: "packages/daemon/src/agent-runtime-contract.ts##AgentRuntimeInstanceCommonDto.status",
    inline: true,
    words: Object.freeze(["ready", "not-ready"]),
  },
  {
    key: "packages/daemon/src/agent-runtime-contract.ts##AgentRuntimeInstanceCommonDto.isolationState",
    inline: true,
    words: Object.freeze(["enforced", "operator-environment"]),
  },
  {
    key: "packages/daemon/src/agent-runtime-contract.ts##AgentRuntimeAssociationDto.phase",
    inline: true,
    words: Object.freeze(["reserving", "held", "released", "orphaned"]),
  },
  {
    key: "packages/daemon/src/agent-runtime-contract.ts##AgentRuntimeSessionDto.liveness",
    inline: true,
    words: Object.freeze(["live", "stale", "unknown", "exited"]),
  },
  {
    key: "packages/daemon/src/agent-runtime-contract.ts##AgentRuntimeSessionDto.outcome",
    inline: true,
    words: Object.freeze(["succeeded", "failed", "unknown", "cancelled", "stopped"]),
  },
  {
    key: "packages/daemon/src/agent-runtime-contract.ts##AgentRuntimeOverviewResult.status",
    inline: true,
    words: Object.freeze(["ready", "pending"]),
  },
  {
    key: "packages/daemon/src/agent-runtime-contract.ts##AgentRuntimeSettlement.outcome",
    inline: true,
    words: Object.freeze(["succeeded", "failed", "cancelled", "unknown", "stopped"]),
  },
  {
    key: "packages/daemon/src/agent-runtime-contract.ts##AgentRuntimeSessionResult.status",
    inline: true,
    words: Object.freeze(["ready", "pending"]),
  },
  {
    key: "packages/daemon/src/agent-runtime-contract.ts##AgentRuntimeSessionGroupsResult.status",
    inline: true,
    words: Object.freeze(["ready", "pending"]),
  },
  {
    key: "packages/daemon/src/agent-runtime-instance-types.ts##RuntimeAuthReadiness.status",
    inline: true,
    words: Object.freeze(["ready", "not-ready"]),
  },
  {
    key: "packages/daemon/src/agent-runtime-session-groups.ts##AgentRuntimeSessionGroupsQuery.status",
    inline: true,
    words: Object.freeze(["ready", "pending"]),
  },
  {
    key: "packages/daemon/src/agent-runtime-stream.ts##AgentRuntimeNativeSignal.outcome",
    inline: true,
    words: Object.freeze(["succeeded", "failed", "unknown", "cancelled", "stopped"]),
  },
  {
    key: "packages/daemon/src/agent-runtime-stream.ts##AgentRuntimeAttachEvent.outcome",
    inline: true,
    words: Object.freeze(["succeeded", "failed", "unknown", "cancelled", "stopped"]),
  },
  {
    key: "packages/daemon/src/agent-runtime-stream.ts##AgentRuntimeAttachResult.status",
    inline: true,
    words: Object.freeze(["attached", "gap"]),
  },
  {
    key: "packages/daemon/src/agent-runtime-token-usage.ts##AgentRuntimeTokenUsageResult.status",
    inline: true,
    words: Object.freeze(["ready", "pending"]),
  },
  {
    key: "packages/daemon/src/agent-runtime-token-usage.ts##AgentRuntimeTokenUsageDetailResult.status",
    inline: true,
    words: Object.freeze(["ready", "pending"]),
  },
  {
    key: "packages/daemon/src/agent-runtime-token-usage.ts##UsageAccumulator.status",
    inline: true,
    words: Object.freeze(["ready", "pending"]),
  },

  {
    key: "packages/daemon/src/dispatch-stream.ts##DispatchStreamWriter.state",
    inline: true,
    words: Object.freeze(["pending", "stored"]),
  },
  {
    key: "packages/daemon/src/dispatch-stream.ts##DispatchStreamWriter.phase",
    inline: true,
    words: Object.freeze(["started", "finished"]),
  },
  {
    key: "packages/daemon/src/dispatch-stream.ts##DispatchStreamSummary.evidenceState",
    inline: true,
    words: Object.freeze(["pending", "stored"]),
  },
  {
    key: "packages/daemon/src/runtime-continuation-context.ts##RuntimeContinuationContext.headStatus",
    inline: true,
    words: Object.freeze(["unchanged", "changed", "unavailable", "no-previous-run"]),
  },
  {
    key: "packages/daemon/src/runtime-dispatch-evidence.ts##DispatchForensicsInput.outcome",
    inline: true,
    words: Object.freeze(["succeeded", "failed", "unknown", "cancelled", "stopped"]),
  },
  {
    key: "packages/daemon/src/runtime-inventory-types.ts##RuntimeProviderDeclaration.defaultState",
    inline: true,
    words: Object.freeze(["enforced", "operator-environment"]),
  },
  {
    key: "packages/daemon/src/runtime-orchestration.ts##BatchRow.status",
    inline: true,
    words: Object.freeze(["succeeded", "failed", "unknown", "stopped", "rejected"]),
  },
  {
    key: "packages/daemon/src/runtime-spawn-adoption.ts##RuntimeRecoveryResult.outcome",
    inline: true,
    words: Object.freeze(["ready", "settled", "failed", "foreign"]),
  },
  {
    key: "packages/daemon/src/runtime-spawn-process.ts##PosixProcessRow.outcome",
    inline: true,
    words: Object.freeze(["succeeded", "failed", "unknown", "cancelled", "stopped"]),
  },
  {
    key: "packages/daemon/src/runtime-spawn-types.ts##ProviderFrame.outcome",
    inline: true,
    words: Object.freeze(["succeeded", "failed", "unknown"]),
  },
  {
    key: "packages/daemon/src/runtime/cloud-dispatch-relay.ts##RelaySettlement.costStatus",
    inline: true,
    words: Object.freeze(["reported", "estimated"]),
  },
  {
    key: "packages/daemon/src/schedule-builtin-executor.ts##BuiltinExecutionResult.outcome",
    inline: true,
    words: Object.freeze(["succeeded", "failed"]),
  },
  {
    key: "packages/daemon/src/schedule-runs-read.ts##ScheduleRunsReadContext.status",
    inline: true,
    words: Object.freeze(["ready", "pending"]),
  },
  {
    key: "packages/daemon/src/schedules-gui-read.ts##SchedulesGuiReadContext.status",
    inline: true,
    words: Object.freeze(["ready", "pending"]),
  },
  {
    key: "packages/daemon/src/schedules-gui-read.ts##SchedulesGuiReadContext.state",
    inline: true,
    words: Object.freeze(["armed", "paused"]),
  },
  {
    key: "packages/daemon/src/schedules-gui-read.ts##SchedulesGuiReadContext.state",
    inline: true,
    words: Object.freeze(["invalid", "missing"]),
  },
  {
    key: "packages/daemon/src/squad-control-result.ts##SquadControlResult.outcome",
    inline: true,
    words: Object.freeze(["completed", "op_rejected"]),
  },
  {
    key: "packages/daemon/src/squad-coordinator.ts##SquadScheduleSettlement.outcome",
    inline: true,
    words: Object.freeze(["succeeded", "failed", "cancelled"]),
  },
  {
    key: "packages/daemon/src/squad-run-contract.ts##SquadRunsListResult.status",
    inline: true,
    words: Object.freeze(["ready", "pending"]),
  },
  {
    key: "packages/daemon/src/squad-run-contract.ts##SquadRunReadResult.status",
    inline: true,
    words: Object.freeze(["ready", "pending"]),
  },
  {
    key: "packages/daemon/src/task-review-dispatch.ts##DispatchStep.outcome",
    inline: true,
    words: Object.freeze(["dispatched", "already_dispatched", "already_reviewed", "pending", "failed"]),
  },
  {
    key: "packages/daemon/src/task-review-dispatch.ts##DispatchStep.outcome",
    inline: true,
    words: Object.freeze(["dispatched", "already_dispatched"]),
  },
]);

// External status vocabularies that were registered before the ownership form became
// mandatory (dec_499E4E98A3D4754132B3BCA1E6 CH1). Owning one later makes its entry
// stale; a new external row without mirrorOf / ownerStore / view-local is refused.
export const statusVocabularyUnownedRegister = Object.freeze([]);
