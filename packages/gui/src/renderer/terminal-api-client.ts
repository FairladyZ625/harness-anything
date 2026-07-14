/**
 * Terminal bridge client — extracted from `api-client.ts` so that file stays
 * under the file-complexity cap. Holds the terminal payload/result types, the
 * five terminal bridge methods, and their result readers. `api-client.ts`
 * composes `createTerminalClient(invokeBridge)` into `harnessClient`.
 */

export interface CreateTerminalSessionPayload {
  readonly name?: string;
  readonly backend?: "direct-pty";
  readonly projectId?: string;
}

export interface TerminalSessionIdPayload {
  readonly sessionId: string;
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

export interface TerminalSessionInfo {
  readonly sessionId: string;
  readonly name: string;
  readonly status: "active" | "idle" | "exited";
  readonly cwd?: string;
  readonly shell?: string;
  readonly exitCode?: number;
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

type TerminalBridgeMethod =
  | "terminalCreate"
  | "terminalWrite"
  | "terminalRead"
  | "terminalResize"
  | "terminalExit";

/**
 * Narrowed invoke signature accepted by the terminal client. `api-client`'s
 * `invokeBridge` (typed over the full bridge-method union, a superset) is
 * assignable here by parameter contravariance.
 */
export type TerminalBridgeInvoke = (method: TerminalBridgeMethod, payload: object | null) => Promise<unknown>;

export interface HarnessTerminalClient {
  createTerminal(payload: CreateTerminalSessionPayload): Promise<TerminalSessionInfo>;
  writeTerminal(payload: WriteTerminalSessionPayload): Promise<TerminalSessionInfo>;
  readTerminal(payload: ReadTerminalSessionPayload): Promise<TerminalOutputReadSuccess>;
  resizeTerminal(payload: ResizeTerminalSessionPayload): Promise<TerminalSessionInfo>;
  exitTerminal(payload: TerminalSessionIdPayload): Promise<TerminalSessionInfo>;
}

function readTerminalSessionResult(value: unknown): TerminalSessionInfo {
  const result = value as { readonly ok?: boolean; readonly session?: TerminalSessionInfo; readonly error?: { readonly hint?: string } };
  if (result?.ok !== true || !result.session || typeof result.session.sessionId !== "string") {
    throw new Error(result?.error?.hint ?? "Terminal bridge returned an invalid session result.");
  }
  return result.session;
}

export function createTerminalClient(invoke: TerminalBridgeInvoke): HarnessTerminalClient {
  return {
    async createTerminal(payload: CreateTerminalSessionPayload): Promise<TerminalSessionInfo> {
      return readTerminalSessionResult(await invoke("terminalCreate", payload));
    },
    async writeTerminal(payload: WriteTerminalSessionPayload): Promise<TerminalSessionInfo> {
      return readTerminalSessionResult(await invoke("terminalWrite", payload));
    },
    async readTerminal(payload: ReadTerminalSessionPayload): Promise<TerminalOutputReadSuccess> {
      const result = await invoke("terminalRead", payload) as Partial<TerminalOutputReadSuccess> & {
        readonly error?: { readonly hint?: string };
      };
      if (
        result?.ok !== true || !result.session || !Array.isArray(result.events) ||
        typeof result.nextCursor !== "number" || typeof result.dropped !== "boolean"
      ) throw new Error(result?.error?.hint ?? "Terminal output bridge returned an invalid result.");
      return result as TerminalOutputReadSuccess;
    },
    async resizeTerminal(payload: ResizeTerminalSessionPayload): Promise<TerminalSessionInfo> {
      return readTerminalSessionResult(await invoke("terminalResize", payload));
    },
    async exitTerminal(payload: TerminalSessionIdPayload): Promise<TerminalSessionInfo> {
      return readTerminalSessionResult(await invoke("terminalExit", payload));
    }
  };
}
