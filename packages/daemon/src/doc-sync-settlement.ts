import type { TaskProjection } from "../../kernel/src/index.ts";
import {
  documentPath,
  resolveDocRoute,
  stableStringify,
  type DocSyncReceiptDetail,
  type DocWriteIntent,
  type WriteReceiptDraft as WriteReceipt,
} from "../../kernel/src/index.ts";
import type { DocIntentChannel } from "./doc-sync-adjudication.ts";
import { publicScan, type DocCandidateScan } from "./doc-sync-candidate-scanner.ts";
import type { DocSettlementReceipt, Input } from "./doc-sync-command-actions.ts";
import { detail, holder, isTaskPackagePath, touch } from "./doc-sync-details.ts";
import { localProseSource, proof } from "./doc-sync-files.ts";

export function scanReceipt(input: Input, scan: DocCandidateScan): DocSettlementReceipt {
  const revision = input.store.readHead()?.revision ?? 0,
    report = publicScan(scan),
    opId = `scan:${input.action.kind}:${scan.baseLedgerSha.headDigest}`,
    detail = scanDetail(input, scan, input.action.kind);
  return input.action.kind === "doc-dry-run"
    ? {
        outcome: "pending",
        opId,
        revision,
        evidence: `doc-scan:${stableStringify(report)}`,
        visibility: "center",
        proof: {
          committedRevision: revision,
          appliedCut: revision,
          durable: false,
          canonicalVisible: false,
          worktreeVisible: false,
        },
        detail,
      }
    : {
        outcome: "applied",
        opId,
        revision,
        evidence: `doc-scan:${stableStringify(report)}`,
        visibility: "center",
        proof: proof(
          revision,
          revision,
          true,
          scan.rows.every((row) => row.state === "clean"),
        ),
        detail,
        ...(input.action.kind === "doc-status" ? { summary: statusSummary(scan) } : {}),
      };
}

function statusSummary(scan: DocCandidateScan): string {
  const blocked = scan.rows.filter(
      (row) => row.state === "blocked" || row.state === "deletion" || row.state === "conflict",
    ),
    eligible = scan.rows.filter((row) => row.state === "eligible").length,
    inapplicable = scan.rows.filter((row) => row.state === "inapplicable").length;
  return [
    blocked.length ? `doc-status: BLOCKED (${blocked.length})` : "doc-status: clean",
    ...(blocked.length
      ? ["blocked:", ...blocked.map((row) => `${row.path}\t${row.state}\t${row.reason ?? "candidate is blocked"}`)]
      : []),
    `eligible: ${eligible}`,
    `inapplicable: ${inapplicable}`,
  ].join("\n");
}

export function scanDetail(input: Input, scan: DocCandidateScan, code: string): DocSyncReceiptDetail {
  return {
    kind: "doc_sync",
    code,
    baseLedgerSha: scan.baseLedgerSha,
    currentLedgerSha: input.store.currentCut(),
    paths: scan.rows.map((row) => ({
      path: row.path,
      baseBlobSha256: row.baseBlobSha256,
      currentBlobSha256: row.baseBlobSha256,
      candidateBlobSha256: row.candidateBlobSha256,
    })),
    holder: holder(scan.lease),
    differences: [],
    unresolvedTouches: scan.rows
      .filter((row) => row.state === "blocked" || row.state === "conflict")
      .map((row) =>
        touch(
          row.path,
          row.state === "conflict"
            ? "local-conflict-resolution"
            : (row.requiredRoute ?? resolveDocRoute(documentPath(row.path)).requiredRoute),
          row.state === "conflict"
            ? `${row.reason}: ${row.conflicts.join(", ")}`
            : (row.reason ?? "candidate is blocked"),
        ),
      ),
    deletions: scan.rows
      .filter((row) => row.state === "deletion" && row.baseBlobSha256)
      .map((row) => ({
        path: row.path,
        baseBlobSha256: row.baseBlobSha256!,
        source: "intent" as const,
      })),
  };
}

export function noOp(input: Input, scan: DocCandidateScan): DocSettlementReceipt {
  const revision = input.store.readHead()?.revision ?? 0;
  return {
    outcome: "no_changes",
    opId: `noop:${scan.baseLedgerSha.headDigest}`,
    revision,
    code: "no_changes",
    origin: "doc-sync",
    evidence: "doc-sync:no-op",
    visibility: "center",
    proof: proof(revision, revision, true, true),
    detail: scanDetail(input, scan, "no_changes"),
    summary: submitSummary("no_changes", [], scan),
  };
}

export function scannerSettlement(
  input: Input,
  scan: DocCandidateScan,
  receipt: DocSettlementReceipt,
): DocSettlementReceipt {
  const receiptDetail = receipt.detail?.kind === "doc_sync" ? receipt.detail : undefined,
    scanned = scanDetail(input, scan, receipt.outcome),
    detail = receiptDetail && {
      ...receiptDetail,
      unresolvedTouches: scanned.unresolvedTouches,
      deletions: scanned.deletions,
    };
  return {
    ...receipt,
    ...(detail ? { detail } : {}),
    summary: submitSummary(receipt.outcome, receiptDetail?.paths.map((row) => row.path) ?? [], scan),
  };
}

export function submitSummary(
  outcome: WriteReceipt["outcome"],
  applied: readonly string[],
  scan: DocCandidateScan,
): string {
  const skipped = scan.rows.filter(
      (row) => row.state === "blocked" || row.state === "deletion" || row.state === "conflict",
    ),
    inapplicable = scan.rows.filter((row) => row.state === "inapplicable");
  return [
    `doc-submit: ${outcome}`,
    "applied:",
    ...(applied.length ? applied : ["(none)"]),
    `applied count: ${applied.length}`,
    "skipped:",
    ...(skipped.length
      ? skipped.map((row) => `${row.path}\t${row.state}\t${row.reason ?? "candidate is not eligible"}`)
      : ["(none)"]),
    "inapplicable:",
    ...(inapplicable.length ? inapplicable.map((row) => `${row.path}\t${row.reason}`) : ["(none)"]),
  ].join("\n");
}

export function admissionRejection(
  input: Pick<Input, "binding" | "workspaceId" | "store" | "projection"> & {
    readonly taskDocumentChannel?: DocIntentChannel;
  },
  intent: DocWriteIntent,
  lease: ReturnType<TaskProjection["currentLeaseForExecution"]>,
): { readonly code: string; readonly detail: DocSyncReceiptDetail } | null {
  // Task-context authority is the dynamically acquired execution lease
  // (decideDocWrite re-checks the holder); the assignment scope gates only
  // which paths a node may touch, so a W3-B lease on any task rides the same
  // path-scoped admission as shared-surface prose. The one exception is the
  // fleet doc-submit channel: task-package documents over fleet ingress must
  // ride the lease-brokered task command (class A); an explicit submit that
  // names the currently held execution keeps decideDocWrite's holder check as
  // its authority, while a channel-less (null execution) submit is refused.
  if (
    (input.taskDocumentChannel ?? "doc-submit") === "doc-submit" &&
    typeof input.binding.source === "object" &&
    input.binding.source.kind === "assignment"
  ) {
    // Fleet assignment ingress treats the whole authored `tasks/<package>/`
    // namespace as class A, including a package that has not projected yet.
    // Relying only on taskIdForDocumentPath would leave a ghost package as an
    // unheld shared-surface write path.
    const taskTouches = intent.changes.filter(
      (change) =>
        intent.executionId === null &&
        (input.projection.taskIdForDocumentPath(change.path) !== null || isTaskPackagePath(change.path)),
    );
    if (taskTouches.length > 0) {
      const rejected = detail(
        intent,
        input.store.currentCut(),
        "task_docs_require_task_command",
        lease,
        taskTouches.map((change) =>
          touch(
            change.path,
            "task-command",
            [
              "task-context documents ride the lease-brokered task command; the ",
              "doc-submit channel cannot write them without naming the held execution",
            ].join(""),
          ),
        ),
      );
      return {
        code: "task_docs_require_task_command",
        detail: {
          ...rejected,
        },
      };
    }
  }
  const touches = scopeTouches(
    input,
    intent.changes.map((change) => change.path),
  );
  if (!touches.length) return null;
  const rejected = detail(intent, input.store.currentCut(), "assignment_scope_mismatch", lease, touches);
  return {
    code: "assignment_scope_mismatch",
    detail: {
      ...rejected,
    },
  };
}

export function scopeTouches(input: Pick<Input, "binding" | "workspaceId">, paths: readonly string[]) {
  if (localProseSource(input.binding.source)) return [];
  const scope = input.binding.assignmentScope,
    assignmentId =
      typeof input.binding.source === "object" && input.binding.source.kind === "assignment"
        ? input.binding.source.assignmentId
        : "remote-direct",
    route = `assignment:${assignmentId}:${scope?.scope.paths.join(",") ?? "scope-missing"}`;
  return paths
    .filter(
      (candidate) =>
        !scope ||
        scope.repoId !== input.workspaceId ||
        !scope.scope.paths.some((allowed) => candidate === allowed || candidate.startsWith(`${allowed}/`)),
    )
    .map((candidate) => touch(candidate, route, "path is outside the authenticated assignment scope"));
}
