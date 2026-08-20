import type { TerminalControlReceipt, TerminalSessionRow } from "../../../daemon/src/gui-s3-control.ts";
import type { DaemonGuiStreamPayloadMap } from "../../../daemon/src/protocol/daemon-protocol.contract.ts";
import { isRendererRecord, rendererErrorHint } from "./result-validation.ts";
import type { TerminalStreamFrame } from "./terminal-model.ts";

export interface TerminalSessionList {
  readonly schema: "terminal-session-list/v1";
  readonly ok: true;
  readonly repoId: string;
  readonly daemonGeneration: number;
  readonly sessions: readonly TerminalSessionRow[];
}
export interface TerminalAttachInitial {
  readonly schema: "terminal-attach/v1";
  readonly ok: true;
  readonly sessionId: string;
  readonly attachmentId: string;
  readonly daemonGeneration: number;
  readonly status: "attached" | "gap";
  readonly replayFromSeq: number;
  readonly outputSeq: number;
}
export interface TerminalSpawnInput {
  readonly idempotencyKey: string;
  readonly name?: string;
  readonly cwd: { readonly scope: "repo-root" } | { readonly scope: "repo-relative"; readonly path: string };
  readonly shellProfileId?: string;
  readonly taskId?: string;
}

type RepoScope = { readonly repoId: string };
type TerminalBridge = {
  readonly listTerminalSessions: (payload: RepoScope) => Promise<unknown>;
  readonly spawnTerminal: (payload: RepoScope & TerminalSpawnInput) => Promise<unknown>;
  readonly attachTerminal: (payload: DaemonGuiStreamPayloadMap["repo.terminal.attach"] & RepoScope, onValue: (value: unknown) => void) => () => void;
  readonly sendTerminalInput: (payload: RepoScope & { readonly sessionId: string; readonly clientSeq: number; readonly utf8: string }) => Promise<unknown>;
  readonly resizeTerminal: (payload: RepoScope & { readonly sessionId: string; readonly cols: number; readonly rows: number }) => Promise<unknown>;
  readonly detachTerminal: (payload: RepoScope & { readonly sessionId: string; readonly attachmentId: string }) => Promise<unknown>;
  readonly terminateTerminal: (payload: RepoScope & { readonly sessionId: string; readonly confirmed: true }) => Promise<unknown>;
};

const bridge = (): TerminalBridge => {
  const value = window.harness as unknown as Partial<TerminalBridge> | undefined;
  const required = ["listTerminalSessions", "spawnTerminal", "attachTerminal", "sendTerminalInput", "resizeTerminal", "detachTerminal", "terminateTerminal"] as const;
  if (!value || required.some((method) => typeof value[method] !== "function")) throw new Error("Terminal contract bridge is unavailable.");
  return value as TerminalBridge;
};

export const terminalQueryKeys = { sessions: (repoId: string) => ["terminal", repoId, "sessions"] as const };
export const terminalClient = {
  list: async (repoId: string): Promise<TerminalSessionList> => sessionList(await bridge().listTerminalSessions({ repoId })),
  spawn: async (repoId: string, input: TerminalSpawnInput): Promise<TerminalControlReceipt> => control(await bridge().spawnTerminal({ repoId, ...input })),
  attach: (repoId: string, sessionId: string, afterSeq: number, onValue: (value: TerminalAttachInitial | TerminalStreamFrame) => void): (() => void) => bridge().attachTerminal({ repoId, sessionId, afterSeq }, (value) => onValue(attachValue(value))),
  input: async (repoId: string, sessionId: string, clientSeq: number, utf8: string): Promise<number> => {
    const result = await bridge().sendTerminalInput({ repoId, sessionId, clientSeq, utf8 });
    if (!isRendererRecord(result) || result.schema !== "terminal-input-ack/v1" || result.ok !== true || !Number.isSafeInteger(result.acceptedThrough)) throw new Error(rendererErrorHint(result, "Terminal input was not acknowledged."));
    return Number(result.acceptedThrough);
  },
  resize: async (repoId: string, sessionId: string, cols: number, rows: number): Promise<TerminalControlReceipt> => control(await bridge().resizeTerminal({ repoId, sessionId, cols, rows })),
  detach: async (repoId: string, sessionId: string, attachmentId: string): Promise<unknown> => {
    const result = await bridge().detachTerminal({ repoId, sessionId, attachmentId });
    if (!isRendererRecord(result) || result.schema !== "terminal-detach-ack/v1" || result.ok !== true || result.state !== "detached") throw new Error(rendererErrorHint(result, "Terminal detach was not acknowledged."));
    return result;
  },
  terminate: async (repoId: string, sessionId: string, confirmed: true): Promise<TerminalControlReceipt> => control(await bridge().terminateTerminal({ repoId, sessionId, confirmed }))
};

function sessionList(value: unknown): TerminalSessionList {
  if (!isRendererRecord(value) || value.schema !== "terminal-session-list/v1" || value.ok !== true || typeof value.repoId !== "string" || !Number.isSafeInteger(value.daemonGeneration) || !Array.isArray(value.sessions)) throw new Error(rendererErrorHint(value, "Terminal session list is invalid."));
  return value as unknown as TerminalSessionList;
}
function control(value: unknown): TerminalControlReceipt {
  if (!isRendererRecord(value) || value.schema !== "terminal-control-receipt/v1" || typeof value.operationId !== "string" || !["applied", "op_rejected"].includes(String(value.outcome))) throw new Error(rendererErrorHint(value, "Terminal control receipt is invalid."));
  return value as unknown as TerminalControlReceipt;
}
function attachValue(value: unknown): TerminalAttachInitial | TerminalStreamFrame {
  if (!isRendererRecord(value)) throw new Error("Terminal stream returned an invalid frame.");
  if (value.schema === "terminal-attach/v1" && value.ok === true && typeof value.attachmentId === "string" && Number.isSafeInteger(value.outputSeq)) return value as unknown as TerminalAttachInitial;
  if (value.schema === "terminal-attach-event/v1" && typeof value.sessionId === "string" && Number.isSafeInteger(value.seq) && ["output", "gap", "exit"].includes(String(value.kind))) return value as unknown as TerminalStreamFrame;
  throw new Error("Terminal stream returned an invalid frame.");
}
