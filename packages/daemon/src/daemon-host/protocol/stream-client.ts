import {
  daemonProtocolFleetPolicy,
  daemonRuntimePolicy,
} from "@harness-anything/kernel/internal/domain/cli-operational-policy.ts";
import { clientRetryDelay } from "./client-retry.ts";
import { DaemonProtocolContractError } from "./json-rpc-types.ts";
import type { DaemonStreamMethod, DaemonStreamPayloadMap } from "./daemon-protocol.contract.ts";
import {
  runtimeStreamKind,
  sameRuntimeStream,
  type AgentRuntimeAttachEvent,
  type AgentRuntimeAttachResult,
  type RuntimeStreamCursor,
} from "./stream-contract.ts";

export type StreamPayload = DaemonStreamPayloadMap[DaemonStreamMethod];
export type StreamReader = (
  payload: StreamPayload,
  receive: (value: unknown) => void,
  signal: AbortSignal,
) => Promise<void>;

const shutdownHandoffMs =
  daemonRuntimePolicy.defaultValue.daemon.shutdownDeadlineMs +
  daemonProtocolFleetPolicy.defaultValue.client.autostartReadyTimeoutMs;

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

function isStreamUnavailableCode(code: string): boolean {
  return (
    code === "daemon_stream_interrupted" ||
    code === "daemon_unavailable" ||
    code === "daemon_stopping" ||
    code === "remote_proxy_unavailable" ||
    code === "repo_warming" ||
    code === "repo_unavailable"
  );
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
    terminalGeneration = terminal?.daemonGeneration,
    attached = false,
    attempts = 0;
  let handoffUntil: number | undefined;
  while (!input.signal.aborted) {
    let initial = true;
    const payload = terminal
      ? {
          ...terminal,
          afterSeq: terminalSeq,
          ...(terminalGeneration === undefined ? {} : { daemonGeneration: terminalGeneration }),
        }
      : runtime && cursor
        ? { ...runtime, afterCursor: cursor }
        : input.payload;
    const outcome = await input
      .read(
        payload,
        (value) => {
          if (input.signal.aborted) return;
          if (terminal) {
            const frame = value as {
              readonly sessionId: string;
              readonly ok?: boolean;
              readonly seq: number;
              readonly daemonGeneration: number;
              readonly outputSeq: number;
            };
            if (frame.sessionId !== terminal.sessionId)
              throw new DaemonProtocolContractError("invalid_result", "Terminal stream returned a different session.");
            if (initial) {
              initial = false;
              if (frame.ok === true) {
                if (
                  (terminalGeneration !== undefined && terminalGeneration !== frame.daemonGeneration) ||
                  frame.outputSeq < terminalSeq
                )
                  terminalSeq = 0;
                terminalGeneration = frame.daemonGeneration;
                attached = true;
              }
            } else {
              if (frame.seq <= terminalSeq) return;
              terminalSeq = frame.seq;
              replenishRetries();
            }
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
            cursor ??= { ...result.cursor, seq: 0 };
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
    // Attach refusals from a draining daemon can persist through shutdown and successor startup.
    // The first stopping signal opens one bounded handoff window, including subsequent socket gaps.
    if (error.code === "daemon_stopping") handoffUntil ??= performance.now() + shutdownHandoffMs;
    const remaining = handoffUntil === undefined ? undefined : Math.ceil(handoffUntil - performance.now());
    const delay = clientRetryDelay(attempts, undefined, remaining);
    if (delay === null) throw new DaemonStreamLostError(error.message, attempts);
    attempts += 1;
    await (input.wait ?? waitForRetry)(delay, input.signal);
  }

  function replenishRetries(): void {
    attempts = 0;
    handoffUntil = undefined;
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
    if (frame.cursor.seq > 0 && (!cursor || !sameRuntimeStream(frame.cursor, cursor) || frame.cursor.seq > cursor.seq))
      replenishRetries();
    cursor = frame.cursor;
    return true;
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
