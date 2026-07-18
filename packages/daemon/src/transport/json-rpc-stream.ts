import { randomUUID } from "node:crypto";
import type { Readable, Writable } from "node:stream";
import type { AcceptedConnectionBinding } from "../protocol/connection-context.ts";
import type { JsonRpcProtocolServer } from "../protocol/json-rpc-server.ts";
import type { JsonRpcErrorResponse, JsonRpcId, JsonRpcNotification, JsonRpcRequest } from "../protocol/json-rpc-types.ts";
import type {
  AcceptedConnectionEvidence,
  DaemonAuthenticationContext,
  DaemonTransportKind
} from "./auth-context.ts";
import { createJsonLineFrameReader, encodeJsonLineFrame, isJsonRpcRequestLike } from "./frame-codec.ts";

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

  options.input.on("data", (chunk: Buffer | string) => {
    const batch = reader.push(chunk);
    enqueueFrames(batch.frames);
    if (batch.error) failConnection(parseError(batch.error));
  });
  options.input.on("end", () => {
    const batch = reader.flush();
    enqueueFrames(batch.frames);
    if (batch.error) failConnection(parseError(batch.error));
    queue = queue.then(closeProtocolServer);
  });
  options.input.on("error", (error: Error) => failConnection(error));
  options.input.once("close", invalidateGeneration);
  options.output.on("error", (error: Error) => options.onError?.(error));
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
    for (const frame of frames) {
      queue = queue.then(() => handleFrame(frame)).catch((error: unknown) => {
        failConnection(error instanceof Error ? error : new Error(String(error)));
      });
    }
  }

  async function handleFrame(frame: unknown): Promise<void> {
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
    try {
      const response = await server.handle(frame as JsonRpcRequest | JsonRpcRequest[]);
      if (response !== undefined) {
        writeFrame(response);
        server.afterResponse?.();
      }
    } catch (error) {
      options.onError?.(error instanceof Error ? error : new Error(String(error)));
      const response = handlerErrorResponse(frame as JsonRpcRequest | JsonRpcRequest[], error);
      if (response !== undefined) writeFrame(response);
    }
  }

  function failConnection(error: Error): void {
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
