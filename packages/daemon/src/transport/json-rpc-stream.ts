import { randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";
import type { Readable, Writable } from "node:stream";
import type { AcceptedConnectionBinding } from "../protocol/connection-context.ts";
import type { JsonRpcProtocolServer } from "../protocol/json-rpc-server.ts";
import type {
  JsonRpcErrorResponse,
  JsonRpcId,
  JsonRpcNotification,
  JsonRpcRequest,
  JsonRpcResponse
} from "../protocol/json-rpc-types.ts";
import type {
  AcceptedConnectionEvidence,
  DaemonAuthenticationContext,
  DaemonTransportKind
} from "./auth-context.ts";
import { createJsonLineFrameReader, encodeJsonLineFrame, isJsonRpcRequestLike } from "./frame-codec.ts";
import {
  createDaemonRequestPerformanceTrace,
  runWithDaemonRequestPerformanceTrace,
  type DaemonRequestPerformanceOutcome,
  type DaemonRequestPerformanceTrace
} from "../observability/request-performance.ts";

export interface DaemonTransportConnection {
  readonly connectionId: string;
  readonly transportKind: DaemonTransportKind;
  readonly authContext: DaemonAuthenticationContext;
  readonly acceptedConnectionEvidence?: AcceptedConnectionEvidence;
  readonly isConnectionGenerationActive: () => boolean;
  readonly close: () => Promise<void>;
}

export interface TransportAuthenticationSuccess {
  readonly ok: true;
  readonly authContext?: DaemonAuthenticationContext;
  readonly forwardFrame?: boolean;
}

export interface TransportAuthenticationFailure {
  readonly ok: false;
  readonly code: string;
  readonly message: string;
}

export type TransportAuthenticationResult = TransportAuthenticationSuccess | TransportAuthenticationFailure;

export interface JsonRpcStreamOptions {
  readonly input: Readable;
  readonly output: Writable;
  readonly transportKind: DaemonTransportKind;
  readonly authContext: DaemonAuthenticationContext;
  readonly acceptedConnectionEvidence?: AcceptedConnectionEvidence;
  readonly createProtocolServer: (
    authContext: DaemonAuthenticationContext,
    acceptedConnection: AcceptedConnectionBinding | undefined,
    notificationSink: (notification: JsonRpcNotification) => void
  ) => JsonRpcProtocolServer;
  readonly authenticateFirstFrame?: (
    frame: unknown,
    authContext: DaemonAuthenticationContext
  ) => TransportAuthenticationResult;
  readonly connectionId?: string;
  readonly onError?: (error: Error) => void;
}

export function serveJsonRpcStream(options: JsonRpcStreamOptions): DaemonTransportConnection {
  const reader = createJsonLineFrameReader();
  const connectionId = options.connectionId ?? options.acceptedConnectionEvidence?.connectionId ?? randomUUID();
  assertEvidenceMatchesConnection(options.acceptedConnectionEvidence, connectionId, options.transportKind);
  let generationActive = true;
  const acceptedConnection = options.acceptedConnectionEvidence
    ? acceptedConnectionBinding(options.acceptedConnectionEvidence)
    : undefined;
  let authContext = options.authContext;
  let server = options.authenticateFirstFrame
    ? undefined
    : options.createProtocolServer(authContext, acceptedConnection, writeFrame);
  let waitingForAuthentication = options.authenticateFirstFrame !== undefined;
  let queue = Promise.resolve();
  let serverClosed = false;
  let inputEnded = false;
  let requestSequence = 0;
  const activeRequestFinishes = new Set<(outcome: DaemonRequestPerformanceOutcome) => void>();

  options.input.on("data", (chunk: Buffer | string) => {
    const batch = reader.push(chunk);
    enqueueFrames(batch.frames);
    if (batch.error) failConnection(parseError(batch.error));
  });
  options.input.on("end", () => {
    inputEnded = true;
    const batch = reader.flush();
    enqueueFrames(batch.frames);
    if (batch.error) failConnection(parseError(batch.error));
    queue = queue.then(closeProtocolServer);
  });
  options.input.on("error", (error: Error) => failConnection(error));
  options.input.once("close", () => {
    if (!inputEnded) finishActiveRequests("connection-closed");
    invalidateGeneration();
  });
  options.output.on("error", (error: Error) => {
    finishActiveRequests("response-write-error");
    options.onError?.(error);
  });
  options.output.once("close", () => finishActiveRequests("connection-closed"));
  options.input.resume();

  return {
    connectionId,
    transportKind: options.transportKind,
    get authContext() {
      return authContext;
    },
    ...(options.acceptedConnectionEvidence
      ? { acceptedConnectionEvidence: options.acceptedConnectionEvidence }
      : {}),
    isConnectionGenerationActive: () => generationActive,
    close: async () => {
      await queue;
      invalidateGeneration();
      await closeProtocolServer();
      options.input.destroy();
      options.output.end();
    }
  };

  function enqueueFrames(frames: ReadonlyArray<unknown>): void {
    const receivedAtMs = performance.now();
    for (const frame of frames) {
      queue = queue.then(() => handleFrame(frame, receivedAtMs)).catch((error: unknown) => {
        failConnection(error instanceof Error ? error : new Error(String(error)));
      });
    }
  }

  async function handleFrame(frame: unknown, receivedAtMs: number): Promise<void> {
    if (waitingForAuthentication) {
      const result = options.authenticateFirstFrame?.(frame, authContext);
      if (!result?.ok) {
        writeFrame(streamErrorResponse(null, -32001, result?.message ?? "Transport authentication failed."));
        options.output.end();
        return;
      }
      authContext = result.authContext ?? authContext;
      server = options.createProtocolServer(authContext, acceptedConnection, writeFrame);
      waitingForAuthentication = false;
      if (!result.forwardFrame) return;
    }

    if (!server || !isJsonRpcRequestLike(frame)) {
      writeFrame(streamErrorResponse(null, -32600, "Invalid Request"));
      return;
    }
    const request = frame as JsonRpcRequest | JsonRpcRequest[];
    const requests = Array.isArray(request) ? request : [request];
    const handled = await Promise.all(
      requests.map((item) => handleProtocolRequest(item, receivedAtMs, ++requestSequence))
    );
    const responseItems = handled.filter((item) => item.response !== undefined);
    for (const item of handled) {
      if (item.response === undefined) item.finish(item.outcome);
    }
    if (responseItems.length === 0) return;

    const endResponse = responseItems.map((item) => item.trace?.begin("response"));
    const responses = responseItems.flatMap((item) =>
      Array.isArray(item.response) ? item.response : [item.response!]
    );
    try {
      await writeResponseFrame(Array.isArray(request) ? responses : responseItems[0]!.response!);
      endResponse.forEach((end) => end?.());
      responseItems.forEach((item) => item.finish(item.outcome));
      try {
        server.afterResponse?.();
      } catch (error) {
        options.onError?.(error instanceof Error ? error : new Error(String(error)));
      }
    } catch (error) {
      endResponse.forEach((end) => end?.());
      responseItems.forEach((item) => item.finish("response-write-error"));
      options.onError?.(error instanceof Error ? error : new Error(String(error)));
    }
  }

  async function handleProtocolRequest(
    request: JsonRpcRequest,
    receivedAtMs: number,
    sequence: number
  ): Promise<{
    readonly response: JsonRpcResponse | JsonRpcResponse[] | undefined;
    readonly outcome: "response-written" | "handler-error";
    readonly trace: DaemonRequestPerformanceTrace | undefined;
    readonly finish: (outcome: DaemonRequestPerformanceOutcome) => void;
  }> {
    const trace = requestPerformanceTrace(request, receivedAtMs, connectionId, sequence);
    const eventLoopUtilizationBaseline = performance.eventLoopUtilization();
    let traceFinished = false;
    function finishTrace(outcome: DaemonRequestPerformanceOutcome): void {
      if (!trace || traceFinished) return;
      traceFinished = true;
      activeRequestFinishes.delete(finishTrace);
      const eventLoop = performance.eventLoopUtilization(eventLoopUtilizationBaseline);
      trace.finish(outcome, eventLoop.active, eventLoop.utilization);
    }
    if (trace) activeRequestFinishes.add(finishTrace);
    return runWithDaemonRequestPerformanceTrace(trace, async () => {
      const endHandler = trace?.begin("handler");
      try {
        const response = await server!.handle(request);
        endHandler?.();
        return { response, outcome: "response-written", trace, finish: finishTrace };
      } catch (error) {
        endHandler?.();
        options.onError?.(error instanceof Error ? error : new Error(String(error)));
        return {
          response: handlerErrorResponse(request, error),
          outcome: "handler-error",
          trace,
          finish: finishTrace
        };
      }
    });
  }

  function failConnection(error: Error): void {
    finishActiveRequests("connection-closed");
    invalidateGeneration();
    options.onError?.(error);
    writeFrame(streamErrorResponse(null, -32700, error.message));
    options.output.end();
    void closeProtocolServer();
  }

  async function closeProtocolServer(): Promise<void> {
    if (serverClosed) return;
    serverClosed = true;
    await server?.close?.();
  }

  function writeFrame(frame: unknown): void {
    options.output.write(encodeJsonLineFrame(frame));
  }

  function writeResponseFrame(frame: unknown): Promise<void> {
    return new Promise((resolve, reject) => {
      try {
        options.output.write(encodeJsonLineFrame(frame), (error: Error | null | undefined) => {
          if (error) reject(error);
          else resolve();
        });
      } catch (error) {
        reject(error);
      }
    });
  }

  function finishActiveRequests(outcome: DaemonRequestPerformanceOutcome): void {
    for (const finish of [...activeRequestFinishes]) finish(outcome);
  }

  function invalidateGeneration(): void {
    generationActive = false;
  }

  function acceptedConnectionBinding(evidence: AcceptedConnectionEvidence): AcceptedConnectionBinding {
    return Object.freeze({
      evidence,
      connectionId: evidence.connectionId,
      connectionGeneration: evidence.connectionGeneration,
      isActive: () => generationActive,
      assertActive: () => {
        if (!generationActive) throw new Error("accepted connection generation is closed");
      }
    });
  }
}

function requestPerformanceTrace(
  request: JsonRpcRequest,
  receivedAtMs: number,
  connectionId: string,
  sequence: number
): DaemonRequestPerformanceTrace | undefined {
  if (request.id === undefined || request.id === null) return undefined;
  const trace = createDaemonRequestPerformanceTrace({
    method: request.method,
    requestId: `${connectionId}\0${sequence}\0${String(request.id)}`,
    receivedAtMs
  });
  trace.record("transport-queue", performance.now() - receivedAtMs);
  return trace;
}

function assertEvidenceMatchesConnection(
  evidence: AcceptedConnectionEvidence | undefined,
  connectionId: string,
  transportKind: DaemonTransportKind
): void {
  if (!evidence) return;
  if (evidence.connectionId !== connectionId) {
    throw new Error("accepted connection evidence does not match the stream connection id");
  }
  if (evidence.transportKind !== transportKind) {
    throw new Error("accepted connection evidence does not match the stream transport kind");
  }
  if (evidence.channelBinding.digest.byteLength !== 32) {
    throw new Error("accepted connection channel digest must be 32 bytes");
  }
}

function parseError(error: Error): Error {
  return new Error(`Invalid JSON-RPC frame: ${error.message}`);
}

function streamErrorResponse(id: null, code: number, message: string): JsonRpcErrorResponse {
  return { jsonrpc: "2.0", id, error: { code, message } };
}

function handlerErrorResponse(
  request: JsonRpcRequest | JsonRpcRequest[],
  error: unknown
): JsonRpcErrorResponse | JsonRpcErrorResponse[] | undefined {
  const message = error instanceof Error ? error.message : String(error);
  if (!Array.isArray(request)) {
    return request.id === undefined ? undefined : internalErrorResponse(request.id, message);
  }
  const responses = request
    .filter((item) => item.id !== undefined)
    .map((item) => internalErrorResponse(item.id!, message));
  return responses.length > 0 ? responses : undefined;
}

function internalErrorResponse(id: JsonRpcId, message: string): JsonRpcErrorResponse {
  return { jsonrpc: "2.0", id, error: { code: -32603, message } };
}
