import type {
  RepoWriteChildMessage,
  RepoWriteParentMessage,
  RepoWriteTelemetryFrame
} from "./repo-write-protocol.ts";
import type {
  RepoWriteProtocolViolationError
} from "./repo-write-client-errors.ts";

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

export interface RepoWriteClientOptions {
  readonly repoId: string;
  readonly generation: number;
  readonly transport: RepoWriteClientTransport;
  readonly expectedArtifactIdentity?: string;
  readonly limits?: Partial<RepoWriteClientLimits>;
  readonly onTelemetry: (frame: RepoWriteTelemetryFrame) => void;
  readonly onProtocolViolation?: (
    error: RepoWriteProtocolViolationError
  ) => void;
}
