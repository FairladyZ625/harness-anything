// Frozen status-vocabulary declarations outside the kernel domain that are not yet
// owned by a declared state store (dec_499E4E98A3D4754132B3BCA1E6 CH1).
//
// A baseline entry is not an exemption: it freezes the current words of one
// declaration so the vocabulary cannot grow silently. Ownership is declared by
// registering the anchor with mirrorOf / ownerStore / scope: "view-local"; the
// entry then becomes stale and the gate refuses it until it is deleted.
export const statusVocabularyBaseline = Object.freeze([
  {
    key: "packages/cli/src/cli/timing.ts#CliTimingPhase",
    words: Object.freeze(["spawn", "parse", "dispatch", "daemonRoundTrip", "render"]),
  },
  {
    key: "packages/cli/src/daemon/control.ts#DaemonStopOutcome",
    words: Object.freeze(["stopped", "draining", "timeout"]),
  },
  {
    key: "packages/cli/src/daemon/probe/probe-capture.ts#JsStackStatus",
    words: Object.freeze(["captured", "not-advertised", "unreachable", "failed"]),
  },
  { key: "packages/cli/src/daemon/probe/probe-trigger.ts#ProbeState", words: Object.freeze(["up", "slow", "down"]) },
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
    key: "packages/daemon/src/entity-content-read.ts#EntityContentOutcome",
    words: Object.freeze(["file", "directory", "missing", "too-large", "binary"]),
  },
  {
    key: "packages/daemon/src/entity-locator-read.ts#EntityLocatorOutcome",
    words: Object.freeze(["file", "directory", "missing", "unsupported", "too-large", "binary"]),
  },
  {
    key: "packages/daemon/src/fleet/edge-join-ssh-tunnel.ts#EdgeJoinTunnelState",
    words: Object.freeze(["connecting", "connected", "reconnecting", "stopped"]),
  },
  {
    key: "packages/daemon/src/fleet/edge-join.ts#EdgeJoinState",
    words: Object.freeze(["pending", "consumed", "expired", "revoked"]),
  },
  {
    key: "packages/daemon/src/fleet/replica-status.ts#ReplicaSyncPhase",
    words: Object.freeze([
      "preparing_replica",
      "authorizing",
      "waiting_backup",
      "backup_queued",
      "building_backup",
      "waiting_shared_backup",
      "sending_backup",
      "sending_commits",
      "awaiting_ack",
      "waiting_for_commit",
      "waiting_socket_drain",
    ]),
  },
  {
    key: "packages/daemon/src/migration-import-types.ts#AuthoredDisposition",
    words: Object.freeze(["migrated", "excluded", "required"]),
  },
  {
    key: "packages/daemon/src/repo-cell-doctor.ts#DoctorCheckStatus",
    words: Object.freeze(["ok", "warn", "fail", "indeterminate"]),
  },
  {
    key: "packages/daemon/src/review-prompt-guidance.ts#ReviewPromptPhase",
    words: Object.freeze(["first", "re-review"]),
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
    key: "packages/daemon/src/terminal-host.ts#TerminalSessionStatus",
    words: Object.freeze(["running", "exited", "unknown"]),
  },
  {
    key: "packages/daemon/src/work-topology-read.ts#TopologyState",
    words: Object.freeze([
      "done",
      "cancelled",
      "in-flight",
      "awaiting-ruling",
      "blocked",
      "ready",
      "unknown",
      "boundary",
    ]),
  },
  {
    key: "packages/gui/src/api/connection-admin-contract.ts#AdminRegistrationState",
    words: Object.freeze(["enabled", "disabled"]),
  },
  {
    key: "packages/gui/src/distribution/runtime-release-readiness.ts#RuntimeReadinessStatus",
    words: Object.freeze(["macos-local-v1-release-candidate"]),
  },
  {
    key: "packages/gui/src/distribution/supply-chain-release-readiness.ts#SupplyChainReadinessStatus",
    words: Object.freeze(["release-gate-without-published-artifacts"]),
  },
  {
    key: "packages/gui/src/renderer/components/agent-ui/AgentPlan.tsx#PlanStepStatus",
    words: Object.freeze(["pending", "running", "done", "failed", "skipped"]),
  },
  {
    key: "packages/gui/src/renderer/components/agent-ui/ApprovalCard.tsx#ApprovalVerdict",
    words: Object.freeze(["approved", "denied"]),
  },
  {
    key: "packages/gui/src/renderer/components/agent-ui/CacheTimer.tsx#PromptCacheTtlState",
    words: Object.freeze(["normal", "warning", "expired"]),
  },
  {
    key: "packages/gui/src/renderer/daemon-startup.ts#DaemonStartupPhase",
    words: Object.freeze(["pending", "waiting", "timeout", "ready"]),
  },
  {
    key: "packages/gui/src/renderer/entity-content-client.ts#EntityContentOutcome",
    words: Object.freeze(["file", "directory", "missing", "too-large", "binary"]),
  },
  {
    key: "packages/gui/src/renderer/entity-locator-client.ts#EntityWriteState",
    words: Object.freeze(["applied", "pending", "conflict", "rejected"]),
  },
  {
    key: "packages/gui/src/renderer/entity-locator-renderer.ts#EntityLocatorReadOutcome",
    words: Object.freeze(["file", "directory", "missing", "unsupported", "too-large", "binary"]),
  },
  {
    key: "packages/gui/src/renderer/model/runtime-health.ts#DaemonHealthState",
    words: Object.freeze(["responsive", "unresponsive", "unknown"]),
  },
  {
    key: "packages/gui/src/renderer/model/schedule-list.ts#ScheduleVerdict",
    words: Object.freeze(["failed", "degraded", "ok", "never"]),
  },
  {
    key: "packages/gui/src/renderer/model/session-achievement.ts#SessionVerdict",
    words: Object.freeze(["succeeded", "failed", "cancelled", "stopped", "unknown", "indeterminate", "running"]),
  },
  {
    key: "packages/gui/src/renderer/session-transcript-model.ts#ToolCallStatus",
    words: Object.freeze(["running", "succeeded", "failed"]),
  },
  {
    key: "packages/gui/src/renderer/session-transcript-model.ts#PlanStepStatus",
    words: Object.freeze(["pending", "in_progress", "completed"]),
  },
  {
    key: "packages/gui/src/renderer/session-transcript-model.ts#SteeringEntryStatus",
    words: Object.freeze(["pending", "injected", "rejected"]),
  },
  { key: "packages/kernel/src/daemon/registry.ts#DaemonRepoState", words: Object.freeze(["enabled", "disabled"]) },
  {
    key: "packages/kernel/src/domain/code-doc-retirement.ts#retiredCodeDocDispositions",
    words: Object.freeze(["repointed", "known-invalid"]),
  },
  {
    key: "packages/storage/src/migration/types.ts#MigrationPhase",
    words: Object.freeze([
      "freezing",
      "prepared",
      "source_sealed",
      "activation_failed",
      "target_activated",
      "abandoned",
      "source_resumed",
    ]),
  },
  {
    key: "packages/daemon/src/protocol/schedules-gui-contract.ts#ScheduleExecutionAvailability",
    words: Object.freeze(["local", "claimed-elsewhere", "not-on-this-node"]),
  },
  {
    key: "packages/daemon/src/runtime-inventory-types.ts#RuntimeEndpointAvailability",
    words: Object.freeze(["none", "optional", "required"]),
  },
  {
    key: "packages/gui/src/renderer/model/types.ts#Freshness",
    words: Object.freeze(["fresh", "stale-but-usable", "unavailable-no-cache"]),
  },
  {
    key: "packages/kernel/src/domain/entity-freshness.ts#entityFreshnesses",
    words: Object.freeze(["current", "orphaned", "unknown"]),
  },
  {
    key: "packages/kernel/src/domain/entity-freshness.ts#relationFreshnesses",
    words: Object.freeze(["current", "suspect", "orphaned"]),
  },
  {
    key: "packages/kernel/src/ports/projection-types.ts#ProjectionFreshness",
    words: Object.freeze(["fresh", "stale-but-usable", "unavailable-no-cache"]),
  },
  {
    key: "packages/application/src/artifact-entity-service.ts##ArtifactEntityImportPreview.contentState",
    inline: true,
    words: Object.freeze(["unobserved", "observed"]),
  },
  {
    key: "packages/application/src/index.ts##RelationCoverageRow.status",
    inline: true,
    words: Object.freeze(["covered", "uncovered"]),
  },
  {
    key: "packages/application/src/task-lifecycle-service.ts##TaskLifecycleServiceRead.status",
    inline: true,
    words: Object.freeze(["ready", "pending"]),
  },
  {
    key: "packages/authorization-gui/src/access-admin-contract.ts##PermissionRequest.state",
    inline: true,
    words: Object.freeze(["pending", "approved", "rejected", "withdrawn"]),
  },
  {
    key: "packages/authorization-gui/src/access-admin-contract.ts##AccessReceipt.phase",
    inline: true,
    words: Object.freeze(["intent", "settled"]),
  },
  {
    key: "packages/authorization-gui/src/access-admin-contract.ts##AccessReceipt.outcome",
    inline: true,
    words: Object.freeze(["applied", "failed", "version_conflict"]),
  },
  {
    key: "packages/authorization-gui/src/access-admin-contract.ts##EdgeJoinStatusReply.state",
    inline: true,
    words: Object.freeze(["pending", "consumed", "expired", "revoked"]),
  },
  {
    key: "packages/authorization-gui/src/access-admin-contract.ts##EdgeJoinSummary.tunnelState",
    inline: true,
    words: Object.freeze(["connecting", "connected", "reconnecting", "stopped"]),
  },
  {
    key: "packages/authorization-gui/src/access-admin-contract.ts##AccessDevice.state",
    inline: true,
    words: Object.freeze(["active", "paused", "removed"]),
  },
  {
    key: "packages/authorization-gui/src/edge-join-entry-contract.ts##EdgeJoinJoined.state",
    inline: true,
    words: Object.freeze(["synced", "partial"]),
  },
  {
    key: "packages/authorization-gui/src/edge-join-entry-contract.ts##EdgeJoinProgressRepository.phase",
    inline: true,
    words: Object.freeze(["workspace", "register", "sync", "synced", "failed"]),
  },
  {
    key: "packages/authorization-keycloak/src/keycloak-policy-adapter.ts##KeycloakPermissionDecision.outcome",
    inline: true,
    words: Object.freeze(["allowed", "denied"]),
  },
  {
    key: "packages/authorization-keycloak/src/keycloak-policy-adapter.ts##KeycloakLegacyRoleMigrationReceipt.outcome",
    inline: true,
    words: Object.freeze(["applied", "failed"]),
  },
  {
    key: "packages/authorization-keycloak/src/keycloak-policy-adapter.ts##KeycloakLegacyRoleMigrationReceipt.grantOutcome",
    inline: true,
    words: Object.freeze(["written", "already_present", "skipped"]),
  },
  {
    key: "packages/authorization-keycloak/src/keycloak-policy-adapter.ts##KeycloakNode.state",
    inline: true,
    words: Object.freeze(["active", "paused", "removed"]),
  },
  {
    key: "packages/cli/src/cli-types.ts##RuntimeBatchResult.status",
    inline: true,
    words: Object.freeze(["succeeded", "failed", "rejected", "unknown", "stopped"]),
  },
  {
    key: "packages/cli/src/cli/thin-command-doctor-health.ts##DoctorCheck.status",
    inline: true,
    words: Object.freeze(["ok", "warn", "fail", "indeterminate"]),
  },
  {
    key: "packages/cli/src/daemon/probe/probe-summary.ts##TimelineSummary.status",
    inline: true,
    words: Object.freeze(["observed", "unobserved"]),
  },
  {
    key: "packages/cli/src/daemon/slo.ts##Availability.status",
    inline: true,
    words: Object.freeze(["observed", "unobserved"]),
  },
  {
    key: "packages/daemon/src/access-admin-service.ts##PermissionRequest.state",
    inline: true,
    words: Object.freeze(["pending", "approved", "rejected", "withdrawn"]),
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
    key: "packages/daemon/src/daemon-host-types.ts##DaemonHost.state",
    inline: true,
    words: Object.freeze(["enabled", "disabled"]),
  },
  {
    key: "packages/daemon/src/daemon-operation.ts##DaemonOperation.outcome",
    inline: true,
    words: Object.freeze(["ok", "error"]),
  },
  {
    key: "packages/daemon/src/daemon-operation.ts##DaemonOperationTrace.outcome",
    inline: true,
    words: Object.freeze(["ok", "error"]),
  },
  {
    key: "packages/daemon/src/decision-annotations.ts##DecisionActionRecord.status",
    inline: true,
    words: Object.freeze(["applied", "failed"]),
  },
  {
    key: "packages/daemon/src/decision-annotations.ts##DecisionAnnotationEntry.status",
    inline: true,
    words: Object.freeze(["pending", "succeeded", "failed"]),
  },
  {
    key: "packages/daemon/src/decision-incident-action.ts##IncidentDecisionFields.headStatus",
    inline: true,
    words: Object.freeze(["unchanged", "changed", "unavailable", "no-previous-run"]),
  },
  {
    key: "packages/daemon/src/decision-incident-action.ts##IncidentActionOutcome.status",
    inline: true,
    words: Object.freeze(["applied", "failed"]),
  },
  {
    key: "packages/daemon/src/decision-incident-receipt.ts##SettledIncidentAction.status",
    inline: true,
    words: Object.freeze(["applied", "failed"]),
  },
  {
    key: "packages/daemon/src/decision-surface-actions.ts##DecisionReadService.status",
    inline: true,
    words: Object.freeze(["ready", "pending"]),
  },
  {
    key: "packages/daemon/src/dispatch-read.ts##RuntimeSessionActivityEvidence.outcome",
    inline: true,
    words: Object.freeze(["succeeded", "failed", "cancelled", "unknown", "stopped"]),
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
    key: "packages/daemon/src/doc-sync-publication.ts##RuntimeDispatchArchive.outcome",
    inline: true,
    words: Object.freeze(["succeeded", "failed", "unknown", "cancelled", "stopped"]),
  },
  {
    key: "packages/daemon/src/entity-action-catalog-receipts.ts##WriteReceiptDraft.status",
    inline: true,
    words: Object.freeze(["ready", "pending"]),
  },
  {
    key: "packages/daemon/src/fleet-edge-mirror.ts##FleetConflictRecord.state",
    inline: true,
    words: Object.freeze(["staged", "resolved"]),
  },
  {
    key: "packages/daemon/src/fleet-edge-mirror.ts##FleetMirrorApplyResult.outcome",
    inline: true,
    words: Object.freeze(["applied", "pull_blocked", "no_view"]),
  },
  {
    key: "packages/daemon/src/fleet-edge-runtime.ts##RuntimePorts.liveness",
    inline: true,
    words: Object.freeze(["live", "stale", "unknown", "exited"]),
  },
  {
    key: "packages/daemon/src/fleet-edge-runtime.ts##RuntimePorts.outcome",
    inline: true,
    words: Object.freeze(["succeeded", "failed", "unknown", "cancelled", "stopped"]),
  },
  {
    key: "packages/daemon/src/fleet/edge-join-client.ts##EdgeJoinRepositoryProgress.phase",
    inline: true,
    words: Object.freeze(["workspace", "register", "sync", "synced", "failed"]),
  },
  {
    key: "packages/daemon/src/fleet/edge-join.ts##EdgeJoinSummary.tunnelState",
    inline: true,
    words: Object.freeze(["connecting", "connected", "reconnecting", "stopped"]),
  },
  {
    key: "packages/daemon/src/fleet/fleet-overview-read.ts##FleetLinkRow.state",
    inline: true,
    words: Object.freeze(["fresh", "lag", "unsynced"]),
  },
  {
    key: "packages/daemon/src/gui-s3-control.ts##DaemonControlReceipt.outcome",
    inline: true,
    words: Object.freeze(["pending", "op_rejected", "applied"]),
  },
  {
    key: "packages/daemon/src/gui-s3-control.ts##DaemonControlReceipt.phase",
    inline: true,
    words: Object.freeze(["queued", "draining", "starting", "settled", "failed"]),
  },
  {
    key: "packages/daemon/src/gui-s3-control.ts##CatalogRereadReceipt.outcome",
    inline: true,
    words: Object.freeze(["applied", "op_rejected"]),
  },
  {
    key: "packages/daemon/src/gui-s3-control.ts##TerminalControlReceipt.outcome",
    inline: true,
    words: Object.freeze(["applied", "op_rejected"]),
  },
  {
    key: "packages/daemon/src/gui-s3-control.ts##TerminalSessionRow.status",
    inline: true,
    words: Object.freeze(["running", "exited", "unknown"]),
  },
  {
    key: "packages/daemon/src/home/home-overview-types.ts##DaemonHomeRepoOverview.registrationState",
    inline: true,
    words: Object.freeze(["enabled", "disabled"]),
  },
  {
    key: "packages/daemon/src/home/home-overview-types.ts##DaemonHomeRepoOverview.cellState",
    inline: true,
    words: Object.freeze(["attached", "warming", "unavailable", "not_loaded"]),
  },
  {
    key: "packages/daemon/src/home/home-overview-types.ts##DaemonHomeRepoOverview.status",
    inline: true,
    words: Object.freeze(["online", "warming", "unavailable", "offline"]),
  },
  {
    key: "packages/daemon/src/migration-import-authored-classification.ts##?.disposition",
    inline: true,
    words: Object.freeze(["excluded", "required"]),
  },
  {
    key: "packages/daemon/src/migration-import-legacy.ts##LegacyExecutionV2.disposition",
    inline: true,
    words: Object.freeze(["excluded", "required"]),
  },
  {
    key: "packages/daemon/src/migration-import-task-restatement.ts##RestatedTaskContract.disposition",
    inline: true,
    words: Object.freeze(["retired-preset-to-standard-task", "renamed-preset", "preset-task-class-aligned"]),
  },
  {
    key: "packages/daemon/src/migration-import-types.ts##MigrationDisposition.disposition",
    inline: true,
    words: Object.freeze(["archived", "retired"]),
  },
  {
    key: "packages/daemon/src/observe-jsonl-tail.ts##JsonlTailPage.status",
    inline: true,
    words: Object.freeze(["ready", "pending"]),
  },
  {
    key: "packages/daemon/src/observe-tail.ts##EventTailPage.status",
    inline: true,
    words: Object.freeze(["ready", "pending"]),
  },
  {
    key: "packages/daemon/src/protocol/artifacts-gui-contract.ts##ArtifactsListResult.status",
    inline: true,
    words: Object.freeze(["ready", "pending"]),
  },
  {
    key: "packages/daemon/src/protocol/daemon-protocol-gui-types.ts##ObserveTailResult.status",
    inline: true,
    words: Object.freeze(["ready", "pending"]),
  },
  {
    key: "packages/daemon/src/protocol/daemon-protocol-gui-types.ts##DaemonGuiReadDataMap.status",
    inline: true,
    words: Object.freeze(["ready", "pending"]),
  },
  {
    key: "packages/daemon/src/protocol/daemon-protocol-gui-types.ts##DaemonDecisionReviewDispatchRow.status",
    inline: true,
    words: Object.freeze(["running", "succeeded", "failed", "unknown"]),
  },
  {
    key: "packages/daemon/src/protocol/daemon-protocol-gui-types.ts##TaskPlacementSupplement.packageDisposition",
    inline: true,
    words: Object.freeze(["active", "archived", "tombstoned"]),
  },
  {
    key: "packages/daemon/src/protocol/daemon-protocol-gui-types.ts##DaemonTaskDocumentListResult.status",
    inline: true,
    words: Object.freeze(["ready", "pending"]),
  },
  {
    key: "packages/daemon/src/protocol/daemon-protocol-gui-types.ts##DaemonTaskDispatchesResultBase.status",
    inline: true,
    words: Object.freeze(["ready", "pending"]),
  },
  {
    key: "packages/daemon/src/protocol/daemon-protocol-gui-types.ts##DaemonTaskDispatchesResultBase.outcome",
    inline: true,
    words: Object.freeze(["succeeded", "failed", "cancelled", "unknown", "stopped"]),
  },
  {
    key: "packages/daemon/src/protocol/daemon-protocol-gui-types.ts##DaemonTaskSnapshotListResult.status",
    inline: true,
    words: Object.freeze(["ready", "pending"]),
  },
  {
    key: "packages/daemon/src/protocol/daemon-protocol-gui-types.ts##DaemonWorkspaceSummaryResult.status",
    inline: true,
    words: Object.freeze(["ready", "pending"]),
  },
  {
    key: "packages/daemon/src/protocol/daemon-protocol-gui-types.ts##TaskWorkspaceView.state",
    inline: true,
    words: Object.freeze(["bound", "materialized", "reclaimed", "retained"]),
  },
  {
    key: "packages/daemon/src/protocol/daemon-protocol-gui-types.ts##DaemonAgendaResult.status",
    inline: true,
    words: Object.freeze(["ready", "pending"]),
  },
  {
    key: "packages/daemon/src/protocol/daemon-protocol-gui-types.ts##DaemonGuiActionResult.outcome",
    inline: true,
    words: Object.freeze(["applied", "pending", "no_changes", "indeterminate", "op_rejected"]),
  },
  {
    key: "packages/daemon/src/protocol/daemon-protocol-task-delivery-diff.ts##DaemonTaskDeliveryDiffResult.status",
    inline: true,
    words: Object.freeze(["ready", "pending"]),
  },
  {
    key: "packages/daemon/src/protocol/daemon-protocol-validate-results.ts##ValidScheduleListRow.state",
    inline: true,
    words: Object.freeze(["armed", "paused"]),
  },
  {
    key: "packages/daemon/src/protocol/daemon-status-contract.ts##DaemonRepoAttachProgress.phase",
    inline: true,
    words: Object.freeze(["opening", "recovering", "catching-up", "restoring-runtimes"]),
  },
  {
    key: "packages/daemon/src/protocol/daemon-status-contract.ts##DaemonStatusResult.state",
    inline: true,
    words: Object.freeze(["enabled", "disabled"]),
  },
  {
    key: "packages/daemon/src/protocol/daemon-status-contract.ts##DaemonStatusResult.state",
    inline: true,
    words: Object.freeze(["warming", "attached", "unavailable", "closed"]),
  },
  {
    key: "packages/daemon/src/protocol/daemon-status-contract.ts##DaemonStatusResult.registrationState",
    inline: true,
    words: Object.freeze(["enabled", "disabled"]),
  },
  {
    key: "packages/daemon/src/protocol/schedule-runs-contract.ts##ScheduleRunsResult.status",
    inline: true,
    words: Object.freeze(["ready", "pending"]),
  },
  {
    key: "packages/daemon/src/protocol/schedules-gui-contract.ts##ScheduleGuiAgentOptionDto.state",
    inline: true,
    words: Object.freeze(["invalid", "missing"]),
  },
  {
    key: "packages/daemon/src/protocol/schedules-gui-contract.ts##ScheduleGuiRowDto.state",
    inline: true,
    words: Object.freeze(["armed", "paused"]),
  },
  {
    key: "packages/daemon/src/protocol/schedules-gui-contract.ts##ScheduleGuiRowDto.targetState",
    inline: true,
    words: Object.freeze(["invalid", "missing"]),
  },
  {
    key: "packages/daemon/src/protocol/schedules-gui-contract.ts##SchedulesListResult.status",
    inline: true,
    words: Object.freeze(["ready", "pending"]),
  },
  {
    key: "packages/daemon/src/protocol/task-dispatch-contract.ts##TaskDispatchDecisionAction.status",
    inline: true,
    words: Object.freeze(["applied", "failed"]),
  },
  {
    key: "packages/daemon/src/protocol/task-dispatch-contract.ts##TaskDispatchRow.activityStatus",
    inline: true,
    words: Object.freeze(["thinking", "tool", "waiting", "silent", "stalled", "unknown"]),
  },
  {
    key: "packages/daemon/src/protocol/task-dispatch-contract.ts##TaskDispatchRow.fallbackState",
    inline: true,
    words: Object.freeze(["scheduled", "dispatched", "exhausted"]),
  },
  {
    key: "packages/daemon/src/protocol/task-dispatch-contract.ts##TaskDispatchRow.outcome",
    inline: true,
    words: Object.freeze(["succeeded", "failed", "unknown", "cancelled", "stopped"]),
  },
  {
    key: "packages/daemon/src/repo-bootstrap.ts##BootstrapDocument.disposition",
    inline: true,
    words: Object.freeze(["created", "preserved", "updated"]),
  },
  {
    key: "packages/daemon/src/repo-bootstrap.ts##RepoBootstrapReceipt.outcome",
    inline: true,
    words: Object.freeze(["applied", "noop", "partial", "indeterminate"]),
  },
  {
    key: "packages/daemon/src/repo-cell-status.ts##?.status",
    inline: true,
    words: Object.freeze(["none", "indeterminate"]),
  },
  {
    key: "packages/daemon/src/repo-cell-task-create.ts##TaskMetadataV1.status",
    inline: true,
    words: Object.freeze(["ready", "pending"]),
  },
  {
    key: "packages/daemon/src/repo-cell-task-query.ts##TaskQueryCell.status",
    inline: true,
    words: Object.freeze(["ready", "pending"]),
  },
  {
    key: "packages/daemon/src/repo-cell-types.ts##RepoCellStatus.state",
    inline: true,
    words: Object.freeze(["warming", "attached", "unavailable", "closed"]),
  },
  {
    key: "packages/daemon/src/repo-cell.ts##RepoCellCore.status",
    inline: true,
    words: Object.freeze(["none", "indeterminate"]),
  },
  {
    key: "packages/daemon/src/repo-local-root-residue.ts##EntryClass.status",
    inline: true,
    words: Object.freeze(["ok", "warn", "fail"]),
  },
  {
    key: "packages/daemon/src/repo-writer-protocol.ts##RepoWriterReceiptV1.outcome",
    inline: true,
    words: Object.freeze(["ok", "error"]),
  },
  {
    key: "packages/daemon/src/repo-writer-protocol.ts##RepoWriterCapabilityResultV1.outcome",
    inline: true,
    words: Object.freeze(["ok", "error"]),
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
    key: "packages/daemon/src/skill-eval-runner.ts##SkillEvalSkill.status",
    inline: true,
    words: Object.freeze(["draft", "published"]),
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
  {
    key: "packages/daemon/src/task-risk-tier.ts##TaskRiskTierScriptInput.status",
    inline: true,
    words: Object.freeze(["added", "modified", "deleted", "renamed", "copied", "type-changed"]),
  },
  {
    key: "packages/daemon/src/task-worktree-legacy-rename.ts##LegacyWorktreeRow.status",
    inline: true,
    words: Object.freeze(["worktree-rename", "worktree-renamed"]),
  },
  {
    key: "packages/daemon/src/work-briefs-read.ts##WorkBriefsReadResult.status",
    inline: true,
    words: Object.freeze(["ready", "pending"]),
  },
  {
    key: "packages/daemon/src/work-topology-read.ts##WorkTopologyRead.status",
    inline: true,
    words: Object.freeze(["ready", "pending"]),
  },
  {
    key: "packages/daemon/src/workspace-link-integrity.ts##WorkspaceLinkCheck.status",
    inline: true,
    words: Object.freeze(["ok", "fail"]),
  },
  {
    key: "packages/daemon/src/workspace-scope-read.ts##WorkspaceScopeRead.status",
    inline: true,
    words: Object.freeze(["ready", "pending"]),
  },
  {
    key: "packages/gui/src/api/update-contract.ts##UpdateState.state",
    inline: true,
    words: Object.freeze(["idle", "checking", "not-available"]),
  },
  {
    key: "packages/gui/src/api/update-contract.ts##UpdateState.state",
    inline: true,
    words: Object.freeze(["available", "downloaded"]),
  },
  {
    key: "packages/gui/src/renderer/agent-entity-client.ts##EntitySaveResult.outcome",
    inline: true,
    words: Object.freeze(["applied", "pending", "op_rejected"]),
  },
  {
    key: "packages/gui/src/renderer/api-client-catalog.ts##CatalogSnapshotSuccess.status",
    inline: true,
    words: Object.freeze(["ready", "pending"]),
  },
  {
    key: "packages/gui/src/renderer/api-client-catalog.ts##CatalogRereadReceipt.outcome",
    inline: true,
    words: Object.freeze(["applied", "op_rejected"]),
  },
  {
    key: "packages/gui/src/renderer/api-client-decisions.ts##DecisionControlListSuccess.status",
    inline: true,
    words: Object.freeze(["ready", "pending"]),
  },
  {
    key: "packages/gui/src/renderer/api-client-decisions.ts##DecisionShowSuccess.status",
    inline: true,
    words: Object.freeze(["ready", "pending"]),
  },
  {
    key: "packages/gui/src/renderer/api-client.ts##TaskListSuccess.status",
    inline: true,
    words: Object.freeze(["ready", "pending"]),
  },
  {
    key: "packages/gui/src/renderer/api-client.ts##AgendaSuccess.status",
    inline: true,
    words: Object.freeze(["ready", "pending"]),
  },
  {
    key: "packages/gui/src/renderer/api-client.ts##SystemRepoRow.registrationState",
    inline: true,
    words: Object.freeze(["enabled", "disabled"]),
  },
  {
    key: "packages/gui/src/renderer/api-client.ts##SystemRepoRow.cellState",
    inline: true,
    words: Object.freeze(["warming", "attached", "unavailable", "not_loaded"]),
  },
  {
    key: "packages/gui/src/renderer/api-client.ts##SystemRepoRow.lockState",
    inline: true,
    words: Object.freeze(["held", "not_applicable", "unknown"]),
  },
  {
    key: "packages/gui/src/renderer/api-client.ts##DaemonControlReceipt.outcome",
    inline: true,
    words: Object.freeze(["pending", "op_rejected"]),
  },
  {
    key: "packages/gui/src/renderer/api-client.ts##DaemonControlReceipt.phase",
    inline: true,
    words: Object.freeze(["queued", "draining", "starting", "settled", "failed"]),
  },
  {
    key: "packages/gui/src/renderer/api-client.ts##DaemonControlReceipt.disposition",
    inline: true,
    words: Object.freeze(["adopt", "rebut"]),
  },
  {
    key: "packages/gui/src/renderer/awaits-answer.ts##AwaitsAnswerFeedback.state",
    inline: true,
    words: Object.freeze(["pending", "success", "error", "conflict"]),
  },
  {
    key: "packages/gui/src/renderer/cadence-feed.ts##CadenceFeedState.status",
    inline: true,
    words: Object.freeze(["loading", "live", "unavailable", "error"]),
  },
  {
    key: "packages/gui/src/renderer/components/GraphRelationState.tsx##GraphRelationStateProps.state",
    inline: true,
    words: Object.freeze(["ready", "loading", "error"]),
  },
  {
    key: "packages/gui/src/renderer/components/ScheduleFormDialog.tsx##strings.state",
    inline: true,
    words: Object.freeze(["invalid", "missing"]),
  },
  {
    key: "packages/gui/src/renderer/components/agent-ui/AgentPlan.tsx##PlanStep.phase",
    inline: true,
    words: Object.freeze(["editing", "running"]),
  },
  {
    key: "packages/gui/src/renderer/components/agent-ui/AgentSteering.tsx##SteerNote.state",
    inline: true,
    words: Object.freeze(["queued", "absorbed"]),
  },
  {
    key: "packages/gui/src/renderer/components/badges.tsx##StatusTone.state",
    inline: true,
    words: Object.freeze(["question", "awaits", "working"]),
  },
  {
    key: "packages/gui/src/renderer/components/runtime/DegradedEntityCard.tsx##DegradedEntityRow.state",
    inline: true,
    words: Object.freeze(["invalid", "missing"]),
  },
  {
    key: "packages/gui/src/renderer/components/runtime/RuntimeRail.tsx##DegradedEntityRow.state",
    inline: true,
    words: Object.freeze(["invalid", "missing"]),
  },
  {
    key: "packages/gui/src/renderer/components/runtime/parts.tsx##?.state",
    inline: true,
    words: Object.freeze(["live", "idle", "failed"]),
  },
  {
    key: "packages/gui/src/renderer/components/runtime/parts.tsx##?.state",
    inline: true,
    words: Object.freeze(["full", "part", "none"]),
  },
  {
    key: "packages/gui/src/renderer/components/runtime/useRuntimeWorkspace.ts##RuntimeDockRow.liveness",
    inline: true,
    words: Object.freeze(["live", "stale", "unknown", "exited"]),
  },
  {
    key: "packages/gui/src/renderer/connection-admin-client.ts##RepoAdminBridge.state",
    inline: true,
    words: Object.freeze(["enabled", "disabled"]),
  },
  {
    key: "packages/gui/src/renderer/daemon-observe-model.ts##ObserveTailSnapshot.status",
    inline: true,
    words: Object.freeze(["idle", "live", "unavailable", "gap", "error"]),
  },
  {
    key: "packages/gui/src/renderer/decision-actions.ts##DecisionSettlement.state",
    inline: true,
    words: Object.freeze(["applied", "pending", "op_rejected"]),
  },
  {
    key: "packages/gui/src/renderer/decision-actions.ts##DecisionMutationFeedback.state",
    inline: true,
    words: Object.freeze(["pending", "success", "error"]),
  },
  {
    key: "packages/gui/src/renderer/entities-data.ts##EntityLiveCount.state",
    inline: true,
    words: Object.freeze(["ready", "pending", "error"]),
  },
  {
    key: "packages/gui/src/renderer/entities-data.ts##FactFacetStats.state",
    inline: true,
    words: Object.freeze(["ready", "pending", "error"]),
  },
  {
    key: "packages/gui/src/renderer/entity-kind-data.ts##EntityKindCatalog.state",
    inline: true,
    words: Object.freeze(["ready", "pending", "error"]),
  },
  {
    key: "packages/gui/src/renderer/model/attestation-pool.ts##GateAttestationItem.gateStatus",
    inline: true,
    words: Object.freeze(["missing", "signoff_missing", "failed"]),
  },
  {
    key: "packages/gui/src/renderer/model/repo-state.ts##ProjectRepo.registrationState",
    inline: true,
    words: Object.freeze(["enabled", "disabled"]),
  },
  {
    key: "packages/gui/src/renderer/model/runtime-health.ts##RuntimeHealthProjection.status",
    inline: true,
    words: Object.freeze(["ready", "pending"]),
  },
  {
    key: "packages/gui/src/renderer/model/runtime-health.ts##RuntimeHealthInput.status",
    inline: true,
    words: Object.freeze(["ready", "pending"]),
  },
  {
    key: "packages/gui/src/renderer/model/session-conclusion.ts##SessionConclusion.verdict",
    inline: true,
    words: Object.freeze(["approved", "changes_requested", "dismissed"]),
  },
  {
    key: "packages/gui/src/renderer/model/smart-attention.ts##SmartAttentionSignal.liveness",
    inline: true,
    words: Object.freeze(["live", "stale", "unknown", "exited"]),
  },
  {
    key: "packages/gui/src/renderer/runtime-control.ts##RuntimeSpawnSettlement.state",
    inline: true,
    words: Object.freeze(["applied", "pending", "op_rejected"]),
  },
  {
    key: "packages/gui/src/renderer/runtime-instance-client.ts##RuntimeInstanceUpdateInput.isolationState",
    inline: true,
    words: Object.freeze(["enforced", "operator-environment"]),
  },
  {
    key: "packages/gui/src/renderer/runtime-instance-client.ts##RuntimeInstanceCreateCommon.isolationState",
    inline: true,
    words: Object.freeze(["enforced", "operator-environment"]),
  },
  {
    key: "packages/gui/src/renderer/session-transcript-model.ts##SessionTranscriptTurn.status",
    inline: true,
    words: Object.freeze(["running", "completed", "failed", "unknown"]),
  },
  {
    key: "packages/gui/src/renderer/start-work-flow.ts##StartWorkPrecondition.state",
    inline: true,
    words: Object.freeze(["ok", "blocked", "unknown"]),
  },
  {
    key: "packages/gui/src/renderer/task-actions.ts##TaskSettlement.state",
    inline: true,
    words: Object.freeze(["applied", "pending", "op_rejected"]),
  },
  {
    key: "packages/gui/src/renderer/task-actions.ts##TaskMutationFeedback.state",
    inline: true,
    words: Object.freeze(["pending", "success", "error"]),
  },
  {
    key: "packages/gui/src/renderer/task-adapter.ts##TaskRowsCache.projectionStatus",
    inline: true,
    words: Object.freeze(["ready", "pending"]),
  },
  {
    key: "packages/gui/src/renderer/terminal-client.ts##TerminalAttachInitial.status",
    inline: true,
    words: Object.freeze(["attached", "gap"]),
  },
  {
    key: "packages/gui/src/renderer/terminal-model.ts##TerminalTab.state",
    inline: true,
    words: Object.freeze(["running", "exited", "unknown"]),
  },
  {
    key: "packages/gui/src/renderer/terminal-model.ts##TerminalStreamFrame.state",
    inline: true,
    words: Object.freeze(["confirmation_required", "requested"]),
  },
  {
    key: "packages/gui/src/renderer/views/live-floor-model.ts##LiveFloorRow.activityStatus",
    inline: true,
    words: Object.freeze(["thinking", "tool", "waiting", "silent", "stalled", "unknown"]),
  },
  {
    key: "packages/kernel/src/ports/decision-projection-model.ts##DecisionRelationEdgeRow.state",
    inline: true,
    words: Object.freeze(["active", "retired"]),
  },
  {
    key: "packages/kernel/src/ports/decision-projection-model.ts##DecisionCoverageRow.status",
    inline: true,
    words: Object.freeze(["covered", "uncovered"]),
  },
  {
    key: "packages/kernel/src/ports/identity-provider-port.ts##AuthorizationNode.state",
    inline: true,
    words: Object.freeze(["active", "paused", "removed"]),
  },
  {
    key: "packages/kernel/src/ports/identity-provider-port.ts##AuthorizationPermissionDecision.outcome",
    inline: true,
    words: Object.freeze(["allowed", "denied"]),
  },
  {
    key: "packages/kernel/src/ports/projection-contracts.ts##DecisionReadinessProjection.state",
    inline: true,
    words: Object.freeze(["clear", "drift", "unknown"]),
  },
  {
    key: "packages/kernel/src/ports/projection-contracts.ts##DecisionReadinessProjection.state",
    inline: true,
    words: Object.freeze(["clear", "conflict", "unknown"]),
  },
  {
    key: "packages/kernel/src/ports/projection-contracts.ts##FactProjectionRow.state",
    inline: true,
    words: Object.freeze(["standing", "superseded_fact"]),
  },
  {
    key: "packages/kernel/src/ports/projection-contracts.ts##RelationCoverageRow.status",
    inline: true,
    words: Object.freeze(["covered", "uncovered"]),
  },
  {
    key: "packages/kernel/src/ports/projection-contracts.ts##RelationFactRow.liveness",
    inline: true,
    words: Object.freeze(["standing", "superseded_fact"]),
  },
  {
    key: "packages/kernel/src/ports/projection-contracts.ts##RelationCycleAuditRead.status",
    inline: true,
    words: Object.freeze(["ready", "pending"]),
  },
  {
    key: "packages/kernel/src/ports/projection-reads.ts##TaskProjectionRead.status",
    inline: true,
    words: Object.freeze(["ready", "pending"]),
  },
  {
    key: "packages/kernel/src/ports/projection-reads.ts##TaskProjectionListRead.status",
    inline: true,
    words: Object.freeze(["ready", "pending"]),
  },
  {
    key: "packages/kernel/src/ports/projection-reads.ts##TaskIndexProjectionRead.status",
    inline: true,
    words: Object.freeze(["ready", "pending"]),
  },
  {
    key: "packages/kernel/src/ports/projection-reads.ts##ArtifactTimelineRead.status",
    inline: true,
    words: Object.freeze(["ready", "pending"]),
  },
  {
    key: "packages/kernel/src/ports/projection-reads.ts##TaskRuntimeBatchRead.status",
    inline: true,
    words: Object.freeze(["ready", "pending"]),
  },
  {
    key: "packages/kernel/src/ports/projection-reads.ts##WorkspaceSummaryProjectionRead.status",
    inline: true,
    words: Object.freeze(["ready", "pending"]),
  },
  {
    key: "packages/kernel/src/ports/projection-reads.ts##TaskRelationProjectionRead.status",
    inline: true,
    words: Object.freeze(["ready", "pending"]),
  },
  {
    key: "packages/kernel/src/ports/projection-reads.ts##DocumentProjectionRead.status",
    inline: true,
    words: Object.freeze(["ready", "pending"]),
  },
  {
    key: "packages/kernel/src/ports/projection-reads.ts##PresetSnapshotProjectionRead.status",
    inline: true,
    words: Object.freeze(["ready", "pending"]),
  },
  {
    key: "packages/kernel/src/ports/projection-reads.ts##FactProjectionRead.status",
    inline: true,
    words: Object.freeze(["ready", "pending"]),
  },
  {
    key: "packages/kernel/src/ports/projection-reads.ts##TaskProgressProjectionRead.status",
    inline: true,
    words: Object.freeze(["ready", "pending"]),
  },
  {
    key: "packages/kernel/src/ports/projection-reads.ts##FactProjectionSearchRead.status",
    inline: true,
    words: Object.freeze(["ready", "pending"]),
  },
  {
    key: "packages/kernel/src/ports/projection-reads.ts##FactDomainTypeProjectionRead.status",
    inline: true,
    words: Object.freeze(["ready", "pending"]),
  },
  {
    key: "packages/kernel/src/ports/projection-reads.ts##FactAnchorProjectionRead.status",
    inline: true,
    words: Object.freeze(["ready", "pending"]),
  },
  {
    key: "packages/kernel/src/ports/projection-reads.ts##FactGraphProjectionRead.status",
    inline: true,
    words: Object.freeze(["ready", "pending"]),
  },
  {
    key: "packages/kernel/src/ports/projection-reads.ts##DecisionProjectionRead.status",
    inline: true,
    words: Object.freeze(["ready", "pending"]),
  },
  {
    key: "packages/kernel/src/ports/projection-reads.ts##DecisionProjectionListRead.status",
    inline: true,
    words: Object.freeze(["ready", "pending"]),
  },
  {
    key: "packages/kernel/src/ports/projection-reads.ts##DecisionAgendaProjectionPageRead.status",
    inline: true,
    words: Object.freeze(["ready", "pending"]),
  },
  {
    key: "packages/kernel/src/ports/projection-reads.ts##DecisionGraphProjectionRead.status",
    inline: true,
    words: Object.freeze(["ready", "pending"]),
  },
  {
    key: "packages/kernel/src/ports/projection-reads.ts##DecisionCoverageProjectionRead.status",
    inline: true,
    words: Object.freeze(["ready", "pending"]),
  },
  {
    key: "packages/kernel/src/ports/task-event-store.ts##MaterializationReceipt.status",
    inline: true,
    words: Object.freeze(["visible", "planned"]),
  },
  {
    key: "packages/kernel/src/ports/task-event-store.ts##CanonicalCommandOutcome.status",
    inline: true,
    words: Object.freeze(["accepted_durable", "rejected"]),
  },
  {
    key: "packages/kernel/src/ports/task-event-store.ts##CanonicalFollowerFacet.status",
    inline: true,
    words: Object.freeze(["pending", "verified"]),
  },
  {
    key: "packages/kernel/src/ports/task-projection.ts##RuntimeDispatchProjectionRow.outcome",
    inline: true,
    words: Object.freeze(["succeeded", "failed", "unknown", "cancelled", "stopped"]),
  },
  {
    key: "packages/kernel/src/ports/task-projection.ts##TaskProjection.status",
    inline: true,
    words: Object.freeze(["ready", "pending"]),
  },
  {
    key: "packages/preset/src/preset-process-service.ts##PresetProducedReceipt.outcome",
    inline: true,
    words: Object.freeze(["applied", "pending", "indeterminate", "op_rejected"]),
  },
  {
    key: "packages/preset/src/preset-resolver-types.ts##RepositoryScaffoldDocument.disposition",
    inline: true,
    words: Object.freeze(["created", "preserved", "drifted"]),
  },
  {
    key: "packages/storage/src/pg/pg-task-source.ts##PgProjectionCut.status",
    inline: true,
    words: Object.freeze(["ready", "pending"]),
  },
  {
    key: "packages/storage/src/postgres/pg-event-store.ts##OutcomeRow.status",
    inline: true,
    words: Object.freeze(["accepted_durable", "rejected"]),
  },
  {
    key: "packages/storage/src/projection/rebuildable-task-projection-sql.ts##Hash.status",
    inline: true,
    words: Object.freeze(["ready", "pending"]),
  },
  {
    key: "packages/storage/src/store/generation-two-conversion.ts##GenerationConversionMapping.disposition",
    inline: true,
    words: Object.freeze(["converted", "retained-read-only", "unsupported"]),
  },
  {
    key: "packages/storage/src/store/sqlite-event-store-types.ts##SqliteCommandOutcome.status",
    inline: true,
    words: Object.freeze(["accepted_durable", "rejected"]),
  },
  {
    key: "packages/storage/src/writer-epoch.ts##LegacyWriterEpochMigrationResult.state",
    inline: true,
    words: Object.freeze(["not-needed", "already-migrated", "migrated", "partial"]),
  },
]);

// External status vocabularies that were registered before the ownership form became
// mandatory (dec_499E4E98A3D4754132B3BCA1E6 CH1). Owning one later makes its entry
// stale; a new external row without mirrorOf / ownerStore / view-local is refused.
export const statusVocabularyUnownedRegister = Object.freeze([
  { id: "dispatch.fallbackState", words: Object.freeze(["scheduled", "dispatched", "exhausted"]) },
  { id: "materialization.state", words: Object.freeze(["ok", "retrying", "failed"]) },
  {
    id: "docCandidate.state",
    words: Object.freeze(["clean", "eligible", "inapplicable", "blocked", "deletion", "conflict"]),
  },
  { id: "documentReplica.syncState", words: Object.freeze(["synced", "unsynced", "unobservable", "derived"]) },
  { id: "documentReplica.syncState-observed", words: Object.freeze(["synced", "unsynced", "unobservable"]) },
]);
