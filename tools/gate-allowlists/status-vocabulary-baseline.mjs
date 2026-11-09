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
]);
