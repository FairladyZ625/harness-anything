import { randomUUID } from "node:crypto";
import type { Readable, Writable } from "node:stream";
import type { DaemonAuthenticationContext, DaemonTransportKind } from "./auth-context.ts";
import { createJsonLineFrameReader, encodeJsonLineFrame, isJsonRpcRequestLike } from "./frame-codec.ts";
import type { JsonRpcProtocolServer } from "../protocol/json-rpc-server.ts";
import type { JsonRpcErrorResponse, JsonRpcRequest } from "../protocol/json-rpc-types.ts";

export interface DaemonTransportConnection {
  readonly connectionId: string;
  readonly transportKind: DaemonTransportKind;
  readonly authContext: DaemonAuthenticationContext;
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
  readonly createProtocolServer: (authContext: DaemonAuthenticationContext) => JsonRpcProtocolServer;
  readonly authenticateFirstFrame?: (
    frame: unknown,
    authContext: DaemonAuthenticationContext
  ) => TransportAuthenticationResult;
  readonly connectionId?: string;
  readonly onError?: (error: Error) => void;
}

export function serveJsonRpcStream(options: JsonRpcStreamOptions): DaemonTransportConnection {
  const reader = createJsonLineFrameReader();
  const connectionId = options.connectionId ?? randomUUID();
  let authContext = options.authContext;
  let server = options.authenticateFirstFrame ? undefined : options.createProtocolServer(authContext);
  let waitingForAuthentication = options.authenticateFirstFrame !== undefined;
  let queue = Promise.resolve();

  options.input.on("data", (chunk: Buffer | string) => {
    const batch = reader.push(chunk);
    enqueueFrames(batch.frames);
    if (batch.error) failConnection(parseError(batch.error));
  });
  options.input.on("end", () => {
    const batch = reader.flush();
    enqueueFrames(batch.frames);
    if (batch.error) failConnection(parseError(batch.error));
  });
  options.input.on("error", (error: Error) => failConnection(error));
  options.output.on("error", (error: Error) => options.onError?.(error));

  return {
    connectionId,
    transportKind: options.transportKind,
    get authContext() {
      return authContext;
    },
    close: async () => {
      await queue;
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
      server = options.createProtocolServer(authContext);
      waitingForAuthentication = false;
      if (!result.forwardFrame) return;
    }

    if (!server || !isJsonRpcRequestLike(frame)) {
      writeFrame(streamErrorResponse(null, -32600, "Invalid Request"));
      return;
    }
    const response = await server.handle(frame as JsonRpcRequest | JsonRpcRequest[]);
    if (response !== undefined) writeFrame(response);
  }

  function failConnection(error: Error): void {
    options.onError?.(error);
    writeFrame(streamErrorResponse(null, -32700, error.message));
    options.output.end();
  }

  function writeFrame(frame: unknown): void {
    options.output.write(encodeJsonLineFrame(frame));
  }
}

function parseError(error: Error): Error {
  return new Error(`Invalid JSON-RPC frame: ${error.message}`);
}

function streamErrorResponse(id: null, code: number, message: string): JsonRpcErrorResponse {
  return { jsonrpc: "2.0", id, error: { code, message } };
}
