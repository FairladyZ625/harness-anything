// dec_9284BD6119D453EEECEED62450: authenticated command transport; replication uses its own stream.
import { uploadFleetChange } from "./upload-client.ts";
import { connect, type TLSSocket } from "node:tls";
import { existsSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import {
  ReplicationDecoder,
  serializeReplicationFrame,
  type ReplicationFrame,
  type ReplicationPeer,
} from "./protocol.ts";
import { openWalReceiverGeneration, runWalReceiver } from "./walreceiver.ts";
import {
  installReplicaGeneration,
  readReplicaGeneration,
  updateReplicaGenerationPosition,
} from "./replica-generation.ts";
import type { LedgerCutIdentity } from "@harness-anything/kernel";
import {
  FleetUtf8LineDecoder,
  currentFleetProtocolVersion,
  parseFleetFrame,
  serializeFleetFrame,
  type FleetDeviceLoginNotice,
  type FleetDescriptor,
  type FleetFrameV1,
  type FleetTaskAction,
} from "./command-protocol.ts";
export interface FleetEdgeChange {
  readonly path: string;
  readonly body: string | Buffer;
  readonly baseBlobSha256?: string | null;
  readonly policyId?: string;
  readonly mediaType?: string;
}
export interface FleetPeerOptions {
  readonly readAccessToken?: () => Promise<string | undefined>;
  readonly executionCredential?: string;
  readonly hostname?: string;
  readonly port: number;
  readonly ca: string | Buffer;
  readonly servername?: string;
  readonly nodeId: string;
  readonly credential: string;
  readonly repoId: string;
  readonly timeoutMs?: number;
  readonly onFrame?: (frame: FleetFrameV1) => void;
  readonly signal?: AbortSignal;
}
export interface FleetWriteClientOptions extends FleetPeerOptions {
  readonly taskId?: string;
  readonly changes: readonly FleetEdgeChange[];
  readonly baseLedgerSha?: LedgerCutIdentity;
  readonly executionId?: string | null;
  readonly channel: "collaborator" | "replica";
}
export interface FleetWriteClientResult {
  readonly descriptors: readonly FleetDescriptor[];
  readonly center: Extract<FleetFrameV1, { schema: "fleet.doc.result/v1" }>;
}
export class FleetRemoteError extends Error {
  readonly code: string;
  readonly retryable: boolean;
  readonly resumeOffset: number | null;
  constructor(frame: Extract<FleetFrameV1, { schema: "fleet.error/v1" }>) {
    super(`${frame.code}: ${frame.message}`);
    this.code = frame.code;
    this.retryable = frame.retryable;
    this.resumeOffset = frame.resumeOffset;
  }
}

export type FleetPeer = Awaited<ReturnType<typeof openPeer>>;

export interface FleetReplicaPullClientOptions extends FleetPeerOptions {
  readonly viewRoot: string;
  readonly diskQuotaBytes: number;
  /** Internal single-round control used by the resident sync owner. */
  readonly stopAfterAck?: boolean;
}
export interface FleetReplicaPullClientResult {
  readonly replica: {
    readonly schema: "fleet.replica.current/v1";
    readonly viewId: string;
    readonly knownHead: { readonly revision: number; readonly headDigest: string };
  };
  readonly current: {
    readonly cut: { readonly revision: number; readonly headDigest: string };
    readonly manifestDigest: string;
    readonly viewId: string;
  };
}
export interface FleetEdgeView {
  readonly current: (repoId: string, viewId: string) => Readonly<Record<string, unknown>> | null;
  readonly close: () => void;
}
export function openFleetEdgeView(rootDir: string, _quotaBytes: number): FleetEdgeView {
  return {
    current: (repoId, viewId) => {
      const generation = readReplicaGeneration(path.join(rootDir, "repos", repoId, "views", viewId));
      return generation
        ? {
            cut: {
              revision: generation.metadata.position.revision,
              headDigest: `sha256:${generation.metadata.position.history}:${generation.metadata.position.sequence}`,
            },
            manifestDigest: "",
            viewId,
          }
        : null;
    },
    close: () => undefined,
  };
}
export function fleetReplicaDiskUsage(root: string): number {
  if (!existsSync(root)) return 0;
  const visit = (file: string): number => {
    const info = statSync(file);
    return info.isFile()
      ? info.size
      : info.isDirectory()
        ? readdirSync(file).reduce((n, name) => n + visit(path.join(file, name)), 0)
        : 0;
  };
  return visit(root);
}
export async function runFleetReplicaPullClient(
  options: FleetReplicaPullClientOptions,
): Promise<FleetReplicaPullClientResult> {
  const viewRoot = path.join(options.viewRoot, "repos", options.repoId, "views", options.nodeId);
  let opened = readReplicaGeneration(viewRoot) ? openWalReceiverGeneration(readReplicaGeneration(viewRoot)!) : null;
  const target = {
    position: () => opened?.position() ?? null,
    install: async (archive: string, metadata: any, size: number, sha256: string) => {
      const installed = await installReplicaGeneration({
        root: viewRoot,
        archive,
        metadata,
        size,
        sha256,
        quotaBytes: options.diskQuotaBytes,
      });
      const prior = opened;
      opened = openWalReceiverGeneration(installed);
      if (prior) await prior.close();
    },
    apply: (
      commit: import("@harness-anything/kernel").ReplicationCommit,
      blobs: readonly import("@harness-anything/kernel").CanonicalContentBlob[],
    ) => {
      if (!opened) throw new Error("replica generation is unavailable");
      opened.apply(commit, blobs);
    },
    project: async (position: import("@harness-anything/kernel").ReplicationPosition) => {
      if (!opened) throw new Error("replica generation is unavailable");
      await opened.project(position);
    },
    updatePosition: (position: import("@harness-anything/kernel").ReplicationPosition) =>
      updateReplicaGenerationPosition(viewRoot, position),
    reset: async () => {
      const prior = opened;
      opened = null;
      await prior?.close();
    },
  };
  const socket = await peerSocket(options),
    decoder = new ReplicationDecoder(),
    queue: ReplicationFrame[] = [],
    waiters: ((f: ReplicationFrame) => void)[] = [];
  let replicationReady = false;
  const replicationPeer: ReplicationPeer = {
    send: async (frame) => {
      if (!socket.write(serializeReplicationFrame(frame)))
        await new Promise<void>((resolve) => socket.once("drain", resolve));
    },
    receive: async (signal) => {
      signal?.throwIfAborted();
      const queued = queue.shift();
      if (queued) return queued;
      return new Promise<ReplicationFrame>((resolve, reject) => {
        const abort = () => reject(signal?.reason ?? new Error("replication aborted"));
        signal?.addEventListener("abort", abort, { once: true });
        waiters.push((frame) => {
          signal?.removeEventListener("abort", abort);
          resolve(frame);
        });
      });
    },
  };
  const ready = new Promise<void>((resolve, reject) => {
    const commandDecoder = new FleetUtf8LineDecoder();
    const onData = (chunk: Buffer) => {
      for (const line of commandDecoder.push(chunk)) {
        const frame = parseFleetFrame(line);
        if (frame.schema === "fleet.session.ready/v1") {
          replicationReady = true;
          socket.off("data", onData);
          resolve();
        }
      }
    };
    socket.on("data", onData);
    socket.once("error", reject);
  });
  const hello = {
    schema: "fleet.session.hello/v1" as const,
    messageId: "replication-hello",
    protocolVersion: currentFleetProtocolVersion,
    nodeId: options.nodeId,
    credential: options.credential,
  };
  socket.write(serializeFleetFrame(hello));
  await ready;
  if (!replicationReady) throw new Error("replication session was not authenticated");
  socket.on("data", (chunk) => {
    for (const frame of decoder.push(chunk)) {
      const waiter = waiters.shift();
      if (waiter) waiter(frame);
      else queue.push(frame);
    }
  });
  try {
    await runWalReceiver({
      peer: replicationPeer,
      repoId: options.repoId,
      target,
      directory: path.join(viewRoot, "staging"),
      quotaBytes: options.diskQuotaBytes,
      maxBufferedBytes: 16 * 1024 * 1024,
      signal: options.signal ?? new AbortController().signal,
      stopAfterAck: (_position: import("@harness-anything/kernel").ReplicationPosition) =>
        Boolean(options.stopAfterAck),
    } as never);
  } finally {
    await opened?.close();
    socket.destroy();
  }
  const generation = readReplicaGeneration(viewRoot);
  if (!generation) throw new Error("replica generation is unavailable after replication");
  const digest = `sha256:${generation.metadata.position.history}:${generation.metadata.position.sequence}`;
  return {
    replica: {
      schema: "fleet.replica.current/v1",
      viewId: options.nodeId,
      knownHead: { revision: generation.metadata.position.revision, headDigest: digest },
    },
    current: {
      cut: { revision: generation.metadata.position.revision, headDigest: digest },
      manifestDigest: digest,
      viewId: options.nodeId,
    },
  };
}
export async function runFleetWriteClient(options: FleetWriteClientOptions): Promise<FleetWriteClientResult> {
  const session = await openPeer(options),
    staged: Array<{ input: FleetEdgeChange; descriptor: FleetDescriptor }> = [];
  try {
    const assigned = await session.request({
      schema: "fleet.repo.metadata.get/v1",
      messageId: session.messageId(),
      repoId: options.repoId,
    });
    if (assigned.schema !== "fleet.repo.metadata.result/v1" || options.changes.length === 0)
      throw new Error("repository metadata and changes expected");
    for (const input of options.changes)
      staged.push({ input, descriptor: await uploadFleetChange(session, options.repoId, input) });
    // Task writes name the current execution; shared prose uses a null
    // repository channel. The center proves canonical holder actor and node.
    const executionId = options.executionId ?? null;
    const center = await session.request({
      schema: "fleet.doc.submit/v1",
      ...(options.executionCredential ? { executionCredential: options.executionCredential } : {}),
      ...(options.taskId ? { taskId: options.taskId } : {}),
      messageId: session.messageId(),
      repoId: options.repoId,
      executionId,
      writerEpoch: assigned.writerEpoch,
      baseLedgerSha: options.baseLedgerSha ?? assigned.baseLedgerSha,
      changes: staged.map(({ input, descriptor }) => ({
        path: input.path,
        baseBlobSha256: input.baseBlobSha256 ?? null,
        policyId: input.policyId ?? "markdown-body-replaceable/v1",
        candidate: descriptor,
      })),
    });
    if (center.schema !== "fleet.doc.result/v1") throw new Error("doc result expected");
    return { descriptors: staged.map(({ descriptor }) => descriptor), center };
  } finally {
    session.close();
  }
}
// Stage claim bytes for a task transition bundle without submitting: the
// descriptors ride the fleet task command frame instead of a doc submit.
export async function runFleetUploadClient(
  options: FleetPeerOptions & { readonly changes: readonly FleetEdgeChange[] },
): Promise<readonly FleetDescriptor[]> {
  const session = await openPeer(options);
  try {
    await session.request({
      schema: "fleet.repo.metadata.get/v1",
      messageId: session.messageId(),
      repoId: options.repoId,
    });
    const descriptors: FleetDescriptor[] = [];
    for (const input of options.changes) descriptors.push(await uploadFleetChange(session, options.repoId, input));
    return descriptors;
  } finally {
    session.close();
  }
}
export async function readFleetRepositoryMetadataClient(
  options: FleetPeerOptions & { readonly actionKind?: string; readonly taskId?: string },
): Promise<Extract<FleetFrameV1, { schema: "fleet.repo.metadata.result/v1" }>> {
  const session = await openPeer(options);
  try {
    const result = await session.request({
      schema: "fleet.repo.metadata.get/v1",
      messageId: session.messageId(),
      repoId: options.repoId,
      ...(options.executionCredential ? { executionCredential: options.executionCredential } : {}),
      ...(options.actionKind ? { actionKind: options.actionKind } : {}),
      ...(options.taskId ? { taskId: options.taskId } : {}),
    });
    if (result.schema !== "fleet.repo.metadata.result/v1") throw new Error("repository metadata result expected");
    return result;
  } finally {
    session.close();
  }
}
export async function readFleetReceiptClient(
  options: FleetPeerOptions & { readonly opId: string },
): Promise<Readonly<Record<string, unknown>>> {
  const session = await openPeer(options);
  try {
    const result = await session.request({
      schema: "fleet.receipt.get/v1",
      messageId: session.messageId(),
      repoId: options.repoId,
      opId: options.opId,
    });
    if (result.schema !== "fleet.receipt.result/v1") throw new Error("receipt result expected");
    return result.receipt;
  } finally {
    session.close();
  }
}
export async function runFleetRuntimeEventClient(
  options: FleetPeerOptions & {
    readonly repoId: string;
    readonly opId: string;
    readonly eventType: string;
    readonly payload: Readonly<Record<string, unknown>>;
    readonly resultBody?: string;
    readonly dispatchContext?: import("./command-protocol.ts").FleetRuntimeDispatchContext;
  },
): Promise<Extract<FleetFrameV1, { schema: "fleet.runtime.event.result/v1" }>> {
  const session = await openPeer(options);
  try {
    const assigned = await session.request({
      schema: "fleet.repo.metadata.get/v1",
      messageId: session.messageId(),
      repoId: options.repoId,
    });
    if (assigned.schema !== "fleet.repo.metadata.result/v1") throw new Error("repository metadata result expected");
    const result =
        options.resultBody === undefined
          ? null
          : await uploadFleetChange(session, options.repoId, {
              path: "runtime-result.txt",
              body: options.resultBody,
              mediaType: "text/plain; charset=utf-8",
            }),
      response = await session.request({
        schema: "fleet.runtime.event/v1",
        messageId: session.messageId(),
        writerEpoch: assigned.writerEpoch,
        repoId: options.repoId,
        opId: options.opId,
        eventType: options.eventType,
        payload: options.payload,
        result,
        dispatchContext: options.dispatchContext ?? null,
      });
    if (response.schema !== "fleet.runtime.event.result/v1") throw new Error("runtime event result expected");
    return response;
  } finally {
    session.close();
  }
}
export async function runFleetRuntimeArchiveClient(
  options: FleetPeerOptions & { readonly repoId: string; readonly archive: Readonly<Record<string, unknown>> },
): Promise<Readonly<Record<string, unknown>>> {
  const session = await openPeer(options);
  try {
    const assigned = await session.request({
      schema: "fleet.repo.metadata.get/v1",
      messageId: session.messageId(),
      repoId: options.repoId,
    });
    if (assigned.schema !== "fleet.repo.metadata.result/v1") throw new Error("repository metadata result expected");
    const response = await session.request({
      schema: "fleet.runtime.archive/v1",
      messageId: session.messageId(),
      writerEpoch: assigned.writerEpoch,
      repoId: options.repoId,
      archive: options.archive,
    });
    if (response.schema !== "fleet.runtime.archive.result/v1") throw new Error("runtime archive result expected");
    return response.receipt;
  } finally {
    session.close();
  }
}
export async function awaitFleetRuntimeSessionsClient(
  options: FleetPeerOptions & {
    readonly repoId: string;
    readonly method: "repo.agentRuntime.sessions.await";
    readonly connectionSignal?: AbortSignal;
    readonly payload: Readonly<Record<string, unknown>>;
  },
): Promise<Readonly<Record<string, unknown>>> {
  const session = await openPeer(options);
  const close = () => session.close();
  options.connectionSignal?.addEventListener("abort", close, { once: true });
  try {
    options.connectionSignal?.throwIfAborted();
    // Only the parked await has no response deadline. Authentication and ordinary reads
    // keep their existing bounds; disconnecting its caller closes the peer.
    const response = await session.request(
      {
        schema: "fleet.runtime.await/v1",
        messageId: session.messageId(),
        repoId: options.repoId,
        method: options.method,
        payload: options.payload,
      },
      null,
    );
    if (response.schema !== "fleet.runtime.await.result/v1") throw new Error("runtime read result expected");
    return response.result;
  } finally {
    options.connectionSignal?.removeEventListener("abort", close);
    session.close();
  }
}
export interface FleetTaskCommandClientOptions extends FleetPeerOptions {
  readonly privatePayload?: Uint8Array;
  readonly artifact?: FleetDescriptor;
  readonly accessToken?: string;
  readonly opId: string;
  readonly repoId: string;
  readonly taskId: string | null;
  readonly action: FleetTaskAction;
  readonly waitMs: number;
  readonly writerEpoch?: number;
  readonly docChanges?: readonly {
    path: string;
    baseBlobSha256: string | null;
    policyId: string;
    candidate: FleetDescriptor;
  }[];
  readonly mirrorBaseCut?: { readonly revision: number; readonly headDigest: string } | null;
}
// Task conflicts return immediately; this timeout covers one canonical command round trip.
export async function runFleetTaskCommandClient(
  options: FleetTaskCommandClientOptions,
): Promise<Extract<FleetFrameV1, { schema: "fleet.task.result/v1" }>> {
  const session = await openPeer({ ...options, timeoutMs: options.timeoutMs ?? options.waitMs + 10_000 });
  try {
    const assigned =
      options.writerEpoch === undefined
        ? await session.request({
            schema: "fleet.repo.metadata.get/v1",
            messageId: session.messageId(),
            repoId: options.repoId,
          })
        : null;
    if (assigned !== null && assigned.schema !== "fleet.repo.metadata.result/v1")
      throw new Error("repository metadata result expected");
    const writerEpoch =
      options.writerEpoch ??
      (assigned as Extract<FleetFrameV1, { schema: "fleet.repo.metadata.result/v1" }>).writerEpoch;
    const candidate = options.privatePayload
      ? await uploadFleetChange(session, options.repoId, {
          path: "rollout.jsonl",
          body: Buffer.from(options.privatePayload),
          mediaType: "application/x-ndjson",
        })
      : null;
    let result: FleetFrameV1;
    const evidence: Buffer[] = [];
    try {
      result = await session.request({
        schema: "fleet.task.command/v1",
        ...(options.executionCredential ? { executionCredential: options.executionCredential } : {}),
        messageId: session.messageId(),
        writerEpoch,
        opId: options.opId,
        repoId: options.repoId,
        taskId: options.taskId,
        action: { ...options.action, ...(candidate ? { candidate } : {}) },
        ...(options.artifact ? { artifact: options.artifact } : {}),
        docChanges: options.docChanges ?? null,
        mirrorBaseCut: options.mirrorBaseCut ?? null,
        ...(options.accessToken ? { accessToken: options.accessToken } : {}),
      });
      // Bytes advance on each chunk; the result frame is the reader's completion signal.
      while (result.schema === "fleet.task.evidence/v1") {
        evidence.push(Buffer.from(result.dataBase64, "base64"));
        result = await session.next();
      }
    } catch (error) {
      if (error instanceof FleetRemoteError && error.code === "writer_epoch_stale") {
        const queried = await session.request({
          schema: "fleet.receipt.get/v1",
          messageId: session.messageId(),
          repoId: options.repoId,
          opId: options.opId,
        });
        if (queried.schema !== "fleet.receipt.result/v1") throw new Error("receipt result expected");
        return {
          schema: "fleet.task.result/v1",
          messageId: session.messageId(),
          inReplyTo: "writer-epoch",
          outcome: "op_rejected",
          opId: options.opId,
          revision: null,
          code: error.code,
          receipt: queried.receipt,
        };
      }
      throw error;
    }
    if (result.schema !== "fleet.task.result/v1") throw new Error("task result expected");
    return options.action.kind === "doc-show" && result.receipt?.outcome === "applied"
      ? { ...result, receipt: { ...result.receipt, evidence: Buffer.concat(evidence).toString("utf8") } }
      : result;
  } finally {
    session.close();
  }
}
export async function runFleetScheduleCommandClient(
  options: FleetPeerOptions & {
    readonly opId: string;
    readonly repoId: string;
    readonly scheduleId: string;
    readonly action: Readonly<Record<string, unknown>> & { readonly kind: string };
    readonly writerEpoch?: number;
  },
): Promise<Extract<FleetFrameV1, { schema: "fleet.schedule.result/v1" }>> {
  const session = await openPeer(options);
  try {
    const assigned =
      options.writerEpoch === undefined
        ? await session.request({
            schema: "fleet.repo.metadata.get/v1",
            messageId: session.messageId(),
            repoId: options.repoId,
          })
        : null;
    if (assigned !== null && assigned.schema !== "fleet.repo.metadata.result/v1")
      throw new Error("repository metadata result expected");
    const writerEpoch =
      options.writerEpoch ??
      (assigned as Extract<FleetFrameV1, { schema: "fleet.repo.metadata.result/v1" }>).writerEpoch;
    try {
      const result = await session.request({
        schema: "fleet.schedule.command/v1",
        messageId: session.messageId(),
        writerEpoch,
        opId: options.opId,
        repoId: options.repoId,
        scheduleId: options.scheduleId,
        action: options.action,
      });
      if (result.schema !== "fleet.schedule.result/v1") throw new Error("schedule result expected");
      return result;
    } catch (error) {
      if (!(error instanceof FleetRemoteError) || error.code !== "writer_epoch_stale") throw error;
      const queried = await session.request({
        schema: "fleet.receipt.get/v1",
        messageId: session.messageId(),
        repoId: options.repoId,
        opId: options.opId,
      });
      if (queried.schema !== "fleet.receipt.result/v1") throw new Error("receipt result expected");
      return {
        schema: "fleet.schedule.result/v1",
        messageId: session.messageId(),
        inReplyTo: "writer-epoch",
        opId: options.opId,
        outcome: "op_rejected",
        revision: null,
        code: error.code,
        receipt: queried.receipt,
      };
    }
  } finally {
    session.close();
  }
}
export async function openPeer(options: Omit<FleetPeerOptions, "repoId">) {
  const socket = await peerSocket(options),
    peer = peerFor(socket, options.timeoutMs ?? 5_000),
    prefix = `${options.nodeId}_${Date.now().toString(36)}`;
  let sequence = 0;
  const messageId = () => `${prefix}_${sequence++}`,
    next = async (responseTimeoutMs?: number | null) => {
      const frame = await peer.next(responseTimeoutMs);
      options.onFrame?.(frame);
      if (frame.schema === "fleet.error/v1") throw new FleetRemoteError(frame);
      return frame;
    },
    send = async (frame: FleetFrameV1) => {
      const token =
        frame.schema === "fleet.session.hello/v1" ||
        frame.schema === "fleet.device.login/v1" ||
        frame.schema === "fleet.device.sessions.revoke/v1"
          ? undefined
          : await options.readAccessToken?.();
      return socket.write(serializeFleetFrame({ ...frame, ...(token ? { accessToken: token } : {}) }));
    },
    request = async (frame: FleetFrameV1, responseTimeoutMs?: number | null) => {
      await send(frame);
      return next(responseTimeoutMs);
    };
  try {
    const ready = await request({
      schema: "fleet.session.hello/v1",
      messageId: messageId(),
      protocolVersion: currentFleetProtocolVersion,
      nodeId: options.nodeId,
      credential: options.credential,
    });
    if (ready.schema !== "fleet.session.ready/v1") throw new Error("session ready expected");
    return { messageId, next, send, request, loginAuthority: ready.loginAuthority, close: peer.close };
  } catch (error) {
    peer.close();
    throw error;
  }
}
export async function reportFleetDeviceLogin(
  options: Omit<FleetPeerOptions, "repoId">,
  notice: FleetDeviceLoginNotice,
): Promise<void> {
  const peer = await openPeer(options);
  try {
    const reply = await peer.request({ schema: "fleet.device.login/v1", messageId: peer.messageId(), ...notice });
    if (reply.schema !== "fleet.device.login.result/v1")
      throw new Error("Device login notice acknowledgement expected.");
  } finally {
    peer.close();
  }
}

export async function readFleetLoginAuthorityClient(
  options: Omit<FleetPeerOptions, "repoId"> & { readonly resetSession?: boolean },
) {
  const peer = await openPeer(options);
  try {
    if (
      !peer.loginAuthority ||
      new URL(peer.loginAuthority.url).protocol !== "https:" ||
      peer.loginAuthority.clientId !== `harness-node-${options.nodeId}`
    )
      throw Object.assign(new Error("The center has no external HTTPS Keycloak login authority for this node."), {
        code: "oidc_listener_required",
      });
    if (options.resetSession) {
      const reply = await peer.request({ schema: "fleet.device.sessions.revoke/v1", messageId: peer.messageId() });
      if (reply.schema !== "fleet.device.sessions.revoked/v1")
        throw new Error("Device session revocation acknowledgement expected.");
    }
    return peer.loginAuthority;
  } finally {
    peer.close();
  }
}
function peerSocket(options: Omit<FleetPeerOptions, "repoId">): Promise<TLSSocket> {
  return new Promise((resolve, reject) => {
    const socket = connect(
      {
        host: options.hostname ?? "127.0.0.1",
        port: options.port,
        ca: options.ca,
        servername: options.servername ?? "localhost",
        rejectUnauthorized: true,
      },
      () => resolve(socket),
    );
    socket.once("error", reject);
  });
}
function peerFor(socket: TLSSocket, timeoutMs: number) {
  let closed: Error | null = null;
  const reader = new FleetUtf8LineDecoder(),
    queue: FleetFrameV1[] = [],
    waiting: Array<{
      readonly resolve: (value: FleetFrameV1) => void;
      readonly reject: (error: Error) => void;
      readonly timer: NodeJS.Timeout | undefined;
    }> = [],
    settleWaiters = (error: Error): void => {
      for (const waiter of waiting.splice(0)) {
        clearTimeout(waiter.timer);
        waiter.reject(error);
      }
    };
  socket.on("data", (chunk) => {
    for (const line of reader.push(chunk)) {
      const frame = parseFleetFrame(line),
        waiter = waiting.shift();
      if (waiter) {
        clearTimeout(waiter.timer);
        waiter.resolve(frame);
      } else queue.push(frame);
    }
  });
  socket.on("end", () => {
    reader.finish();
  });
  socket.on("error", (error) => {
    closed = error;
    settleWaiters(error);
  }); // A parked server-hold request must fail fast when the connection drops, so
  // the retry loop can reconnect with the same opId instead of waiting out the
  // response timeout (adversarial F4).
  socket.on("close", () => {
    const error = closed ?? new Error("Fleet connection closed");
    closed = error;
    settleWaiters(error);
  });
  return {
    next: (responseTimeoutMs: number | null = timeoutMs) => {
      if (queue.length) return Promise.resolve(queue.shift()!);
      if (closed) return Promise.reject(closed);
      return new Promise<FleetFrameV1>((resolve, reject) => {
        const timer =
          responseTimeoutMs === null
            ? undefined
            : setTimeout(() => {
                const at = waiting.findIndex((waiter) => waiter.timer === timer);
                if (at >= 0) waiting.splice(at, 1);
                reject(new Error("Fleet response timeout"));
              }, responseTimeoutMs);
        waiting.push({ resolve, reject, timer });
      });
    },
    close: () => socket.destroy(),
  };
}
