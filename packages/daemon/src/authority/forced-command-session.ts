import type { Readable, Writable } from "node:stream";
import {
  decodeActorAxesBindingV2,
  type AuthoritySubmissionService,
  type ReplicaChangeLog
} from "../../../application/src/index.ts";
import {
  authorityWireFrameType,
  isAuthorityRequestFrame,
  sameAuthorityProtocol,
  type AuthorityNegotiatedProtocol,
  type AuthorityResponseFrame,
  type AuthorityServerFrame
} from "./protocol.ts";
import {
  createLengthPrefixedFrameReader,
  defaultAuthorityMaxFrameBytes,
  encodeLengthPrefixedFrame
} from "../transport/length-frame-codec.ts";

export interface AuthorityTransportObserver {
  readonly observe: (event: {
    readonly kind: "connected" | "request" | "committed" | "rejected" | "closed";
    readonly connectionGeneration: number;
    readonly requestId?: string;
    readonly opId?: string;
    readonly revision?: number;
    readonly queueDepth: number;
  }) => void;
}

export interface AuthorityForcedCommandOptions {
  readonly input: Readable;
  readonly output: Writable;
  readonly workspaceId: string;
  readonly protocol: AuthorityNegotiatedProtocol;
  readonly submissionService: AuthoritySubmissionService;
  readonly replicaChangeLog: ReplicaChangeLog;
  readonly maxFrameBytes?: number;
  readonly maxQueuedFrames?: number;
  readonly observer?: AuthorityTransportObserver;
}

export interface AuthorityForcedCommandSession {
  readonly close: () => Promise<void>;
}

export function serveAuthorityForcedCommand(options: AuthorityForcedCommandOptions): AuthorityForcedCommandSession {
  const maxFrameBytes = options.maxFrameBytes ?? defaultAuthorityMaxFrameBytes;
  const maxQueuedFrames = options.maxQueuedFrames ?? 1024;
  const reader = createLengthPrefixedFrameReader(maxFrameBytes);
  let handshaken = false;
  let generation = 0;
  let negotiatedChannelNonceDigest: string | undefined;
  let negotiatedV2 = false;
  let queueDepth = 0;
  let closed = false;
  let queue = Promise.resolve();

  options.input.on("data", (chunk: Buffer) => {
    const batch = reader.push(chunk);
    for (const frame of batch.frames) enqueue(frame);
    if (batch.error) closeWithError("INVALID_FRAME", batch.error.message);
  });
  options.input.on("end", () => {
    const batch = reader.flush();
    if (batch.error) closeWithError("INVALID_FRAME", batch.error.message);
  });
  options.input.on("error", (error: Error) => closeWithError("INPUT_ERROR", error.message));

  return {
    close: async () => {
      closed = true;
      await queue;
      options.input.destroy();
      options.output.end();
      options.observer?.observe({ kind: "closed", connectionGeneration: generation, queueDepth });
    }
  };

  function enqueue(value: unknown): void {
    if (closed) return;
    if (queueDepth >= maxQueuedFrames) {
      void streamClose("BACKPRESSURE", "authority input queue exceeded its configured bound");
      return;
    }
    queueDepth += 1;
    queue = queue.then(() => handle(value)).catch((error: unknown) => {
      closeWithError("SERVER_ERROR", error instanceof Error ? error.message : String(error));
    }).finally(() => {
      queueDepth -= 1;
    });
  }

  async function handle(value: unknown): Promise<void> {
    if (!isAuthorityRequestFrame(value)) {
      write(response("invalid", generation, false, undefined, "INVALID_REQUEST", "Invalid authority request frame."));
      return;
    }
    if (value.kind === "hello") {
      if (handshaken) {
        write(response(value.requestId, generation, false, undefined, "HELLO_ALREADY_COMPLETED", "A connection protocol tuple is immutable."));
        return;
      }
      generation = value.connectionGeneration;
      if (value.workspaceId !== options.workspaceId || !sameAuthorityProtocol(value.protocol, options.protocol)) {
        write(response(value.requestId, generation, false, undefined, "UPGRADE_REQUIRED", "Workspace or protocol tuple is not supported."));
        await streamClose("UPGRADE_REQUIRED", "Reconnect with the exact supported protocol tuple.");
        return;
      }
      handshaken = true;
      negotiatedChannelNonceDigest = value.channelNonceDigest;
      negotiatedV2 = "policy" in value.protocol;
      write(response(value.requestId, generation, true, {
        accepted: true,
        protocol: options.protocol,
        capabilities: [
          "single-writer",
          "op-id-dedupe",
          "replica-change/v1",
          "view-scoped-delegation-token",
          ...(negotiatedV2 ? ["actor-axes-binding/v2", "semantic-mutation-envelope/v2"] : [])
        ]
      }));
      options.observer?.observe({ kind: "connected", connectionGeneration: generation, requestId: value.requestId, queueDepth });
      return;
    }
    if (!handshaken) {
      write(response(value.requestId, value.connectionGeneration, false, undefined, "HELLO_REQUIRED", "Negotiate the protocol before semantic requests."));
      return;
    }
    if (value.connectionGeneration !== generation) return;
    options.observer?.observe({ kind: "request", connectionGeneration: generation, requestId: value.requestId, opId: value.kind === "submit" ? value.envelope.opId : undefined, queueDepth });
    if (value.kind === "get_operation") {
      if (negotiatedV2) {
        write(response(value.requestId, generation, false, undefined, "AUTHORIZATION_REQUIRED", "V2 outcome queries require a current coarse-authority presentation."));
        return;
      }
      const record = await options.submissionService.getOperation(value.workspaceId, value.opId);
      write(response(value.requestId, generation, true, record ?? null));
      return;
    }
    if (value.kind === "submit_v2") {
      if (!negotiatedV2) {
        write(response(value.requestId, generation, false, undefined, "UPGRADE_REQUIRED", "submit_v2 requires the exact V2 protocol tuple."));
        return;
      }
      if (!options.submissionService.submitV2) {
        write(response(value.requestId, generation, false, undefined, "UPGRADE_REQUIRED", "V2 authority submission is not enabled for this negotiated tuple."));
        return;
      }
      try {
        const presentationToken = decodeBase64Url(value.presentationToken);
        const tokenChannel = Buffer.from(decodeActorAxesBindingV2(presentationToken).claims.channelNonceDigest).toString("hex");
        if (tokenChannel !== negotiatedChannelNonceDigest) {
          write(response(value.requestId, generation, false, undefined, "CHANNEL_BINDING_MISMATCH", "V2 token is not bound to this connection generation."));
          return;
        }
        const receipt = await options.submissionService.submitV2({
          requestId: value.requestId,
          presentationToken,
          envelope: decodeBase64Url(value.envelope)
        });
        write(response(value.requestId, generation, true, receipt));
        options.observer?.observe({
          kind: receipt.tag === "COMMITTED" ? "committed" : "rejected",
          connectionGeneration: generation,
          requestId: value.requestId,
          opId: receipt.opId,
          ...(receipt.tag === "COMMITTED" ? { revision: receipt.revision } : {}),
          queueDepth
        });
        if (receipt.tag === "COMMITTED") {
          const change = await options.replicaChangeLog.getByOperation(receipt.workspaceId, receipt.opId);
          if (change) write({ type: authorityWireFrameType, kind: "replica_change", connectionGeneration: generation, change });
        }
      } catch (error) {
        write(response(value.requestId, generation, false, undefined, "AUTHORITY_REJECTED", safeErrorMessage(error)));
      }
      return;
    }
    if (negotiatedV2) {
      write(response(value.requestId, generation, false, undefined, "UPGRADE_REQUIRED", "Legacy submit is not valid under a V2 protocol negotiation."));
      return;
    }
    if (value.envelope.channelNonceDigest !== negotiatedChannelNonceDigest) {
      write(response(value.requestId, generation, false, undefined, "CHANNEL_BINDING_MISMATCH", "Delegation token request is not bound to this connection generation."));
      return;
    }
    const receipt = await options.submissionService.submit(value.envelope);
    write(response(value.requestId, generation, true, receipt));
    options.observer?.observe({
      kind: receipt.tag === "COMMITTED" ? "committed" : "rejected",
      connectionGeneration: generation,
      requestId: value.requestId,
      opId: value.envelope.opId,
      ...(receipt.tag === "COMMITTED" ? { revision: receipt.revision } : {}),
      queueDepth
    });
    if (receipt.tag === "COMMITTED") {
      const change = await options.replicaChangeLog.getByOperation(value.envelope.workspaceId, value.envelope.opId);
      if (change) write({ type: authorityWireFrameType, kind: "replica_change", connectionGeneration: generation, change });
    }
  }

  function response(
    requestId: string,
    connectionGeneration: number,
    ok: boolean,
    result?: AuthorityResponseFrame["result"],
    code?: string,
    message?: string
  ): AuthorityResponseFrame {
    return {
      type: authorityWireFrameType,
      kind: "response",
      requestId,
      connectionGeneration,
      ok,
      ...(result !== undefined ? { result } : {}),
      ...(!ok ? { error: { code: code ?? "AUTHORITY_ERROR", message: message ?? "Authority request failed." } } : {})
    };
  }

  async function streamClose(code: "BACKPRESSURE" | "UPGRADE_REQUIRED" | "SERVER_SHUTDOWN", message: string): Promise<void> {
    const latest = await options.replicaChangeLog.latest(options.workspaceId);
    write({
      type: authorityWireFrameType,
      kind: "stream_closed",
      connectionGeneration: generation,
      code,
      lastDurableRevision: latest?.revision ?? 0,
      message
    });
    closed = true;
    options.output.end();
  }

  function closeWithError(code: string, message: string): void {
    if (closed) return;
    write(response("transport", generation, false, undefined, code, message));
    closed = true;
    options.output.end();
  }

  function write(frame: AuthorityServerFrame): void {
    if (!closed) options.output.write(encodeLengthPrefixedFrame(frame, maxFrameBytes));
  }
}

function decodeBase64Url(value: string): Uint8Array {
  if (!value || !/^[A-Za-z0-9_-]+$/u.test(value)) throw new Error("invalid base64url authority payload");
  const decoded = Buffer.from(value, "base64url");
  if (decoded.toString("base64url") !== value) throw new Error("non-canonical base64url authority payload");
  return decoded;
}

function safeErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "authority admission rejected";
}
