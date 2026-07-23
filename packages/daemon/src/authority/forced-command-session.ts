import type { Readable, Writable } from "node:stream";
import {
  decodeActorAxesBindingV2,
  type AuthoritySubmissionService,
  type ReplicaChangeLog
} from "@harness-anything/application";
import {
  authorityWireFrameType,
  isAuthorityRequestFrame,
  sameAuthorityProtocol,
  type AuthorityNegotiatedProtocol,
  type AuthorityBlobResult,
  type AuthorityChangesAfterResult,
  type AuthoritySnapshotManifest,
  type AuthoritySnapshotLease,
  type AuthoritySnapshotReservation,
  type AuthorityResponseFrame,
  type AuthorityServerFrame,
  type Sha256Digest
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
  /** Server-observed connection binding. V2 never accepts the hello field as authority. */
  readonly serverChannelNonceDigest?: Uint8Array;
  readonly submissionService: AuthoritySubmissionService;
  readonly replicaChangeLog: ReplicaChangeLog;
  readonly readDownService?: AuthorityReadDownService;
  readonly maxFrameBytes?: number;
  readonly maxQueuedFrames?: number;
  readonly observer?: AuthorityTransportObserver;
}

export interface AuthorityReadDownService {
  readonly beginSnapshot: () => Promise<AuthoritySnapshotReservation>;
  readonly getManifest: (streamToken: string, digest: Sha256Digest) => Promise<AuthoritySnapshotManifest>;
  readonly getCutChange: (streamToken: string) => Promise<import("@harness-anything/application").ReplicaChangeRecord | null>;
  readonly releaseLease: (streamToken: string) => Promise<void>;
  readonly getBlob: (streamToken: string, digest: Sha256Digest) => Promise<AuthorityBlobResult>;
  readonly renewLease: (streamToken: string) => Promise<AuthoritySnapshotLease>;
  readonly changesAfter: (streamToken: string, sinceRevision: number) => Promise<AuthorityChangesAfterResult>;
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
  let closePromise: Promise<void> | undefined;
  let queue = Promise.resolve();
  let unsubscribe: (() => void) | undefined;
  let subscribedAfterRevision: number | undefined;
  const pendingHints: import("@harness-anything/application").ReplicaChangeRecord[] = [];

  options.input.on("data", (chunk: Buffer) => {
    const batch = reader.push(chunk);
    for (const frame of batch.frames) enqueue(frame);
    if (batch.error) closeWithError("INVALID_FRAME", batch.error.message);
  });
  options.input.on("end", () => {
    const batch = reader.flush();
    if (batch.error) closeWithError("INVALID_FRAME", batch.error.message);
    else void closeAuthoritySession();
  });
  options.input.on("close", () => void closeAuthoritySession());
  options.input.on("error", (error: Error) => {
    closeWithError("INPUT_ERROR", error.message);
    void closeAuthoritySession();
  });

  return {
    close: closeAuthoritySession
  };

  function closeAuthoritySession(): Promise<void> {
    if (closePromise) return closePromise;
    closed = true;
    unsubscribe?.();
    unsubscribe = undefined;
    pendingHints.length = 0;
    closePromise = (async () => {
      await queue;
      if (!options.input.destroyed) options.input.destroy();
      if (!options.output.destroyed) options.output.end();
      options.observer?.observe({ kind: "closed", connectionGeneration: generation, queueDepth });
    })();
    return closePromise;
  }

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
    if (closed) return;
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
      negotiatedV2 = "policy" in value.protocol;
      if (negotiatedV2 && options.serverChannelNonceDigest?.byteLength !== 32) {
        write(response(value.requestId, generation, false, undefined, "SERVER_CHANNEL_BINDING_REQUIRED", "V2 requires a server-observed connection binding."));
        await streamClose("UPGRADE_REQUIRED", "Reconnect through a transport that provides a server-observed connection binding.");
        return;
      }
      negotiatedChannelNonceDigest = negotiatedV2
        ? Buffer.from(options.serverChannelNonceDigest!).toString("hex")
        : value.channelNonceDigest;
      write(response(value.requestId, generation, true, {
        accepted: true,
        protocol: options.protocol,
        capabilities: [
          "single-writer",
          "op-id-dedupe",
          "replica-change/v2",
          ...(options.readDownService ? [
            "begin-snapshot-and-subscribe/v1",
            "authority-snapshot-manifest/v1",
            "authority-cut-change/v1",
            "authority-blob/v1",
            "authority-changes-after/v1",
            "authority-lease-renewal/v1"
          ] : []),
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
    if (value.kind === "begin_snapshot_and_subscribe") {
      if (!options.readDownService || value.workspaceId !== options.workspaceId) {
        write(response(value.requestId, generation, false, undefined, "READ_DOWN_UNAVAILABLE", "Authority read-down is not available for this workspace."));
        return;
      }
      unsubscribe?.();
      subscribedAfterRevision = undefined;
      pendingHints.length = 0;
      unsubscribe = options.replicaChangeLog.subscribe(options.workspaceId, (change) => {
        if (subscribedAfterRevision === undefined) {
          pendingHints.push(change);
        } else if (change.revision > subscribedAfterRevision) {
          writeReplicaHint(change);
        }
      });
      try {
        const reservation = await options.readDownService.beginSnapshot();
        subscribedAfterRevision = reservation.cut.revision;
        try {
          const accepted = write(response(value.requestId, generation, true, reservation));
          if (!accepted && (closed || options.output.destroyed || options.output.writableEnded)) {
            throw new Error("SNAPSHOT_RESPONSE_NOT_DELIVERABLE");
          }
        } catch (error) {
          await options.readDownService.releaseLease(reservation.stream.streamToken);
          throw error;
        }
        for (const change of pendingHints.splice(0)) {
          if (change.revision > reservation.cut.revision) writeReplicaHint(change);
        }
      } catch (error) {
        unsubscribe?.();
        unsubscribe = undefined;
        writeReadDownError(value.requestId, error);
      }
      return;
    }
    if (value.kind === "get_snapshot_manifest") {
      await handleReadDown(value.requestId, () => options.readDownService!.getManifest(value.streamToken, value.manifestDigest));
      return;
    }
    if (value.kind === "get_cut_change") {
      await handleReadDown(value.requestId, () => options.readDownService!.getCutChange(value.streamToken));
      return;
    }
    if (value.kind === "get_blob") {
      await handleReadDown(value.requestId, () => options.readDownService!.getBlob(value.streamToken, value.digest));
      return;
    }
    if (value.kind === "renew_lease") {
      if (!options.readDownService) {
        write(response(value.requestId, generation, false, undefined, "READ_DOWN_UNAVAILABLE", "Authority read-down is not available for this workspace."));
        return;
      }
      if (value.workspaceId !== options.workspaceId) {
        write(response(value.requestId, generation, false, undefined, "WORKSPACE_MISMATCH", "Read-down lease belongs to another workspace."));
        return;
      }
      await handleReadDown(value.requestId, () => options.readDownService!.renewLease(value.streamToken));
      return;
    }
    if (value.kind === "changes_after") {
      if (value.workspaceId !== options.workspaceId) {
        write(response(value.requestId, generation, false, undefined, "WORKSPACE_MISMATCH", "Read-down cursor belongs to another workspace."));
        return;
      }
      await handleReadDown(value.requestId, () => options.readDownService!.changesAfter(value.streamToken, value.sinceRevision));
      return;
    }
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
          if (change && !unsubscribe) writeReplicaHint(change);
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
      if (change && !unsubscribe) writeReplicaHint(change);
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
    if (closed) return;
    closed = true;
    unsubscribe?.();
    unsubscribe = undefined;
    const latest = await options.replicaChangeLog.latest(options.workspaceId);
    writeRaw({
      type: authorityWireFrameType,
      kind: "stream_closed",
      connectionGeneration: generation,
      code,
      lastDurableRevision: latest?.revision ?? 0,
      message
    });
    options.output.end();
  }

  function closeWithError(code: string, message: string): void {
    if (closed) return;
    unsubscribe?.();
    unsubscribe = undefined;
    writeRaw(response("transport", generation, false, undefined, code, message));
    closed = true;
    options.output.end();
  }

  function write(frame: AuthorityServerFrame): boolean {
    return !closed && writeRaw(frame);
  }

  function writeRaw(frame: AuthorityServerFrame): boolean {
    if (options.output.destroyed || options.output.writableEnded) return false;
    return options.output.write(encodeLengthPrefixedFrame(frame, maxFrameBytes));
  }

  function writeReplicaHint(change: import("@harness-anything/application").ReplicaChangeRecord): void {
    const accepted = write({ type: authorityWireFrameType, kind: "replica_change", connectionGeneration: generation, change });
    if (!accepted) void streamClose("BACKPRESSURE", "authority replica hint output exceeded its configured bound");
  }

  async function handleReadDown(
    requestId: string,
    read: () => Promise<AuthorityResponseFrame["result"]>
  ): Promise<void> {
    if (!options.readDownService) {
      write(response(requestId, generation, false, undefined, "READ_DOWN_UNAVAILABLE", "Authority read-down is not enabled."));
      return;
    }
    try {
      write(response(requestId, generation, true, await read()));
    } catch (error) {
      writeReadDownError(requestId, error);
    }
  }

  function writeReadDownError(requestId: string, error: unknown): void {
    const message = safeErrorMessage(error);
    const knownCode = /^(?:SNAPSHOT_EXPIRED|RESYNC_REQUIRED|BLOB_DIGEST_MISMATCH|MANIFEST_DIGEST_MISMATCH)(?::|$)/u.exec(message)?.[0]?.replace(/:$/u, "");
    write(response(requestId, generation, false, undefined, knownCode ?? "READ_DOWN_FAILED", message));
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
