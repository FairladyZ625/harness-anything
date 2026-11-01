// dec_9284BD6119D453EEECEED62450: authenticated command transport; replication uses its own stream.
import { uploadFleetChange } from "./upload-client.ts";
import { encodeFleetFrames, FleetTransferAssembler } from "./command-transfer.ts";
import { connect, type TLSSocket } from "node:tls";
import { createHash, X509Certificate } from "node:crypto";
import { isIP } from "node:net";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
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
  replicaGenerationReaders,
  revokeReplicaView,
  updateReplicaGenerationPosition,
} from "./replica-generation.ts";
import type { BaseBackupMetadata } from "@harness-anything/storage";
import { consumeKnownError, type LedgerCutIdentity } from "@harness-anything/kernel";
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
import { daemonBuildStamp } from "../build-identity.ts";
import type { ResourceBudget } from "./resource-budget.ts";
import { createResourceBudget, DOC_SHOW_BUDGET_LIMITS } from "./resource-budget.ts";
const edgeCommandResourceBudget = createResourceBudget(DOC_SHOW_BUDGET_LIMITS);
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
  /** Shared edge-side admission ledger for inbound and outbound bulk transfers. */
  readonly commandResourceBudget?: ResourceBudget;
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
  constructor(frame: Extract<FleetFrameV1, { schema: "fleet.error/v1" }>, versionWarning?: string | null) {
    super(`${frame.code}: ${frame.message}${versionWarning ? ` ${versionWarning}` : ""}`);
    this.code = frame.code;
    this.retryable = frame.retryable;
    this.resumeOffset = frame.resumeOffset;
  }
}

export type FleetPeer = Awaited<ReturnType<typeof openPeer>>;

/** Three missed center keepalives (REPLICATION_KEEPALIVE_MS, center-listener.ts). */
const REPLICATION_IDLE_TIMEOUT_MS = 45_000;

export interface FleetReplicaStreamOptions extends FleetPeerOptions {
  readonly viewRoot: string;
  readonly diskQuotaBytes: number;
  /**
   * A streaming replica that hears nothing for this long treats the connection as dead and fails the
   * session, so the owner reconnects. The center sends `replica.progress` every keepalive interval
   * (15 s); the default allows three to go missing. Not applied while a base backup is awaited.
   */
  readonly idleTimeoutMs?: number;
  /** Called with each position the replica acknowledged as durably applied and queryable. */
  readonly onApplied?: (
    position: import("@harness-anything/storage").ReplicationPosition,
    changedPaths?: readonly string[],
  ) => void | Promise<void>;
  readonly onVersionWarning?: (warning: FleetVersionWarning | null) => void;
}
export interface FleetVersionWarning {
  readonly centerBuildCommit: string;
  readonly localBuildCommit: string;
  readonly upgradeCommand: "ha update";
  readonly message: string;
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
/** Received frames held before the stream stops reading; at 64 KiB per data frame about 16 MiB. */
const queuedFramesHigh = 256,
  queuedFramesLow = 64;
/**
 * One resident replication stream for this node and repository: base backup when needed, then
 * ordered commits until the connection fails or the signal aborts. It never returns normally;
 * the caller owns reconnecting.
 */
export async function runFleetReplicaStream(options: FleetReplicaStreamOptions): Promise<never> {
  const viewRoot = path.join(options.viewRoot, "repos", options.repoId, "views", options.nodeId),
    generations = replicaGenerationReaders(viewRoot),
    signal = options.signal ?? new AbortController().signal;
  const socket = await peerSocket(options),
    decoder = new ReplicationDecoder(),
    queue: ReplicationFrame[] = [],
    waiters: { readonly resolve: (frame: ReplicationFrame) => void; readonly reject: (error: Error) => void }[] = [];
  let closed: Error | null = null;
  socket.on("error", (error) => {
    closed ??= error;
  });
  socket.once("close", () => {
    closed ??= new Error("replication connection closed");
    for (const waiter of waiters.splice(0)) waiter.reject(closed);
  });
  let opened: ReturnType<typeof openWalReceiverGeneration> | null = null;
  // null: this batch installed a base backup, so its changed paths are unknown.
  let pendingChangedPaths: Set<string> | null = new Set<string>();
  try {
    // The center admits a replica on the node owner's signed-in session; the hello is the only
    // frame of this conversation that can carry it.
    const accessToken = await options.readAccessToken?.();
    await new Promise<void>((resolve, reject) => {
      const commandDecoder = new FleetUtf8LineDecoder();
      const onData = (chunk: Buffer) => {
        for (const line of commandDecoder.push(chunk)) {
          const frame = parseFleetFrame(line);
          if (frame.schema !== "fleet.session.ready/v1") continue;
          const localBuildCommit = daemonBuildStamp().commit;
          options.onVersionWarning?.(
            frame.versionWarning && frame.centerBuildCommit && localBuildCommit
              ? {
                  centerBuildCommit: frame.centerBuildCommit,
                  localBuildCommit,
                  upgradeCommand: "ha update",
                  message: frame.versionWarning,
                }
              : null,
          );
          socket.off("data", onData);
          socket.off("close", onClose);
          socket.on("data", (data: Buffer) => {
            for (const replicated of decoder.push(data)) {
              const waiter = waiters.shift();
              if (waiter) waiter.resolve(replicated);
              else queue.push(replicated);
            }
            // Stop reading while frames wait: the unread TCP window is what makes the center's
            // drain wait, so a base backup flows at the speed this node writes it.
            if (queue.length >= queuedFramesHigh) socket.pause();
          });
          resolve();
          return;
        }
      };
      const onClose = () => reject(closed ?? new Error("replication session was not authenticated"));
      socket.on("data", onData);
      socket.once("close", onClose);
      socket.write(
        serializeFleetFrame({
          schema: "fleet.session.hello/v1",
          messageId: "replication-hello",
          protocolVersion: currentFleetProtocolVersion,
          nodeId: options.nodeId,
          credential: options.credential,
          buildCommit: daemonBuildStamp().commit,
          ...(accessToken ? { accessToken } : {}),
        }),
      );
    });
    // A crash mid-install leaves staging behind, and one between an install and its collection
    // leaves superseded generations behind.
    await generations.discardStaging();
    await generations.collect();
    const current = readReplicaGeneration(viewRoot);
    opened = current ? openWalReceiverGeneration(current) : null;
    const target = {
      position: () => opened?.position() ?? null,
      install: async (archive: string, metadata: BaseBackupMetadata, size: number, sha256: string) => {
        const installed = await installReplicaGeneration({
          root: viewRoot,
          archive,
          metadata,
          size,
          sha256,
          quotaBytes: options.diskQuotaBytes,
        });
        pendingChangedPaths = null;
        const prior = opened;
        opened = openWalReceiverGeneration(installed);
        if (prior) await prior.close();
        // Superseded generations go now unless a read still pins one; its release collects it.
        await generations.collect();
      },
      apply: (commit: import("@harness-anything/storage").ReplicationCommit) => {
        if (!opened) throw new Error("replica generation is unavailable");
        opened.apply(commit);
      },
      installObject: async (sha256: string, file: string) => {
        if (!opened) throw new Error("replica generation is unavailable");
        await opened.installObject(sha256, file);
      },
      project: async (_position: import("@harness-anything/storage").ReplicationPosition) => {
        if (!opened) throw new Error("replica generation is unavailable");
        await opened.project(_position);
      },
      updatePosition: (position: import("@harness-anything/storage").ReplicationPosition) =>
        updateReplicaGenerationPosition(viewRoot, position),
      changedPaths: (paths: readonly string[]) => {
        if (pendingChangedPaths) for (const changed of paths) pendingChangedPaths.add(changed);
      },
      reset: async () => {
        const prior = opened;
        opened = null;
        await prior?.close();
      },
      revoke: async () => {
        revokeReplicaView(viewRoot);
        await generations.collect();
      },
    };
    const replicationPeer: ReplicationPeer = {
      send: async (frame) => {
        if (closed) throw closed;
        const flushed = socket.write(serializeReplicationFrame(frame));
        if (frame.type === "replica.ack") {
          const changedPaths = pendingChangedPaths;
          pendingChangedPaths = new Set();
          await options.onApplied?.(frame.applied, changedPaths ? [...changedPaths] : undefined);
        }
        if (!flushed) await Promise.race([once(socket, "drain"), once(socket, "close")]);
      },
      receive: async (receiveSignal) => {
        receiveSignal?.throwIfAborted();
        const queued = queue.shift();
        if (socket.isPaused() && queue.length <= queuedFramesLow) socket.resume();
        if (queued) return queued;
        if (closed) throw closed;
        return new Promise<ReplicationFrame>((resolve, reject) => {
          const abort = () => reject(receiveSignal?.reason ?? new Error("replication aborted"));
          receiveSignal?.addEventListener("abort", abort, { once: true });
          const settle = () => {
            clearTimeout(idle);
            receiveSignal?.removeEventListener("abort", abort);
          };
          const waiter = {
            resolve: (frame: ReplicationFrame) => {
              settle();
              resolve(frame);
            },
            reject: (error: Error) => {
              settle();
              reject(error);
            },
          };
          // Silence past the keepalive budget is a dead connection (sleep, NAT reset, suspended VM),
          // which TCP may never report. Only a streaming replica expects keepalives; a center still
          // building a base backup sends nothing until the package.
          const idle =
            target.position() === null
              ? undefined
              : setTimeout(() => {
                  const at = waiters.indexOf(waiter);
                  if (at >= 0) waiters.splice(at, 1);
                  socket.destroy();
                  waiter.reject(
                    Object.assign(new Error("replication keepalive missed: the center connection is silent"), {
                      code: "replica_keepalive_missed",
                    }),
                  );
                }, options.idleTimeoutMs ?? REPLICATION_IDLE_TIMEOUT_MS);
          waiters.push(waiter);
        });
      },
    };
    await runWalReceiver({
      peer: replicationPeer,
      repoId: options.repoId,
      target,
      directory: path.join(viewRoot, "staging"),
      quotaBytes: options.diskQuotaBytes,
      // The commit envelope only (events and outcome); content objects stream to staging files.
      maxBufferedBytes: 16 * 1024 * 1024,
      signal,
    });
    throw new Error("replication stream ended");
  } finally {
    await opened?.close();
    socket.destroy();
    await generations.collect();
  }
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
      opId: randomUUID(),
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
  options: FleetPeerOptions & {
    readonly changes: readonly FleetEdgeChange[];
    readonly operationIds?: readonly string[];
  },
): Promise<readonly FleetDescriptor[]> {
  const session = await openPeer(options);
  try {
    await session.request({
      schema: "fleet.repo.metadata.get/v1",
      messageId: session.messageId(),
      repoId: options.repoId,
    });
    const descriptors: FleetDescriptor[] = [];
    for (const [index, input] of options.changes.entries())
      descriptors.push(
        await uploadFleetChange(session, options.repoId, input, options.operationIds?.[index] ?? randomUUID()),
      );
    return descriptors;
  } finally {
    session.close();
  }
}
export async function readFleetRepositoryMetadataClient(
  options: FleetPeerOptions & {
    readonly actionKind?: string;
    readonly includeGitMetadata?: boolean;
    readonly taskId?: string;
  },
): Promise<Extract<FleetFrameV1, { schema: "fleet.repo.metadata.result/v1" }>> {
  const session = await openPeer(options);
  try {
    const result = await session.request({
      schema: "fleet.repo.metadata.get/v1",
      messageId: session.messageId(),
      repoId: options.repoId,
      ...(options.executionCredential ? { executionCredential: options.executionCredential } : {}),
      ...(options.includeGitMetadata ? { includeGitMetadata: true } : {}),
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
  options: FleetPeerOptions & {
    readonly repoId: string;
    readonly archive: Readonly<Record<string, unknown>>;
    readonly opId?: string;
  },
): Promise<Extract<FleetFrameV1, { schema: "fleet.runtime.archive.result/v1" }>> {
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
      opId: options.opId ?? randomUUID(),
      archive: options.archive,
    });
    if (response.schema !== "fleet.runtime.archive.result/v1") throw new Error("runtime archive result expected");
    return response;
  } finally {
    session.close();
  }
}
export async function readFleetOperationalClient(
  options: FleetPeerOptions & {
    readonly repoId: string;
    readonly method: "repo.agentRuntime.sessions.await" | "repo.task.dispatches" | "repo.fleet.overview.read";
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
        schema: "fleet.operational.read/v1",
        messageId: session.messageId(),
        repoId: options.repoId,
        method: options.method,
        payload: options.payload,
      },
      options.method === "repo.agentRuntime.sessions.await" ? null : (options.timeoutMs ?? 5_000),
    );
    if (response.schema !== "fleet.operational.read.result/v1") throw new Error("repository read result expected");
    if (!session.versionWarning) return response.result;
    if (!session.centerBuildCommit || !daemonBuildStamp().commit) return response.result;
    return {
      ...response.result,
      versionWarning: {
        centerBuildCommit: session.centerBuildCommit,
        localBuildCommit: daemonBuildStamp().commit,
        upgradeCommand: "ha update",
      },
    };
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
          replicationSequence: assigned?.schema === "fleet.repo.metadata.result/v1" ? assigned.replicationSequence : 0,
          code: error.code,
          receipt: queried.receipt,
        };
      }
      throw error;
    }
    if (result.schema !== "fleet.task.result/v1") throw new Error("task result expected");
    return result;
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
        replicationSequence: assigned?.schema === "fleet.repo.metadata.result/v1" ? assigned.replicationSequence : 0,
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
    budget = options.commandResourceBudget ?? edgeCommandResourceBudget,
    prefix = `${options.nodeId}_${Date.now().toString(36)}`;
  const peer = peerFor(socket, options.timeoutMs ?? 5_000, {
    commandResourceBudget: budget,
    nodeId: options.nodeId,
    sessionId: prefix,
  });
  let sequence = 0;
  let versionWarning: string | null = null;
  const messageId = () => `${prefix}_${sequence++}`,
    next = async (responseTimeoutMs?: number | null, signal?: AbortSignal) => {
      const frame = await peer.next(responseTimeoutMs, signal);
      options.onFrame?.(frame);
      if (frame.schema === "fleet.session.ready/v1") versionWarning = frame.versionWarning ?? null;
      if (frame.schema === "fleet.error/v1") throw new FleetRemoteError(frame, versionWarning);
      return frame;
    },
    send = async (frame: FleetFrameV1, signal?: AbortSignal) => {
      const token =
        frame.schema === "fleet.session.hello/v1" ||
        frame.schema === "fleet.device.login/v1" ||
        frame.schema === "fleet.device.sessions.revoke/v1"
          ? undefined
          : await options.readAccessToken?.();
      for await (const encoded of encodeFleetFrames(
        { ...frame, ...(token ? { accessToken: token } : {}) },
        "request",
        "repoId" in frame && typeof frame.repoId === "string" ? frame.repoId : "transport",
        (repoId, bytes) =>
          budget.reserve(
            { nodeId: options.nodeId, sessionId: prefix, repoId },
            { memoryBytes: bytes, bulkTransfers: 1 },
          ),
      )) {
        if (!socket.write(`${JSON.stringify(encoded)}\n`)) await waitForSocketDrain(socket, signal ?? options.signal);
      }
    },
    request = async (frame: FleetFrameV1, responseTimeoutMs?: number | null) => {
      const timeout = responseTimeoutMs === undefined ? (options.timeoutMs ?? 5_000) : responseTimeoutMs,
        controller = new AbortController(),
        startedAt = Date.now(),
        timer =
          timeout === null
            ? undefined
            : setTimeout(() => controller.abort(new Error("Fleet response timeout")), timeout);
      try {
        const signal = options.signal ? AbortSignal.any([controller.signal, options.signal]) : controller.signal;
        await send(frame, signal);
        const remaining = timeout === null ? null : Math.max(1, timeout - (Date.now() - startedAt));
        return await next(remaining, signal);
      } finally {
        if (timer) clearTimeout(timer);
      }
    };
  try {
    const ready = await request({
      schema: "fleet.session.hello/v1",
      messageId: messageId(),
      protocolVersion: currentFleetProtocolVersion,
      nodeId: options.nodeId,
      credential: options.credential,
      buildCommit: daemonBuildStamp().commit,
    });
    if (ready.schema !== "fleet.session.ready/v1") throw new Error("session ready expected");
    return {
      messageId,
      next,
      send,
      request,
      loginAuthority: ready.loginAuthority,
      centerBuildCommit: ready.centerBuildCommit ?? null,
      versionWarning,
      close: peer.close,
    };
  } catch (error) {
    peer.close();
    throw error;
  }
}

/** Joins before a CA file exists: pin the presented SPKI, then use that certificate as the CA. */
export async function requestFleetEdgeJoinPinned(options: {
  readonly hostname: string;
  readonly port: number;
  readonly servername?: string;
  readonly joinId: string;
  readonly inviteToken: string;
  readonly accessToken: string;
  readonly spkiSha256: string;
  readonly timeoutMs?: number;
}): Promise<Extract<FleetFrameV1, { schema: "fleet.edge.join.result/v1" }> & { readonly certificate: string }> {
  const socket = await new Promise<TLSSocket>((resolve, reject) => {
    const candidate = connect(
      {
        host: options.hostname,
        port: options.port,
        servername: options.servername ?? options.hostname,
        rejectUnauthorized: false,
      },
      () => resolve(candidate),
    );
    candidate.once("error", reject);
  });
  try {
    const peer = socket.getPeerCertificate(true);
    if (!peer.raw)
      throw Object.assign(new Error("The center did not present a certificate."), { code: "pin_mismatch" });
    const pin = createHash("sha256")
      .update(new X509Certificate(peer.raw).publicKey.export({ type: "spki", format: "der" }))
      .digest("hex");
    if (pin !== options.spkiSha256)
      throw Object.assign(new Error("The center certificate fingerprint does not match the invitation."), {
        code: "pin_mismatch",
      });
    const response = await new Promise<Extract<FleetFrameV1, { schema: "fleet.edge.join.result/v1" }>>(
      (resolve, reject) => {
        const peerState = peerFor(socket, options.timeoutMs ?? 10_000);
        const messageId = `${options.joinId}_join`;
        socket.write(
          serializeFleetFrame({
            schema: "fleet.edge.join/v1",
            messageId,
            joinId: options.joinId,
            inviteToken: options.inviteToken,
            accessToken: options.accessToken,
          }),
        );
        peerState.next(options.timeoutMs ?? 10_000).then((frame) => {
          if (frame.schema === "fleet.edge.join.result/v1") resolve(frame);
          else if (frame.schema === "fleet.error/v1") reject(new FleetRemoteError(frame));
          else reject(new Error("edge join result expected"));
        }, reject);
      },
    );
    return { ...response, certificate: new X509Certificate(peer.raw).raw.toString("base64") };
  } finally {
    socket.destroy();
  }
}

/** Checks the invitation's center endpoint and SPKI before asking the member to sign in. */
export async function probeFleetEdgeCenterAddress(options: {
  readonly hostname: string;
  readonly port: number;
  readonly servername?: string;
  readonly spkiSha256: string;
  readonly timeoutMs?: number;
}): Promise<void> {
  const hostname = options.hostname.replace(/^\[|\]$/gu, "");
  const socket = await new Promise<TLSSocket>((resolve, reject) => {
    const candidate = connect({
      host: hostname,
      port: options.port,
      ...(options.servername
        ? { servername: options.servername }
        : isIP(hostname) === 0
          ? { servername: hostname }
          : {}),
      rejectUnauthorized: false,
    });
    const unreachable = (cause?: unknown) =>
      Object.assign(
        new Error(
          `Center address https://${options.hostname}:${options.port} is unreachable; check its DNS, routing, firewall, and port mapping.`,
        ),
        { code: "center_address_unreachable", ...(cause === undefined ? {} : { cause }) },
      );
    const timer = setTimeout(() => {
      candidate.destroy();
      reject(unreachable());
    }, options.timeoutMs ?? 5_000);
    candidate.once("secureConnect", () => {
      clearTimeout(timer);
      resolve(candidate);
    });
    candidate.once("error", (error) => {
      clearTimeout(timer);
      reject(unreachable(error));
    });
  });
  try {
    const peer = socket.getPeerCertificate(true);
    if (!peer.raw)
      throw Object.assign(new Error("The center did not present a certificate."), { code: "pin_mismatch" });
    const pin = createHash("sha256")
      .update(new X509Certificate(peer.raw).publicKey.export({ type: "spki", format: "der" }))
      .digest("hex");
    if (pin !== options.spkiSha256)
      throw Object.assign(new Error("The center certificate fingerprint does not match the invitation."), {
        code: "pin_mismatch",
      });
  } finally {
    socket.destroy();
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
      () => {
        socket.setKeepAlive(true, 15_000);
        resolve(socket);
      },
    );
    socket.once("error", reject);
  });
}
function waitForSocketDrain(socket: TLSSocket, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const cleanup = (): void => {
      socket.removeListener("drain", onDrain);
      socket.removeListener("error", onError);
      socket.removeListener("close", onClose);
      signal?.removeEventListener("abort", onAbort);
    };
    const finish = (error?: Error): void => {
      cleanup();
      if (error) reject(error);
      else resolve();
    };
    const onDrain = (): void => finish();
    const onError = (error: Error): void => finish(error);
    const onClose = (): void => finish(new Error("Fleet connection closed while waiting for socket drain"));
    const onAbort = (): void =>
      finish(signal?.reason instanceof Error ? signal.reason : new Error("Fleet send cancelled"));
    if (signal?.aborted) return onAbort();
    socket.once("drain", onDrain);
    socket.once("error", onError);
    socket.once("close", onClose);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}
function peerFor(
  socket: TLSSocket,
  timeoutMs: number,
  options: Partial<Pick<FleetPeerOptions, "commandResourceBudget" | "nodeId">> & { readonly sessionId?: string } = {},
) {
  let closed: Error | null = null;
  const reader = new FleetUtf8LineDecoder(),
    queue: FleetFrameV1[] = [],
    waiting: Array<{
      readonly resolve: (value: FleetFrameV1) => void;
      readonly reject: (error: Error) => void;
      readonly timer: NodeJS.Timeout | undefined;
      readonly signal?: AbortSignal;
      readonly abort?: () => void;
    }> = [],
    deliver = (frame: FleetFrameV1): void => {
      const waiter = waiting.shift();
      if (waiter) {
        clearTimeout(waiter.timer);
        if (waiter.abort) waiter.signal?.removeEventListener("abort", waiter.abort);
        waiter.resolve(frame);
      } else queue.push(frame);
    },
    transfers = new FleetTransferAssembler({
      direction: "response",
      reserve:
        options.commandResourceBudget && options.nodeId
          ? (repoId, bytes) =>
              options.commandResourceBudget!.reserve(
                {
                  nodeId: options.nodeId!,
                  sessionId: options.sessionId ?? `peer_${socket.remotePort ?? "unknown"}`,
                  repoId,
                },
                { memoryBytes: bytes, bulkTransfers: 1 },
              )
          : undefined,
      onTimeout: (transfer) => {
        deliver({
          schema: "fleet.error/v1",
          messageId: `transfer_timeout_${Date.now()}`,
          inReplyTo: transfer.correlationId,
          code: "transfer_timeout",
          message: `Fleet response transfer timed out (actualBytes=${transfer.totalBytes}).`,
          retryable: true,
          resumeOffset: null,
        });
      },
    }),
    settleWaiters = (error: Error): void => {
      for (const waiter of waiting.splice(0)) {
        clearTimeout(waiter.timer);
        if (waiter.abort) waiter.signal?.removeEventListener("abort", waiter.abort);
        waiter.reject(error);
      }
    };
  const failSession = (error: Error): void => {
    transfers.reset();
    settleWaiters(error);
    if (!socket.destroyed) socket.destroy(error);
  };
  socket.on("data", (chunk) => {
    try {
      for (const line of reader.push(chunk)) {
        const frame = transfers.push(parseFleetFrame(line));
        if (frame === null) continue;
        deliver(frame);
      }
    } catch (error) {
      consumeKnownError(error);
      failSession(error instanceof Error ? error : new Error(String(error)));
    }
  });
  socket.on("end", () => {
    reader.finish();
  });
  socket.on("error", (error) => {
    closed = error;
    failSession(error);
  }); // A parked server-hold request must fail fast when the connection drops, so
  // the retry loop can reconnect with the same opId instead of waiting out the
  // response timeout (adversarial F4).
  socket.on("close", () => {
    const error = closed ?? new Error("Fleet connection closed");
    closed = error;
    transfers.reset();
    settleWaiters(error);
  });
  return {
    next: (responseTimeoutMs: number | null = timeoutMs, signal?: AbortSignal) => {
      if (queue.length) return Promise.resolve(queue.shift()!);
      if (closed) return Promise.reject(closed);
      if (signal?.aborted)
        return Promise.reject(signal.reason instanceof Error ? signal.reason : new Error("Fleet request cancelled"));
      return new Promise<FleetFrameV1>((resolve, reject) => {
        const timer =
          responseTimeoutMs === null
            ? undefined
            : setTimeout(() => {
                const at = waiting.findIndex((waiter) => waiter.timer === timer);
                if (at >= 0) waiting.splice(at, 1);
                if (abort && signal) signal.removeEventListener("abort", abort);
                reject(new Error("Fleet response timeout"));
              }, responseTimeoutMs);
        const abortSignal = signal;
        const abort = abortSignal
          ? () => {
              const at = waiting.findIndex((waiter) => waiter.abort === abort);
              if (at >= 0) waiting.splice(at, 1);
              clearTimeout(timer);
              abortSignal.removeEventListener("abort", abort!);
              reject(abortSignal.reason instanceof Error ? abortSignal.reason : new Error("Fleet request cancelled"));
            }
          : undefined;
        waiting.push({ resolve, reject, timer, ...(signal ? { signal } : {}), ...(abort ? { abort } : {}) });
        if (abort && signal) signal.addEventListener("abort", abort, { once: true });
      });
    },
    close: () => {
      transfers.reset();
      socket.destroy();
    },
  };
}
