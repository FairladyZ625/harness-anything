import type { CiObserveProgress, ScheduleV1, WriteReceiptDraft } from "@harness-anything/kernel";
import {
  fetchCiObservations,
  listCiArtifacts,
  runCiProviderCommand,
  privateLedgerCiObservations,
  type CiObservationFetch,
  type RunGh,
} from "./ci-observation-actions.ts";
import type { RepoCellOperationalContext } from "./repo-cell-action-context.ts";
import type { RepoTaskAction } from "./repo-cell-types.ts";
import type { BuiltinExecutionResult } from "./schedule-builtin-executor.ts";

type Target = CiObserveProgress["pending"][number];
type Run = { readonly id: number; readonly run_attempt: number; readonly head_branch: string; readonly status: string };

/** Network and preparation stay outside the writer; only accept re-enters under the occurrence fence. */
export async function reconcileCiOccurrence(input: {
  readonly cell: Pick<RepoCellOperationalContext, "rootDir" | "settings" | "cellCodedError" | "projection" | "now">;
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
  const retain = (target: Target) => {
    if (!pending.has(key(target)) && pending.size === 100)
      throw cell.cellCodedError(
        "invalid_transition",
        "CI diagnostic pending capacity reached; scan page retained until targets settle.",
      );
    pending.set(key(target), target);
  };
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
      if (!(error instanceof Error) || !/HTTP 404|Not Found/iu.test(error.message)) throw error;
      pending.delete(key(target));
      unavailable.push({ runId: target.runId, attempt: target.attempt, reason: "provider-run-unavailable" });
      throw error;
    }
    await accept(fetched);
    const run = fetched.runs[0];
    if (!run) {
      retain(target);
      return;
    }
    if (run.artifactUnavailable) return;
    if (run.attemptInventory && run.attemptInventory.missingArtifactJobIds.length === 0) pending.delete(key(target));
    else {
      // Provider expiry is authoritative; an absent artifact remains pending for a later occurrence.
      const artifacts = await listCiArtifacts(gh, cell.rootDir, target.runId);
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
    await accept(privateLedgerCiObservations(cell));
    for (const target of [...pending.values()]) await observe(target);
    // Explicit refresh and completion hints drain into this same occurrence, never a second importer.
    for (const request of input.requests()) await accept(await fetchCiObservations(cell, request, gh));
    if (workflows.length) {
      const workflowIndex = Math.min(progress.workflowIndex, workflows.length - 1),
        workflow = workflows[workflowIndex]!;
      if (progress.workflow !== workflow)
        progress = { ...progress, workflow, workflowIndex, nextPage: 1, nextRunId: null, nextAttempt: 1 };
      const page = await readApi<{ workflow_runs: readonly Run[] }>(
        `repos/:owner/:repo/actions/workflows/${encodeURIComponent(workflow)}.yml/runs?per_page=20&page=${progress.nextPage}`,
      );
      const runs = page.workflow_runs.filter((run) => run.head_branch === "main");
      const resume =
        progress.nextRunId === null
          ? 0
          : Math.max(
              0,
              runs.findIndex((run) => run.id === progress.nextRunId),
            );
      let processed = 0,
        complete = true;
      for (const run of runs.slice(resume)) {
        const firstAttempt = run.id === progress.nextRunId ? progress.nextAttempt : 1;
        // The attempt increases monotonically. A bounded subpage cursor preserves an old
        // run with many reruns; it must not restart at attempt 1 after each rate-limit window.
        for (let attempt = firstAttempt; attempt <= run.run_attempt; attempt += 1) {
          progress = { ...progress, nextRunId: run.id, nextAttempt: attempt };
          if (processed === 100) {
            complete = false;
            break;
          }
          processed += 1;
          const target = { runId: run.id, attempt, workflow };
          if (run.status !== "completed" && attempt === run.run_attempt) retain(target);
          else await observe(target);
        }
        if (!complete) break;
      }
      if (complete) {
        progress = { ...progress, nextRunId: null, nextAttempt: 1 };
        if (page.workflow_runs.length) progress = { ...progress, nextPage: progress.nextPage + 1 };
        else if (workflowIndex + 1 < workflows.length)
          progress = {
            ...progress,
            workflow: workflows[workflowIndex + 1]!,
            workflowIndex: workflowIndex + 1,
            nextPage: 1,
            nextRunId: null,
            nextAttempt: 1,
          };
        else
          progress = {
            ...progress,
            workflow: workflows[0]!,
            workflowIndex: 0,
            nextPage: 1,
            scanPass: progress.scanPass + 1,
            lastCompletedScanAt: cell.now(),
          };
      }
    }
    return {
      outcome: "succeeded",
      detail: "CI reconciliation checkpoint accepted.",
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
