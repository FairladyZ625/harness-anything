import { createHash } from "node:crypto";
import type {
  ReplicaChangeLog,
  ReplicaChangeRecord
} from "@harness-anything/application";
import {
  foldPortableComponent,
  validatePortableManagedPath
} from "@harness-anything/application";
import type { AuthoritySnapshotManifestEntry } from "./protocol.ts";
import type { DurableAuthorityStateTable } from "./production/service-state.ts";
import { readAuthorityGitBytes } from "./production/publication-evidence.ts";

type ReplicaChangeDraft = Parameters<ReplicaChangeLog["append"]>[0];
type ReplicaFileMode = NonNullable<ReplicaChangeRecord["paths"][number]["mode"]>;
type ReplicaPathChange = ReplicaChangeRecord["paths"][number];
type Sha256Digest = ReplicaChangeRecord["manifest"]["digest"];

export interface AuthorityReplicaSnapshot {
  readonly commitSha: string;
  readonly manifestDigest: Sha256Digest;
  readonly pinnedBlobSetDigest: Sha256Digest;
  readonly entries: ReadonlyArray<AuthoritySnapshotManifestEntry>;
}

export interface AuthorityReplicationContentStore {
  readonly snapshot: (commitSha: string, revision: number) => AuthorityReplicaSnapshot;
  readonly blob: (digest: Sha256Digest) => Uint8Array;
  readonly describeChange: (draft: ReplicaChangeDraft) => ReplicaChangeRecord;
}

export function createAuthorityReplicationContentStore(input: {
  readonly gitRoot: string;
  readonly state: DurableAuthorityStateTable;
  readonly workspaceId: string;
  readonly epoch: string;
}): AuthorityReplicationContentStore {
  const cache = new Map<string, ReadonlyArray<AuthoritySnapshotManifestEntry>>();

  return {
    snapshot: buildReplicaSnapshot,
    blob: (digest) => {
      validateBlobDigest(digest);
      const encoded = input.state.get<string>(blobStateKey(digest));
      if (!encoded) throw new Error(`RESYNC_REQUIRED:BLOB_NOT_RETAINED:${digest}`);
      const bytes = Buffer.from(encoded, "base64");
      if (bytes.toString("base64") !== encoded || digestBlobBytes(bytes) !== digest) {
        throw new Error(`BLOB_DIGEST_MISMATCH:${digest}`);
      }
      return bytes;
    },
    describeChange: (draft) => {
      const current = buildReplicaSnapshot(draft.commitSha, draft.revision);
      const previous = draft.previousCommit ? loadReplicaEntries(draft.previousCommit) : undefined;
      return {
        ...draft,
        schema: "replica-change/v2",
        operations: draft.operations ?? [{
          opId: draft.opId,
          semanticDigest: draft.semanticDigest,
          ...(draft.authorityIntegrity ? { authorityIntegrity: draft.authorityIntegrity } : {})
        }],
        manifest: { digest: current.manifestDigest, entryCount: current.entries.length },
        paths: diffSnapshots(previous ?? [], current.entries)
      };
    }
  };

  function buildReplicaSnapshot(commitSha: string, revision: number): AuthorityReplicaSnapshot {
    const entries = loadReplicaEntries(commitSha);
    const value: AuthorityReplicaSnapshot = {
      commitSha,
      manifestDigest: manifestDigest({
        workspaceId: input.workspaceId,
        epoch: input.epoch,
        revision,
        commitSha
      }, entries),
      pinnedBlobSetDigest: digestSet(entries.map((entry) => entry.blobDigest)),
      entries
    };
    return structuredClone(value);
  }

  function loadReplicaEntries(commitSha: string): ReadonlyArray<AuthoritySnapshotManifestEntry> {
    const cached = cache.get(commitSha);
    if (cached) return structuredClone(cached);
    const entries = readGitEntries(input.gitRoot, commitSha, storeBlob);
    cache.set(commitSha, entries);
    return structuredClone(entries);
  }

  function storeBlob(bytes: Uint8Array): Sha256Digest {
    const digest = digestBlobBytes(bytes);
    const key = blobStateKey(digest);
    const known = input.state.get<string>(key);
    if (known) {
      const knownBytes = Buffer.from(known, "base64");
      if (knownBytes.toString("base64") !== known || digestBlobBytes(knownBytes) !== digest) {
        throw new Error(`BLOB_DIGEST_MISMATCH:${digest}`);
      }
      return digest;
    }
    input.state.put(key, Buffer.from(bytes).toString("base64"));
    return digest;
  }
}

export function createContentEnrichedReplicaChangeLog(
  base: ReplicaChangeLog,
  content: AuthorityReplicationContentStore
): ReplicaChangeLog {
  const hydrate = (record: ReplicaChangeRecord | undefined) => record === undefined
    ? undefined
    : hydrateRecord(record, content);
  return {
    append: (draft) => base.append(content.describeChange(draft)),
    latest: async (workspaceId) => hydrate(await base.latest(workspaceId)),
    getByOperation: async (workspaceId, opId) => hydrate(await base.getByOperation(workspaceId, opId)),
    changesAfter: async (workspaceId, revision) =>
      (await base.changesAfter(workspaceId, revision)).map((record) => hydrateRecord(record, content)),
    subscribe: (workspaceId, listener) => base.subscribe(workspaceId, (record) => listener(hydrateRecord(record, content)))
  };
}

export function manifestDigest(
  cut: { readonly workspaceId: string; readonly epoch: string; readonly revision: number; readonly commitSha: string },
  entries: ReadonlyArray<AuthoritySnapshotManifestEntry>
): Sha256Digest {
  const hash = createHash("sha256").update("ha/authority-snapshot-manifest/v1\0", "utf8");
  updateField(hash, Buffer.from(cut.workspaceId, "utf8"));
  updateField(hash, Buffer.from(cut.epoch, "utf8"));
  updateField(hash, Buffer.from(String(cut.revision), "ascii"));
  updateField(hash, Buffer.from(cut.commitSha, "ascii"));
  for (const entry of [...entries].sort(compareEntries)) {
    updateField(hash, Buffer.from(entry.path, "utf8"));
    updateField(hash, Buffer.from(entry.mode, "ascii"));
    updateField(hash, Buffer.from(entry.blobDigest, "ascii"));
    updateField(hash, Buffer.from([0]));
  }
  return `sha256:${hash.digest("hex")}`;
}

export function digestSet(digests: ReadonlyArray<Sha256Digest>): Sha256Digest {
  const hash = createHash("sha256").update("ha/authority-pinned-blob-set/v1\0", "utf8");
  for (const digest of [...new Set(digests)].sort()) updateField(hash, Buffer.from(digest, "ascii"));
  return `sha256:${hash.digest("hex")}`;
}

function hydrateRecord(
  record: ReplicaChangeRecord,
  content: AuthorityReplicationContentStore
): ReplicaChangeRecord {
  if (isCompleteChange(record)) return structuredClone(record);
  return content.describeChange(record);
}

function isCompleteChange(record: ReplicaChangeRecord): boolean {
  return Boolean(record.manifest?.digest)
    && Number.isSafeInteger(record.manifest?.entryCount)
    && Array.isArray(record.paths);
}

function readGitEntries(
  root: string,
  commitSha: string,
  persistBlob: (bytes: Uint8Array) => Sha256Digest
): ReadonlyArray<AuthoritySnapshotManifestEntry> {
  const listing = readAuthorityGitBytes(root, "ls-tree", "-r", "-z", "--full-tree", commitSha);
  const entries = splitNul(listing).map((row) => {
    const separator = row.indexOf(0x09);
    const metadata = separator >= 0 ? row.subarray(0, separator).toString("ascii") : "";
    const match = /^(100644|100755|120000) blob ([0-9a-f]+)$/u.exec(metadata);
    if (!match || separator < 0) throw new Error(`RESYNC_REQUIRED:UNSUPPORTED_GIT_TREE_ENTRY:${metadata.slice(0, 80)}`);
    const pathBytes = row.subarray(separator + 1);
    const pathName = decodePortableGitPath(pathBytes);
    const bytes = readAuthorityGitBytes(root, "cat-file", "blob", match[2]!);
    return {
      path: pathName,
      blobDigest: persistBlob(bytes),
      mode: match[1] as ReplicaFileMode,
      tombstone: false as const
    };
  }).sort(compareEntries);
  const portableKeys = new Set<string>();
  for (const entry of entries) {
    const portableKey = entry.path.split("/").map(foldPortableComponent).join("/");
    if (portableKeys.has(portableKey)) throw new Error(`RESYNC_REQUIRED:PORTABLE_PATH_COLLISION:${portableKey}`);
    portableKeys.add(portableKey);
  }
  return entries;
}

function splitNul(value: Uint8Array): ReadonlyArray<Buffer> {
  const bytes = Buffer.from(value);
  const rows: Buffer[] = [];
  let start = 0;
  for (let index = 0; index < bytes.length; index += 1) {
    if (bytes[index] !== 0) continue;
    if (index > start) rows.push(bytes.subarray(start, index));
    start = index + 1;
  }
  if (start !== bytes.length) throw new Error("RESYNC_REQUIRED:GIT_TREE_NOT_NUL_TERMINATED");
  return rows;
}

function decodePortableGitPath(pathBytes: Uint8Array): string {
  let pathName: string;
  try {
    pathName = new TextDecoder("utf-8", { fatal: true }).decode(pathBytes);
  } catch {
    throw new Error(`RESYNC_REQUIRED:GIT_PATH_NOT_UTF8:${Buffer.from(pathBytes).toString("hex").slice(0, 80)}`);
  }
  if (!Buffer.from(pathName, "utf8").equals(Buffer.from(pathBytes))) {
    throw new Error(`RESYNC_REQUIRED:GIT_PATH_NOT_UTF8_ROUND_TRIP:${Buffer.from(pathBytes).toString("hex").slice(0, 80)}`);
  }
  try {
    validatePortableManagedPath(pathName);
  } catch {
    throw new Error(`RESYNC_REQUIRED:GIT_PATH_NOT_PORTABLE:${pathName}`);
  }
  return pathName;
}

function diffSnapshots(
  previous: ReadonlyArray<AuthoritySnapshotManifestEntry>,
  current: ReadonlyArray<AuthoritySnapshotManifestEntry>
): ReadonlyArray<ReplicaPathChange> {
  const oldEntries = new Map(previous.map((entry) => [entry.path, entry]));
  const newEntries = new Map(current.map((entry) => [entry.path, entry]));
  const paths = [...new Set([...oldEntries.keys(), ...newEntries.keys()])].sort(comparePaths);
  return paths.flatMap((pathName) => {
    const oldEntry = oldEntries.get(pathName);
    const newEntry = newEntries.get(pathName);
    if (oldEntry?.blobDigest === newEntry?.blobDigest && oldEntry?.mode === newEntry?.mode) return [];
    return [newEntry ?? { path: pathName, blobDigest: null, mode: null, tombstone: true }];
  });
}

function validateBlobDigest(digest: Sha256Digest): void {
  if (!/^sha256:[0-9a-f]{64}$/u.test(digest)) throw new Error(`BLOB_DIGEST_MISMATCH:${digest}`);
}

function blobStateKey(digest: Sha256Digest): string {
  validateBlobDigest(digest);
  return `blob:${digest}`;
}

function digestBlobBytes(bytes: Uint8Array): Sha256Digest {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

function compareEntries(left: AuthoritySnapshotManifestEntry, right: AuthoritySnapshotManifestEntry): number {
  return comparePaths(left.path, right.path);
}

function comparePaths(left: string, right: string): number {
  return Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"));
}

function updateField(hash: ReturnType<typeof createHash>, value: Uint8Array): void {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(value.byteLength);
  hash.update(length).update(value);
}
