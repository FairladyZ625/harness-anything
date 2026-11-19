import { daemonProtocolFleetPolicy } from "@harness-anything/kernel/internal/domain/cli-operational-policy.ts";
import {
  assertDaemonHello,
  daemonHelloParams,
  recoverableStreamUpgradeRequired,
  supportsRecoverableStreams,
} from "./daemon-hello.ts";
import { createInterface } from "node:readline";
import { daemonStreamFacetByMethod } from "../protocol/daemon-protocol-action-routes.ts";
import type { DaemonStreamMethod, DaemonStreamPayloadMap } from "../protocol/daemon-protocol.contract.ts";
import { parseDaemonStreamEnd, parseDaemonStreamEvent, parseDaemonStreamResult } from "../protocol/stream-contract.ts";
import { DaemonProtocolContractError, isJsonObject } from "../protocol/json-rpc-types.ts";
import { currentDaemonProtocolVersion } from "../protocol/version.ts";
import { consumeDaemonStream, streamInterrupted, type StreamPayload } from "../protocol/stream-client.ts";
import type { AgentRuntimeStreamValue } from "../protocol/stream-contract.ts";
import { createDaemonEndpointSocket, executionCredentialParams } from "./local-json-rpc-client.ts";

export interface DaemonStreamFailure {
  readonly code: string;
  readonly attempts: number;
  readonly lastError: string;
}
interface DaemonSocketStream {
  readonly socketPath: string;
  readonly repoId: string;
  readonly method: DaemonStreamMethod;
  readonly payload: StreamPayload;
  readonly onValue: (value: unknown) => void;
  readonly timeoutMs?: number;
  readonly invokingCommand?: string;
}

export function streamAgentRuntimeAt(
  input: Omit<Parameters<typeof streamDaemonFacetAt>[0], "method" | "payload" | "onValue"> & {
    readonly payload: DaemonStreamPayloadMap["repo.agentRuntime.attach"];
    readonly onValue: (value: AgentRuntimeStreamValue) => void;
  },
): Promise<() => void> {
  return streamDaemonFacetAt({
    ...input,
    method: "repo.agentRuntime.attach",
    onValue: (value) => input.onValue(value as AgentRuntimeStreamValue),
  });
}

export async function streamDaemonFacetAt(
  input: DaemonSocketStream & {
    readonly signal?: AbortSignal;
    readonly onClosed?: (failure: DaemonStreamFailure) => void;
  },
): Promise<() => void> {
  const controller = new AbortController(),
    signal = input.signal ? AbortSignal.any([controller.signal, input.signal]) : controller.signal,
    ready = Promise.withResolvers<void>();
  let opened = false;
  void consumeDaemonStream({
    ...input,
    signal,
    read: (payload, onValue, active) => readDaemonStreamAt({ ...input, payload, onValue, signal: active }),
    onValue: (value) => {
      input.onValue(value);
      opened = true;
      ready.resolve();
    },
  }).then(
    () => ready.resolve(),
    (error: unknown) => {
      if (!opened) return ready.reject(error);
      input.onClosed?.({
        code: error instanceof DaemonProtocolContractError ? error.code : "daemon_request_failed",
        attempts: isJsonObject(error) && typeof error.attempts === "number" ? error.attempts : 0,
        lastError: error instanceof Error ? error.message : String(error),
      });
    },
  );
  await ready.promise;
  return () => controller.abort();
}

/** One socket attempt. Only the final consumer owns cursor resume and the retry budget. */
export async function readDaemonStreamAt(
  input: Omit<DaemonSocketStream, "onValue"> & {
    readonly signal: AbortSignal;
    readonly onValue: (value: unknown) => void | Promise<void>;
  },
): Promise<void> {
  if (input.signal.aborted) return;
  const facet = daemonStreamFacetByMethod.get(input.method);
  if (!facet) throw new DaemonProtocolContractError("method_not_allowed", "Unknown daemon stream.");
  const socket = createDaemonEndpointSocket(input.socketPath),
    lines = createInterface({ input: socket });
  let handshaken = false,
    attached = false,
    failure: Error | undefined,
    watchdog: ReturnType<typeof setTimeout> | undefined;

  function abort(): void {
    lines.close();
    socket.destroy();
  }
  function armWatchdog(): void {
    clearTimeout(watchdog);
    watchdog = setTimeout(
      () => disconnect(new Error("Daemon did not answer the stream attach.")),
      input.timeoutMs ?? daemonProtocolFleetPolicy.defaultValue.client.streamSilenceMs,
    );
  }
  function send(id: number, method: string, params: unknown): void {
    socket.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
  }
  function disconnect(error: Error): void {
    failure = streamInterrupted(error.message);
    abort();
  }
  input.signal.addEventListener("abort", abort, { once: true });
  socket.once("error", disconnect);
  lines.on("error", disconnect);
  armWatchdog();
  socket.once("connect", () =>
    send(
      1,
      "protocol.hello",
      daemonHelloParams({
        protocolVersion: currentDaemonProtocolVersion,
        ...executionCredentialParams(),
        ...(input.invokingCommand ? { invokingCommand: input.invokingCommand } : {}),
      }),
    ),
  );
  try {
    for await (const line of lines) {
      if (input.signal.aborted) return;
      if (!attached) armWatchdog();
      const value: unknown = JSON.parse(line);
      if (!isJsonObject(value)) throw new DaemonProtocolContractError("invalid_result", "Invalid stream envelope.");
      if (isJsonObject(value.error))
        throw new DaemonProtocolContractError("invalid_result", String(value.error.message));
      if (value.id === 1) {
        assertDaemonHello(value.result);
        if (!supportsRecoverableStreams(value.result.protocolVersion)) throw recoverableStreamUpgradeRequired();
        handshaken = true;
        send(2, facet.method, { repo: { repoId: input.repoId }, payload: input.payload });
      } else if (value.id === 2 && handshaken) {
        if (isJsonObject(value.result) && value.result.ok === false && isJsonObject(value.result.error)) {
          const { code, hint } = value.result.error;
          throw new DaemonProtocolContractError(String(code), String(hint));
        }
        const receipt = parseDaemonStreamResult(input.method, value.result);
        await input.onValue(receipt);
        attached = receipt.ok === true;
        clearTimeout(watchdog);
        if (!attached) return;
      } else if (attached && value.method === facet.eventMethod) {
        await input.onValue(parseDaemonStreamEvent(input.method, value.params));
      } else if (attached && value.method === `${facet.eventMethod}.end`) {
        return parseDaemonStreamEnd(value.params);
      }
    }
    if (!input.signal.aborted) throw streamInterrupted("Daemon closed the stream connection.");
  } catch (error) {
    throw failure ?? error;
  } finally {
    clearTimeout(watchdog);
    input.signal.removeEventListener("abort", abort);
    lines.close();
    socket.destroy();
  }
}
