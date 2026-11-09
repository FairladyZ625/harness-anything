import path from "node:path";
import { isNativeExecution, resolveHarnessLayout, type TaskProjection } from "@harness-anything/kernel";
import {
  documentPath,
  documentWorkspacePath,
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
import { formatShellCommand } from "./shell-command-text.ts";

/**
 * One output spelling for a CLI caller: every path its receipt prints is relative to the caller's
 * workspace root. A daemon-internal caller keeps the authored key it indexed the projection with,
 * so the canonical projection and the internal receipts never switch coordinates.
 */
export function workspacePathOf(input: Pick<Input, "rootDir" | "workspaceCoordinate">): (document: string) => string {
  if (input.workspaceCoordinate !== true) return (document) => document;
  // Resolve the layout once per receipt, not once per path row: the scanner lists many rows.
  const layout = resolveHarnessLayout(input.rootDir);
  return (document) => documentWorkspacePath(input.rootDir, document, layout);
}

const toWorkspace = workspacePathOf;

/** The inverse: a workspace spelling back to the ledger key the projection indexes by. */
function authoredPathOf(input: Pick<Input, "rootDir">): (workspace: string) => string {
  const prefix = path
    .relative(input.rootDir, resolveHarnessLayout(input.rootDir).authoredRoot)
    .split(path.sep)
    .join("/");
  return (workspace) => (prefix && workspace.startsWith(`${prefix}/`) ? workspace.slice(prefix.length + 1) : workspace);
}

export function scanReceipt(input: Input, scan: DocCandidateScan): DocSettlementReceipt {
  const revision = input.store.readHead()?.revision ?? 0,
    report = publicScan(scan, workspacePathOf(input)),
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
        ...(input.action.kind === "doc-status" ? { summary: statusSummary(scan, toWorkspace(input)) } : {}),
      };
}

function statusSummary(scan: DocCandidateScan, workspacePath: (document: string) => string): string {
  const blocked = scan.rows.filter(
      (row) => row.state === "blocked" || row.state === "deletion" || row.state === "conflict",
    ),
    eligible = scan.rows.filter((row) => row.state === "eligible").length,
    inapplicable = scan.rows.filter((row) => row.state === "inapplicable").length,
    rebuilt = rebuiltRows(scan);
  return [
    blocked.length ? `doc-status: BLOCKED (${blocked.length})` : "doc-status: clean",
    ...(blocked.length
      ? [
          "blocked:",
          ...blocked.map(
            (row) =>
              `${workspacePath(row.path)}\t${row.state}\t${workspaceReason(row.reason ?? "candidate is blocked", workspacePath)}`,
          ),
        ]
      : []),
    ...retireNextLines(
      blocked.filter((row) => row.state === "deletion"),
      workspacePath,
    ),
    ...rebuiltSummaryLines(rebuilt, workspacePath),
    `eligible: ${eligible}`,
    `inapplicable: ${inapplicable}`,
  ].join("\n");
}

// A blocked reason can quote the authored key that failed the projection (`tasks/<dir>`). The row
// beside it is rendered in workspace coordinates, so the reason must use the same spelling or the
// user reads two names for one path and cannot paste the displayed one back into --path.
function workspaceReason(reason: string, workspacePath: (document: string) => string): string {
  return reason.replace(/(?<![\w/])tasks\/[^\s;,]+/gu, (document) => workspacePath(document));
}

export function scanDetail(input: Input, scan: DocCandidateScan, code: string): DocSyncReceiptDetail {
  const workspacePath = toWorkspace(input);
  return {
    kind: "doc_sync",
    code,
    baseLedgerSha: scan.baseLedgerSha,
    currentLedgerSha: input.store.currentCut(),
    paths: scan.rows.map((row) => ({
      path: workspacePath(row.path),
      baseBlobSha256: row.baseBlobSha256,
      currentBlobSha256: input.projection.readDocument(row.path).document?.blobSha256 ?? null,
      candidateBlobSha256: row.candidateBlobSha256,
    })),
    holder: holder(scan.lease),
    differences: [],
    unresolvedTouches: scan.rows
      .filter((row) => row.state === "blocked" || row.state === "conflict")
      .map((row) =>
        touch(
          workspacePath(row.path),
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
        path: workspacePath(row.path),
        baseBlobSha256: row.baseBlobSha256!,
        source: "intent" as const,
      })),
  };
}

// Submit-all is a deleted semantics (dec_5D2A53976DA1EF7A78F0094BAB CH1): a local submit that
// names neither --task nor --path is refused before anything is published, and the receipt lists
// the candidates it would have carried grouped by owning task, so another session's half-written
// files are never swept into someone else's commit. `all: true` rides the same refusal — locally
// it only spelled the same whole-tree sweep; the fleet edge channel keeps its own confirmation
// gate and never reaches this scanner.
export function scopeRequiredRejection(input: Input, scan: DocCandidateScan): DocSettlementReceipt {
  const summary = scopeRequiredSummary(
    scan,
    (candidate) => input.projection.taskIdForDocumentPath(candidate),
    toWorkspace(input),
  );
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

export function scopeRequiredSummary(
  scan: DocCandidateScan,
  taskOwner: (path: string) => string | null,
  workspacePath: (document: string) => string = (document) => document,
): string {
  const candidates = scan.rows.filter((row) => row.state !== "clean" && row.state !== "inapplicable"),
    groups = new Map<string, string[]>();
  for (const row of candidates) {
    const owner = taskOwner(row.path);
    groups.set(owner ?? "", [...(groups.get(owner ?? "") ?? []), `${workspacePath(row.path)}\t${row.state}`]);
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
    summary: submitSummary(
      "no_changes",
      [],
      scan,
      (candidate) => input.projection.taskIdForDocumentPath(candidate),
      toWorkspace(input),
    ),
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
  const submitNext =
    receipt.outcome === "applied" ? closeoutSubmitNext(input.projection, scanned, authoredPathOf(input)) : [];
  return {
    ...receipt,
    ...(detail ? { detail } : {}),
    summary: submitSummary(
      receipt.outcome,
      receiptDetail?.paths.map((row) => row.path) ?? [],
      scan,
      (candidate) => input.projection.taskIdForDocumentPath(candidate),
      toWorkspace(input),
    ),
    ...(submitNext.length ? { next: submitNext } : {}),
  };
}

/** A synced closeout is the hand-back; its task's open execution becomes a delivery only on `ha task submit`. */
function closeoutSubmitNext(
  projection: TaskProjection,
  receiptDetail: { readonly paths: readonly { readonly path: string }[] } | undefined,
  authoredPath: (workspace: string) => string,
): { command: string; reason: string }[] {
  const taskIds = new Set(
    (receiptDetail?.paths ?? [])
      .filter((row) => row.path.endsWith("/closeout.md"))
      .map((row) => projection.taskIdForDocumentPath(authoredPath(row.path)))
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
  workspacePath: (document: string) => string,
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
            `${workspacePath(row.path)}\t${row.state}\ttask=${taskOwner(row.path) ?? "-"}\t` +
            `requiredRoute=${row.requiredRoute ?? "ha doc sync"}\t${row.reason ?? "candidate is not eligible"}`,
        )
      : ["(none)"]),
    "inapplicable:",
    ...(inapplicable.length ? inapplicable.map((row) => `${workspacePath(row.path)}\t${row.reason}`) : ["(none)"]),
    ...rebuiltSummaryLines(rebuiltRows(scan), workspacePath),
    ...retireNextLines(
      blocked.filter((row) => row.state === "deletion"),
      workspacePath,
    ),
  ].join("\n");
}

// A route-owned projection rebuilt from the canonical document is clean, but the local rewrite it
// replaced is gone; the summary is where the operator learns that happened.
function rebuiltRows(scan: DocCandidateScan) {
  return scan.rows.filter((row) => row.state === "clean" && row.reason !== null);
}

function rebuiltSummaryLines(
  rebuilt: readonly { readonly path: string; readonly reason: string | null }[],
  workspacePath: (document: string) => string,
): string[] {
  return rebuilt.length === 0
    ? []
    : [
        "rebuilt (route-owned projections restored from the canonical document):",
        ...rebuilt.map((row) => `${workspacePath(row.path)}\t${row.reason}`),
      ];
}

// A receipt that reports a canonical document missing from the worktree must name its one exit:
// retirement at the center. `requiredRoute=deletion_forbidden` is a rejection code, not a route,
// so without these lines the receipt points at nothing the operator can run.
function retireNextLines(
  deletions: readonly { readonly path: string }[],
  workspacePath: (document: string) => string = (document) => document,
): string[] {
  return deletions.length === 0
    ? []
    : [
        "next: a canonical document deleted from the worktree is retired at the center, not synced:",
        ...deletions.map((row) =>
          formatShellCommand("ha", [
            "doc",
            "retire",
            "--path",
            workspacePath(row.path),
            "--reason",
            "<why the document is gone>",
          ]),
        ),
      ];
}

export function scanRejectionSummary(
  code: string,
  scan: DocCandidateScan,
  workspacePath: (document: string) => string = (document) => document,
): string {
  const blocked = scan.rows.filter(
      (row) => row.state === "blocked" || row.state === "deletion" || row.state === "conflict",
    ),
    deletions = blocked.filter((row) => row.state === "deletion"),
    next = [
      ...(code === "lease_conflict"
        ? [leaseRecoveryNext(scan)]
        : blocked.length > deletions.length
          ? [
              "next: use the required route shown for each blocked path; these documents are daemon-managed. Then rerun " +
                "ha doc sync --submit with --task <task-id> or --path <path>",
            ]
          : []),
      ...retireNextLines(deletions, workspacePath),
    ].join("\n");
  return [
    `doc-submit: op_rejected (${code})`,
    "blocked:",
    ...blocked.map(
      (row) =>
        `${workspacePath(row.path)}\t${row.state}\t${row.reason ?? "candidate is blocked"}\t` +
        `requiredRoute=${row.requiredRoute ?? "ha doc sync"}`,
    ),
    next,
  ].join("\n");
}

function leaseRecoveryNext(scan: DocCandidateScan): string {
  return scan.frozenTaskIds.length > 0
    ? "next: the submitted cut on " +
        scan.frozenTaskIds.join(", ") +
        " is frozen — doc-sync task package files BEFORE ha task submit; if artifacts must still land, " +
        "a changes_requested review verdict returns the cut for rework and the work is resubmitted with them"
    : scan.lease
      ? `next: lease held by ${scan.lease.actor.principal.personId} (${scan.lease.executionId}); ` +
        "submit through the lease holder or use the repository prose channel"
      : "next: submit through the repository prose channel or acquire the task lease";
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
  const derivedExplainers = intent.changes.filter((change) => {
    if (!change.path.endsWith("/artifacts/explainer.html")) return false;
    const taskId = input.projection.taskIdForDocumentPath(change.path);
    return taskId !== null && input.projection.read(taskId).snapshot.task?.taskClass === "work";
  });
  if (derivedExplainers.length)
    return {
      code: "derived_document_read_only",
      detail: detail(
        intent,
        input.store.currentCut(),
        "derived_document_read_only",
        lease,
        derivedExplainers.map((change) =>
          touch(
            change.path,
            "daemon-derived",
            "Work explainers are rendered from the current work projection and cannot be written.",
          ),
        ),
      ),
    };
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
  //
  // A planned task's plan is exempt from the fleet node's class-A rule below: it must be canonical
  // before start can name an execution at all. Only a content submission is exempt, never a
  // retirement of that path.
  const plannedPlanPaths = new Set(
    (input.taskDocumentChannel ?? "doc-submit") === "doc-submit"
      ? intent.changes
          .filter((change) => change.candidate !== null && plannedTaskPlanSubmission(input, change.path))
          .map((change) => change.path)
      : [],
  );
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
        (input.projection.taskIdForDocumentPath(change.path) !== null || isTaskPackagePath(change.path)) &&
        !plannedPlanPaths.has(change.path),
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
              "task-context documents other than a planned task's plan ride the canonical ",
              "lease-checked task command; this doc-submit names no held execution",
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
        plannedPlanPaths,
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

/**
 * A planned task's plan is the one task-package document the plain doc-submit channel may carry.
 * `ha task start` refuses until the plan is canonical, and a planned task has no execution to name
 * on the lease-checked task command, so the two guards would otherwise deadlock every fresh task.
 * The exemption is deliberately narrow: planned status, no effective lease, exactly the package's
 * task_plan.md. Anything else in a task package still requires the canonical task command.
 */
function plannedTaskPlanSubmission(input: Pick<Input, "projection">, path: string): boolean {
  const taskId = input.projection.taskIdForDocumentPath(path);
  if (taskId === null) return false;
  const task = input.projection.read(taskId);
  return (
    task.snapshot.task?.status === "planned" &&
    task.packagePath !== null &&
    path === `${task.packagePath}/task_plan.md` &&
    input.projection.currentLease(taskId) === null
  );
}

export function scopeTouches(
  input: Pick<Input, "binding" | "workspaceId" | "projection">,
  paths: readonly string[],
  unleasedTaskCommandId?: string,
  exemptPaths?: ReadonlySet<string>,
): readonly ReturnType<typeof touch>[] {
  if (localProseSource(input.binding.source)) return [];
  return paths
    .filter((candidate) => {
      const taskId = input.projection.taskIdForDocumentPath(candidate);
      if (!taskId) return isTaskPackagePath(candidate);
      if (taskId === unleasedTaskCommandId) return false;
      // Only admission passes the exact content submissions it exempted. A read has no intent and
      // stays bound to the canonical lease scope, even for a planned task's plan.
      if (exemptPaths?.has(candidate)) return false;
      const lease = input.projection.currentLease(taskId);
      return (
        !lease ||
        lease.phase !== "held" ||
        lease.actor.principal.personId !== input.binding.actor.principal.personId ||
        JSON.stringify(lease.source) !== JSON.stringify(input.binding.source)
      );
    })
    .map((candidate) =>
      touch(candidate, "canonical-task-lease", "Task document requires the node's current task lease"),
    );
}
