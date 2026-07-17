import {
  directPtyCapability,
  selectTerminalBackend,
  type TerminalBackendCapability,
  type TerminalBackendSelectionSuccess
} from "./backend-policy.ts";
import type {
  ScrollbackConfig,
  TerminalBackend,
  TerminalSessionDetailResult,
  TerminalSessionFailure,
  TerminalSessionIdPayload,
  TerminalSessionInfo,
  TerminalSessionService,
  TerminateTerminalSessionPayload
} from "../../../application/src/terminal-session-contract.ts";
export type * from "../../../application/src/terminal-session-contract.ts";

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
  readonly initialSessions?: ReadonlyArray<TerminalSessionInfo>;
  readonly onChange?: (sessions: ReadonlyArray<TerminalSessionInfo>) => void;
}

const defaultScrollback: ScrollbackConfig = {
  maxBytes: 1_048_576,
  replayMaxBytes: 262_144,
  eviction: "drop-oldest"
};

export function createInMemoryTerminalSessionService(options: TerminalSessionRegistryOptions = {}): InMemoryTerminalSessionService {
  const sessions = new Map((options.initialSessions ?? []).map((session) => [session.sessionId, session]));
  const createId = options.createId ?? randomSessionId;
  const now = options.now ?? (() => new Date().toISOString());
  const defaultBackend = options.defaultBackend ?? "direct-pty";
  const backendCapabilities = options.backendCapabilities ?? [directPtyCapability()];
  const defaultHostLabel = options.defaultHostLabel ?? "local";
  const scrollback = options.scrollback ?? defaultScrollback;

  function getExistingSession(sessionId: string): TerminalSessionInfo | TerminalSessionFailure {
    const session = sessions.get(sessionId);
    if (!session) return sessionFailure("terminal_session_not_found", `Terminal session not found: ${sessionId}`);
    return session;
  }

  function saveSession(session: TerminalSessionInfo): TerminalSessionInfo {
    sessions.set(session.sessionId, session);
    options.onChange?.([...sessions.values()]);
    return session;
  }

  function selectBackend(requestedBackend?: TerminalBackend): TerminalBackendSelectionSuccess | TerminalSessionFailure {
    const selection = selectTerminalBackend({
      requestedBackend,
      defaultBackend,
      capabilities: backendCapabilities,
      allowDirectPtyFallback: options.allowDirectPtyFallback
    });
    if (!selection.ok) return sessionFailure(selection.error.code, selection.error.hint);
    return selection;
  }

  return {
    createSession: (payload) => {
      const timestamp = now();
      if (payload.reopenOfSessionId) {
        const source = getExistingSession(payload.reopenOfSessionId);
        if (!isTerminalSessionInfo(source)) return source;
        if (!registrySessionHasExited(source)) {
          return sessionFailure("terminal_session_not_exited", "Only exited terminal sessions can be reopened.");
        }
        const selectedBackend = selectBackend(payload.backend ?? source.backend);
        if (!selectedBackend.ok) return selectedBackend;
        return {
          ok: true,
          session: saveSession({
            sessionId: createId(),
            name: payload.name ?? source.name,
            backend: selectedBackend.backend,
            durability: selectedBackend.capability.durability,
            degraded: selectedBackend.warnings.length > 0,
            ...backendWarningProperties(selectedBackend),
            envProfileId: payload.envProfileId ?? source.envProfileId,
            hostProfileId: payload.hostProfileId ?? source.hostProfileId,
            hostLabel: payload.hostLabel ?? source.hostLabel,
            projectId: payload.projectId ?? source.projectId,
            taskId: payload.taskId ?? source.taskId,
            cwd: payload.cwd ?? source.cwd,
            shell: payload.shell ?? source.shell,
            status: "active",
            attachable: true,
            createdAt: timestamp,
            lastActivityAt: timestamp
          })
        };
      }

      const selectedBackend = selectBackend(payload.backend);
      if (!selectedBackend.ok) return selectedBackend;
      return {
        ok: true,
        session: saveSession({
          sessionId: createId(),
          name: payload.name ?? "Terminal",
          backend: selectedBackend.backend,
          durability: selectedBackend.capability.durability,
          degraded: selectedBackend.warnings.length > 0,
          ...backendWarningProperties(selectedBackend),
          status: "active",
          attachable: true,
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
      if (registrySessionHasExited(session)) return sessionFailure("terminal_session_exited", "Reopen exited terminal sessions before attaching.");
      if (!session.attachable || registrySessionStatusIsUnknown(session)) {
        return sessionFailure("terminal_session_not_attachable", "The daemon cannot prove a live attach channel for this session.");
      }
      const attached = saveSession({ ...session, status: "active", lastActivityAt: now() });
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
        return sessionFailure("invalid_terminal_input", "Terminal input must be a string no larger than 64 KiB.");
      }
      const session = getExistingSession(payload.sessionId);
      if (!isTerminalSessionInfo(session)) return session;
      if (registrySessionHasExited(session)) return sessionFailure("terminal_session_exited", "Exited terminal sessions do not accept input.");
      return { ok: true, session: saveSession({ ...session, status: "active", lastActivityAt: now() }) };
    },
    readSession: (payload) => {
      const session = getExistingSession(payload.sessionId);
      if (!isTerminalSessionInfo(session)) return session;
      const cursor = Number.isInteger(payload.cursor) && Number(payload.cursor) >= 0 ? Number(payload.cursor) : 0;
      return { ok: true, session, events: [], nextCursor: cursor, dropped: false };
    },
    resizeSession: (payload) => {
      if (!Number.isInteger(payload.columns) || payload.columns <= 0 || !Number.isInteger(payload.rows) || payload.rows <= 0) {
        return sessionFailure("invalid_terminal_size", "Terminal rows and columns must be positive integers.");
      }
      const session = getExistingSession(payload.sessionId);
      if (!isTerminalSessionInfo(session)) return session;
      if (registrySessionHasExited(session)) return sessionFailure("terminal_session_exited", "Exited terminal sessions cannot be resized.");
      return { ok: true, session: saveSession({ ...session, lastActivityAt: now() }) };
    },
    detachSession: (payload) => {
      const session = getExistingSession(payload.sessionId);
      if (!isTerminalSessionInfo(session)) return session;
      if (registrySessionHasExited(session)) return { ok: true, session };
      return { ok: true, session: saveSession({ ...session, status: "idle", lastActivityAt: now() }) };
    },
    terminateSession: (payload: TerminateTerminalSessionPayload) => {
      if (payload.confirmation !== "terminate-terminal-session") {
        return sessionFailure("terminal_termination_confirmation_required", "Set confirmation to terminate-terminal-session before terminating the process.");
      }
      const session = getExistingSession(payload.sessionId);
      if (!isTerminalSessionInfo(session)) return session;
      if (registrySessionHasExited(session)) return { ok: true, session };
      return { ok: true, session: saveSession({ ...session, status: "exited", attachable: false, lastActivityAt: now(), exitCode: session.exitCode ?? 0 }) };
    },
    closeSession: (payload) => {
      const session = getExistingSession(payload.sessionId);
      if (!isTerminalSessionInfo(session)) return session;
      if (registrySessionHasExited(session)) return { ok: true, session };
      return { ok: true, session: saveSession({ ...session, status: "exited", attachable: false, lastActivityAt: now(), exitCode: session.exitCode ?? 0 }) };
    },
    detachSessionView: (payload) => {
      const session = getExistingSession(payload.sessionId);
      if (!isTerminalSessionInfo(session)) return session;
      if (registrySessionHasExited(session)) return { ok: true, session };
      return { ok: true, session: saveSession({ ...session, status: "idle", lastActivityAt: now() }) };
    },
    markSessionExited: (payload) => {
      const session = getExistingSession(payload.sessionId);
      if (!isTerminalSessionInfo(session)) return session;
      return {
        ok: true,
        session: saveSession({ ...session, status: "exited", attachable: false, lastActivityAt: now(), exitCode: payload.exitCode })
      };
    }
  };
}

function sessionFailure(code: string, hint: string): TerminalSessionFailure {
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

function registrySessionHasExited(session: TerminalSessionInfo): boolean {
  return session.status === "exited";
}

function registrySessionStatusIsUnknown(session: TerminalSessionInfo): boolean {
  return session.status === "unknown";
}

function randomSessionId(): string {
  return `term-${Math.random().toString(36).slice(2, 10)}`;
}
