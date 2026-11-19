import { daemonProtocolFleetPolicy } from "@harness-anything/kernel/internal/domain/cli-operational-policy.ts";
import { DaemonProtocolContractError } from "./json-rpc-types.ts";
import type { DaemonStreamMethod, DaemonStreamPayloadMap } from "./daemon-protocol.contract.ts";
import {
  runtimeStreamKind,
  sameRuntimeStream,
  type AgentRuntimeAttachEvent,
  type AgentRuntimeAttachResult,
  type RuntimeStreamCursor,
} from "./stream-contract.ts";

const { reconnectBaseDelayMs, reconnectMaxDelayMs, reconnectAttemptLimit } =
  daemonProtocolFleetPolicy.defaultValue.client;

export type StreamPayload = DaemonStreamPayloadMap[DaemonStreamMethod];
export type StreamReader = (
  payload: StreamPayload,
  receive: (value: unknown) => void,
  signal: AbortSignal,
) => Promise<void>;

export function streamInterrupted(message: string): Error {
  return new DaemonProtocolContractError("daemon_stream_interrupted", message);
}

class DaemonStreamLostError extends DaemonProtocolContractError {
  readonly attempts: number;

  constructor(message: string, attempts: number) {
    super("daemon_stream_lost", message);
    this.attempts = attempts;
  }
}

export function isStreamUnavailableCode(code: unknown): boolean {
  return (
    code === "daemon_stream_interrupted" ||
    code === "daemon_unavailable" ||
    code === "daemon_stopping" ||
    code === "remote_proxy_unavailable" ||
    code === "repo_warming" ||
    code === "repo_unavailable"
  );
}

export function streamRetryDelay(attempt: number, random = Math.random()): number | null {
  if (attempt >= reconnectAttemptLimit) return null;
  const ceiling = Math.min(reconnectMaxDelayMs, reconnectBaseDelayMs * 2 ** attempt);
  return Math.floor(ceiling * (0.5 + random * 0.5));
}

/** The socket, Electron and browser share one owner of the applied cursor and retry budget. */
export async function consumeDaemonStream(input: {
  readonly method: DaemonStreamMethod;
  readonly repoId: string;
  readonly payload: StreamPayload;
  readonly signal: AbortSignal;
  readonly read: StreamReader;
  readonly onValue: (value: unknown) => void;
  readonly wait?: (delay: number, signal: AbortSignal) => Promise<void>;
}): Promise<void> {
  const runtime = "runtimeSessionId" in input.payload ? input.payload : undefined,
    terminal = "afterSeq" in input.payload ? input.payload : undefined;
  let cursor = runtime?.afterCursor,
    terminalSeq = terminal?.afterSeq ?? 0,
    attached = false,
    attempts = 0;
  while (!input.signal.aborted) {
    let initial = true;
    const payload = terminal
      ? { ...terminal, afterSeq: terminalSeq }
      : runtime && cursor
        ? { ...runtime, afterCursor: cursor }
        : input.payload;
    const outcome = await input
      .read(
        payload,
        (value) => {
          if (input.signal.aborted) return;
          if (terminal) {
            const frame = value as { readonly sessionId: string; readonly ok?: boolean; readonly seq?: number };
            if (frame.sessionId !== terminal.sessionId)
              throw new DaemonProtocolContractError("invalid_result", "Terminal stream returned a different session.");
            if (initial) attached ||= frame.ok === true;
            else if (typeof frame.seq === "number" && frame.seq > terminalSeq) {
              // The attach head describes pending replay. Resume after the last applied frame.
              terminalSeq = frame.seq;
              attempts = 0;
            }
            initial = false;
            input.onValue(value);
            return;
          }
          if (initial) {
            initial = false;
            const result = value as AgentRuntimeAttachResult;
            if (runtime && result.runtimeSessionId !== runtime.runtimeSessionId)
              throw new DaemonProtocolContractError("invalid_result", "Runtime attach returned a different session.");
            if (!result.ok || !runtime) {
              input.onValue(value);
              return;
            }
            checkCursor(result.cursor, result.status === "gap");
            // A gap can move the sequence backwards (ahead cursor or a new epoch). Make it the
            // first applied frame before subsequent frames are compared with the snapshot sequence.
            const unseen = result.events.filter((frame) => accept(frame, result.status === "gap"));
            input.onValue({ ...result, events: unseen });
            attached = true;
            if (result.cursor.seq > (cursor?.seq ?? -1) || !cursor) advance(result.cursor);
            return;
          }
          if (!runtime) {
            input.onValue(value);
            return;
          }
          const frame = value as AgentRuntimeAttachEvent;
          if (frame.runtimeSessionId !== runtime.runtimeSessionId)
            throw new DaemonProtocolContractError("invalid_result", "Runtime stream returned a different session.");
          if (accept(frame, false)) input.onValue(frame);
        },
        input.signal,
      )
      .then(
        () => ({ ok: true as const }),
        (error: unknown) => ({ ok: false as const, error }),
      );
    if (outcome.ok || input.signal.aborted) return;
    const { error } = outcome;
    if (!attached || !(error instanceof DaemonProtocolContractError) || !isStreamUnavailableCode(error.code))
      throw error;
    const delay = streamRetryDelay(attempts);
    if (delay === null) throw new DaemonStreamLostError(error.message, attempts);
    attempts += 1;
    await (input.wait ?? waitForRetry)(delay, input.signal);
  }

  function checkCursor(next: RuntimeStreamCursor, reset: boolean): void {
    if (
      next.repoId !== input.repoId ||
      next.streamKind !== runtimeStreamKind ||
      (cursor && !reset && !sameRuntimeStream(next, cursor))
    )
      throw new DaemonProtocolContractError("invalid_result", "Runtime stream returned a different cursor scope.");
  }
  function accept(frame: AgentRuntimeAttachEvent, reset: boolean): boolean {
    checkCursor(frame.cursor, frame.type === "gap");
    if (!reset && cursor && sameRuntimeStream(frame.cursor, cursor) && frame.cursor.seq <= cursor.seq) return false;
    advance(frame.cursor);
    return true;
  }
  function advance(next: RuntimeStreamCursor): void {
    if (!cursor || !sameRuntimeStream(next, cursor) || next.seq > cursor.seq) attempts = 0;
    cursor = next;
  }
}

function waitForRetry(delay: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const timer = setTimeout(done, delay);
    signal.addEventListener("abort", done, { once: true });
    function done() {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolve();
    }
  });
}
