import path from "node:path";
import { localContentObjectFileSystem } from "@harness-anything/kernel/internal/local/local-layout-file-system.ts";
import { sha256Bytes } from "@harness-anything/kernel/internal/integrity/stable-hash.ts";
import { readFileWindow } from "../durable-file.ts";
import { validateContentRange } from "../content-blob-range.ts";
import { TaskEventStoreError } from "@harness-anything/kernel/internal/ports/task-event-store.ts";
import type {
  EventContentPrefetch,
  EventStreamPort,
} from "@harness-anything/kernel/internal/ports/task-projection-source.ts";
import type { CanonicalContentBlob, CanonicalEventV1 } from "@harness-anything/kernel";
import { contentClaims } from "@harness-anything/kernel/internal/ports/canonical-document-claims.ts";

export interface VerifiedContentBlob {
  readonly sha256: string;
  readonly size: number;
  readonly bytes: Uint8Array;
  utf8Default?: string;
  utf8IgnoreBom?: string;
}

export type VerifiedContentBlobReader = (sha256: string) => VerifiedContentBlob | null;

export interface BatchContentReader {
  readonly prefetchBytes: (digests: ReadonlySet<string>) => ReadonlyMap<string, Uint8Array | null>;
  readonly prefetchSizes: (digests: ReadonlySet<string>) => ReadonlyMap<string, number | null>;
}

const MAX_VERIFIED_OBJECT_CACHE_ENTRIES = 256;
const MAX_VERIFIED_OBJECT_CACHE_BYTES = 8 * 1024 * 1024;
const MAX_VERIFIED_OBJECT_SINGLE_BYTES = 1024 * 1024;

interface CachedVerifiedObject {
  readonly stamp: string;
  readonly entry: VerifiedContentBlob;
}

const verifiedObjectCache = new Map<string, CachedVerifiedObject>();
let verifiedObjectCacheBytes = 0;

function removeCachedVerifiedObject(target: string): void {
  const existing = verifiedObjectCache.get(target);
  if (existing === undefined) return;
  verifiedObjectCacheBytes -= existing.entry.size;
  verifiedObjectCache.delete(target);
}

function cacheVerifiedObject(target: string, stamp: string, entry: VerifiedContentBlob): void {
  if (entry.size > MAX_VERIFIED_OBJECT_SINGLE_BYTES) return;
  removeCachedVerifiedObject(target);
  verifiedObjectCache.set(target, { stamp, entry });
  verifiedObjectCacheBytes += entry.size;
  while (
    verifiedObjectCache.size > MAX_VERIFIED_OBJECT_CACHE_ENTRIES ||
    verifiedObjectCacheBytes > MAX_VERIFIED_OBJECT_CACHE_BYTES
  ) {
    const oldestKey = verifiedObjectCache.keys().next().value;
    if (oldestKey === undefined) break;
    removeCachedVerifiedObject(oldestKey);
  }
}

const verifiedContentBlobReaders = new WeakMap<EventStreamPort["readContentBlob"], VerifiedContentBlobReader>();

export function registerVerifiedContentBlobReader(
  readBlob: EventStreamPort["readContentBlob"],
  reader: VerifiedContentBlobReader,
): void {
  verifiedContentBlobReaders.set(readBlob, reader);
}

export function verifiedContentBlobReaderFor(
  readBlob: EventStreamPort["readContentBlob"] | undefined,
): VerifiedContentBlobReader | undefined {
  return readBlob === undefined ? undefined : verifiedContentBlobReaders.get(readBlob);
}

const batchContentReaders = new WeakMap<EventContentPrefetch, BatchContentReader>();

export function registerBatchContentReader(prefetch: EventContentPrefetch, reader: BatchContentReader): void {
  batchContentReaders.set(prefetch, reader);
}

export function batchContentReaderFor(prefetch: EventContentPrefetch | undefined): BatchContentReader | undefined {
  return prefetch === undefined ? undefined : batchContentReaders.get(prefetch);
}

// Claimed content objects live under objectRoot/<2>/<62>; every claim is validated before any object is
// written, and objects are persisted in fsync batches ahead of the SQLite accept.
export function persistContentObjects(
  objectRoot: string,
  events: readonly CanonicalEventV1[],
  blobs: readonly CanonicalContentBlob[] | ReadonlyMap<string, CanonicalContentBlob>,
): void {
  const supplied = "get" in blobs ? blobs : new Map(blobs.map((blob) => [blob.sha256, blob])),
    pending = new Map<string, { readonly sha256: string; readonly bytes: Uint8Array }>();
  for (const event of events)
    for (const claim of contentClaims(event)) {
      const target = objectPath(objectRoot, claim.sha256);
      if (localContentObjectFileSystem.exists(target)) continue;
      const blob = supplied.get(claim.sha256),
        bytes = blob === undefined ? null : typeof blob.body === "string" ? Buffer.from(blob.body) : blob.body;
      if (!blob || !bytes || blob.size !== claim.size || bytes.byteLength !== claim.size)
        throw new TaskEventStoreError("invalid_write_plan", `event content object ${claim.sha256} is missing`);
      pending.set(target, { sha256: claim.sha256, bytes });
    }
  const entries = [...pending].map(([target, value]) => ({ path: target, body: value.bytes, sha256: value.sha256 }));
  for (let offset = 0; offset < entries.length; offset += 128)
    localContentObjectFileSystem.replaceMany(entries.slice(offset, offset + 128));
  for (const entry of entries) {
    const info = localContentObjectFileSystem.fileStamp(entry.path);
    if (info !== null && info.size === entry.body.byteLength) {
      cacheVerifiedObject(entry.path, info.stamp, {
        sha256: entry.sha256,
        size: entry.body.byteLength,
        bytes: entry.body,
      });
    }
  }
}

export function prepareContentObjects(
  objectRoot: string,
  events: readonly CanonicalEventV1[],
  blobs: readonly CanonicalContentBlob[],
): void {
  persistContentObjects(objectRoot, events, blobs);
}

/**
 * Record blobs already committed to CAS by an out-of-thread canonical writer into this isolate's
 * stat-validated LRU cache so subsequent reads avoid redundant disk reads and SHA-256 passes.
 */
export function rememberPersistedContentObjects(objectRoot: string, blobs: readonly CanonicalContentBlob[]): void {
  for (const blob of blobs) {
    const bytes = typeof blob.body === "string" ? Buffer.from(blob.body) : blob.body;
    if (bytes.byteLength !== blob.size) continue;
    const target = objectPath(objectRoot, blob.sha256);
    const info = localContentObjectFileSystem.fileStamp(target);
    if (info !== null && info.size === bytes.byteLength) {
      cacheVerifiedObject(target, info.stamp, {
        sha256: blob.sha256,
        size: bytes.byteLength,
        bytes,
      });
    }
  }
}

export function objectPath(objectRoot: string, sha256: string): string {
  if (!/^[0-9a-f]{64}$/u.test(sha256)) throw new Error("content object hash is invalid");
  return path.join(objectRoot, sha256.slice(0, 2), sha256.slice(2));
}

export function readContentObject(objectRoot: string, sha256: string): Uint8Array | null {
  const target = objectPath(objectRoot, sha256);
  return localContentObjectFileSystem.exists(target) ? localContentObjectFileSystem.readBytes(target) : null;
}

/**
 * Read a content object with stat-validated LRU caching and strict SHA-256 verification on miss.
 * Every hit verifies the file's device/inode/size/mtime/ctime stamp via `statSync`, so deletion
 * or disk modification immediately invalidates the entry without bypassing L3 integrity checks.
 */
export function readVerifiedContentObject(objectRoots: readonly string[], sha256: string): VerifiedContentBlob | null {
  for (const objectRoot of objectRoots) {
    const target = objectPath(objectRoot, sha256);
    const info = localContentObjectFileSystem.fileStamp(target);
    if (info === null) {
      removeCachedVerifiedObject(target);
      continue;
    }
    const cached = verifiedObjectCache.get(target);
    if (cached !== undefined && cached.stamp === info.stamp && cached.entry.sha256 === sha256) {
      cacheVerifiedObject(target, cached.stamp, cached.entry);
      return cached.entry;
    }
    const bytes = localContentObjectFileSystem.readBytes(target);
    const actualSha256 = sha256Bytes(bytes);
    if (actualSha256 !== sha256) {
      removeCachedVerifiedObject(target);
      return { sha256: actualSha256, size: bytes.byteLength, bytes };
    }
    const entry: VerifiedContentBlob = { sha256, size: bytes.byteLength, bytes };
    cacheVerifiedObject(target, info.stamp, entry);
    return entry;
  }
  return null;
}

export function contentObjectSize(objectRoot: string, sha256: string): number | null {
  const target = objectPath(objectRoot, sha256);
  return localContentObjectFileSystem.exists(target) ? localContentObjectFileSystem.sizeBytes(target) : null;
}

/** Read one bounded window without materializing the complete content object. */
export function readContentObjectRange(
  objectRoot: string,
  sha256: string,
  offset: number,
  maxBytes: number,
): Uint8Array | null {
  validateContentRange(offset, maxBytes);
  const target = objectPath(objectRoot, sha256);
  if (!localContentObjectFileSystem.exists(target)) return null;
  return readFileWindow(target, offset, maxBytes);
}

export function listContentObjectDigests(objectRoot: string): readonly string[] {
  if (!localContentObjectFileSystem.exists(objectRoot)) return [];
  return localContentObjectFileSystem
    .readNames(objectRoot)
    .filter((prefix) => /^[0-9a-f]{2}$/u.test(prefix))
    .flatMap((prefix) =>
      localContentObjectFileSystem
        .readNames(path.join(objectRoot, prefix))
        .filter((name) => /^[0-9a-f]{62}$/u.test(name))
        .map((name) => `${prefix}${name}`),
    )
    .sort();
}
