import type { TerminalControlReceipt, TerminalSessionRow } from "@harness-anything/daemon/protocol";
import type { DaemonStreamPayloadMap } from "@harness-anything/daemon/protocol";
import { isRendererRecord, rendererErrorHint } from "./result-validation.ts";
import type { TerminalStreamFrame } from "./terminal-model.ts";
import { invoke } from "./api-client-invoke.ts";
import { guiHostBridge } from "./gui-transport.ts";

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
  readonly backend: "direct-pty" | "tmux";
  readonly name?: string;
  readonly cwd: { readonly scope: "repo-root" } | { readonly scope: "repo-relative"; readonly path: string };
  readonly shellProfileId?: string;
  readonly taskId?: string;
}

type RepoScope = { readonly repoId: string };
type TerminalStreamBridge = {
  readonly attachTerminal: (
    payload: DaemonStreamPayloadMap["repo.terminal.attach"] & RepoScope,
    onValue: (value: unknown) => void,
  ) => () => void;
};

const streamBridge = (): TerminalStreamBridge => {
  const value = guiHostBridge() as unknown as Partial<TerminalStreamBridge> | undefined;
  if (!value || typeof value.attachTerminal !== "function") throw new Error("Terminal contract bridge is unavailable.");
  return value as TerminalStreamBridge;
};

export const terminalQueryKeys = { sessions: (repoId: string) => ["terminal", repoId, "sessions"] as const };
export const terminalClient = {
  list: async (repoId: string): Promise<TerminalSessionList> =>
    sessionList(await invoke("repo.terminal.sessions.list", { repoId }, "listTerminalSessions")),
  spawn: async (repoId: string, input: TerminalSpawnInput): Promise<TerminalControlReceipt> =>
    control(await invoke("repo.terminal.spawn", { repoId, ...input }, "spawnTerminal")),
  attach: (
    repoId: string,
    sessionId: string,
    afterSeq: number,
    onValue: (value: TerminalAttachInitial | TerminalStreamFrame) => void,
  ): (() => void) =>
    streamBridge().attachTerminal({ repoId, sessionId, afterSeq }, (value) => onValue(attachValue(value))),
  input: async (repoId: string, sessionId: string, clientSeq: number, utf8: string): Promise<number> => {
    const result: unknown = await invoke(
      "repo.terminal.input",
      { repoId, sessionId, clientSeq, utf8 } as { readonly repoId: string } & object,
      "sendTerminalInput",
    );
    if (
      !isRendererRecord(result) ||
      result.schema !== "terminal-input-ack/v1" ||
      result.ok !== true ||
      !Number.isSafeInteger(result.acceptedThrough)
    )
      throw new Error(rendererErrorHint(result, "Terminal input was not acknowledged."));
    return Number(result.acceptedThrough);
  },
  resize: async (repoId: string, sessionId: string, cols: number, rows: number): Promise<TerminalControlReceipt> =>
    control(
      await invoke(
        "repo.terminal.resize",
        { repoId, sessionId, cols, rows } as { readonly repoId: string } & object,
        "resizeTerminal",
      ),
    ),
  detach: async (repoId: string, sessionId: string, attachmentId: string): Promise<unknown> => {
    const result: unknown = await invoke(
      "repo.terminal.detach",
      { repoId, sessionId, attachmentId } as { readonly repoId: string } & object,
      "detachTerminal",
    );
    if (
      !isRendererRecord(result) ||
      result.schema !== "terminal-detach-ack/v1" ||
      result.ok !== true ||
      result.state !== "detached"
    )
      throw new Error(rendererErrorHint(result, "Terminal detach was not acknowledged."));
    return result;
  },
  terminate: async (repoId: string, sessionId: string, confirmed: true): Promise<TerminalControlReceipt> =>
    control(
      await invoke(
        "repo.terminal.terminate",
        { repoId, sessionId, confirmed } as { readonly repoId: string } & object,
        "terminateTerminal",
      ),
    ),
};

function sessionList(value: unknown): TerminalSessionList {
  if (
    !isRendererRecord(value) ||
    value.schema !== "terminal-session-list/v1" ||
    value.ok !== true ||
    typeof value.repoId !== "string" ||
    !Number.isSafeInteger(value.daemonGeneration) ||
    !Array.isArray(value.sessions)
  )
    throw new Error(rendererErrorHint(value, "Terminal session list is invalid."));
  return value as unknown as TerminalSessionList;
}
function control(value: unknown): TerminalControlReceipt {
  if (
    !isRendererRecord(value) ||
    value.schema !== "terminal-control-receipt/v1" ||
    typeof value.operationId !== "string" ||
    !["applied", "op_rejected"].includes(String(value.outcome))
  )
    throw new Error(rendererErrorHint(value, "Terminal control receipt is invalid."));
  return value as unknown as TerminalControlReceipt;
}
function attachValue(value: unknown): TerminalAttachInitial | TerminalStreamFrame {
  if (!isRendererRecord(value)) throw new Error("Terminal stream returned an invalid frame.");
  if (
    value.schema === "terminal-attach/v1" &&
    value.ok === true &&
    typeof value.attachmentId === "string" &&
    Number.isSafeInteger(value.outputSeq)
  )
    return value as unknown as TerminalAttachInitial;
  if (
    value.schema === "terminal-attach-event/v1" &&
    typeof value.sessionId === "string" &&
    Number.isSafeInteger(value.seq) &&
    ["output", "gap", "exit"].includes(String(value.kind))
  )
    return value as unknown as TerminalStreamFrame;
  throw new Error("Terminal stream returned an invalid frame.");
}
