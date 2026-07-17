export type TerminalBackend = "direct-pty" | "tmux" | "remote";
export type TerminalSessionStatus = "active" | "idle" | "exited" | "unknown";
export type TerminalSessionDurability = "none" | "daemon-restart" | "remote-owned";

export interface TerminalBackendWarning {
  readonly code: "terminal_backend_downgraded_non_durable";
  readonly requestedBackend: TerminalBackend;
  readonly selectedBackend: TerminalBackend;
  readonly hint: string;
}

/** Renderer-safe daemon projection. It intentionally carries no process owner, PID, token, or environment values. */
export interface TerminalSessionInfo {
  readonly sessionId: string;
  readonly name: string;
  readonly backend: TerminalBackend;
  readonly durability: TerminalSessionDurability;
  readonly degraded: boolean;
  readonly backendWarnings?: ReadonlyArray<TerminalBackendWarning>;
  readonly status: TerminalSessionStatus;
  readonly attachable: boolean;
  readonly envProfileId?: string;
  readonly hostProfileId?: string;
  readonly hostLabel: string;
  readonly projectId?: string;
  readonly taskId?: string;
  readonly cwd?: string;
  readonly shell?: string;
  readonly createdAt: string;
  readonly lastActivityAt?: string;
  readonly exitCode?: number;
}

export interface ScrollbackConfig {
  readonly maxBytes: number;
  readonly replayMaxBytes: number;
  readonly eviction: "drop-oldest";
}

export interface TerminalSessionFailure {
  readonly ok: false;
  readonly error: { readonly code: string; readonly hint: string };
}

export interface TerminalSessionIdPayload { readonly sessionId: string }

export interface TerminateTerminalSessionPayload extends TerminalSessionIdPayload {
  readonly confirmation: "terminate-terminal-session";
}

export interface CreateTerminalSessionPayload {
  readonly name?: string;
  readonly backend?: TerminalBackend;
  readonly envProfileId?: string;
  readonly hostProfileId?: string;
  readonly hostLabel?: string;
  readonly projectId?: string;
  readonly taskId?: string;
  readonly cwd?: string;
  readonly shell?: string;
  readonly reopenOfSessionId?: string;
}

export interface ResizeTerminalSessionPayload extends TerminalSessionIdPayload {
  readonly columns: number;
  readonly rows: number;
}

export interface WriteTerminalSessionPayload extends TerminalSessionIdPayload { readonly data: string }
export interface ReadTerminalSessionPayload extends TerminalSessionIdPayload {
  readonly cursor?: number;
  readonly timeoutMs?: number;
}

export interface TerminalOutputDataEvent { readonly kind: "data"; readonly sequence: number; readonly data: string }
export interface TerminalOutputExitEvent {
  readonly kind: "exit";
  readonly sequence: number;
  readonly exitCode: number;
  readonly signal?: number;
}
export type TerminalOutputEvent = TerminalOutputDataEvent | TerminalOutputExitEvent;

export interface TerminalOutputReadSuccess {
  readonly ok: true;
  readonly session: TerminalSessionInfo;
  readonly events: ReadonlyArray<TerminalOutputEvent>;
  readonly nextCursor: number;
  readonly dropped: boolean;
}
export type TerminalOutputReadResult = TerminalOutputReadSuccess | TerminalSessionFailure;

export interface TerminalSessionDetailSuccess { readonly ok: true; readonly session: TerminalSessionInfo }
export type TerminalSessionDetailResult = TerminalSessionDetailSuccess | TerminalSessionFailure;
export interface TerminalSessionListSuccess { readonly ok: true; readonly sessions: ReadonlyArray<TerminalSessionInfo> }
export type TerminalSessionListResult = TerminalSessionListSuccess | TerminalSessionFailure;

export interface TerminalAttachPolicy {
  readonly displayOnly: true;
  readonly outputCreatesTaskState: false;
  readonly inputAccepted: true;
  readonly replayMaxBytes: number;
}
export interface TerminalAttachPolicySuccess {
  readonly ok: true;
  readonly session: TerminalSessionInfo;
  readonly policy: TerminalAttachPolicy;
}
export type TerminalAttachPolicyResult = TerminalAttachPolicySuccess | TerminalSessionFailure;

export interface TerminalSessionService {
  readonly createSession: (payload: CreateTerminalSessionPayload) => TerminalSessionDetailResult;
  readonly listSessions: () => TerminalSessionListResult;
  readonly getSession: (payload: TerminalSessionIdPayload) => TerminalSessionDetailResult;
  readonly attachSession: (payload: TerminalSessionIdPayload) => TerminalAttachPolicyResult;
  readonly detachSession: (payload: TerminalSessionIdPayload) => TerminalSessionDetailResult;
  readonly terminateSession: (payload: TerminateTerminalSessionPayload) => TerminalSessionDetailResult;
  readonly writeSession: (payload: WriteTerminalSessionPayload) => TerminalSessionDetailResult;
  readonly readSession: (payload: ReadTerminalSessionPayload) => TerminalOutputReadResult | Promise<TerminalOutputReadResult>;
  readonly resizeSession: (payload: ResizeTerminalSessionPayload) => TerminalSessionDetailResult;
  /** Compatibility road: retains the old explicit exit/kill meaning. */
  readonly closeSession: (payload: TerminalSessionIdPayload) => TerminalSessionDetailResult;
}
