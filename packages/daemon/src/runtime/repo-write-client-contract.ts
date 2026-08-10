import type {
  RepoWriteChildMessage,
  RepoWriteParentMessage,
  RepoWriteRecoveryDiagnosticFrame,
  RepoWriteRetryBudgetSignalFrame,
  RepoWriteTelemetryBatchFrame,
  RepoWriteTelemetryFrame
} from "./repo-write-protocol.ts";
import type {
  RepoWriteProtocolViolationError
} from "./repo-write-client-errors.ts";

export const defaultRepoWriteRequestTimeoutMs = 30_000;

export interface RepoWriteClientTransport {
  /**
   * A synchronous throw means the frame was definitely not sent. Asynchronous
   * rejection must identify delivery when knowable; an untyped rejection is
   * conservatively treated as possibly sent.
   */
  readonly send: (message: RepoWriteParentMessage) => void | Promise<void>;
  readonly onMessage: (
    listener: (message: RepoWriteChildMessage) => void
  ) => () => void;
  readonly onDisconnect: (listener: (error: Error) => void) => () => void;
}

export interface RepoWriteClientLimits {
  readonly maxPendingRequests: number;
  /** Maximum time without a previously unseen startup phase/work-unit pair. */
  readonly readyTimeoutMs: number;
  readonly requestTimeoutMs: number;
  /**
   * Total wall time from request dispatch until a proceeded operation is escalated.
   * The default is two request windows: 30s observes, 60s replaces and looks up.
   */
  readonly proceededStallTimeoutMs: number;
}

export interface RepoWriteRequestDiagnostic {
  readonly requestId: string;
  readonly commandName: string;
  readonly lane: "durable" | "direct" | "lookup";
  readonly opId?: string;
  readonly lastTelemetry?: RepoWriteTelemetryFrame;
}

export interface RepoWriteRequestTimeoutDiagnostic extends RepoWriteRequestDiagnostic {
  readonly deadlineMs: number;
  readonly watchdogStage: "deadline" | "observation" | "escalation";
}

export interface RepoWriteRequestFailureDiagnostic extends RepoWriteRequestDiagnostic {
  readonly code: string;
  readonly diagnostic: string;
}

export interface RepoWriteClientOptions {
  readonly repoId: string;
  readonly generation: number;
  readonly transport: RepoWriteClientTransport;
  readonly expectedArtifactIdentity?: string;
  readonly limits?: Partial<RepoWriteClientLimits>;
  readonly onTelemetry: (frame: RepoWriteTelemetryFrame) => void;
  readonly onTelemetryBatch?: (frame: RepoWriteTelemetryBatchFrame) => void;
  readonly onDiagnostic?: (frame: RepoWriteRecoveryDiagnosticFrame) => void;
  readonly onRetryBudgetSignal?: (frame: RepoWriteRetryBudgetSignalFrame) => void;
  readonly onRequestTimeout?: (
    diagnostic: RepoWriteRequestTimeoutDiagnostic
  ) => void;
  readonly onRequestFailure?: (
    diagnostic: RepoWriteRequestFailureDiagnostic
  ) => void;
  readonly onProtocolViolation?: (
    error: RepoWriteProtocolViolationError
  ) => void;
}
