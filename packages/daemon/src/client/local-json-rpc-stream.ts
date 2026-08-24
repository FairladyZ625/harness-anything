import net from "node:net";
import { createInterface } from "node:readline";
import { consumeKnownError } from "../../../kernel/src/index.ts";
import type { AgentRuntimeAttachEvent, AgentRuntimeAttachResult } from "../agent-runtime-stream.ts";
import { daemonGuiStreamFacets, type DaemonGuiStreamPayloadMap } from "../protocol/daemon-protocol.contract.ts";
import { parseDaemonGuiStreamEvent, parseDaemonGuiStreamResult } from "../protocol/gui-result-validation.ts";
import { currentDaemonProtocolVersion } from "../protocol/version.ts";
export type AgentRuntimeStreamValue = AgentRuntimeAttachResult | AgentRuntimeAttachEvent;
// A stream that has attached once survives daemon unavailability by reconnecting — that is what
// lets panels ride out the GUI's own daemon-restart control — but the reconnect used to be 25/s
// forever with every failure swallowed, which turned a busy daemon into a connection storm that
// kept the daemon busy (#1654). Each unavailability episode now gets five attempts with doubling
// backoff; when the budget is spent the stream gives up and says so through onClosed instead of
// spinning invisibly. The silence deadline only runs before the first result and resets on every
// received line, so a slow attach is patience, not a kill: the old flat 200ms fired mid-handshake
// under load and fed the storm it was timing.
const reconnectBaseDelayMs = 250,
  reconnectMaxDelayMs = 5_000,
  reconnectAttemptLimit = 5,
  defaultSilenceMs = 10_000;
export interface DaemonStreamLost {
  readonly code: "daemon_stream_lost";
  readonly attempts: number;
  readonly lastError: string;
}
export async function streamAgentRuntimeAt(input: {
  readonly socketPath: string;
  readonly repoId: string;
  readonly payload: DaemonGuiStreamPayloadMap["repo.agentRuntime.attach"];
  readonly onValue: (value: AgentRuntimeStreamValue) => void;
  readonly timeoutMs?: number;
  readonly onClosed?: (failure: DaemonStreamLost) => void;
}): Promise<() => void> {
  return streamDaemonFacetAt({
    ...input,
    method: "repo.agentRuntime.attach",
    onValue: input.onValue as (value: unknown) => void,
  });
}
export async function streamDaemonFacetAt(input: {
  readonly socketPath: string;
  readonly repoId: string;
  readonly method: keyof DaemonGuiStreamPayloadMap;
  readonly payload: DaemonGuiStreamPayloadMap[keyof DaemonGuiStreamPayloadMap];
  readonly onValue: (value: unknown) => void;
  readonly timeoutMs?: number;
  readonly onClosed?: (failure: DaemonStreamLost) => void;
}): Promise<() => void> {
  let detached = false,
    everAttached = false,
    socket: net.Socket | undefined,
    retry: ReturnType<typeof setTimeout> | undefined,
    reconnects = 0,
    lastFailure = "socket closed",
    cursor: string | number =
      input.method === "repo.agentRuntime.attach"
        ? (input.payload as DaemonGuiStreamPayloadMap["repo.agentRuntime.attach"]).afterCursor
        : (input.payload as DaemonGuiStreamPayloadMap["repo.terminal.attach"]).afterSeq;
  const facet = daemonGuiStreamFacets.find((candidate) => candidate.method === input.method)!;
  const scheduleReconnect = (): void => {
    if (detached) return;
    if (reconnects >= reconnectAttemptLimit) {
      input.onClosed?.({ code: "daemon_stream_lost", attempts: reconnects, lastError: lastFailure });
      return;
    }
    const delayMs = Math.min(reconnectBaseDelayMs * 2 ** reconnects, reconnectMaxDelayMs);
    reconnects += 1;
    retry = setTimeout(() => {
      retry = undefined;
      void connect().catch(consumeKnownError);
    }, delayMs);
  };
  const connect = () =>
    new Promise<void>((resolve, reject) => {
      const next = net.createConnection(input.socketPath),
        lines = createInterface({ input: next });
      let watchdog: ReturnType<typeof setTimeout> | undefined;
      socket = next;
      let settled = false,
        supported = true;
      const armWatchdog = () => {
        clearTimeout(watchdog);
        watchdog = setTimeout(
          () => streamFail(new Error("daemon_stream_unavailable")),
          input.timeoutMs ?? defaultSilenceMs,
        );
      };
      armWatchdog();
      next.once("connect", () => {
        const payload =
          input.method === "repo.agentRuntime.attach"
            ? { ...(input.payload as object), afterCursor: cursor }
            : { ...(input.payload as object), afterSeq: cursor };
        next.write(
          `${JSON.stringify({
            jsonrpc: "2.0",
            id: 1,
            method: "protocol.hello",
            params: { protocolVersion: currentDaemonProtocolVersion },
          })}\n${JSON.stringify({
            jsonrpc: "2.0",
            id: 2,
            method: facet.method,
            params: { repo: { repoId: input.repoId }, payload },
          })}\n`,
        );
      });
      lines.on("line", (line) => {
        if (!settled) armWatchdog();
        try {
          const value = JSON.parse(line) as {
            readonly id?: number;
            readonly method?: string;
            readonly params?: unknown;
            readonly result?: unknown;
            readonly error?: { readonly message?: string };
          };
          if (value.id === 2) {
            if (value.error) throw new Error(value.error.message ?? "daemon stream failed");
            const initial = parseDaemonGuiStreamResult(input.method, value.result);
            input.onValue(initial);
            supported = initial.ok === true;
            if (initial.ok) {
              cursor =
                input.method === "repo.agentRuntime.attach"
                  ? (initial as AgentRuntimeAttachResult & { readonly cursor: string }).cursor
                  : Number((initial as Record<string, unknown>).outputSeq);
              everAttached = true;
              reconnects = 0;
            }
            settled = true;
            clearTimeout(watchdog);
            resolve();
            if (!supported) next.end();
          } else if (value.method === facet.eventMethod) {
            const event =
              input.method === "repo.agentRuntime.attach"
                ? parseDaemonGuiStreamEvent(value.params)
                : parseDaemonGuiStreamEvent(value.params, "repo.terminal.attach");
            cursor =
              input.method === "repo.agentRuntime.attach"
                ? (event as AgentRuntimeAttachEvent).cursor
                : Number((event as Record<string, unknown>).seq);
            input.onValue(event);
          }
        } catch (error) {
          consumeKnownError(error);
          streamFail(error instanceof Error ? error : new Error(String(error)));
        }
      });
      lines.on("error", consumeKnownError);
      next.once("error", streamFail);
      next.once("close", () => {
        lines.close();
        clearTimeout(watchdog);
        if (!settled && !everAttached) {
          reject(new Error("daemon stream closed before attach"));
          return;
        }
        if (!detached && supported && everAttached && input.method === "repo.agentRuntime.attach") scheduleReconnect();
      });
      function streamFail(error: Error): void {
        lastFailure = error.message;
        clearTimeout(watchdog);
        if (!settled) reject(error);
        next.destroy();
      }
    });
  await connect();
  return () => {
    if (detached) return;
    detached = true;
    if (retry) clearTimeout(retry);
    socket?.end();
  };
}
