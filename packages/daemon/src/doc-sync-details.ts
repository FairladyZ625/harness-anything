import { existsSync, lstatSync, readFileSync, unlinkSync } from "node:fs";
import path from "node:path";
import type { TaskProjection } from "../../kernel/src/index.ts";
import {
  DOC_POLICY_ID,
  documentPath,
  resolveDocRoute,
  resolveHarnessLayout,
  sha256Bytes,
  stableStringify,
  type ActorIdentity,
  type DocClaimRef,
  type DocEventV1,
  type DocSyncReceiptDetail,
  type DocWriteIntent,
  type LedgerCutIdentity,
  type WriteSource,
} from "../../kernel/src/index.ts";
import type { Input } from "./doc-sync-command-actions.ts";
import { localProseSource } from "./doc-sync-files.ts";

interface BlockedCandidate {
  readonly path: string;
  readonly reason: string | null;
  readonly requiredRoute: string | null;
}

export function blockedCandidateNextAction(
  candidate: BlockedCandidate,
  nextStep = "rerun ha doc sync --submit",
): string {
  const route = candidate.requiredRoute ?? resolveDocRoute(documentPath(candidate.path)).requiredRoute;
  return `resolve ${candidate.path} through ${route}: ${candidate.reason ?? "candidate is blocked"}; then ${nextStep}`;
}

export function readDetail(
  input: Input,
  paths: readonly string[],
  current: LedgerCutIdentity,
  lease: ReturnType<TaskProjection["currentLeaseForExecution"]>,
  unresolvedTouches: DocSyncReceiptDetail["unresolvedTouches"],
): DocSyncReceiptDetail {
  const reads = paths.map((candidate) => input.projection.readDocument(candidate));
  return {
    kind: "doc_sync",
    code: unresolvedTouches.length ? "assignment_scope_mismatch" : input.action.kind,
    baseLedgerSha: current,
    currentLedgerSha: current,
    paths: reads.map((read, index) => ({
      path: paths[index]!,
      baseBlobSha256: read.document?.blobSha256 ?? null,
      currentBlobSha256: read.document?.blobSha256 ?? null,
      candidateBlobSha256: null,
    })),
    holder: holder(lease),
    differences: [],
    unresolvedTouches,
    deletions: [],
    nextAction: reads.every((read) => read.status === "ready")
      ? "submit against this base cut"
      : "retry after projection catch-up",
  };
}

export function detail(
  intent: DocWriteIntent,
  current: LedgerCutIdentity,
  code: string,
  lease: ReturnType<TaskProjection["currentLeaseForExecution"]>,
  unresolvedTouches: DocSyncReceiptDetail["unresolvedTouches"] = [],
): DocSyncReceiptDetail {
  return {
    kind: "doc_sync",
    code,
    baseLedgerSha: intent.baseLedgerSha,
    currentLedgerSha: current,
    paths: intent.changes.map((change) => ({
      path: change.path,
      baseBlobSha256: change.baseBlobSha256,
      currentBlobSha256: null,
      candidateBlobSha256: change.candidate?.sha256 ?? null,
    })),
    holder: holder(lease),
    differences: [],
    unresolvedTouches,
    deletions: [],
    nextAction: unresolvedTouches[0]
      ? blockedCandidateNextAction(unresolvedTouches[0])
      : "run ha doc sync --dry-run --path <path> and resubmit with a new opId",
  };
}

export function touch(
  pathValue: string,
  requiredRoute: string,
  reason: string,
): DocSyncReceiptDetail["unresolvedTouches"][number] {
  return {
    path: pathValue,
    regionId: null,
    anchor: null,
    reason,
    requiredRoute,
    policy: DOC_POLICY_ID,
  };
}

export function isTaskPackagePath(value: string): boolean {
  const parts = value.split("/");
  return parts.length >= 3 && parts[0] === "tasks" && parts[1]!.length > 0;
}

export function holder(lease: ReturnType<TaskProjection["currentLeaseForExecution"]>): DocSyncReceiptDetail["holder"] {
  return (
    lease && {
      taskId: lease.taskId,
      executionId: lease.executionId,
      personId: lease.actor.principal.personId,
      executorId: lease.actor.executor?.id ?? null,
      source: lease.source,
      expiresAt: lease.expiresAt,
      version: lease.version,
    }
  );
}

export function claimBytes(rootDir: string, ref: DocClaimRef): Uint8Array | null {
  const target = claimFile(rootDir, ref);
  return target && lstatSync(target).isFile() ? readFileSync(target) : null;
}

export function claimFile(rootDir: string, ref: string): string | null {
  let target = resolveHarnessLayout(rootDir).localRoot;
  if (existsSync(target) && lstatSync(target).isSymbolicLink()) return null;
  for (const segment of ref.split("/")) {
    target = path.join(target, segment);
    if (!existsSync(target) || lstatSync(target).isSymbolicLink()) return null;
  }
  return target;
}

export function recycleClaims(rootDir: string, intent: DocWriteIntent): void {
  for (const change of intent.changes) {
    const target = change.candidate && claimFile(rootDir, change.candidate.ref);
    if (target) unlinkSync(target);
  }
}

export function directPaths(rootDir: string, paths: readonly string[]): boolean {
  const authored = resolveHarnessLayout(rootDir).authoredRoot;
  if (existsSync(authored) && lstatSync(authored).isSymbolicLink()) return false;
  return paths.every((document) => {
    let target = authored;
    for (const segment of document.split("/")) {
      target = path.join(target, segment);
      if (existsSync(target) && lstatSync(target).isSymbolicLink()) return false;
    }
    return true;
  });
}

export function observe(
  rootDir: string,
  source: WriteSource,
  documents: readonly ({
    readonly path: string;
    readonly blobSha256: string;
  } | null)[],
): boolean | null {
  if (!localProseSource(source) || documents.some((document) => document === null)) return null;
  const authored = resolveHarnessLayout(rootDir).authoredRoot;
  return documents.every((document) => {
    const target = path.join(authored, document!.path);
    return existsSync(target) && sha256Bytes(readFileSync(target)) === document!.blobSha256;
  });
}

export function matches(
  event: DocEventV1,
  intent: DocWriteIntent,
  actor: ActorIdentity,
  source: WriteSource,
  retirementReason?: string,
): boolean {
  return (
    event.payload.executionId === intent.executionId &&
    event.payload.retirementReason === retirementReason &&
    stableStringify(event.payload.baseLedgerSha) === stableStringify(intent.baseLedgerSha) &&
    stableStringify(event.actor) === stableStringify(actor) &&
    stableStringify(event.source) === stableStringify(source) &&
    stableStringify(
      event.payload.changes.map((change) => ({
        path: change.path,
        baseBlobSha256: change.baseBlobSha256,
        policyId: change.policyId,
        candidate: change.candidate,
      })),
    ) ===
      stableStringify(
        intent.changes.map((change) => ({
          path: change.path,
          baseBlobSha256: change.baseBlobSha256,
          policyId: change.policyId,
          candidate: change.candidate && {
            sha256: change.candidate.sha256,
            size: change.candidate.size,
            mediaType: change.candidate.mediaType,
          },
        })),
      )
  );
}
