import path from "node:path";
import type { EntityId } from "../domain/index.ts";
import { sha256Text } from "../integrity/stable-hash.ts";
import { normalizeRelativeDocumentPath, resolveHarnessLayout, type HarnessLayoutInput } from "../layout/index.ts";
import type { WriteOp } from "../ports/write-coordinator.ts";
import { durableFileExists, readFileBytes, removeFileDurably, writeFileDurably } from "./write-journal-durable.ts";
import { rejectWrite } from "./write-journal-rejection.ts";

export interface CanonicalAuthoredWrite {
  readonly path: string;
  readonly body: string;
  readonly baseBlobSha256: string | null;
}

export function canonicalAuthoredBatchWrites(op: WriteOp): ReadonlyArray<CanonicalAuthoredWrite> {
  if (op.kind !== "doc_sync_submit" && op.kind !== "script_ingest") {
    rejectWrite(`unsupported canonical authored batch kind: ${op.kind}`, op.entityId);
  }
  const writes = payloadWrites(op.payload);
  if (writes.length === 0) rejectWrite(`${op.kind} requires at least one canonical authored write`, op.entityId);
  const paths = new Set<string>();
  return writes.map((write) => {
    if (!write || typeof write !== "object") malformed(op);
    const candidate = write as Partial<CanonicalAuthoredWrite>;
    if (typeof candidate.path !== "string" || typeof candidate.body !== "string" ||
      (candidate.baseBlobSha256 !== null && typeof candidate.baseBlobSha256 !== "string")) {
      malformed(op);
    }
    const normalized = normalizeBatchPath(candidate.path, op.entityId);
    if (isTaskTypedAuthorityPath(normalized)) {
      rejectWrite(`${op.kind} cannot write Task typed-authority path: ${normalized}`, op.entityId);
    }
    if (paths.has(normalized)) rejectWrite(`duplicate canonical authored batch path: ${normalized}`, op.entityId);
    paths.add(normalized);
    return { path: normalized, body: candidate.body, baseBlobSha256: candidate.baseBlobSha256 };
  });
}

function isTaskTypedAuthorityPath(relativePath: string): boolean {
  return /^tasks\/[^/]+\/INDEX\.md$/u.test(relativePath) ||
    /^tasks\/[^/]+\/task-contract\.json$/u.test(relativePath) ||
    /^tasks\/[^/]+\/(?:executions|reviews)(?:\/|$)/u.test(relativePath);
}

export function canonicalAuthoredBatchPaths(rootInput: HarnessLayoutInput, op: WriteOp): ReadonlyArray<string> {
  const authoredRoot = resolveHarnessLayout(rootInput).authoredRoot;
  return canonicalAuthoredBatchWrites(op).map((write) => path.join(authoredRoot, write.path));
}

export function validateCanonicalAuthoredBatch(rootInput: HarnessLayoutInput, op: WriteOp): void {
  const authoredRoot = resolveHarnessLayout(rootInput).authoredRoot;
  for (const write of canonicalAuthoredBatchWrites(op)) {
    const targetPath = path.join(authoredRoot, write.path);
    const currentHash = durableFileExists(targetPath) ? sha256Text(readText(targetPath)) : null;
    const submittedHash = sha256Text(write.body);
    const acceptsPreAppliedDocSync = op.kind === "doc_sync_submit" && currentHash === submittedHash;
    if (currentHash !== write.baseBlobSha256 && !acceptsPreAppliedDocSync) {
      rejectWrite(`canonical authored base changed before ${op.kind}: ${write.path}`, op.entityId);
    }
  }
}

export function applyCanonicalAuthoredBatch(rootInput: HarnessLayoutInput, op: WriteOp): void {
  const authoredRoot = resolveHarnessLayout(rootInput).authoredRoot;
  const writes = canonicalAuthoredBatchWrites(op).map((write) => ({
    ...write,
    targetPath: path.join(authoredRoot, write.path)
  }));
  const backups = writes.map((write) => ({
    targetPath: write.targetPath,
    existed: durableFileExists(write.targetPath),
    body: durableFileExists(write.targetPath) ? readFileBytes(write.targetPath) : null
  }));
  try {
    for (const write of writes) writeFileDurably(write.targetPath, write.body);
  } catch (error) {
    for (const backup of backups.reverse()) {
      if (backup.existed && backup.body !== null) {
        writeFileDurably(backup.targetPath, backup.body);
      } else {
        removeFileDurably(backup.targetPath);
      }
    }
    throw error;
  }
}

function readText(filePath: string): string {
  return Buffer.from(readFileBytes(filePath)).toString("utf8");
}

function payloadWrites(payload: unknown): ReadonlyArray<unknown> {
  if (!payload || typeof payload !== "object" || !Array.isArray((payload as { readonly writes?: unknown }).writes)) return [];
  return (payload as { readonly writes: ReadonlyArray<unknown> }).writes;
}

function normalizeBatchPath(input: string, entityId: EntityId): string {
  try {
    return normalizeRelativeDocumentPath(input);
  } catch (error) {
    rejectWrite(error instanceof Error ? error.message : String(error), entityId);
  }
}

function malformed(op: WriteOp): never {
  rejectWrite(`${op.kind} requires writes with path, body, and baseBlobSha256`, op.entityId);
}
