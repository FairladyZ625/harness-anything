/**
 * Terminal bridge client — extracted from `api-client.ts` so that file stays
 * under the file-complexity cap. Holds the terminal payload/result types, the
 * terminal bridge methods, and their result readers. `api-client.ts`
 * composes `createTerminalClient(invokeBridge)` into `harnessClient`.
 *
 * Types mirror the owner-stripped TerminalSessionInfo DTO from the
 * daemon contract. Renderer must not invent PID, process owner, or secret fields.
 */

export type TerminalBackend = "direct-pty" | "tmux" | "remote";
export type TerminalSessionStatus = "active" | "idle" | "exited" | "unknown";
export type TerminalSessionDurability = "none" | "daemon-restart" | "remote-owned";

export interface TerminalBackendWarning {
  readonly code: "terminal_backend_downgraded_non_durable";
  readonly requestedBackend: TerminalBackend;
  readonly selectedBackend: TerminalBackend;
  readonly hint: string;
}

/** Owner-stripped session DTO safe for the renderer. */
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

export interface TerminalSessionIdPayload {
  readonly sessionId: string;
}

export interface TerminateTerminalSessionPayload extends TerminalSessionIdPayload {
  readonly confirmation: "terminate-terminal-session";
}

export interface WriteTerminalSessionPayload extends TerminalSessionIdPayload {
  readonly data: string;
}

export interface ReadTerminalSessionPayload extends TerminalSessionIdPayload {
  readonly cursor?: number;
  readonly timeoutMs?: number;
}

export interface ResizeTerminalSessionPayload extends TerminalSessionIdPayload {
  readonly columns: number;
  readonly rows: number;
}

export interface TerminalAttachPolicy {
  readonly displayOnly: true;
  readonly outputCreatesTaskState: false;
  readonly inputAccepted: true;
  readonly replayMaxBytes: number;
}

export interface TerminalAttachResult {
  readonly session: TerminalSessionInfo;
  readonly policy: TerminalAttachPolicy;
}

export interface TerminalOutputReadSuccess {
  readonly ok: true;
  readonly session: TerminalSessionInfo;
  readonly events: ReadonlyArray<
    | { readonly kind: "data"; readonly sequence: number; readonly data: string }
    | { readonly kind: "exit"; readonly sequence: number; readonly exitCode: number; readonly signal?: number }
  >;
  readonly nextCursor: number;
  readonly dropped: boolean;
}

export type TerminalBridgeMethod =
  | "terminalCreate"
  | "terminalList"
  | "terminalGet"
  | "terminalAttach"
  | "terminalDetach"
  | "terminalTerminate"
  | "terminalWrite"
  | "terminalRead"
  | "terminalResize"
  | "terminalExit";

/**
 * Narrowed invoke signature accepted by the terminal client. `api-client`'s
 * `invokeBridge` (typed over the full bridge-method union, a superset) is
 * assignable here by parameter contravariance once the terminal methods are
 * included in that union.
 */
export type TerminalBridgeInvoke = (method: TerminalBridgeMethod, payload: object | null) => Promise<unknown>;

export interface HarnessTerminalClient {
  createTerminal(payload: CreateTerminalSessionPayload): Promise<TerminalSessionInfo>;
  listTerminals(): Promise<ReadonlyArray<TerminalSessionInfo>>;
  getTerminal(payload: TerminalSessionIdPayload): Promise<TerminalSessionInfo>;
  attachTerminal(payload: TerminalSessionIdPayload): Promise<TerminalAttachResult>;
  detachTerminal(payload: TerminalSessionIdPayload): Promise<TerminalSessionInfo>;
  terminateTerminal(payload: TerminateTerminalSessionPayload): Promise<TerminalSessionInfo>;
  writeTerminal(payload: WriteTerminalSessionPayload): Promise<TerminalSessionInfo>;
  readTerminal(payload: ReadTerminalSessionPayload): Promise<TerminalOutputReadSuccess>;
  resizeTerminal(payload: ResizeTerminalSessionPayload): Promise<TerminalSessionInfo>;
  /** Legacy close/kill road — pane unmount must use detachTerminal instead. */
  exitTerminal(payload: TerminalSessionIdPayload): Promise<TerminalSessionInfo>;
}

/** Exact confirmation string required by terminalTerminate. */
export const TERMINATE_TERMINAL_SESSION_CONFIRMATION = "terminate-terminal-session" as const;

function readSessionShape(session: unknown): session is TerminalSessionInfo {
  if (!session || typeof session !== "object") return false;
  const value = session as Partial<TerminalSessionInfo>;
  return typeof value.sessionId === "string"
    && typeof value.name === "string"
    && typeof value.backend === "string"
    && typeof value.durability === "string"
    && typeof value.degraded === "boolean"
    && typeof value.status === "string"
    && typeof value.attachable === "boolean"
    && typeof value.hostLabel === "string"
    && typeof value.createdAt === "string";
}

function bridgeErrorHint(value: unknown, fallback: string): string {
  const result = value as { readonly error?: { readonly hint?: string } } | null;
  return result?.error?.hint ?? fallback;
}

function readTerminalSessionResult(value: unknown): TerminalSessionInfo {
  const result = value as { readonly ok?: boolean; readonly session?: unknown };
  if (result?.ok !== true || !readSessionShape(result.session)) {
    throw new Error(bridgeErrorHint(value, "Terminal bridge returned an invalid session result."));
  }
  return result.session;
}

function readTerminalListResult(value: unknown): ReadonlyArray<TerminalSessionInfo> {
  const result = value as { readonly ok?: boolean; readonly sessions?: unknown };
  if (result?.ok !== true || !Array.isArray(result.sessions)) {
    throw new Error(bridgeErrorHint(value, "Terminal list bridge returned an invalid result."));
  }
  const sessions = result.sessions.filter(readSessionShape);
  if (sessions.length !== result.sessions.length) {
    throw new Error("Terminal list bridge returned rows outside the owner-stripped session DTO.");
  }
  return sessions;
}

function readTerminalAttachResult(value: unknown): TerminalAttachResult {
  const result = value as {
    readonly ok?: boolean;
    readonly session?: unknown;
    readonly policy?: Partial<TerminalAttachPolicy>;
  };
  if (
    result?.ok !== true
    || !readSessionShape(result.session)
    || !result.policy
    || result.policy.displayOnly !== true
    || result.policy.outputCreatesTaskState !== false
    || result.policy.inputAccepted !== true
    || typeof result.policy.replayMaxBytes !== "number"
  ) {
    throw new Error(bridgeErrorHint(value, "Terminal attach bridge returned an invalid result."));
  }
  return {
    session: result.session,
    policy: {
      displayOnly: true,
      outputCreatesTaskState: false,
      inputAccepted: true,
      replayMaxBytes: result.policy.replayMaxBytes
    }
  };
}

export function createTerminalClient(invoke: TerminalBridgeInvoke): HarnessTerminalClient {
  return {
    async createTerminal(payload: CreateTerminalSessionPayload): Promise<TerminalSessionInfo> {
      return readTerminalSessionResult(await invoke("terminalCreate", payload));
    },
    async listTerminals(): Promise<ReadonlyArray<TerminalSessionInfo>> {
      return readTerminalListResult(await invoke("terminalList", null));
    },
    async getTerminal(payload: TerminalSessionIdPayload): Promise<TerminalSessionInfo> {
      return readTerminalSessionResult(await invoke("terminalGet", payload));
    },
    async attachTerminal(payload: TerminalSessionIdPayload): Promise<TerminalAttachResult> {
      return readTerminalAttachResult(await invoke("terminalAttach", payload));
    },
    async detachTerminal(payload: TerminalSessionIdPayload): Promise<TerminalSessionInfo> {
      return readTerminalSessionResult(await invoke("terminalDetach", payload));
    },
    async terminateTerminal(payload: TerminateTerminalSessionPayload): Promise<TerminalSessionInfo> {
      return readTerminalSessionResult(await invoke("terminalTerminate", payload));
    },
    async writeTerminal(payload: WriteTerminalSessionPayload): Promise<TerminalSessionInfo> {
      return readTerminalSessionResult(await invoke("terminalWrite", payload));
    },
    async readTerminal(payload: ReadTerminalSessionPayload): Promise<TerminalOutputReadSuccess> {
      const result = await invoke("terminalRead", payload) as Partial<TerminalOutputReadSuccess> & {
        readonly error?: { readonly hint?: string };
      };
      if (
        result?.ok !== true
        || !readSessionShape(result.session)
        || !Array.isArray(result.events)
        || typeof result.nextCursor !== "number"
        || typeof result.dropped !== "boolean"
      ) {
        throw new Error(result?.error?.hint ?? "Terminal output bridge returned an invalid result.");
      }
      return {
        ok: true,
        session: result.session,
        events: result.events,
        nextCursor: result.nextCursor,
        dropped: result.dropped
      };
    },
    async resizeTerminal(payload: ResizeTerminalSessionPayload): Promise<TerminalSessionInfo> {
      return readTerminalSessionResult(await invoke("terminalResize", payload));
    },
    async exitTerminal(payload: TerminalSessionIdPayload): Promise<TerminalSessionInfo> {
      return readTerminalSessionResult(await invoke("terminalExit", payload));
    }
  };
}
