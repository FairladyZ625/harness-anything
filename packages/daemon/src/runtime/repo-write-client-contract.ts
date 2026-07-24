import type {
  RepoWriteChildMessage,
  RepoWriteParentMessage,
  RepoWriteRecoveryDeferredFrame,
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
  readonly readyTimeoutMs: number;
  readonly requestTimeoutMs: number;
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
  readonly onDiagnostic?: (frame: RepoWriteRecoveryDeferredFrame) => void;
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
