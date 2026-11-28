import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import path from "node:path";
import { sha256Bytes } from "@harness-anything/kernel";
import {
  BASE_BACKUP_ARCHIVE_ROOT,
  listLedgerClaimedContentObjects,
  openFleetStorage,
  openSqliteEventStore,
  writeFileDurablyStream,
  type DaemonStorageConfig,
} from "@harness-anything/storage";
import { withReplicaGeneration, type ReplicaGeneration } from "../../fleet-sync/fleet/replica-generation.ts";
import type { FleetMirrorView } from "../fleet-edge-mirror.ts";
import { immediate, mid } from "./center-transport.ts";
import { FleetFault, type Delivery } from "./center-types.ts";
import { FLEET_CHUNK_BYTES, type FleetFrameV1 } from "./command-protocol.ts";
import { FleetRemoteError, openPeer, type FleetPeer, type FleetPeerOptions } from "./peer.ts";

/** Chunk size for `fleet.blob.get/v1` responses so every frame fits comfortably under FLEET_FRAME_BYTES. */
export const FLEET_BLOB_GET_CHUNK_BYTES = 48 * 1024;

export class EdgeBlobError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

export class BlobNotFetchedOfflineError extends Error {
  readonly code = "blob_not_fetched_offline";
  readonly sha256: string;
  constructor(sha256: string, cause?: unknown) {
    super(
      `Cold blob ${sha256} is not fetched locally and the fleet center is offline or unreachable. ` +
        `Reconnect to fetch on demand or run 'ha daemon fleet edge prefetch --all' while online.`,
      cause === undefined ? undefined : { cause },
    );
    this.sha256 = sha256;
  }
}

export class BlobDigestMismatchError extends Error {
  readonly code = "content_blob_digest_mismatch";
  readonly sha256: string;
  constructor(sha256: string, detail: string) {
    super(`Content blob ${sha256} verification failed: ${detail}`);
    this.sha256 = sha256;
  }
}

export function replicaObjectRoot(generation: ReplicaGeneration): string {
  return path.join(
    generation.rootDir,
    BASE_BACKUP_ARCHIVE_ROOT,
    "store",
    "generations",
    String(generation.metadata.ledgerGeneration),
    "objects",
    "sha256",
  );
}

export function replicaObjectFilePath(objectRoot: string, sha256: string): string {
  if (!/^[0-9a-f]{64}$/u.test(sha256)) {
    throw new EdgeBlobError("invalid_field", `Invalid content blob digest: ${sha256}`);
  }
  return path.join(objectRoot, sha256.slice(0, 2), sha256.slice(2));
}

/** Center-side handler for authenticated TLS `fleet.blob.get/v1` lazy cold-blob fetch requests. */
export async function handleFleetBlobGetFrame(input: {
  readonly nodeId: string;
  readonly frame: Extract<FleetFrameV1, { readonly schema: "fleet.blob.get/v1" }>;
  readonly nodeContext: (
    nodeId: string,
    repoId: string,
    accessToken?: string,
  ) => Promise<{ readonly nodeId: string; readonly repoId: string; readonly accessToken?: string }>;
  readonly admitReplicaRead: (node: {
    readonly nodeId: string;
    readonly repoId: string;
    readonly accessToken?: string;
  }) => Promise<unknown>;
  readonly repoRoot: (repoId: string) => string;
  readonly storage?: Readonly<Record<string, DaemonStorageConfig>>;
}): Promise<Delivery> {
  const { nodeId, frame } = input;
  const ctx = await input.nodeContext(nodeId, frame.repoId, frame.accessToken);
  await input.admitReplicaRead(ctx);
  const rootDir = input.repoRoot(ctx.repoId);
  const store = openFleetStorage({
    rootDir,
    repoId: ctx.repoId,
    storage: input.storage?.[ctx.repoId],
  });
  try {
    const offset = frame.offset ?? 0;
    const requestedLength = Math.min(frame.length ?? FLEET_BLOB_GET_CHUNK_BYTES, FLEET_CHUNK_BYTES);
    let totalSize: number;
    let slice: Uint8Array;
    if (
      "readContentObjectSize" in store &&
      typeof store.readContentObjectSize === "function" &&
      "readContentObjectRange" in store &&
      typeof store.readContentObjectRange === "function"
    ) {
      const size = store.readContentObjectSize(frame.sha256);
      if (size === null) {
        throw new FleetFault("content_blob_missing", `Content blob ${frame.sha256} is not present at the center.`);
      }
      if (offset > size) {
        throw new FleetFault("invalid_field", `Blob offset ${offset} exceeds total blob size ${size}.`);
      }
      totalSize = size;
      const toRead = Math.min(requestedLength, Math.max(0, totalSize - offset));
      if (toRead === 0) {
        slice = Buffer.alloc(0);
      } else {
        const range = store.readContentObjectRange(frame.sha256, offset, toRead);
        if (range === null) {
          throw new FleetFault("content_blob_missing", `Content blob ${frame.sha256} is not present at the center.`);
        }
        slice = range;
      }
    } else {
      const bytes = store.readContentObject(frame.sha256);
      if (bytes === null) {
        throw new FleetFault("content_blob_missing", `Content blob ${frame.sha256} is not present at the center.`);
      }
      totalSize = bytes.byteLength;
      if (offset > totalSize) {
        throw new FleetFault("invalid_field", `Blob offset ${offset} exceeds total blob size ${totalSize}.`);
      }
      slice = bytes.subarray(offset, Math.min(totalSize, offset + requestedLength));
    }
    const eof = offset + slice.byteLength >= totalSize;
    return immediate({
      schema: "fleet.blob.get.result/v1",
      messageId: mid(frame.messageId, "blob"),
      inReplyTo: frame.messageId,
      repoId: ctx.repoId,
      sha256: frame.sha256,
      totalSize,
      offset,
      dataBase64: Buffer.from(slice.buffer, slice.byteOffset, slice.byteLength).toString("base64"),
      eof,
    });
  } finally {
    store.close();
  }
}

export interface FetchFleetBlobResult {
  readonly sha256: string;
  readonly size: number;
  readonly targetPath: string;
  readonly fetched: boolean;
}

/**
 * Fetches one blob over an existing authenticated TLS FleetPeer session, streaming verified chunks
 * into a temporary file, checking SHA-256 and declared byte length before atomic rename into
 * `objects/sha256/<2>/<62>`.
 */
export async function fetchFleetBlobWithSession(input: {
  readonly session: Pick<FleetPeer, "request" | "messageId">;
  readonly repoId: string;
  readonly sha256: string;
  readonly objectRoot: string;
  readonly chunkBytes?: number;
  readonly timeoutMs?: number;
}): Promise<FetchFleetBlobResult> {
  const targetPath = replicaObjectFilePath(input.objectRoot, input.sha256);
  const chunkBytes = Math.min(input.chunkBytes ?? FLEET_BLOB_GET_CHUNK_BYTES, FLEET_CHUNK_BYTES);
  let declaredTotalSize: number | null = null;
  let receivedBytes = 0;

  async function* generateVerifiedChunks(): AsyncGenerator<Uint8Array> {
    const hash = createHash("sha256");
    let offset = 0;
    for (;;) {
      const reply = await input.session.request(
        {
          schema: "fleet.blob.get/v1",
          messageId: input.session.messageId(),
          repoId: input.repoId,
          sha256: input.sha256,
          offset,
          length: chunkBytes,
        },
        input.timeoutMs,
      );
      if (reply.schema !== "fleet.blob.get.result/v1") {
        throw new Error(`Expected fleet.blob.get.result/v1, got ${reply.schema}`);
      }
      if (reply.sha256 !== input.sha256 || reply.repoId !== input.repoId || reply.offset !== offset) {
        throw new BlobDigestMismatchError(
          input.sha256,
          `response metadata mismatch (got sha256=${reply.sha256}, offset=${reply.offset}, expected=${offset})`,
        );
      }
      if (declaredTotalSize === null) {
        declaredTotalSize = reply.totalSize;
      } else if (declaredTotalSize !== reply.totalSize) {
        throw new BlobDigestMismatchError(
          input.sha256,
          `inconsistent totalSize across chunks (${reply.totalSize} !== ${declaredTotalSize})`,
        );
      }
      const chunk = reply.dataBase64.length === 0 ? Buffer.alloc(0) : Buffer.from(reply.dataBase64, "base64");
      receivedBytes += chunk.byteLength;
      if (receivedBytes > declaredTotalSize) {
        throw new BlobDigestMismatchError(
          input.sha256,
          `stream exceeded declared byte length (${receivedBytes} > ${declaredTotalSize})`,
        );
      }
      if (chunk.byteLength > 0) {
        Reflect.apply(hash.update, hash, [chunk]);
        yield chunk;
        offset += chunk.byteLength;
      } else if (!reply.eof && offset < declaredTotalSize) {
        throw new BlobDigestMismatchError(input.sha256, "received empty non-EOF blob chunk");
      }
      if (reply.eof) break;
    }
    if (declaredTotalSize === null || receivedBytes !== declaredTotalSize) {
      throw new BlobDigestMismatchError(
        input.sha256,
        `truncated blob stream (received=${receivedBytes}, declared=${declaredTotalSize ?? -1})`,
      );
    }
    const actualSha256 = hash.digest("hex");
    if (actualSha256 !== input.sha256) {
      throw new BlobDigestMismatchError(input.sha256, `digest mismatch (actual=${actualSha256})`);
    }
  }

  await writeFileDurablyStream(targetPath, generateVerifiedChunks());

  return {
    sha256: input.sha256,
    size: receivedBytes,
    targetPath,
    fetched: true,
  };
}

export async function fetchFleetBlobToObjectRoot(input: {
  readonly peer: FleetPeerOptions;
  readonly sha256: string;
  readonly objectRoot: string;
  readonly chunkBytes?: number;
}): Promise<FetchFleetBlobResult> {
  const session = await openPeer(input.peer);
  try {
    return await fetchFleetBlobWithSession({
      session,
      repoId: input.peer.repoId,
      sha256: input.sha256,
      objectRoot: input.objectRoot,
      chunkBytes: input.chunkBytes,
      timeoutMs: input.peer.timeoutMs,
    });
  } finally {
    session.close();
  }
}

const OFFLINE_ERROR_CODES = new Set([
  "ECONNREFUSED",
  "ECONNRESET",
  "ETIMEDOUT",
  "ENOTFOUND",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "EPIPE",
  "center_address_unreachable",
  "replica_stream_down",
]);
const NON_OFFLINE_ERROR_CODES = new Set([
  "content_blob_digest_mismatch",
  "authorization_denied",
  "authentication_required",
]);
const OFFLINE_MESSAGE_RE =
  /Fleet connection (?:timeout|closed)|Fleet response timeout|connect ECONNREFUSED|socket hang up/iu;

function centerUnreachableError(error: unknown): boolean {
  const rawCode =
    typeof error === "object" && error !== null && "code" in error
      ? String((error as { readonly code?: unknown }).code)
      : "";
  const message = error instanceof Error ? error.message : String(error);
  return (
    !(error instanceof BlobDigestMismatchError) &&
    !(error instanceof FleetRemoteError) &&
    !NON_OFFLINE_ERROR_CODES.has(rawCode) &&
    (OFFLINE_ERROR_CODES.has(rawCode) || OFFLINE_MESSAGE_RE.test(message))
  );
}

/**
 * Transparent on-demand reader for an edge replica blob:
 * 1. Serves immediately from local `objects/sha256/<2>/<62>` if already cached (verifying SHA-256).
 * 2. If locally absent (lazy cold blob) and online (`peer` or `fetchRemote` provided), fetches once
 *    via `fleet.blob.get/v1`, verifies SHA-256 + length streaming to temp file, atomically renames
 *    into `objects/sha256/<2>/<62>`, and returns the verified bytes.
 * 3. Strict L3 fail-closed: if offline or the center is unreachable, NEVER returns empty bytes or
 *    null — throws `BlobNotFetchedOfflineError` (`code: "blob_not_fetched_offline"`).
 */
export async function readEdgeViewBlobLazy(input: {
  readonly view: Pick<FleetMirrorView, "viewDir" | "repoId">;
  readonly sha256: string;
  readonly peer?: FleetPeerOptions | null;
  readonly fetchRemote?: (sha256: string, objectRoot: string) => Promise<void>;
}): Promise<Uint8Array> {
  if (!/^[a-f0-9]{64}$/u.test(input.sha256)) {
    throw new EdgeBlobError("invalid_field", `Invalid content blob digest: ${input.sha256}`);
  }
  const localCheck = withReplicaGeneration(input.view.viewDir, (generation) => {
    if (!generation) {
      throw new EdgeBlobError("replica_unavailable", "Replica generation is unavailable.");
    }
    const store = openSqliteEventStore({
      databasePath: generation.ledgerPath,
      repoId: generation.metadata.repoId,
      generation: generation.metadata.ledgerGeneration,
      readOnly: true,
    });
    try {
      const bytes = store.readContentObject(input.sha256);
      if (bytes !== null) {
        if (sha256Bytes(bytes) !== input.sha256) {
          throw new BlobDigestMismatchError(input.sha256, "local replica object digest mismatch");
        }
        return { hit: true as const, bytes };
      }
      return { hit: false as const, objectRoot: replicaObjectRoot(generation) };
    } finally {
      store.close();
    }
  });
  if (localCheck.hit) return localCheck.bytes;

  if (!input.fetchRemote && !input.peer) {
    throw new BlobNotFetchedOfflineError(input.sha256);
  }
  try {
    if (input.fetchRemote) {
      await input.fetchRemote(input.sha256, localCheck.objectRoot);
    } else {
      await fetchFleetBlobToObjectRoot({
        peer: input.peer!,
        sha256: input.sha256,
        objectRoot: localCheck.objectRoot,
      });
    }
  } catch (error) {
    if (error instanceof BlobNotFetchedOfflineError || error instanceof BlobDigestMismatchError) throw error;
    if (centerUnreachableError(error)) throw new BlobNotFetchedOfflineError(input.sha256, error);
    throw error;
  }

  return withReplicaGeneration(input.view.viewDir, (generation) => {
    if (!generation) {
      throw new EdgeBlobError("replica_unavailable", "Replica generation is unavailable.");
    }
    const store = openSqliteEventStore({
      databasePath: generation.ledgerPath,
      repoId: generation.metadata.repoId,
      generation: generation.metadata.ledgerGeneration,
      readOnly: true,
    });
    try {
      const bytes = store.readContentObject(input.sha256);
      if (bytes === null) throw new BlobNotFetchedOfflineError(input.sha256);
      if (sha256Bytes(bytes) !== input.sha256) {
        throw new BlobDigestMismatchError(input.sha256, "cached blob digest mismatch after fetch");
      }
      return bytes;
    } finally {
      store.close();
    }
  });
}

export interface ReplicaObjectInventory {
  readonly totalObjects: number;
  readonly alreadyPresent: number;
  readonly missingSha256s: readonly string[];
  readonly objectRoot: string;
}

/** Lists all content objects claimed by a replica generation's ledger and identifies unfetched cold blobs. */
export function inspectReplicaMissingObjects(generation: ReplicaGeneration): ReplicaObjectInventory {
  const objectRoot = replicaObjectRoot(generation);
  const claimedSha256s = listLedgerClaimedContentObjects(generation.ledgerPath);
  const missingSha256s: string[] = [];
  let alreadyPresent = 0;
  for (const sha256 of claimedSha256s) {
    const file = replicaObjectFilePath(objectRoot, sha256);
    if (existsSync(file)) alreadyPresent += 1;
    else missingSha256s.push(sha256);
  }
  return {
    totalObjects: claimedSha256s.length,
    alreadyPresent,
    missingSha256s,
    objectRoot,
  };
}

export interface PrefetchReplicaBlobsResult {
  readonly totalObjects: number;
  readonly alreadyPresent: number;
  readonly fetchedCount: number;
  readonly fetchedBytes: number;
  readonly remainingMissing: number;
}

/** Eagerly materializes 100% of unfetched cold blobs over one authenticated TLS session (`prefetch --all`). */
export async function prefetchReplicaBlobs(input: {
  readonly viewDir: string;
  readonly peer: FleetPeerOptions;
  readonly chunkBytes?: number;
}): Promise<PrefetchReplicaBlobsResult> {
  const inventory = withReplicaGeneration(input.viewDir, (generation) => {
    if (!generation) {
      throw new EdgeBlobError("replica_unavailable", "Replica generation is unavailable.");
    }
    return inspectReplicaMissingObjects(generation);
  });
  if (inventory.missingSha256s.length === 0) {
    return {
      totalObjects: inventory.totalObjects,
      alreadyPresent: inventory.alreadyPresent,
      fetchedCount: 0,
      fetchedBytes: 0,
      remainingMissing: 0,
    };
  }
  let fetchedCount = 0;
  let fetchedBytes = 0;
  const session = await openPeer(input.peer);
  try {
    for (const sha256 of inventory.missingSha256s) {
      const fetched = await fetchFleetBlobWithSession({
        session,
        repoId: input.peer.repoId,
        sha256,
        objectRoot: inventory.objectRoot,
        chunkBytes: input.chunkBytes,
        timeoutMs: input.peer.timeoutMs,
      });
      fetchedCount += 1;
      fetchedBytes += fetched.size;
    }
  } finally {
    session.close();
  }
  const after = withReplicaGeneration(input.viewDir, (generation) =>
    generation ? inspectReplicaMissingObjects(generation) : null,
  );
  return {
    totalObjects: inventory.totalObjects,
    alreadyPresent: inventory.alreadyPresent,
    fetchedCount,
    fetchedBytes,
    remainingMissing: after ? after.missingSha256s.length : 0,
  };
}
