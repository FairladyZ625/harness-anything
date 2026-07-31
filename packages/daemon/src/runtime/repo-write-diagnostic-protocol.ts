interface RepoWriteDiagnosticFrameBase {
  readonly protocol: "harness-repo-write-ipc/v1";
  readonly repoId: string;
  readonly generation: number;
}

export type RepoWriteTelemetryPhase =
  "queue" | "compile" | "journal" | "git" | "fsync" | "materializer" | "projection" | "total";

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
