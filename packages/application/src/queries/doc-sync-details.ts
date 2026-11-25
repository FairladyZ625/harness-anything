import type {
  ActorIdentity,
  DocEventV1,
  DocSyncReceiptDetail,
  DocWriteIntent,
  LedgerCutIdentity,
  TaskProjectionQueries,
  WriteReceiptDraft as WriteReceipt,
  WriteSource,
} from "@harness-anything/kernel";
import { DOC_POLICY_ID, documentPath, resolveDocRoute, stableStringify } from "@harness-anything/kernel";

export type DocAction = Readonly<Record<string, unknown>> & { readonly kind: string };

export interface BlockedCandidate {
  readonly path: string;
  readonly reason: string | null;
  readonly requiredRoute: string | null;
}

export function localProseSource(source: WriteSource): boolean {
  return source === "local";
}

export function proof(
  committedRevision: number,
  appliedCut: number,
  canonicalVisible: boolean,
  worktreeVisible: boolean | null,
) {
  return {
    committedRevision,
    appliedCut,
    durable: true,
    canonicalVisible,
    worktreeVisible,
  };
}

export function rejectDocSyncAction(
  opId: string,
  code: string,
  receiptDetail: DocSyncReceiptDetail,
  routing?: string,
): WriteReceipt {
  return {
    outcome: "op_rejected",
    opId,
    code,
    origin: "doc-sync-contract",
    ...(code === "base_blob_changed"
      ? {
          rejectionExplanation:
            "Concurrent document conflict: a submitted document changed at the center. Sync the latest documents, resolve any staged conflict with ha doc conflict resolve|discard-local|overwrite-center, then submit again.",
        }
      : {}),
    evidence: routing === undefined ? `contract-rejection:${code}` : `contract-rejection:${code}:${routing}`,
    detail: receiptDetail,
  };
}

export function requiredDocSyncText(value: unknown, name: string): string {
  if (typeof value === "string" && value.trim()) return value;
  throw docSyncError("invalid_command", `${name} is required`);
}

export function hasExactDocSyncActionFields(value: DocAction, fields: readonly string[]): boolean {
  return Object.keys(value).length === fields.length && fields.every((field) => Object.hasOwn(value, field));
}

export function docSyncError(code: string, message: string): Error & { readonly code: string } {
  const error = new Error(message) as Error & { code: string };
  error.code = code;
  return error;
}

export function blockedCandidateNextAction(
  candidate: BlockedCandidate,
  nextStep = "rerun ha doc sync --submit with --task <task-id> or --path <path>",
  workspacePath: (document: string) => string = (document) => document,
): string {
  const route = candidate.requiredRoute ?? resolveDocRoute(documentPath(candidate.path)).requiredRoute;
  return (
    `${workspacePath(candidate.path)} is daemon-managed; use ${route}: ${candidate.reason ?? "candidate is blocked"}; ` +
    `then ${nextStep}`
  );
}

export function readDetail(
  input: {
    readonly action: DocAction;
    readonly projection: Pick<TaskProjectionQueries, "readDocument">;
  },
  paths: readonly string[],
  current: LedgerCutIdentity,
  lease: ReturnType<TaskProjectionQueries["currentLeaseForExecution"]>,
  unresolvedTouches: DocSyncReceiptDetail["unresolvedTouches"],
): DocSyncReceiptDetail {
  const reads = paths.map((candidate) => input.projection.readDocument(candidate));
  return {
    kind: "doc_sync",
    code: unresolvedTouches.length ? "execution_scope_mismatch" : input.action.kind,
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
  };
}

export function detail(
  intent: DocWriteIntent,
  current: LedgerCutIdentity,
  code: string,
  lease: ReturnType<TaskProjectionQueries["currentLeaseForExecution"]>,
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

export function holder(
  lease: ReturnType<TaskProjectionQueries["currentLeaseForExecution"]>,
): DocSyncReceiptDetail["holder"] {
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

export function matches(
  event: DocEventV1,
  intent: DocWriteIntent,
  actor: ActorIdentity,
  source: WriteSource,
  retirementReason?: string,
  ignoreBaseLedgerSha = false,
): boolean {
  return (
    event.payload.executionId === intent.executionId &&
    event.payload.retirementReason === retirementReason &&
    (ignoreBaseLedgerSha || stableStringify(event.payload.baseLedgerSha) === stableStringify(intent.baseLedgerSha)) &&
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
