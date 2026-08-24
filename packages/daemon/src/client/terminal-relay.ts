import process from "node:process";
import { consumeKnownError } from "../../../kernel/src/index.ts";
import type { JsonObject } from "../protocol/json-rpc-types.ts";
import { requestLocalDaemonJsonRpcForTarget } from "./local-json-rpc-client.ts";
import { streamDaemonFacetAt } from "./local-json-rpc-stream.ts";

// Interactive runtime sign-in runs on a daemon-owned PTY, never in this process, so the person
// at the keyboard is bridged to it: local keystrokes ride repo.terminal.input with a strictly
// serialized clientSeq (the host rejects gaps), PTY frames stream back through repo.terminal.attach,
// and the window size follows the operator's terminal. The relay moves bytes between two
// terminals only — credentials are typed by the person and land in the provider's isolated
// state root, never in argv, logs, or events.
type RelayStdin = NodeJS.ReadableStream & { readonly isTTY?: boolean; setRawMode?(mode: boolean): void };
export async function relayDaemonTerminal(input: {
  readonly socketPath: string;
  readonly repoId: string;
  readonly sessionId: string;
  readonly write: (text: string) => void;
  readonly stdin?: RelayStdin;
  readonly columns?: () => number;
  readonly rows?: () => number;
}): Promise<number> {
  const stdin = input.stdin ?? process.stdin,
    call = (method: string, payload: JsonObject, responseTimeoutMs?: number) =>
      requestLocalDaemonJsonRpcForTarget(
        { socketPath: input.socketPath },
        method,
        Object.keys(payload).length ? { repo: { repoId: input.repoId }, payload } : { repo: { repoId: input.repoId } },
        75,
        responseTimeoutMs,
      );
  let clientSeq = 0,
    queue: Promise<unknown> = Promise.resolve(),
    settled = false,
    resolveExit: ((code: number) => void) | null = null;
  const exited = new Promise<number>((resolve) => {
    resolveExit = resolve;
  });
  const sessionRow = async (): Promise<{ readonly status?: unknown; readonly exitCode?: unknown } | null> => {
    try {
      const listed = await call("repo.terminal.sessions.list", {}, 15_000);
      const row = Array.isArray(listed.sessions)
        ? (
            listed.sessions as readonly {
              readonly sessionId?: unknown;
              readonly status?: unknown;
              readonly exitCode?: unknown;
            }[]
          ).find((candidate) => candidate.sessionId === input.sessionId)
        : undefined;
      return row ?? null;
    } catch (error) {
      consumeKnownError(error);
      return null;
    }
  };
  const finish = (code: number) => {
    if (settled) return;
    settled = true;
    stdin.pause();
    stdin.off("data", onStdin);
    stdin.setRawMode?.(false);
    process.stdout.off("resize", onResize);
    detach();
    resolveExit?.(code);
  };
  const finishFromFrame = async () => {
    const row = await sessionRow();
    finish(typeof row?.exitCode === "number" ? row.exitCode : row === null ? 1 : 0);
  };
  const finishOnLostDaemon = async () => {
    if ((await sessionRow()) === null) finish(1);
  };
  const onStdin = (chunk: string | Buffer) => {
    const utf8 = Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk);
    if (!utf8) return;
    queue = queue
      .then(() => call("repo.terminal.input", { sessionId: input.sessionId, clientSeq: clientSeq + 1, utf8 }))
      .then(
        () => {
          clientSeq += 1;
        },
        () => {
          void finishOnLostDaemon();
        },
      );
  };
  const onResize = () => {
    void call("repo.terminal.resize", {
      sessionId: input.sessionId,
      cols: input.columns?.() ?? process.stdout.columns ?? 80,
      rows: input.rows?.() ?? process.stdout.rows ?? 24,
    }).catch((error) => consumeKnownError(error));
  };
  const detach = await streamDaemonFacetAt({
    socketPath: input.socketPath,
    repoId: input.repoId,
    method: "repo.terminal.attach",
    payload: { sessionId: input.sessionId, afterSeq: 0 },
    onValue: (value) => {
      const frame = value as { readonly kind?: unknown; readonly utf8?: unknown };
      if (frame.kind === "output" && typeof frame.utf8 === "string") input.write(frame.utf8);
      else if (frame.kind === "gap")
        input.write("\n[stream] some terminal output was dropped; scrollback is incomplete.\n");
      else if (frame.kind === "exit") void finishFromFrame();
    },
    timeoutMs: 2_000,
  });
  stdin.setRawMode?.(true);
  stdin.on("data", onStdin);
  stdin.resume();
  if (process.stdout.isTTY) process.stdout.on("resize", onResize);
  onResize();
  return exited;
}
