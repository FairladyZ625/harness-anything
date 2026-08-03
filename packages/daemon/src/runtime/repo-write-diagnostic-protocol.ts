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
  "authority-evidence-git-commit", "fsync", "materializer", "projection", "total"
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
