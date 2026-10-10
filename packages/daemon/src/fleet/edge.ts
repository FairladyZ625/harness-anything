import type { EdgeReaderProfile } from "@harness-anything/kernel";
import { uploadFleetChange } from "./upload-client.ts";
import { referencedEdgeBlobs } from "./edge-view-references.ts";
import {
  commitEdgeManifest,
  markEdgeContent,
  edgeContentBytes,
  forgetEdgeContent,
  pruneEdgeManifests,
  readEdgeManifestHeader,
  discardUnpublishedEdgeManifests,
} from "./replica-read-model.ts";
import { withFleetReplicaPullLock } from "../fleet-edge-mirror.ts";
import { recordReplicaHealth, replicaFailure } from "./replica-health.ts";
import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { connect, type TLSSocket } from "node:tls";
import { waitForReplicaCheckpoint } from "./edge-replica-watch.ts";
import type { FleetReplicaSessionPool } from "./edge-replica-sync.ts";
import { consumeKnownError, type LedgerCutIdentity } from "@harness-anything/kernel";
import { recordHeadConfirmation, recordNodeReadDenied } from "./replica-read-model.ts";
import { READ_MODEL_META_PATH, sha256Bytes } from "@harness-anything/kernel";
import { readFileWindow, writeFileDurably } from "../durable-file.ts";
import {
  FLEET_SESSION_SEND_WINDOW_BYTES,
  FleetUtf8LineDecoder,
  currentFleetProtocolVersion,
  parseFleetFrame,
  serializeFleetFrame,
  type FleetDeviceLoginNotice,
  type FleetCut,
  type FleetDeltaChange,
  type FleetDescriptor,
  type FleetEntry,
  type FleetFrameV1,
  type FleetTaskAction,
} from "./contract.ts";

type Begin = Extract<FleetFrameV1, { schema: "fleet.snapshot.begin/v1" | "fleet.delta.begin/v1" }>;
type Finish = Extract<FleetFrameV1, { schema: "fleet.snapshot.finish/v1" | "fleet.delta.finish/v1" }>;
type Current = {
  cut: FleetCut;
  schemaGeneration: number;
  manifestDigest: string;
  readerProfile: EdgeReaderProfile;
  authorizationShapeDigest: string;
};
export interface FleetEdgeView {
  readonly receive: (frame: FleetFrameV1) => FleetFrameV1 | null;
  readonly current: (repoId: string, viewId: string) => Current | null;
  readonly collect: (repoId: string, viewId: string, transferId: string) => void;
  readonly discard: (repoId: string, viewId: string) => void;
}
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
export interface FleetReplicaPullClientOptions extends FleetPeerOptions {
  readonly viewRoot: string;
  readonly diskQuotaBytes: number;
  /** Wait for a fixed write revision or the first observed center head before returning. */
  readonly through?: number | "known-head";
  readonly beforeAck?: (frame: Extract<FleetFrameV1, { schema: "fleet.ack/v1" }>) => void;
  readonly edgeKillpoint?: (point: "after_page" | "after_chunk" | "before_current_rename") => void;
  /** Reuse the authenticated TLS session for this node/repository when supplied. */
  readonly sessionPool?: FleetReplicaSessionPool;
}
export interface FleetReplicaPullClientResult {
  readonly replica:
    | Extract<FleetFrameV1, { schema: "fleet.ack.result/v1" }>
    | Extract<FleetFrameV1, { schema: "fleet.replica.current/v1" | "fleet.replica.checkpoint/v1" }>;
  readonly current: Current;
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

export function openFleetEdgeView(
  rootDir: string,
  diskQuotaBytes: number,
  killpoint?: (point: "after_page" | "after_chunk" | "before_current_rename") => void,
): FleetEdgeView {
  if (!Number.isSafeInteger(diskQuotaBytes) || diskQuotaBytes <= 0) throw new Error("replica disk quota is required");
  // Reopening a view recomputes durable usage. Within one receive session,
  // account appended staging bytes instead of walking the full mirror per chunk.
  let knownDiskBytes: number | null = null;
  const incomingSizes = new Map<string, Map<string, number>>();
  const active = new Map<string, string>(),
    accountedDiskBytes = () => (knownDiskBytes ??= fleetReplicaDiskUsage(rootDir)),
    repoRoot = (repoId: string) => path.join(rootDir, "repos", repoId),
    viewRoot = (repoId: string, viewId: string) => path.join(repoRoot(repoId), "views", viewId),
    current = (repoId: string, viewId: string): Current | null =>
      readJson(path.join(viewRoot(repoId, viewId), "current.json"));
  return {
    current,
    discard: (repoId, viewId) => {
      const root = viewRoot(repoId, viewId),
        staging = path.join(root, ".staging");
      if (!existsSync(staging) || readdirSync(staging).length === 0) return;
      const published = current(repoId, viewId);
      for (const identity of discardUnpublishedEdgeManifests(root, published?.cut ?? null))
        rmSync(path.join(root, "cuts", identity), { recursive: true, force: true });
      // Drop this view's in-flight pins before collecting shared orphan content.
      for (const transferId of readdirSync(staging)) {
        rmSync(path.join(staging, transferId), { recursive: true, force: true });
        active.delete(transferId);
        incomingSizes.delete(transferId);
      }
      collect(
        root,
        path.join(repoRoot(repoId), "cas", "sha256"),
        published ? `${published.cut.revision}-g${published.schemaGeneration}` : null,
        true,
      );
      knownDiskBytes = null;
    },
    collect: (repoId, viewId, transferId) => {
      const root = viewRoot(repoId, viewId),
        published = current(repoId, viewId)!;
      collect(
        root,
        path.join(repoRoot(repoId), "cas", "sha256"),
        `${published.cut.revision}-g${published.schemaGeneration}`,
      );
      rmSync(path.join(root, ".staging", transferId), { recursive: true, force: true });
    },
    receive: (frame) => {
      if (frame.schema === "fleet.snapshot.begin/v1" || frame.schema === "fleet.delta.begin/v1") {
        const root = viewRoot(frame.repoId, frame.viewId),
          staging = path.join(root, ".staging"),
          activeCut = current(frame.repoId, frame.viewId);
        if (
          frame.schema === "fleet.snapshot.begin/v1" &&
          accountedDiskBytes() + frame.manifest.totalBytes + FLEET_SESSION_SEND_WINDOW_BYTES > diskQuotaBytes
        )
          throw new Error("replica_quota_exceeded: incoming snapshot exceeds persistent quota");
        mkdirSync(staging, { recursive: true });
        for (const stale of readdirSync(staging).sort().slice(64))
          rmSync(path.join(staging, stale), { recursive: true, force: true });
        const replayedTarget =
          JSON.stringify(activeCut?.cut) ===
          JSON.stringify(frame.schema === "fleet.snapshot.begin/v1" ? frame.cut : frame.toCut);
        if (
          frame.schema === "fleet.delta.begin/v1" &&
          JSON.stringify(activeCut?.cut) !== JSON.stringify(frame.fromCut) &&
          !replayedTarget
        )
          throw new Error("snapshot_required: delta base cut is not current");
        exactJson(path.join(staging, frame.transferId, "begin.json"), frame);
        active.set(frame.transferId, root);
        incomingSizes.set(frame.transferId, new Map());
        return null;
      }
      if (!("transferId" in frame) || typeof frame.transferId !== "string" || !active.has(frame.transferId))
        return null;
      const root = active.get(frame.transferId)!,
        staging = path.join(root, ".staging", frame.transferId);
      if (frame.schema === "fleet.snapshot.page/v1" || frame.schema === "fleet.delta.page/v1") {
        exactJson(path.join(staging, `page-${frame.pageIndex}.json`), frame);
        const sizes = incomingSizes.get(frame.transferId)!;
        const entries =
          frame.schema === "fleet.snapshot.page/v1"
            ? frame.entries
            : frame.changes.filter((change) => change.op === "put");
        for (const entry of entries) {
          const previous = sizes.get(entry.blob.sha256);
          if (previous !== undefined && previous !== entry.blob.size) throw new Error("transfer blob mismatch");
          sizes.set(entry.blob.sha256, entry.blob.size);
        }
        killpoint?.("after_page");
        return null;
      }
      if (frame.schema === "fleet.snapshot.chunk/v1" || frame.schema === "fleet.delta.chunk/v1") {
        const cas = path.join(
            path.dirname(path.dirname(root)),
            "cas",
            "sha256",
            frame.blobSha256.slice(0, 2),
            frame.blobSha256,
          ),
          target = existsSync(cas) ? cas : path.join(staging, "blobs", frame.blobSha256),
          bytes = Buffer.from(frame.dataBase64, "base64"),
          expectedSize = incomingSizes.get(frame.transferId)!.get(frame.blobSha256);
        if (expectedSize !== undefined && frame.offset + bytes.length > expectedSize)
          throw new Error("transfer blob mismatch");
        mkdirSync(path.dirname(target), { recursive: true });
        const length = existsSync(target) ? statSync(target).size : 0;
        if (frame.offset > length) throw new Error("chunk gap");
        if (frame.offset < length || target === cas) {
          // Replay comparison reads only the contested window; the staged blob
          // can be far larger than the chunk being retried.
          if (!readFileWindow(target, frame.offset, bytes.length).equals(bytes))
            throw new Error("chunk replay mismatch");
        } else {
          const usedBytes = accountedDiskBytes();
          if (usedBytes + bytes.byteLength > diskQuotaBytes)
            throw new Error("replica_quota_exceeded: staging chunk exceeds persistent quota");
          const fd = openSync(target, "a");
          try {
            writeFileSync(fd, bytes);
            fsyncSync(fd);
          } finally {
            closeSync(fd);
          }
          knownDiskBytes = usedBytes + bytes.byteLength;
        }
        if (target !== cas && expectedSize !== undefined && statSync(target).size === expectedSize) {
          if (sha256Bytes(readFileSync(target)) !== frame.blobSha256) throw new Error("transfer blob mismatch");
          markEdgeContent(root, frame.blobSha256, expectedSize);
          mkdirSync(path.dirname(cas), { recursive: true });
          renameSync(target, cas);
        }
        killpoint?.("after_chunk");
        return null;
      }
      if (frame.schema === "fleet.snapshot.finish/v1" || frame.schema === "fleet.delta.finish/v1") {
        incomingSizes.delete(frame.transferId);
        const response = finish(root, staging, frame, killpoint);
        active.delete(frame.transferId);
        knownDiskBytes = null;
        return response;
      }
      return null;
    },
  };
}
function finish(
  viewRoot: string,
  staging: string,
  frame: Finish,
  killpoint?: (point: "after_page" | "after_chunk" | "before_current_rename") => void,
): FleetFrameV1 {
  const begin = readJson<Begin>(path.join(staging, "begin.json"));
  if (
    !begin ||
    begin.transferId !== frame.transferId ||
    (frame.schema === "fleet.snapshot.finish/v1"
      ? begin.schema !== "fleet.snapshot.begin/v1" || begin.manifest.digest !== frame.manifestDigest
      : begin.schema !== "fleet.delta.begin/v1" || begin.resultManifestDigest !== frame.resultManifestDigest)
  )
    throw new Error("transfer finish mismatch");
  const cut = begin.schema === "fleet.snapshot.begin/v1" ? begin.cut : begin.toCut,
    expected = begin.schema === "fleet.snapshot.begin/v1" ? begin.manifest.digest : begin.resultManifestDigest,
    already = readJson<Current>(path.join(viewRoot, "current.json"));
  if (
    Number.isSafeInteger(already?.schemaGeneration) &&
    JSON.stringify(already?.cut) === JSON.stringify(cut) &&
    already?.manifestDigest === expected
  ) {
    return ack(begin.transferId, cut, expected);
  }
  if (already?.cut.revision === cut.revision && already.cut.headDigest !== cut.headDigest)
    throw new Error("snapshot canonical head conflict");
  const pageNames = readdirSync(staging)
    .filter((name) => /^page-\d+\.json$/u.test(name))
    .sort((a, b) => Number.parseInt(a.slice(5), 10) - Number.parseInt(b.slice(5), 10));
  function* pages() {
    for (const [index, name] of pageNames.entries()) {
      const page = readJson<Extract<FleetFrameV1, { schema: "fleet.snapshot.page/v1" | "fleet.delta.page/v1" }>>(
        path.join(staging, name),
      )!;
      if (page.pageIndex !== index) throw new Error("transfer page gap");
      yield page;
    }
  }
  let entries: FleetEntry[];
  const changes: FleetDeltaChange[] = [];
  const result = path.join(staging, "result"),
    repo = path.dirname(path.dirname(viewRoot)),
    casRoot = path.join(repo, "cas", "sha256");
  rmSync(result, { recursive: true, force: true });
  if (begin.schema === "fleet.snapshot.begin/v1") {
    entries = [];
    for (const page of pages()) if (page.schema === "fleet.snapshot.page/v1") entries.push(...page.entries);
    if (
      entries.length !== begin.manifest.entryCount ||
      entries.reduce((sum, entry) => sum + entry.blob.size, 0) !== begin.manifest.totalBytes
    )
      throw new Error("snapshot manifest count mismatch");
  } else {
    const previous = readJson<Current>(path.join(viewRoot, "current.json"));
    if (!previous || JSON.stringify(previous.cut) !== JSON.stringify(begin.fromCut))
      throw new Error("snapshot_required: delta base changed");
    for (const page of pages()) if (page.schema === "fleet.delta.page/v1") changes.push(...page.changes);
    if (changes.length !== begin.changeCount) throw new Error("delta change count mismatch");
    entries = changes.filter((change) => change.op === "put").map(({ path, blob }) => ({ path, blob }));
  }
  for (const entry of entries) {
    const cas = path.join(casRoot, entry.blob.sha256.slice(0, 2), entry.blob.sha256),
      incoming = path.join(staging, "blobs", entry.blob.sha256);
    if (!existsSync(cas)) {
      if (!existsSync(incoming)) {
        if (entry.blob.size !== 0 || entry.blob.sha256 !== sha256Bytes(Buffer.alloc(0)))
          throw new Error("transfer blob missing");
        markEdgeContent(viewRoot, entry.blob.sha256, entry.blob.size);
        writeFileDurably(cas, Buffer.alloc(0));
      } else {
        // Incoming bytes are hashed exactly once, here; the CAS file is the
        // verified rename of them, and a CAS blob that already exists was
        // verified when it was written, so no read-back rehash follows.
        const bytes = readFileSync(incoming);
        if (bytes.byteLength !== entry.blob.size || sha256Bytes(bytes) !== entry.blob.sha256)
          throw new Error("transfer blob mismatch");
        markEdgeContent(viewRoot, entry.blob.sha256, entry.blob.size);
        mkdirSync(path.dirname(cas), { recursive: true });
        renameSync(incoming, cas);
      }
    }
  }
  const digest = expected;
  const meta = entries.find((entry) => entry.path === READ_MODEL_META_PATH);
  const schemaGeneration = meta
    ? (
        JSON.parse(readFileSync(path.join(casRoot, meta.blob.sha256.slice(0, 2), meta.blob.sha256), "utf8")) as {
          schemaGeneration: number;
        }
      ).schemaGeneration
    : begin.schema === "fleet.delta.begin/v1"
      ? already!.schemaGeneration
      : 0;
  if (!Number.isSafeInteger(schemaGeneration) || schemaGeneration < 0)
    throw new Error("snapshot schema generation is invalid");
  if (schemaGeneration !== cut.schemaGeneration) throw new Error("snapshot schema generation does not match its cut");
  const header = { cut, schemaGeneration, manifestDigest: digest };
  commitEdgeManifest(
    viewRoot,
    header,
    begin.schema === "fleet.delta.begin/v1" ? begin.fromCut : null,
    begin.schema === "fleet.delta.begin/v1" ? changes : entries.map((entry) => ({ op: "put", ...entry })),
  );
  writeEdgeDurableJson(path.join(result, "manifest.json"), header);
  const cutDir = path.join(viewRoot, "cuts", `${cut.revision}-g${schemaGeneration}`);
  mkdirSync(path.dirname(cutDir), { recursive: true });
  if (!existsSync(cutDir)) renameSync(result, cutDir);
  else {
    const retained = readEdgeManifestHeader(path.join(cutDir, "manifest.json"));
    // Persistent identity stores generation beside the canonical cut. Compare
    // those fields, rather than the wire cut's serialized representation.
    if (
      !retained ||
      retained.manifestDigest !== digest ||
      retained.schemaGeneration !== schemaGeneration ||
      retained.cut.revision !== cut.revision ||
      retained.cut.headDigest !== cut.headDigest
    )
      throw new Error("immutable snapshot identity conflict");
    rmSync(result, { recursive: true, force: true });
  }
  killpoint?.("before_current_rename");
  writeEdgeDurableJson(path.join(viewRoot, "current.json"), {
    cut,
    schemaGeneration,
    manifestDigest: digest,
    readerProfile: begin.readerProfile,
    authorizationShapeDigest: begin.authorizationShapeDigest,
  });

  return ack(begin.transferId, cut, digest);
}

function collect(viewRoot: string, casRoot: string, currentIdentity: string | null, compact = false): void {
  const cutsRoot = path.join(viewRoot, "cuts"),
    revisions = existsSync(cutsRoot)
      ? readdirSync(cutsRoot)
          .filter((name) => /^\d+-g\d+$/u.test(name))
          .sort(
            (a, b) =>
              Number(b.split("-g")[0]) - Number(a.split("-g")[0]) ||
              Number(b.split("-g")[1]) - Number(a.split("-g")[1]),
          )
      : [],
    keep = new Set([currentIdentity, ...revisions.filter((revision) => revision !== currentIdentity).slice(0, 63)]);
  for (const revision of revisions.filter((value) => !keep.has(value)).slice(0, 64))
    rmSync(path.join(cutsRoot, String(revision)), { recursive: true, force: true });
  const viewsRoot = path.dirname(viewRoot),
    views = readdirSync(viewsRoot);
  const referenced = referencedEdgeBlobs(viewsRoot, views);
  const released = pruneEdgeManifests(viewRoot).filter((sha) => !referenced.has(sha));
  for (const sha of released) rmSync(path.join(casRoot, sha.slice(0, 2), sha), { force: true });
  forgetEdgeContent(viewRoot, released, compact);
}

function ack(
  transferId: string,
  cut: FleetCut,
  manifestDigest: string,
): Extract<FleetFrameV1, { schema: "fleet.ack/v1" }> {
  return { schema: "fleet.ack/v1", messageId: `${transferId}_ack`, transferId, cut, manifestDigest };
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
    readonly dispatchContext?: import("./contract.ts").FleetRuntimeDispatchContext;
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
// Serialize one node's durable view across both daemon sessions and processes.
export async function runFleetReplicaPullClient(
  options: FleetReplicaPullClientOptions,
): Promise<FleetReplicaPullClientResult> {
  const viewDir = path.join(options.viewRoot, "repos", options.repoId, "views", options.nodeId);
  return withFleetReplicaPullLock(viewDir, async () => {
    try {
      return await pullReplica(options);
    } catch (error) {
      recordReplicaHealth(viewDir, { syncFailure: replicaFailure(error, "replica_pull_failed") });
      if (
        error instanceof FleetRemoteError &&
        [
          "authorization_denied",
          "authentication_required",
          "human_confirmation_required",
          "node_owner_unregistered",
        ].includes(error.code)
      )
        recordNodeReadDenied(options.viewRoot, options.repoId, options.nodeId);
      throw error;
    }
  });
}
async function pullReplica(options: FleetReplicaPullClientOptions): Promise<FleetReplicaPullClientResult> {
  const view = openFleetEdgeView(options.viewRoot, options.diskQuotaBytes, options.edgeKillpoint);
  // The caller holds this view's pull lock: a prior process may have left staging behind.
  view.discard(options.repoId, options.nodeId);
  const session = options.sessionPool ? await options.sessionPool.acquire(options) : await openPeer(options);
  let failed = true;
  let target = typeof options.through === "number" ? options.through : null;
  const deadline = Date.now() + (options.timeoutMs ?? 5_000);
  try {
    for (;;) {
      let result: FleetReplicaPullClientResult;
      await session.send({
        schema: "fleet.replica.pull/v1",
        messageId: session.messageId(),
        repoId: options.repoId,
      });
      for (;;) {
        const inbound = await session.next();
        if (inbound.schema === "fleet.replica.preparing/v1") continue;
        if (inbound.schema === "fleet.replica.current/v1" || inbound.schema === "fleet.replica.checkpoint/v1") {
          const current = view.current(inbound.repoId, inbound.viewId);
          if (
            !current ||
            JSON.stringify(current.cut) !== JSON.stringify(inbound.cut) ||
            current.manifestDigest !== inbound.manifestDigest
          )
            throw new Error("center current differs from edge current");
          writeEdgeDurableJson(
            path.join(options.viewRoot, "repos", inbound.repoId, "views", inbound.viewId, "current.json"),
            {
              cut: inbound.cut,
              schemaGeneration: current.schemaGeneration,
              manifestDigest: inbound.manifestDigest,
              readerProfile: inbound.readerProfile,
              authorizationShapeDigest: inbound.authorizationShapeDigest,
            },
          );
          recordHeadConfirmation(
            path.join(options.viewRoot, "repos", inbound.repoId, "views", inbound.viewId),
            inbound.knownHead,
          );
          result = { replica: inbound, current };
          break;
        }
        const response = view.receive(inbound);
        if (!response) continue;
        if (response.schema !== "fleet.ack/v1") throw new Error("replica ACK expected");
        options.beforeAck?.(response);
        const acknowledged = await session.request(response);
        if (acknowledged.schema !== "fleet.ack.result/v1") throw new Error("ACK result expected");
        if (acknowledged.outcome === "op_rejected") throw new Error("replica ACK rejected");
        // Publication is durable before ACK; reclamation must not consume its delivery lease.
        view.collect(options.repoId, acknowledged.viewId, response.transferId);
        recordHeadConfirmation(
          path.join(options.viewRoot, "repos", options.repoId, "views", acknowledged.viewId),
          acknowledged.knownHead,
        );
        const current = view.current(options.repoId, acknowledged.viewId)!;
        result = { replica: acknowledged, current };
        break;
      }
      if (options.through === "known-head") target ??= result.replica.knownHead.revision;
      if (target === null || result.current.cut.revision >= target) {
        failed = false;
        return result;
      }
      await waitForReplicaCheckpoint(session, options.repoId, target, deadline);
    }
  } finally {
    if (!options.sessionPool) session.close();
    else if (failed) options.sessionPool.discard(options, session);
    else options.sessionPool.release(options, session);
    if (failed) view.discard(options.repoId, options.nodeId);
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
    try {
      for (const line of reader.push(chunk)) {
        const frame = parseFleetFrame(line),
          waiter = waiting.shift();
        if (waiter) {
          clearTimeout(waiter.timer);
          waiter.resolve(frame);
        } else queue.push(frame);
      }
    } catch (error) {
      consumeKnownError(error);
      closed = error instanceof Error ? error : new Error(String(error));
      settleWaiters(closed);
      socket.destroy(closed);
    }
  });
  socket.on("end", () => {
    try {
      reader.finish();
    } catch (error) {
      consumeKnownError(error);
      closed = error instanceof Error ? error : new Error(String(error));
      settleWaiters(closed);
    }
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
function exactJson(file: string, value: unknown): void {
  if (existsSync(file)) {
    if (JSON.stringify(readJson(file)) !== JSON.stringify(value)) throw new Error("transfer replay mismatch");
    return;
  }
  writeEdgeDurableJson(file, value);
}
function writeEdgeDurableJson(file: string, value: unknown): void {
  writeFileDurably(file, `${JSON.stringify(value)}\n`);
}
function readJson<T>(file: string): T | null {
  return existsSync(file) ? (JSON.parse(readFileSync(file, "utf8")) as T) : null;
}
export function fleetReplicaDiskUsage(root: string, repos = path.join(root, "repos")): number {
  if (!existsSync(root)) return 0;
  if (path.basename(root) === "cas" && path.dirname(path.dirname(root)) === repos)
    return edgeContentBytes(path.dirname(root));
  const stat = statSync(root);
  return stat.isDirectory()
    ? readdirSync(root).reduce((sum, name) => sum + fleetReplicaDiskUsage(path.join(root, name), repos), 0)
    : stat.size;
}
