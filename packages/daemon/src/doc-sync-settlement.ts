import { principalId } from "@harness-anything/kernel";
import { samePrincipal } from "@harness-anything/kernel";
import { isNativeExecution, type TaskProjection } from "@harness-anything/kernel";
import {
  documentPath,
  resolveDocRoute,
  stableStringify,
  type DocSyncReceiptDetail,
  type DocWriteIntent,
  type WriteReceiptDraft as WriteReceipt,
} from "@harness-anything/kernel";
import type { DocIntentChannel } from "./doc-sync-adjudication.ts";
import { publicScan, type DocCandidateScan } from "./doc-sync-candidate-scanner.ts";
import type { DocSettlementReceipt, Input } from "./doc-sync-command-actions.ts";
import { detail, holder, isTaskPackagePath, touch } from "./doc-sync-details.ts";
import { localProseSource, proof, rejectDocSyncAction } from "./doc-sync-files.ts";

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
  const nextAction = scan.rows
    .filter((row) => row.reason?.includes("ha task artifact add"))
    .map((row) => row.reason!.slice(row.reason!.indexOf("ha task artifact add")))[0];
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
    ...(nextAction === undefined ? {} : { nextAction }),
  };
}

// Submit-all is a deleted semantics (dec_5D2A53976DA1EF7A78F0094BAB CH1): a local submit that
// names neither --task nor --path is refused before anything is published, and the receipt lists
// the candidates it would have carried grouped by owning task, so another session's half-written
// files are never swept into someone else's commit. `all: true` rides the same refusal — locally
// it only spelled the same whole-tree sweep; the fleet edge channel keeps its own confirmation
// gate and never reaches this scanner.
export function scopeRequiredRejection(input: Input, scan: DocCandidateScan): DocSettlementReceipt {
  const summary = scopeRequiredSummary(scan, (candidate) => input.projection.taskIdForDocumentPath(candidate));
  return Object.assign(
    rejectDocSyncAction(
      `scan:${scan.baseLedgerSha.headDigest}`,
      "doc_submit_scope_required",
      scanDetail(input, scan, "doc_submit_scope_required"),
    ),
    // rejectionExplanation is the field the CLI's human hint chain promotes, so the candidate
    // grouping itself — not just the code — reaches the operator.
    { summary, rejectionExplanation: summary },
  );
}

export function scopeRequiredSummary(scan: DocCandidateScan, taskOwner: (path: string) => string | null): string {
  const candidates = scan.rows.filter((row) => row.state !== "clean" && row.state !== "inapplicable"),
    groups = new Map<string, string[]>();
  for (const row of candidates) {
    const owner = taskOwner(row.path);
    groups.set(owner ?? "", [...(groups.get(owner ?? "") ?? []), `${row.path}\t${row.state}`]);
  }
  return [
    "doc-submit: op_rejected (doc_submit_scope_required)",
    ...(candidates.length ? ["candidates by task:"] : ["candidates: (none)"]),
    ...[...groups.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .flatMap(([owner, rows]) => [
        owner ? `task ${owner}:` : "shared surface (no owning task):",
        ...rows.sort().map((row) => `  ${row}`),
      ]),
    "next: rerun ha doc sync --submit with --task <task-id> or --path <path>...",
  ].join("\n");
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
    summary: submitSummary("no_changes", [], scan, (candidate) => input.projection.taskIdForDocumentPath(candidate)),
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
  const submitNext = receipt.outcome === "applied" ? closeoutSubmitNext(input.projection, receiptDetail) : [];
  return {
    ...receipt,
    ...(detail ? { detail } : {}),
    summary: submitSummary(receipt.outcome, receiptDetail?.paths.map((row) => row.path) ?? [], scan, (candidate) =>
      input.projection.taskIdForDocumentPath(candidate),
    ),
    ...(submitNext.length ? { next: submitNext } : {}),
  };
}

/** A synced closeout is the hand-back; its task's open execution becomes a delivery only on `ha task submit`. */
function closeoutSubmitNext(
  projection: TaskProjection,
  receiptDetail: { readonly paths: readonly { readonly path: string }[] } | undefined,
): { command: string; reason: string }[] {
  const taskIds = new Set(
    (receiptDetail?.paths ?? [])
      .filter((row) => row.path.endsWith("/closeout.md"))
      .map((row) => projection.taskIdForDocumentPath(row.path))
      .filter((taskId): taskId is string => taskId !== null),
  );
  return [...taskIds]
    .filter((taskId) =>
      projection
        .read(taskId)
        .snapshot.executions.some((execution) => isNativeExecution(execution) && execution.state === "active"),
    )
    .map((taskId) => ({
      command: `ha task submit ${taskId}`,
      reason: "the closeout is synced; submitting the open execution makes it the delivery",
    }));
}

export function submitSummary(
  outcome: WriteReceipt["outcome"],
  applied: readonly string[],
  scan: DocCandidateScan,
  taskOwner: (path: string) => string | null,
): string {
  const blocked = scan.rows.filter(
      (row) => row.state === "blocked" || row.state === "deletion" || row.state === "conflict",
    ),
    inapplicable = scan.rows.filter((row) => row.state === "inapplicable");
  return [
    `doc-submit: ${outcome}`,
    "applied:",
    ...(applied.length ? applied : ["(none)"]),
    `applied count: ${applied.length}`,
    "blocked (not submitted; owning task and required route shown):",
    ...(blocked.length
      ? blocked.map(
          (row) =>
            `${row.path}\t${row.state}\ttask=${taskOwner(row.path) ?? "-"}\t` +
            `requiredRoute=${row.requiredRoute ?? "ha doc sync"}\t${row.reason ?? "candidate is not eligible"}`,
        )
      : ["(none)"]),
    "inapplicable:",
    ...(inapplicable.length ? inapplicable.map((row) => `${row.path}\t${row.reason}`) : ["(none)"]),
  ].join("\n");
}

export function scanRejectionSummary(code: string, scan: DocCandidateScan): string {
  const blocked = scan.rows.filter(
    (row) => row.state === "blocked" || row.state === "deletion" || row.state === "conflict",
  );
  const next =
    code === "lease_conflict"
      ? scan.frozenTaskIds.length > 0
        ? "next: the submitted cut on " +
          scan.frozenTaskIds.join(", ") +
          " is frozen — doc-sync task package files BEFORE ha task submit; if artifacts must still land, " +
          "the owner returns the cut with ha task adjudicate <task-id> --return and the work is resubmitted with them"
        : scan.lease
          ? `next: lease held by ${principalId(scan.lease.actor.principal)} (${scan.lease.executionId}); ` +
            "submit through the lease holder or use the repository prose channel"
          : "next: submit through the repository prose channel or acquire the task lease"
      : "next: use the required route shown for each blocked path; these documents are daemon-managed. Then rerun " +
        "ha doc sync --submit with --task <task-id> or --path <path>";
  return [
    `doc-submit: op_rejected (${code})`,
    "blocked:",
    ...blocked.map(
      (row) =>
        `${row.path}\t${row.state}\t${row.reason ?? "candidate is blocked"}\t` +
        `requiredRoute=${row.requiredRoute ?? "ha doc sync"}`,
    ),
    next,
  ].join("\n");
}

export function admissionRejection(
  input: Pick<Input, "binding" | "workspaceId" | "store" | "projection" | "runtimeArchive"> & {
    readonly taskDocumentChannel?: DocIntentChannel;
    readonly taskId?: string;
    readonly unleasedTaskCommandId?: string;
  },
  intent: DocWriteIntent,
  lease: ReturnType<TaskProjection["currentLeaseForExecution"]>,
  delegatedTaskId?: string,
): { readonly code: string; readonly detail: DocSyncReceiptDetail } | null {
  if (input.taskDocumentChannel === "task-command") {
    const outside = intent.changes.filter(
      (change) => input.projection.taskIdForDocumentPath(change.path) !== input.taskId,
    );
    if (outside.length)
      return {
        code: "execution_scope_mismatch",
        detail: detail(
          intent,
          input.store.currentCut(),
          "execution_scope_mismatch",
          lease,
          outside.map((change) =>
            touch(change.path, "canonical-task-package", "Carried documents must belong to this task command"),
          ),
        ),
      };
  }
  // Class-A reserve commands validate their one canonical task package before
  // the lease exists; service.executeWithDocuments then commits docs and lease
  // together only if the canonical reserve CAS succeeds. Explicit amendment
  // proves the original canonical submission actor/source instead. Other writes
  // require the current node + owner lease. Archives use their exact dispatch.
  if (
    (input.taskDocumentChannel ?? "doc-submit") === "doc-submit" &&
    typeof input.binding.source === "object" &&
    input.binding.source.kind === "node" &&
    input.runtimeArchive === undefined
  ) {
    // Fleet node ingress treats the whole authored `tasks/<package>/`
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
              "task-context documents ride the canonical lease-checked task command; the ",
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
  const touches = input.runtimeArchive
    ? []
    : scopeTouches(
        input,
        intent.changes.map((change) => change.path),
        input.taskDocumentChannel === "task-command" ? input.unleasedTaskCommandId : delegatedTaskId,
      );
  if (!touches.length) return null;
  const rejected = detail(intent, input.store.currentCut(), "execution_scope_mismatch", lease, touches);
  return {
    code: "execution_scope_mismatch",
    detail: {
      ...rejected,
    },
  };
}

export function scopeTouches(
  input: Pick<Input, "binding" | "workspaceId" | "projection">,
  paths: readonly string[],
  unleasedTaskCommandId?: string,
): readonly ReturnType<typeof touch>[] {
  if (localProseSource(input.binding.source)) return [];
  return paths
    .filter((candidate) => {
      const taskId = input.projection.taskIdForDocumentPath(candidate);
      if (!taskId) return isTaskPackagePath(candidate);
      if (taskId === unleasedTaskCommandId) return false;
      const lease = input.projection.currentLease(taskId);
      return (
        !lease ||
        lease.phase !== "held" ||
        !samePrincipal(lease.actor.principal, input.binding.actor.principal) ||
        JSON.stringify(lease.source) !== JSON.stringify(input.binding.source)
      );
    })
    .map((candidate) =>
      touch(candidate, "canonical-task-lease", "Task document requires the node's current task lease"),
    );
}
