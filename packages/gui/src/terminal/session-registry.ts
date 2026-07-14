import {
  directPtyCapability,
  selectTerminalBackend,
  type TerminalBackendCapability,
  type TerminalBackendSelectionSuccess,
  type TerminalBackendWarning
} from "./backend-policy.ts";

export type TerminalBackend = "direct-pty" | "tmux" | "remote";
export type TerminalSessionStatus = "active" | "idle" | "exited";

export interface TerminalSessionInfo {
  readonly sessionId: string;
  readonly name: string;
  readonly backend: TerminalBackend;
  readonly backendWarnings?: ReadonlyArray<TerminalBackendWarning>;
  readonly status: TerminalSessionStatus;
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
  readonly error: {
    readonly code: string;
    readonly hint: string;
  };
}

export interface TerminalSessionIdPayload {
  readonly sessionId: string;
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

export interface WriteTerminalSessionPayload extends TerminalSessionIdPayload {
  readonly data: string;
}

export interface ReadTerminalSessionPayload extends TerminalSessionIdPayload {
  readonly cursor?: number;
  readonly timeoutMs?: number;
}

export interface TerminalOutputDataEvent {
  readonly kind: "data";
  readonly sequence: number;
  readonly data: string;
}

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

export interface TerminalSessionDetailSuccess {
  readonly ok: true;
  readonly session: TerminalSessionInfo;
}

export type TerminalSessionDetailResult = TerminalSessionDetailSuccess | TerminalSessionFailure;

export interface TerminalSessionListSuccess {
  readonly ok: true;
  readonly sessions: ReadonlyArray<TerminalSessionInfo>;
}

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
  readonly writeSession: (payload: WriteTerminalSessionPayload) => TerminalSessionDetailResult;
  readonly readSession: (payload: ReadTerminalSessionPayload) => TerminalOutputReadResult | Promise<TerminalOutputReadResult>;
  readonly resizeSession: (payload: ResizeTerminalSessionPayload) => TerminalSessionDetailResult;
  readonly closeSession: (payload: TerminalSessionIdPayload) => TerminalSessionDetailResult;
}

export interface InMemoryTerminalSessionService extends TerminalSessionService {
  readonly detachSessionView: (payload: TerminalSessionIdPayload) => TerminalSessionDetailResult;
  readonly markSessionExited: (payload: TerminalSessionIdPayload & { readonly exitCode: number }) => TerminalSessionDetailResult;
}

export interface TerminalSessionRegistryOptions {
  readonly createId?: () => string;
  readonly now?: () => string;
  readonly defaultBackend?: TerminalBackend;
  readonly backendCapabilities?: ReadonlyArray<TerminalBackendCapability>;
  readonly allowDirectPtyFallback?: boolean;
  readonly defaultHostLabel?: string;
  readonly scrollback?: ScrollbackConfig;
}

const defaultScrollback: ScrollbackConfig = {
  maxBytes: 1_048_576,
  replayMaxBytes: 262_144,
  eviction: "drop-oldest"
};

export function createInMemoryTerminalSessionService(options: TerminalSessionRegistryOptions = {}): InMemoryTerminalSessionService {
  const sessions = new Map<string, TerminalSessionInfo>();
  const createId = options.createId ?? randomSessionId;
  const now = options.now ?? (() => new Date().toISOString());
  const defaultBackend = options.defaultBackend ?? "direct-pty";
  const backendCapabilities = options.backendCapabilities ?? [directPtyCapability()];
  const defaultHostLabel = options.defaultHostLabel ?? "local";
  const scrollback = options.scrollback ?? defaultScrollback;

  function getExistingSession(sessionId: string): TerminalSessionInfo | TerminalSessionFailure {
    const session = sessions.get(sessionId);
    if (!session) return failure("terminal_session_not_found", `Terminal session not found: ${sessionId}`);
    return session;
  }

  function save(session: TerminalSessionInfo): TerminalSessionInfo {
    sessions.set(session.sessionId, session);
    return session;
  }

  function selectBackend(requestedBackend?: TerminalBackend): TerminalBackendSelectionSuccess | TerminalSessionFailure {
    const selection = selectTerminalBackend({
      requestedBackend,
      defaultBackend,
      capabilities: backendCapabilities,
      allowDirectPtyFallback: options.allowDirectPtyFallback
    });
    if (!selection.ok) return failure(selection.error.code, selection.error.hint);
    return selection;
  }

  return {
    createSession: (payload) => {
      const timestamp = now();
      if (payload.reopenOfSessionId) {
        const source = getExistingSession(payload.reopenOfSessionId);
        if (!isTerminalSessionInfo(source)) return source;
        if (source.status !== "exited") {
          return failure("terminal_session_not_exited", "Only exited terminal sessions can be reopened.");
        }
        const selectedBackend = selectBackend(payload.backend ?? source.backend);
        if (!selectedBackend.ok) return selectedBackend;
        return {
          ok: true,
          session: save({
            sessionId: createId(),
            name: payload.name ?? source.name,
            backend: selectedBackend.backend,
            ...backendWarningProperties(selectedBackend),
            envProfileId: payload.envProfileId ?? source.envProfileId,
            hostProfileId: payload.hostProfileId ?? source.hostProfileId,
            hostLabel: payload.hostLabel ?? source.hostLabel,
            projectId: payload.projectId ?? source.projectId,
            taskId: payload.taskId ?? source.taskId,
            cwd: payload.cwd ?? source.cwd,
            shell: payload.shell ?? source.shell,
            status: "active",
            createdAt: timestamp,
            lastActivityAt: timestamp
          })
        };
      }

      const selectedBackend = selectBackend(payload.backend);
      if (!selectedBackend.ok) return selectedBackend;
      return {
        ok: true,
        session: save({
          sessionId: createId(),
          name: payload.name ?? "Terminal",
          backend: selectedBackend.backend,
          ...backendWarningProperties(selectedBackend),
          status: "active",
          envProfileId: payload.envProfileId,
          hostProfileId: payload.hostProfileId,
          hostLabel: payload.hostLabel ?? defaultHostLabel,
          projectId: payload.projectId,
          taskId: payload.taskId,
          cwd: payload.cwd,
          shell: payload.shell,
          createdAt: timestamp,
          lastActivityAt: timestamp
        })
      };
    },
    listSessions: () => ({
      ok: true,
      sessions: [...sessions.values()].sort((left, right) => left.createdAt.localeCompare(right.createdAt))
    }),
    getSession: (payload) => {
      const session = getExistingSession(payload.sessionId);
      if (!isTerminalSessionInfo(session)) return session;
      return { ok: true, session };
    },
    attachSession: (payload) => {
      const session = getExistingSession(payload.sessionId);
      if (!isTerminalSessionInfo(session)) return session;
      if (session.status === "exited") return failure("terminal_session_exited", "Reopen exited terminal sessions before attaching.");
      const attached = save({ ...session, status: "active", lastActivityAt: now() });
      return {
        ok: true,
        session: attached,
        policy: {
          displayOnly: true,
          outputCreatesTaskState: false,
          inputAccepted: true,
          replayMaxBytes: scrollback.replayMaxBytes
        }
      };
    },
    writeSession: (payload) => {
      if (typeof payload.data !== "string" || new TextEncoder().encode(payload.data).byteLength > 65_536) {
        return failure("invalid_terminal_input", "Terminal input must be a string no larger than 64 KiB.");
      }
      const session = getExistingSession(payload.sessionId);
      if (!isTerminalSessionInfo(session)) return session;
      if (session.status === "exited") return failure("terminal_session_exited", "Exited terminal sessions do not accept input.");
      return { ok: true, session: save({ ...session, status: "active", lastActivityAt: now() }) };
    },
    readSession: (payload) => {
      const session = getExistingSession(payload.sessionId);
      if (!isTerminalSessionInfo(session)) return session;
      const cursor = Number.isInteger(payload.cursor) && Number(payload.cursor) >= 0 ? Number(payload.cursor) : 0;
      return { ok: true, session, events: [], nextCursor: cursor, dropped: false };
    },
    resizeSession: (payload) => {
      if (!Number.isInteger(payload.columns) || payload.columns <= 0 || !Number.isInteger(payload.rows) || payload.rows <= 0) {
        return failure("invalid_terminal_size", "Terminal rows and columns must be positive integers.");
      }
      const session = getExistingSession(payload.sessionId);
      if (!isTerminalSessionInfo(session)) return session;
      if (session.status === "exited") return failure("terminal_session_exited", "Exited terminal sessions cannot be resized.");
      return { ok: true, session: save({ ...session, lastActivityAt: now() }) };
    },
    closeSession: (payload) => {
      const session = getExistingSession(payload.sessionId);
      if (!isTerminalSessionInfo(session)) return session;
      if (session.status === "exited") return { ok: true, session };
      return { ok: true, session: save({ ...session, status: "exited", lastActivityAt: now(), exitCode: session.exitCode ?? 0 }) };
    },
    detachSessionView: (payload) => {
      const session = getExistingSession(payload.sessionId);
      if (!isTerminalSessionInfo(session)) return session;
      if (session.status === "exited") return { ok: true, session };
      return { ok: true, session: save({ ...session, status: "idle", lastActivityAt: now() }) };
    },
    markSessionExited: (payload) => {
      const session = getExistingSession(payload.sessionId);
      if (!isTerminalSessionInfo(session)) return session;
      return {
        ok: true,
        session: save({ ...session, status: "exited", lastActivityAt: now(), exitCode: payload.exitCode })
      };
    }
  };
}

function failure(code: string, hint: string): TerminalSessionFailure {
  return { ok: false, error: { code, hint } };
}

function backendWarningProperties(
  selection: TerminalBackendSelectionSuccess
): Pick<TerminalSessionInfo, "backendWarnings"> {
  return selection.warnings.length > 0 ? { backendWarnings: selection.warnings } : {};
}

function isTerminalSessionInfo(value: TerminalSessionInfo | TerminalSessionFailure): value is TerminalSessionInfo {
  return !("ok" in value);
}

function randomSessionId(): string {
  return `term-${Math.random().toString(36).slice(2, 10)}`;
}
