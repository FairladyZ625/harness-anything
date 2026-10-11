import {
  localGitObjectRefStore,
  type CiObserveProgress,
  type ScheduleV1,
  type WriteReceiptDraft,
} from "@harness-anything/kernel";
import {
  fetchCiObservations,
  isTransientCiProviderFailure,
  listCiArtifacts,
  runCiProviderCommand,
  privateLedgerCiObservations,
  type CiObservationFetch,
  type RunGh,
} from "./ci-observation-actions.ts";
import type { RepoCellOperationalContext } from "./repo-cell-action-context.ts";
import { githubActionsGateResult } from "./repo-cell-ci-evidence.ts";
import { cellErrorCode } from "./repo-cell-errors.ts";
import type { RepoTaskAction } from "./repo-cell-types.ts";
import type { BuiltinExecutionResult } from "./schedule-builtin-executor.ts";

type Target = CiObserveProgress["pending"][number];
type Run = { readonly id: number; readonly run_attempt: number; readonly head_branch: string; readonly status: string };

/** Network and preparation stay outside the writer; only accept re-enters under the occurrence fence. */
export async function reconcileCiOccurrence(input: {
  readonly cell: Pick<
    RepoCellOperationalContext,
    "rootDir" | "settings" | "cellCodedError" | "projection" | "projectionReady" | "now"
  >;
  readonly schedule: ScheduleV1;
  readonly accept: (fetched: CiObservationFetch) => Promise<WriteReceiptDraft>;
  readonly requests: () => readonly RepoTaskAction[];
  readonly gh?: RunGh;
}): Promise<BuiltinExecutionResult> {
  const { cell } = input,
    workflows = cell.settings.read().ci.workflows;
  let progress: CiObserveProgress = input.schedule.status.ciObserve ?? {
    workflow: workflows[0] ?? "",
    workflowIndex: 0,
    scanPass: 0,
    nextPage: 1,
    nextRunId: null,
    nextAttempt: 1,
    pending: [],
    unavailable: [],
    lastCompletedScanAt: null,
    error: null,
    retryAt: null,
  };
  if (progress.retryAt && progress.retryAt > cell.now())
    return {
      outcome: "failed",
      detail: progress.error ?? "Waiting for the GitHub rate-limit reset.",
      ciObserve: progress,
    };
  const gh: RunGh = input.gh ?? runCiProviderCommand;
  const readApi = async <T>(endpoint: string): Promise<T> =>
    JSON.parse(await gh("gh", ["api", endpoint], { cwd: cell.rootDir })) as T;
  const unavailable: CiObserveProgress["unavailable"][number][] = [];
  const pending = new Map(progress.pending.map((target) => [key(target), target]));
  const observed = new Set<string>();
  const accept = async (fetched: CiObservationFetch) => {
    const receipt = await input.accept(fetched);
    if (receipt.outcome !== "applied" && receipt.outcome !== "no_changes")
      throw cell.cellCodedError(
        receipt.code ?? "service_rejected",
        `${receipt.code ?? "service_rejected"}: ${receipt.rejectionExplanation ?? receipt.evidence ?? "CI acceptance failed."}`,
      );
    for (const run of fetched.runs.filter((entry) => entry.artifactUnavailable)) {
      pending.delete(`${run.databaseId}.${run.summary.attempt}`);
      if (!unavailable.some((target) => target.runId === run.databaseId && target.attempt === run.summary.attempt))
        unavailable.push({
          runId: run.databaseId,
          attempt: run.summary.attempt,
          reason: "provider-artifact-unavailable",
        });
    }
  };
  const acceptFetched = async (fetched: CiObservationFetch): Promise<boolean> => {
    return accept(fetched).then(
      () => true,
      (error) => {
        if (cellErrorCode(error) !== "gate_run_stale") throw error;
        for (const run of fetched.runs) {
          pending.delete(`${run.databaseId}.${run.summary.attempt}`);
          if (!unavailable.some((target) => target.runId === run.databaseId && target.attempt === run.summary.attempt))
            unavailable.push({ runId: run.databaseId, attempt: run.summary.attempt, reason: "gate-run-stale" });
        }
        return false;
      },
    );
  };
  const retain = (target: Target) => {
    // Diagnostic history is bounded; the canonical submitted-task demand is re-derived above.
    // Drop the oldest diagnostic before admitting a newer run or attempt so a full queue cannot
    // hide the provider state that completion actually needs.
    if (!pending.has(key(target)) && pending.size >= 100) {
      const oldest = pending.keys().next().value as string | undefined;
      if (oldest !== undefined) pending.delete(oldest);
    }
    pending.set(key(target), target);
  };
  let failedTargets = 0;
  const observe = async (target: Target) => {
    let fetched: CiObservationFetch;
    try {
      fetched = await fetchCiObservations(
        cell,
        {
          kind: "ci-observe-pull",
          occurrenceId: input.schedule.status.activeRun?.occurrenceId,
          claimFence: input.schedule.status.activeRun?.claimFence,
          runs: [target.runId],
          attempts: { [target.runId]: target.attempt },
        },
        gh,
      );
    } catch (error) {
      if (isTransientCiProviderFailure(error)) {
        failedTargets += 1;
        return { outcome: "pending" as const, failure: error };
      }
      if (!(error instanceof Error) || !/HTTP 404|Not Found/iu.test(error.message)) throw error;
      pending.delete(key(target));
      unavailable.push({ runId: target.runId, attempt: target.attempt, reason: "provider-run-unavailable" });
      throw error;
    }
    if (!(await acceptFetched(fetched))) return;
    const run = fetched.runs[0];
    if (!run) {
      retain(target);
      return;
    }
    if (run.artifactUnavailable) return;
    if (run.attemptInventory && run.attemptInventory.missingArtifactJobIds.length === 0) pending.delete(key(target));
    else {
      // Provider expiry is authoritative; an absent artifact remains pending for a later occurrence.
      let artifacts;
      try {
        artifacts = await listCiArtifacts(gh, cell.rootDir, target.runId);
      } catch (error) {
        if (!isTransientCiProviderFailure(error)) throw error;
        failedTargets += 1;
        return { outcome: "pending" as const, failure: error };
      }
      const relevant = artifacts.filter((artifact) =>
        artifact.name.startsWith(`ci-observation-${target.runId}-${target.attempt}-`),
      );
      if (relevant.length && relevant.every((artifact) => artifact.expired)) {
        pending.delete(key(target));
        unavailable.push({ runId: target.runId, attempt: target.attempt, reason: "artifact-expired" });
      } else retain(target);
    }
  };
  try {
    // Drain once: arrivals after this cut remain queued for the next center occurrence.
    for (const request of input.requests()) {
      const result = await fetchCiRequest(cell, request, gh);
      if ("failure" in result) {
        if (!isTransientCiProviderFailure(result.failure)) throw result.failure;
        failedTargets += 1;
        continue;
      }
      await acceptFetched(result.fetched);
    }
    // The canonical submission is the durable demand. Re-derive it on every center occurrence;
    // accept publishes the witness before any diagnostic backlog or scan settlement.
    for (const status of ["submitted", "in_review"] as const) {
      for (const { taskId, snapshot } of cell.projection.list({ status }).rows) {
        const execution = snapshot.executions.find(
          (candidate) => candidate.iteration === snapshot.task?.iteration && candidate.submission !== null,
        );
        const submission = execution?.submission;
        const requirement = (submission?.completionContract.gates ?? []).find(
          (gate) => gate.witness.kind === "github-actions",
        );
        if (
          !submission ||
          !requirement ||
          !submission.commitSha ||
          !localGitObjectRefStore.hasCommit(cell.rootDir, submission.commitSha)
        )
          continue;
        if (githubActionsGateResult(requirement, execution!) === "pass") continue;
        const result = await fetchCiRequest(cell, { kind: "ci-observe-pull", taskId }, gh);
        if ("failure" in result) {
          // Durable submissions are re-derived next occurrence after a transient provider failure or
          // a return/resubmit that landed after this occurrence listed the task.
          // Authentication, rate limits and local IO still fail the occurrence.
          const code = cellErrorCode(result.failure);
          if (
            code !== "ci_witness_not_found" &&
            code !== "ci_witness_delivery_unresolved" &&
            !isTransientCiProviderFailure(result.failure)
          )
            throw result.failure;
          failedTargets += 1;
          continue;
        }
        await acceptFetched(result.fetched);
      }
    }
    await accept(privateLedgerCiObservations(cell));
    for (const target of [...pending.values()].slice(0, 5)) {
      observed.add(key(target));
      if ((await observe(target))?.outcome === "pending") retain(target);
      // Rotate unfinished targets so later pending diagnostics cannot starve.
      if (pending.has(key(target))) {
        pending.delete(key(target));
        pending.set(key(target), target);
      }
    }
    if (workflows.length) {
      const workflowIndex = 0,
        workflow = workflows[workflowIndex]!;
      const page = await readApi<{ workflow_runs: readonly Run[] }>(
        `repos/:owner/:repo/actions/workflows/${encodeURIComponent(workflow)}.yml/runs?per_page=20&page=1`,
      );
      const runs = page.workflow_runs.filter((run) => run.head_branch === "main");
      for (const run of runs.slice(0, 20)) {
        const target = { runId: run.id, attempt: run.run_attempt, workflow };
        if (observed.has(key(target))) continue;
        observed.add(key(target));
        if (run.status !== "completed") retain(target);
        else if ((await observe(target))?.outcome === "pending") retain(target);
      }
      // The first page is the source of truth for current main runs. Historical pages and
      // per-attempt cursors only delayed newer provider conclusions while serving no completion
      // demand, so the persisted cursor remains at the first page after every occurrence.
      progress = {
        ...progress,
        workflow,
        workflowIndex,
        nextPage: 1,
        nextRunId: null,
        nextAttempt: 1,
      };
    }
    return {
      outcome: "succeeded",
      detail: `CI reconciliation checkpoint accepted; ${failedTargets} target(s) failed.`,
      ciObserve: {
        ...progress,
        pending: [...pending.values()],
        unavailable: unavailable.slice(-100),
        error: null,
        retryAt: null,
      },
    };
  } catch (error) {
    const detail = (error instanceof Error ? error.message : String(error)).slice(0, 1024);
    return {
      outcome: "failed",
      detail,
      ciObserve: {
        ...progress,
        pending: [...pending.values()],
        unavailable: unavailable.slice(-100),
        error: detail,
        retryAt: rateLimitReset(detail, cell.now()),
      },
    };
  }
}

async function fetchCiRequest(
  cell: Parameters<typeof fetchCiObservations>[0],
  request: RepoTaskAction,
  gh: RunGh,
): Promise<{ readonly fetched: CiObservationFetch } | { readonly failure: unknown }> {
  try {
    return { fetched: await fetchCiObservations(cell, request, gh) };
  } catch (failure) {
    return { failure };
  }
}

function key(target: Target): string {
  return `${target.runId}.${target.attempt}`;
}

function rateLimitReset(detail: string, now: string): string | null {
  const hint = /(?:resets in|reset in|try again in) ((?:[0-9]+[hms])+)/iu.exec(detail)?.[1];
  if (!hint) return null;
  const factors = { h: 3_600_000, m: 60_000, s: 1_000 };
  const delay = [...hint.matchAll(/([0-9]+)([hms])/gu)].reduce(
    (sum, match) => sum + Number(match[1]) * factors[match[2] as keyof typeof factors],
    0,
  );
  return new Date(Date.parse(now) + delay).toISOString();
}
