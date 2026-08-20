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
  readonly createProtocolServer: (authContext: DaemonAuthenticationContext, emit: (method: string, params: Record<string, unknown>) => Promise<void>, connectionId: string) => JsonRpcProtocolServer;
  readonly authenticateFirstFrame?: (
    frame: unknown,
    authContext: DaemonAuthenticationContext
  ) => TransportAuthenticationResult;
  readonly connectionId?: string;
  readonly onError?: (error: Error) => void;
}

// A stopping daemon gives an in-flight request this long to reply before the
// stream is torn down: long enough for a normal write to finish, short enough
// that one stuck request cannot hold shutdown open.
const shutdownDrainMs = 5_000;

function shutdownDrainDeadline(): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, shutdownDrainMs);
    timer.unref?.();
  });
}

export function serveJsonRpcStream(options: JsonRpcStreamOptions): DaemonTransportConnection {
  const reader = createJsonLineFrameReader();
  const connectionId = options.connectionId ?? randomUUID();
  let authContext = options.authContext;
  let server = options.authenticateFirstFrame ? undefined : options.createProtocolServer(authContext, emit, connectionId);
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
    if (batch.error) failConnection(parseError(batch.error)); else queue = queue.finally(() => server?.close());
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
      // Shutdown is a force-close boundary, but a request already executing
      // still has to get its reply: the daemon stops the transport before the
      // host, so a request abandoned here can land its write with no receipt.
      // Detaching the protocol server settles subscriptions, which never drain
      // on their own; the deadline bounds whatever is still running.
      const deadline = shutdownDrainDeadline();
      server?.close();
      await Promise.race([queue, deadline]);
      // A reply the queue just produced can still sit in the socket buffer, and
      // destroy() discards buffered bytes -- flush before tearing the stream
      // down. Both waits share the one deadline, so stop stays bounded.
      if (!options.output.writableFinished && !options.output.destroyed) {
        options.output.end();
        await Promise.race([new Promise<void>((resolve) => options.output.once("finish", resolve)), deadline]);
      }
      options.input.destroy();
      options.output.destroy();
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
      server = options.createProtocolServer(authContext, emit, connectionId);
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

  function writeFrame(frame: unknown): boolean { return options.output.write(encodeJsonLineFrame(frame)); }
  async function emit(method: string, params: Record<string, unknown>): Promise<void> { if (writeFrame({ jsonrpc: "2.0", method, params })) return; await writableReady(options.output); }
}
function writableReady(output: Writable): Promise<void> { return new Promise((resolve) => { const done = () => { output.off("drain", done); output.off("close", done); resolve(); }; output.once("drain", done); output.once("close", done); }); }

function parseError(error: Error): Error {
  return new Error(`Invalid JSON-RPC frame: ${error.message}`);
}

function streamErrorResponse(id: null, code: number, message: string): JsonRpcErrorResponse {
  return { jsonrpc: "2.0", id, error: { code, message } };
}
