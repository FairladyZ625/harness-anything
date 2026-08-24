import type { TaskProjection } from "../../kernel/src/index.ts";
import {
  canStartExecution,
  documentPath,
  resolveDocRoute,
  runtimeSessionIdFromActor,
  stableStringify,
  type DocSyncReceiptDetail,
  type DocWriteIntent,
  type WriteReceipt,
} from "../../kernel/src/index.ts";
import type { DocIntentChannel } from "./doc-sync-adjudication.ts";
import { publicScan, type DocCandidateScan } from "./doc-sync-candidate-scanner.ts";
import type { DocSettlementReceipt, Input } from "./doc-sync-command-actions.ts";
import { detail, holder, isTaskPackagePath, touch } from "./doc-sync-details.ts";
import { localProseSource, proof } from "./doc-sync-files.ts";

export function scanReceipt(input: Input, scan: DocCandidateScan): WriteReceipt {
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
        nextAction: detail.nextAction,
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
      };
}

export function scanDetail(input: Input, scan: DocCandidateScan, code: string): DocSyncReceiptDetail {
  const hasConflict = scan.rows.some((row) => row.conflicts.length),
    deletion = scan.rows.find((row) => row.state === "deletion"),
    executionCommands = scan.executionCandidates
      .map((executionId) => `ha doc sync --submit --execution-id ${executionId}`)
      .join(" or "),
    executionChoice =
      scan.executionCandidates.length > 1
        ? ["choose one matching execution explicitly: ", executionCommands, ""].join("")
        : null,
    leaseConflict =
      executionChoice !== null
        ? null
        : (leaseConflictNextAction(input, scan) ??
          (code === "lease_conflict"
            ? "refresh status and submit through the matching execution or repository prose channel"
            : null)),
    headingRestore = taskPlanHeadingRestore(input, scan);
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
    nextAction: hasConflict
      ? [
          "merge the listed conflict scratch into the canonical file, run ha doc ",
          "sync --dry-run --path <path> for a fresh base, then save to submit a new ",
          "opId",
        ].join("")
      : deletion
        ? [
            "run ha doc retire --path ",
            `${deletion.path}`,
            ' --reason "<reason>" for intentional retirement, or restore the ',
            "document, then run ha doc status",
          ].join("")
        : (executionChoice ??
          leaseConflict ??
          headingRestore ??
          (scan.rows.some((row) => row.state === "blocked")
            ? [
                "run ha doc status, resolve the listed blocked candidates through their ",
                "requiredRoute, then rerun ha doc sync --submit",
              ].join("")
            : scan.rows.some((row) => row.state === "eligible")
              ? "submit this selection against the reported automatic base"
              : scan.rows.some((row) => row.state === "inapplicable")
                ? "no action required; inapplicable candidates are outside doc sync"
                : "no action required")),
  };
}

// dec_01KXGDXZG03JZRGTW8V91H11ER CH1(二): a lease_conflict receipt must name the
// command that actually unblocks this caller. The old single hint ("rerun with
// --execution-id") was itself a dead end for every non-holder, and for a
// lapsed runtime lease the working recovery is the same release+re-enter
// round `ha task progress append` already names (task-progress-event.ts).
export function leaseConflictNextAction(input: Input, scan: DocCandidateScan): string | null {
  const row = scan.rows.find((candidate) => candidate.rejectionCode === "lease_conflict");
  if (row === undefined) return null;
  if (runtimeSessionIdFromActor(input.binding.actor) === null)
    return scan.executionId === null
      ? "rerun ha doc sync --submit without --execution-id to submit through the repository prose channel"
      : [
          "execution ",
          `${scan.executionId}`,
          " is not held by this principal; rerun ha doc sync --submit without ",
          "--execution-id to submit through the repository prose channel",
        ].join("");
  const taskId = input.projection.taskIdForDocumentPath(row.path),
    lease = taskId === null ? null : input.projection.currentLease(taskId, input.now());
  if (lease?.phase === "orphaned") {
    const task = input.projection.read(lease.taskId),
      reentry = task.snapshot.task !== null && canStartExecution({ ...task.snapshot, lease: null }, lease.executionId);
    return reentry
      ? [
          "the lease for execution ",
          `${lease.executionId}`,
          " lapsed at ",
          `${lease.expiresAt}`,
          "; run ha task release ",
          `${lease.taskId}`,
          ", then re-enter the round with ha task start ",
          `${lease.taskId}`,
          " --execution-id ",
          `${lease.executionId}`,
          "",
        ].join("")
      : [
          "the lease for execution ",
          `${lease.executionId}`,
          " lapsed at ",
          `${lease.expiresAt}`,
          " and this lifecycle state has no lease re-entry; the dispatcher must ",
          "re-dispatch, or rerun ha doc sync --submit from a non-runtime principal ",
          "through the repository prose channel",
        ].join("");
  }
  return [
    "no live execution lease covers ",
    `${row.path}`,
    " for this runtime session; submit through the lease-brokered task ",
    "command for a bound execution, or have the dispatcher re-dispatch (a ",
    "non-runtime principal may rerun ha doc sync --submit through the ",
    "repository prose channel)",
  ].join("");
}

// The base-region guard keeps a task plan's H1 pinned to the ledger title;
// when the missing base region IS that title heading, the fix is mechanical
// and the receipt can name it exactly. A region that matches the pre-amended
// title instead (the base predates ha task amend) deliberately keeps the
// generic guidance here — that shape is resolved on the typed route, not by
// prose edits.
export function taskPlanHeadingRestore(input: Input, scan: DocCandidateScan): string | null {
  for (const row of scan.rows) {
    if (row.state !== "blocked" || row.requiredRoute !== "refresh-region-policy" || !row.path.endsWith("/task_plan.md"))
      continue;
    const taskId = input.projection.taskIdForDocumentPath(row.path),
      task = taskId === null ? null : input.projection.read(taskId).snapshot.task;
    if (task !== null && row.regionId === `heading/${task.title.toLowerCase()}`)
      return [
        "restore the H1 of ",
        `${row.path}`,
        ' to the task title verbatim ("# ',
        `${task.title}`,
        '"), then rerun ha doc sync --submit --path ',
        `${row.path}`,
        "",
      ].join("");
  }
  return null;
}

export function noOp(input: Input, scan: DocCandidateScan): DocSettlementReceipt {
  const revision = input.store.readHead()?.revision ?? 0,
    nextAction = "no eligible document changes to submit";
  // Lifecycle-owned task plans may be clean after an H1 heal already published by task amend.
  // Keep that idempotent acknowledgement applied; ordinary zero-write scans reject below.
  if (scan.rows.length > 0 && scan.rows.every((row) => row.path.endsWith("/task_plan.md")))
    return {
      outcome: "applied",
      opId: `noop:${scan.baseLedgerSha.headDigest}`,
      revision,
      evidence: "doc-sync:no-op",
      visibility: "center",
      proof: proof(revision, revision, true, true),
      detail: scanDetail(input, scan, "no_op"),
      summary: submitSummary("applied", [], scan),
    };
  return {
    outcome: "op_rejected",
    opId: `noop:${scan.baseLedgerSha.headDigest}`,
    revision,
    code: "no_changes",
    origin: "doc-sync",
    evidence: "doc-sync:no-op",
    nextAction,
    detail: { ...scanDetail(input, scan, "no_changes"), nextAction },
    summary: submitSummary("op_rejected", [], scan),
  };
}

export function scannerSettlement(
  input: Input,
  scan: DocCandidateScan,
  receipt: DocSettlementReceipt,
): DocSettlementReceipt {
  const scanned = scanDetail(input, scan, receipt.outcome),
    skipped = scanned.unresolvedTouches.length + scanned.deletions.length,
    detail = receipt.detail && {
      ...receipt.detail,
      unresolvedTouches: scanned.unresolvedTouches,
      deletions: scanned.deletions,
      nextAction: skipped ? scanned.nextAction : receipt.detail.nextAction,
    };
  return {
    ...receipt,
    ...(detail ? { detail } : {}),
    summary: submitSummary(receipt.outcome, receipt.detail?.paths.map((row) => row.path) ?? [], scan),
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
  if (input.binding.docWriteAllowed === false) {
    const rejected = detail(
      intent,
      input.store.currentCut(),
      "rbac_forbidden",
      lease,
      intent.changes.map((change) => touch(change.path, "repo-write", "principal lacks repo-write")),
    );
    return {
      code: "rbac_forbidden",
      detail: {
        ...rejected,
        nextAction: "use a repo-write principal holding the active execution lease",
      },
    };
  }
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
          nextAction: [
            "run the task command (it carries its task documents automatically), or ",
            "submit with the held --execution-id as the current holder",
          ].join(""),
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
      nextAction: "submit only paths in the authenticated assignment scope",
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
    route = `assignment:${assignmentId}:${scope?.paths.join(",") ?? "scope-missing"}`;
  return paths
    .filter(
      (candidate) =>
        !scope ||
        scope.repoId !== input.workspaceId ||
        !scope.paths.some((allowed) => candidate === allowed || candidate.startsWith(`${allowed}/`)),
    )
    .map((candidate) => touch(candidate, route, "path is outside the authenticated assignment scope"));
}
