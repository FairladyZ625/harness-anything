interface RepoWriteDiagnosticFrameBase {
  readonly protocol: "harness-repo-write-ipc/v1";
  readonly repoId: string;
  readonly generation: number;
}

export const repoWriteTelemetryPhases = [
  "queue", "compile", "compile-command-normalize", "compile-authority-plan",
  "compile-task-load", "compile-task-holder", "compile-task-witness",
  "compile-task-plan", "compile-outcome", "journal", "command-conflict-preflight",
  "command-conflict-recheck", "git", "authority-replica-change-read",
  "authority-publication-proof", "authority-operation-integrity", "authority-admission",
  "authority-binding-verified", "authority-batch-start", "authority-generation-acquire",
  "authority-generation-held", "authority-coordinator-enqueue", "authority-coordinator-enqueued",
  "authority-prepared-persisted", "authority-flush-start", "authority-replication-snapshot",
  "authority-replica-change-append", "authority-evidence-commit", "authority-evidence-worktree",
  "authority-evidence-history-verify", "authority-evidence-pending-verify",
  "authority-evidence-git-commit", "authority-evidence-git-commit-done",
  "authority-evidence-publish-returned", "authority-event-published",
  "authority-terminal-record-start", "authority-terminal-record-persisted",
  "authority-flush-git-commit-plan-start", "authority-flush-git-commit-plan-done",
  "authority-flush-git-session-checkout-start", "authority-flush-git-session-checkout-done",
  "authority-flush-git-stage-start", "authority-flush-git-stage-done",
  "authority-flush-git-unstage-logs-start", "authority-flush-git-unstage-logs-done",
  "authority-flush-git-trunk-checkout-start", "authority-flush-git-trunk-checkout-done",
  "authority-flush-git-commit-call-start", "authority-flush-git-commit-call-done",
  "authority-flush-git-staged-paths-start", "authority-flush-git-staged-paths-done",
  "authority-flush-git-staged-entries-start", "authority-flush-git-staged-entries-done",
  "authority-flush-git-worktree-verify-start", "authority-flush-git-worktree-verify-done",
  "authority-flush-git-alternate-index-start", "authority-flush-git-alternate-index-ready",
  "authority-flush-git-commit-start", "authority-flush-git-commit-done",
  "authority-flush-git-index-refresh-start", "authority-flush-git-index-refresh-done",
  "authority-flush-git-index-refresh-fallback-start", "authority-flush-git-index-refresh-fallback-done",
  "authority-flush-git-native-commit-start",
  "authority-flush-git-native-commit-done",
  "authority-flush-projection-fingerprint-start",
  "authority-flush-projection-fingerprint-done",
  "authority-flush-post-commit-attribution-confirm-start",
  "authority-flush-post-commit-attribution-confirm-done",
  "authority-flush-post-commit-projection-hash-start",
  "authority-flush-post-commit-projection-hash-done",
  "authority-flush-post-commit-watermark-start",
  "authority-flush-post-commit-watermark-done",
  "authority-flush-post-commit-compaction-start",
  "authority-flush-post-commit-compaction-done",
  "authority-flush-post-commit-projection-notify-start",
  "authority-flush-post-commit-projection-notify-done",
  "runtime-event-append-start", "runtime-event-append-done",
  "authority-materializer-start", "authority-materializer-baseline-start",
  "authority-materializer-baseline-done", "authority-materializer-merge-start",
  "authority-materializer-merge-done", "authority-materializer-projection-start",
  "authority-materializer-projection-load-current", "authority-materializer-projection-capture-source",
  "authority-materializer-projection-derive-affected", "authority-materializer-projection-declared-delta",
  "authority-materializer-projection-hash-next", "authority-materializer-projection-verify-source",
  "authority-materializer-projection-source-cache-refresh",
  "authority-materializer-projection-source-cache-change",
  "authority-materializer-projection-attribution-delta",
  "authority-materializer-projection-source-delta", "authority-materializer-projection-publish",
  "authority-materializer-projection-database-start",
  "authority-materializer-projection-database-task-rows-done",
  "authority-materializer-projection-database-decision-rows-done",
  "authority-materializer-projection-database-graph-rows-done",
  "authority-materializer-projection-database-declared-rows-done",
  "authority-materializer-projection-database-source-cache-done",
  "authority-materializer-projection-database-attribution-done",
  "authority-materializer-projection-database-meta-done",
  "authority-materializer-projection-database-commit-start",
  "authority-materializer-projection-database-commit-done",
  "authority-materializer-projection-database-done",
  "authority-materializer-projection-mode-incremental", "authority-materializer-projection-mode-rebuild",
  "authority-materializer-projection-mode-unchanged",
  "authority-materializer-projection-mode-rebuild-reason-projection-missing",
  "authority-materializer-projection-mode-rebuild-reason-projection-read-failed",
  "authority-materializer-projection-mode-rebuild-reason-projection-version-mismatch",
  "authority-materializer-projection-mode-rebuild-reason-source-cache-invalid",
  "authority-materializer-projection-mode-rebuild-reason-projection-metadata-read-failed",
  "authority-materializer-projection-mode-rebuild-reason-projection-integrity-mismatch",
  "authority-materializer-projection-mode-rebuild-reason-relation-graph-reuse-unavailable",
  "authority-materializer-projection-mode-rebuild-reason-declared-projection-delta-failed",
  "authority-materializer-projection-mode-rebuild-reason-source-fingerprint-mismatch",
  "authority-materializer-projection-mode-rebuild-reason-source-verification-race",
  "authority-materializer-projection-mode-rebuild-reason-source-verification-failed",
  "authority-materializer-projection-mode-rebuild-reason-source-cache-reload-failed",
  "authority-materializer-projection-mode-rebuild-reason-source-cache-refresh-failed",
  "authority-materializer-projection-mode-rebuild-reason-attribution-cache-change-missing",
  "authority-materializer-projection-mode-rebuild-reason-projection-update-recovered",
  "authority-materializer-projection-attribution-decision-delete-present",
  "authority-materializer-projection-attribution-decision-non-single-upsert",
  "authority-materializer-projection-attribution-decision-source-path-exists",
  "authority-materializer-projection-attribution-decision-event-decode-failed",
  "authority-materializer-projection-attribution-decision-projected-read-failed",
  "authority-materializer-projection-attribution-decision-op-id-ambiguous",
  "authority-materializer-projection-attribution-decision-v1-v2-precedence",
  "authority-materializer-projection-attribution-decision-replay",
  "authority-materializer-projection-attribution-decision-new-source-path",
  "authority-materializer-projection-attribution-decision-v1-to-v2-replacement",
  "authority-materializer-projection-attribution-decision-op-id-collision",
  "authority-materializer-projection-attribution-decision-other",
  "authority-materializer-projection-done", "authority-materializer-attribution-start",
  "authority-materializer-attribution-done", "authority-materializer-end",
  "child-execution-returned", "child-telemetry-flushed", "child-terminal-response",
  "fsync", "materializer", "projection", "total"
] as const;

export type RepoWriteTelemetryPhase = typeof repoWriteTelemetryPhases[number];

export interface RepoWriteTelemetryFrame extends RepoWriteDiagnosticFrameBase {
  readonly kind: "telemetry";
  readonly requestId: string;
  readonly opId?: string;
  readonly phase: RepoWriteTelemetryPhase;
  readonly elapsedMs: number;
}

export interface RepoWriteRecoveryDeferredFrame extends RepoWriteDiagnosticFrameBase {
  readonly kind: "recovery-deferred";
  readonly outerOpId: string;
  readonly code: string;
  readonly diagnostic: string;
}

export interface RepoWriteRecoveryRejectedFrame extends RepoWriteDiagnosticFrameBase {
  readonly kind: "recovery-rejected";
  readonly outerOpId: string;
  readonly code: string;
  readonly diagnostic: string;
  readonly next: string;
}

export type RepoWriteRecoveryDiagnosticFrame =
  RepoWriteRecoveryDeferredFrame | RepoWriteRecoveryRejectedFrame;
