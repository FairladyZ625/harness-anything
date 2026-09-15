import {
  currentExecutionCuts,
  resolveLedgerGitLayout,
  type WriteReceiptDraft as WriteReceipt,
} from "../../kernel/src/index.ts";
import type { DaemonBuildStatus } from "./build-identity.ts";
import { scanDocCandidates } from "./doc-sync-candidate-scanner.ts";
import { runProcessTextAsync } from "./process-port.ts";
import { readTaskWipSnapshot } from "./repo-cell-task-query.ts";
import type { RepoCellOperationalContext } from "./repo-cell-action-context.ts";
import type { RepoCellBinding, RepoTaskAction } from "./repo-cell-types.ts";

export type DoctorCheckStatus = "ok" | "warn" | "fail" | "indeterminate";
export interface DoctorCheck {
  readonly id: string;
  readonly status: DoctorCheckStatus;
  readonly summary: string;
  readonly count: number;
  readonly next: string;
}

/**
 * `ha doctor` health: six read-only checks over the canonical projection and local Git
 * state. Nothing here appends, scans for writes, or mutates; every check degrades to
 * `indeterminate` rather than guessing when its data source cannot answer (a missing
 * `origin/main` ref on an unfetched clone, a Git-less edge node, an unreachable object).
 */
export async function doctorHealth(
  cell: RepoCellOperationalContext,
  action: RepoTaskAction,
  binding: RepoCellBinding,
): Promise<WriteReceipt> {
  if (cell.mode === "remote-edge") return unavailableCenterDoctor(cell.input.repoId) as WriteReceipt;
  const ledger = resolveLedgerGitLayout(cell.rootDir),
    gitRoots = [...new Set([cell.rootDir, ledger.rootDir])],
    tips: Record<string, string | null> = {};
  for (const root of gitRoots) tips[root] = await gitTip(root);
  const submitted = submittedRoundExecutions(cell),
    checks: DoctorCheck[] = [
      await staleDeliveredCheck(submitted, tips),
      executorUndeclaredCheck(submitted),
      orphanLeaseCheck(cell),
      wipPressureCheck(cell),
      await docDebtCheck(cell, binding),
      doctorBuildDrift(null),
    ],
    cut = cell.projection.readCut(),
    scope = {
      repoId: cell.input.repoId,
      productOriginMainTip: tips[cell.rootDir] ?? null,
      ledgerRoot: ledger.rootDir,
      ledgerOriginMainTip: tips[ledger.rootDir] ?? null,
      note: "center repository local origin/main tips only; an unfetched ref does not imply " + "the remote is current",
    },
    payload = { schema: "doctor-health/v1" as const, scope, checks };
  const receipt = cell.readResult(
    cell.operationId(action, binding, cell.input.repoId, cut.sourceRevision),
    payload,
    cut.sourceRevision,
    null,
    cut,
  );
  return { ...receipt, ...payload } as WriteReceipt;
}

async function gitTip(root: string): Promise<string | null> {
  const result = await git(root, ["rev-parse", "origin/main"]);
  return result.exit === 0 ? result.stdout.trim() : null;
}

async function git(root: string, args: readonly string[]): Promise<{ readonly exit: number; readonly stdout: string }> {
  try {
    return { exit: 0, stdout: await runProcessTextAsync("git", args, root) };
  } catch (error) {
    const exit = typeof error === "object" && error !== null && "status" in error ? Number(error.status) : null;
    return { exit: exit ?? -1, stdout: "" };
  }
}

function submittedRoundExecutions(cell: RepoCellOperationalContext): {
  readonly taskId: string;
  readonly status: string;
  readonly node: string;
  readonly executionId: string;
  readonly commitSha: string | null;
  readonly executor: string | null;
}[] {
  const tasks = (["in_review", "active"] as const).flatMap(
    (status) => cell.projection.list({ status, activePackagesOnly: true }).rows,
  );
  return tasks.flatMap((row) => {
    const task = row.snapshot.task;
    if (!task) return [];
    return currentExecutionCuts(row.snapshot)
      .filter((execution) => execution.state === "submitted")
      .map((execution) => ({
        taskId: row.taskId,
        status: task.status,
        node: task.currentNode,
        executionId: execution.executionId,
        commitSha: execution.submission?.commitSha ?? null,
        executor:
          execution.actor.executor === null ? null : `${execution.actor.executor.kind}:${execution.actor.executor.id}`,
      }));
  });
}

// Delivered cuts waiting on the review/closeout half of the chain. A cut already merged into
// origin/main is called out; one still unmerged is the normal waiting queue — either way the
// item is a warning, not a failure. Missing refs or objects make the whole check indeterminate.
async function staleDeliveredCheck(
  submitted: ReturnType<typeof submittedRoundExecutions>,
  tips: Record<string, string | null>,
): Promise<DoctorCheck> {
  const id = "stale-delivered",
    roots = Object.keys(tips);
  if (roots.every((root) => tips[root] === null))
    return {
      id,
      status: "indeterminate",
      summary: "No local origin/main ref exists; delivered-cut freshness cannot be judged.",
      count: submitted.length,
      next: "Fetch origin on the center repository, then rerun ha doctor.",
    };
  const items: string[] = [],
    measurements = new Map<string, { owner: string | null; exit: number | null }>();
  let indeterminate = false;
  for (const entry of submitted) {
    if (entry.commitSha === null) continue;
    let measured = measurements.get(entry.commitSha);
    if (!measured) {
      const owner = await gitHasCommit(roots, entry.commitSha),
        tip = owner === null ? null : tips[owner],
        exit =
          owner === null || !tip
            ? null
            : (await git(owner, ["merge-base", "--is-ancestor", entry.commitSha, tip])).exit;
      measured = { owner, exit };
      measurements.set(entry.commitSha, measured);
    }
    const { owner } = measured;
    if (owner === null) {
      indeterminate = true;
      items.push(`${entry.taskId}/${entry.executionId}: commit ${entry.commitSha.slice(0, 12)} not found locally`);
      continue;
    }
    if (tips[owner] === null) {
      indeterminate = true;
      items.push(`${entry.taskId}/${entry.executionId}: ${owner} has no origin/main ref`);
      continue;
    }
    const merged = { exit: measured.exit };
    if (merged.exit !== 0 && merged.exit !== 1) {
      indeterminate = true;
      items.push(`${entry.taskId}/${entry.executionId}: ancestry of ${entry.commitSha.slice(0, 12)} is unreadable`);
      continue;
    }
    items.push(
      `${entry.taskId}/${entry.executionId}: ${entry.commitSha.slice(0, 12)} ` +
        (merged.exit === 0 ? "already merged into origin/main" : "not yet merged into origin/main"),
    );
  }
  if (indeterminate)
    return {
      id,
      status: "indeterminate",
      summary: `Delivered cuts could not be fully judged: ${items.join("; ")}`,
      count: items.length,
      next: "Fetch origin and repair the local object store, then rerun ha doctor.",
    };
  return {
    id,
    status: items.length ? "warn" : "ok",
    summary: items.length
      ? `Submitted cuts awaiting closeout: ${items.join("; ")}`
      : "No submitted cuts are waiting on review or completion.",
    count: items.length,
    next: items.length
      ? "Continue each task with ha task review-execution / ha task review-consent / ha task complete, " +
        "or rerun ha task settle <task-id> for a rejected step."
      : "Nothing to do.",
  };
}

async function gitHasCommit(roots: readonly string[], sha: string): Promise<string | null> {
  for (const root of roots) {
    const result = await git(root, ["cat-file", "-e", `${sha}^{commit}`]);
    if (result.exit === 0) return root;
  }
  return null;
}

// A submitted execution with executor=null cannot attribute the work to the runtime that did
// it; review and completion of that cut are unsafe. Every item is a failure.
function executorUndeclaredCheck(submitted: ReturnType<typeof submittedRoundExecutions>): DoctorCheck {
  const items = submitted.filter((entry) => entry.node === "review" && entry.executor === null);
  return {
    id: "executor-undeclared",
    status: items.length ? "fail" : "ok",
    summary: items.length
      ? `Submitted executions without executor attribution: ${items
          .map((entry) => `${entry.taskId}/${entry.executionId}`)
          .join(", ")}`
      : "Every submitted execution names the executor that produced it.",
    count: items.length,
    next: items.length
      ? "Declare the executor with ha task declare-executor <task-id> --execution-id <id> " +
        "--agent <agent-id> --reason <reason> before review."
      : "Nothing to do.",
  };
}

// An orphaned lease is a held lease past its TTL: the holder may still be alive, so this only
// reports the record, never a verdict on the worker.
function orphanLeaseCheck(cell: RepoCellOperationalContext): DoctorCheck {
  const now = cell.now(),
    items = (["planned", "active", "blocked", "in_review"] as const)
      .flatMap((status) => cell.projection.list({ status, activePackagesOnly: true }).rows)
      .flatMap((row) => {
        const lease = cell.projection.currentLease(row.taskId, now);
        return lease !== null && lease.phase === "orphaned"
          ? [`${row.taskId}/${lease.executionId} (expired ${lease.expiresAt})`]
          : [];
      });
  return {
    id: "orphan-lease",
    status: items.length ? "warn" : "ok",
    summary: items.length ? `Leases past expiry: ${items.join(", ")}` : "No held or orphaned lease is past its expiry.",
    count: items.length,
    next: items.length
      ? "A peer may rejoin with ha task start <task-id>; the reservation CAS fences the takeover."
      : "Nothing to do.",
  };
}

function wipPressureCheck(cell: RepoCellOperationalContext): DoctorCheck {
  const snapshot = readTaskWipSnapshot(cell),
    ratio = snapshot.limit === 0 ? 0 : snapshot.counted.length / snapshot.limit;
  return {
    id: "wip-pressure",
    status: snapshot.counted.length >= snapshot.limit ? "fail" : ratio >= 0.8 ? "warn" : "ok",
    summary: `Execution WIP is ${snapshot.counted.length}/${snapshot.limit} (${snapshot.limitLabel}).`,
    count: snapshot.counted.length,
    next:
      ratio >= 0.8
        ? "Settle or block WIP tasks before admitting more executions; see ha task list --status in_review."
        : "Nothing to do.",
  };
}

// Caller-visible doc debt only: what this caller's own sync enumeration would submit. It is
// not a fleet-wide statement — another caller's dirty worktree is invisible here.
async function docDebtCheck(cell: RepoCellOperationalContext, binding: RepoCellBinding): Promise<DoctorCheck> {
  try {
    const scan = scanDocCandidates({
        rootDir: cell.rootDir,
        workspaceId: cell.input.repoId,
        store: cell.store,
        projection: cell.projection,
        actor: binding.actor,
        source: binding.source,
        now: cell.now(),
      }),
      eligible = scan.rows.filter((row) => row.state === "eligible");
    return {
      id: "doc-debt",
      status: eligible.length ? "warn" : "ok",
      summary: eligible.length
        ? `Caller-visible eligible but unsubmitted documents: ${eligible
            .map((row) => row.path)
            .join(", ")} (caller-visible scope, not fleet-wide)`
        : "No caller-visible eligible documents are waiting to be submitted.",
      count: eligible.length,
      next: eligible.length
        ? "Run ha doc sync --submit, or ha task settle <task-id> for task-bound documents."
        : "Nothing to do.",
    };
  } catch (error) {
    return {
      id: "doc-debt",
      status: "indeterminate",
      summary: `Document debt could not be scanned: ${error instanceof Error ? error.message : String(error)}`,
      count: 0,
      next: "Repair the repository working tree or run ha daemon projection rebuild, then rerun ha doctor.",
    };
  }
}

// Host composition supplies the observed process build pair in the same health response.
export function doctorBuildDrift(build: Pick<DaemonBuildStatus, "loadedBuildId" | "diskBuildId"> | null): DoctorCheck {
  const loaded = build?.loadedBuildId,
    disk = build?.diskBuildId;
  return !loaded || !disk
    ? {
        id: "build-drift",
        status: "indeterminate",
        count: 0,
        summary: "The loaded/disk build identities are unavailable; center build drift cannot be judged.",
        next: "Run ha daemon status on the center to inspect its build identities.",
      }
    : {
        id: "build-drift",
        status: loaded === disk ? "ok" : "warn",
        count: loaded === disk ? 0 : 1,
        summary:
          loaded === disk
            ? `Daemon build ${loaded} matches disk.`
            : `Daemon loaded build ${loaded} while disk has ${disk}.`,
        next:
          loaded === disk
            ? "Nothing to do."
            : "Let the center daemon drain, or restart it with ha daemon start --service.",
      };
}

export function unavailableCenterDoctor(repoId: string) {
  const note =
    "ha doctor observes center-local health. Center observations are unavailable from a remote-edge; run ha doctor on the center.";
  return {
    schema: "doctor-health/v1",
    ok: true,
    outcome: "applied" as const,
    opId: "doctor-center-unavailable",
    scope: { repoId, productOriginMainTip: null, ledgerOriginMainTip: null, note },
    checks: ["stale-delivered", "executor-undeclared", "orphan-lease", "wip-pressure", "doc-debt", "build-drift"].map(
      (id) => ({
        id,
        status: "indeterminate" as const,
        summary: note,
        count: 0,
        next: "Run ha doctor on the center.",
      }),
    ),
  };
}
