import path from "node:path";
import type { EntityId } from "../../../domain/index.ts";
import { sha256Text } from "../../../integrity/stable-hash.ts";
import { noFollowPathComponents } from "../../../layout/path-safety.ts";
import { normalizeRelativeDocumentPath, resolveHarnessLayout, type HarnessLayoutInput } from "../../../layout/index.ts";
import type { WriteOp } from "../../../ports/write-coordinator.ts";
import { durableFileExists, durableFileIsRegularNoFollow, readFileBytes, removeFileDurably, writeFileDurably } from "../durable.ts";
import { rejectWrite } from "../rejection.ts";

export interface CanonicalAuthoredWrite {
  readonly path: string;
  readonly body?: string;
  readonly bodySha256?: string;
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
    const hasBody = typeof candidate.body === "string";
    const hasWorkingTreeBody = typeof candidate.bodySha256 === "string"
      && /^[a-f0-9]{64}$/u.test(candidate.bodySha256);
    if (typeof candidate.path !== "string" || hasBody === hasWorkingTreeBody ||
      (candidate.baseBlobSha256 !== null && typeof candidate.baseBlobSha256 !== "string")) {
      malformed(op);
    }
    if (hasWorkingTreeBody && op.kind !== "doc_sync_submit") {
      rejectWrite(`${op.kind} cannot use a working-tree body reference`, op.entityId);
    }
    const normalized = normalizeBatchPath(candidate.path, op.entityId);
    if (isTaskTypedAuthorityPath(normalized)) {
      rejectWrite(`${op.kind} cannot write Task typed-authority path: ${normalized}`, op.entityId);
    }
    if (paths.has(normalized)) rejectWrite(`duplicate canonical authored batch path: ${normalized}`, op.entityId);
    paths.add(normalized);
    return {
      path: normalized,
      ...(hasBody ? { body: candidate.body } : { bodySha256: candidate.bodySha256 }),
      baseBlobSha256: candidate.baseBlobSha256
    };
  });
}

function isTaskTypedAuthorityPath(relativePath: string): boolean {
  return /^tasks\/[^/]+\/INDEX\.md$/u.test(relativePath) ||
    /^tasks\/[^/]+\/task-contract\.json$/u.test(relativePath) ||
    /^tasks\/[^/]+\/(?:executions|consents|reviews)(?:\/|$)/u.test(relativePath);
}

export function canonicalAuthoredBatchPaths(rootInput: HarnessLayoutInput, op: WriteOp): ReadonlyArray<string> {
  const authoredRoot = resolveHarnessLayout(rootInput).authoredRoot;
  return canonicalAuthoredBatchWrites(op).map((write) => path.join(authoredRoot, write.path));
}

export function validateCanonicalAuthoredBatch(rootInput: HarnessLayoutInput, op: WriteOp): void {
  const authoredRoot = resolveHarnessLayout(rootInput).authoredRoot;
  for (const write of canonicalAuthoredBatchWrites(op)) {
    const targetPath = path.join(authoredRoot, write.path);
    assertCanonicalAuthoredPath(authoredRoot, op, targetPath, write.path);
    const currentHash = durableFileExists(targetPath) ? sha256Text(readText(targetPath)) : null;
    const submittedHash = write.bodySha256 ?? sha256Text(write.body!);
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
  for (const write of writes) assertCanonicalAuthoredPath(authoredRoot, op, write.targetPath, write.path);
  verifyCanonicalAuthoredWorkingTreeReferences(authoredRoot, op, writes);
  const changedWrites = writes.filter((write) => write.body !== undefined);
  const backups = changedWrites.map((write) => ({
    targetPath: write.targetPath,
    existed: durableFileExists(write.targetPath),
    body: durableFileExists(write.targetPath) ? readFileBytes(write.targetPath) : null
  }));
  const writtenBackups: typeof backups[number][] = [];
  try {
    for (const [index, write] of changedWrites.entries()) {
      assertCanonicalAuthoredPath(authoredRoot, op, write.targetPath, write.path);
      writeFileDurably(write.targetPath, write.body!);
      writtenBackups.push(backups[index]!);
    }
  } catch (error) {
    for (const backup of writtenBackups.reverse()) {
      assertCanonicalAuthoredPath(authoredRoot, op, backup.targetPath, "rollback target");
      if (backup.existed && backup.body !== null) {
        writeFileDurably(backup.targetPath, backup.body);
      } else {
        removeFileDurably(backup.targetPath);
      }
    }
    throw error;
  }
}

export function verifyAppliedCanonicalAuthoredBatch(rootInput: HarnessLayoutInput, op: WriteOp): void {
  const authoredRoot = resolveHarnessLayout(rootInput).authoredRoot;
  const writes = canonicalAuthoredBatchWrites(op).map((write) => ({
    ...write,
    targetPath: path.join(authoredRoot, write.path)
  }));
  for (const write of writes) assertCanonicalAuthoredPath(authoredRoot, op, write.targetPath, write.path);
  verifyCanonicalAuthoredWorkingTreeReferences(authoredRoot, op, writes);
}

function verifyCanonicalAuthoredWorkingTreeReferences(
  authoredRoot: string,
  op: WriteOp,
  writes: ReadonlyArray<CanonicalAuthoredWrite & { readonly targetPath: string }>
): void {
  for (const write of writes) {
    if (write.bodySha256 === undefined) continue;
    assertCanonicalAuthoredPath(authoredRoot, op, write.targetPath, write.path);
    assertRegularWorkingTreeReference(op, write);
    let actualHash: string;
    try {
      actualHash = sha256Text(readText(write.targetPath));
    } catch {
      rejectWrite(
        `canonical authored working-tree body reference could not be read before ${op.kind}: ${write.path}`,
        op.entityId
      );
    }
    assertCanonicalAuthoredPath(authoredRoot, op, write.targetPath, write.path);
    assertRegularWorkingTreeReference(op, write);
    if (actualHash !== write.bodySha256) {
      rejectWrite(
        `canonical authored working-tree body reference changed before ${op.kind}: ${write.path}; expected ${write.bodySha256}, current ${actualHash}`,
        op.entityId
      );
    }
  }
}

function assertCanonicalAuthoredPath(
  authoredRoot: string,
  op: WriteOp,
  targetPath: string,
  displayPath: string
): void {
  const check = noFollowPathComponents(authoredRoot, targetPath);
  if (check.ok) return;
  rejectWrite(
    `canonical authored path must remain inside non-symlink path components before ${op.kind}: ${displayPath}; ${check.reason}`,
    op.entityId
  );
}

function assertRegularWorkingTreeReference(
  op: WriteOp,
  write: CanonicalAuthoredWrite & { readonly targetPath: string }
): void {
  if (durableFileIsRegularNoFollow(write.targetPath)) return;
  rejectWrite(
    `canonical authored working-tree body reference must remain a regular file before ${op.kind}: ${write.path}`,
    op.entityId
  );
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
  rejectWrite(`${op.kind} requires writes with path, exactly one of body/bodySha256, and baseBlobSha256`, op.entityId);
}
