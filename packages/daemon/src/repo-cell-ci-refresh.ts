import { randomUUID } from "node:crypto";
import type { ScheduleV1, WriteReceipt } from "@harness-anything/kernel";
import type { RepoCellApiContext } from "./repo-cell-api.ts";
import type { RepoCellBinding, RepoTaskAction } from "./repo-cell-types.ts";
import { builtinCiObserveScheduleId } from "./schedule-builtin-executor.ts";
import { isSquadControlResult, type SquadControlResult } from "./squad-control-result.ts";
import { githubActionsGateResult, submittedGithubActionsRequirement } from "./repo-cell-ci-evidence.ts";

type RefreshContext = Pick<
  RepoCellApiContext,
  "projection" | "store" | "extracted" | "cellCodedError" | "now" | "withHumanSummary"
>;

export interface CiRefreshQueue {
  /** The external read behind a `ci-observe-pull` action before it enters the write queue. */
  readonly refreshCi: (action: RepoTaskAction, binding: RepoCellBinding) => Promise<WriteReceipt>;
  /** The occurrence drain: queued pulls, minus those a recorded witness already answers. */
  readonly requests: () => readonly RepoTaskAction[];
  /** Resolve the triggering pull whose witness the occurrence just accepted. */
  readonly answer: (taskId: string, receipt: WriteReceipt) => void;
}

/**
 * The center CI refresh queue. A pull whose frozen github-actions witness already holds a
 * passing record at this cut is answered from the ledger alone: no provider IO, no occurrence,
 * nothing queued — completion judged that same record, so a done task returns by construction.
 * The pull that starts an occurrence waits only until the drain accepts what it asked for; the
 * diagnostic backlog and the scan settle with the occurrence in the background.
 */
export function makeCiRefreshQueue(input: {
  readonly context: RefreshContext;
  readonly builtinRuns: () => Map<string, Promise<WriteReceipt>>;
  readonly run: (action: RepoTaskAction, binding: RepoCellBinding) => Promise<WriteReceipt | SquadControlResult>;
  readonly runCommand: (action: RepoTaskAction, binding: RepoCellBinding) => Promise<WriteReceipt | SquadControlResult>;
}): CiRefreshQueue {
  const { context } = input,
    ciRequests: RepoTaskAction[] = [],
    ciWaiters = new Map<
      string,
      { readonly resolve: (receipt: WriteReceipt) => void; readonly reject: (error: unknown) => void }
    >();
  let ciRefresh: Promise<WriteReceipt> | null = null;
  const recordedWitnessReceipt = (taskId: string): WriteReceipt | null => {
    const target = submittedGithubActionsRequirement(context.projection.read(taskId).snapshot);
    if (!target) return null;
    if (githubActionsGateResult(context.extracted, target.requirement, target.execution) !== "pass") return null;
    return {
      outcome: "no_changes",
      opId: `ci-observe-pull:${taskId}`,
      revision: context.store.readHead()?.revision ?? 0,
      evidence: `CI witness of ${taskId} is already recorded; nothing to pull.`,
      summary: `CI witness of ${taskId} is already recorded; nothing to pull.`,
    } as unknown as WriteReceipt;
  };
  const refreshCi = async (action: RepoTaskAction, binding: RepoCellBinding): Promise<WriteReceipt> => {
    if (typeof action.taskId === "string") {
      const recorded = recordedWitnessReceipt(action.taskId);
      if (recorded) return recorded;
    }
    const schedule = context.projection.getEntity("schedule", builtinCiObserveScheduleId)?.value as
      | ScheduleV1
      | undefined;
    if (!schedule)
      throw context.cellCodedError(
        "schedule_target_unconfigured",
        "Run authenticated ha init --configure-only to seed the center CI Schedule.",
      );
    // A forwarded edge refresh never claims a builtin. The center cadence is its collection owner.
    if (typeof binding.source === "object" && binding.source.kind === "node")
      return context.withHumanSummary({
        outcome: "pending",
        opId: `ci-refresh:${schedule.scheduleId}`,
        revision: context.store.readHead()?.revision ?? 0,
        evidence: `Center CI Schedule ${schedule.scheduleId} will reconcile the requested witness.`,
      }) as WriteReceipt;
    if (!ciRequests.includes(action)) ciRequests.push(action);
    const queued = () =>
      context.withHumanSummary({
        outcome: "pending",
        opId: `ci-refresh:${schedule.scheduleId}`,
        revision: context.store.readHead()?.revision ?? 0,
        evidence:
          "CI request queued for center reconciliation; arrivals after the active drain wait for the next occurrence.",
      }) as WriteReceipt;
    const active =
      ciRefresh ??
      (schedule.status.activeRun ? (input.builtinRuns().get(schedule.status.activeRun.claimFence) ?? null) : null);
    if (active) {
      // A diagnostic --run arrival returns its queued receipt; the cadence owns it. A --task
      // pull's answer is its witness verdict: hold until the active occurrence settles, then
      // re-enter — the ledger may answer at once, or a fresh occurrence drains the request.
      if (typeof action.taskId !== "string") return queued();
      return active.then(
        () => refreshCi(action, binding),
        (error: unknown) => {
          throw error;
        },
      );
    }
    if (schedule.status.activeRun) {
      // In-process executors cannot survive reopening this RepoCell. Settle only its current fence.
      const recovered = await input.run(
        {
          kind: "schedule-settle",
          scheduleId: schedule.scheduleId,
          claimFence: schedule.status.activeRun.claimFence,
          outcome: "unknown",
          endedAt: context.now(),
          detail: "CI executor absent after center restart; resume durable reconciliation.",
          idempotencyKey: `ci-recover:${schedule.status.activeRun.claimFence}`,
        },
        binding,
      );
      if (isSquadControlResult(recovered) || recovered.outcome !== "applied")
        throw context.cellCodedError("schedule_claim_stale", "The orphan CI claim could not be settled.");
    }
    const taskId = typeof action.taskId === "string" ? action.taskId : null,
      waiter = taskId === null ? null : Promise.withResolvers<WriteReceipt>();
    if (waiter && taskId !== null) ciWaiters.set(taskId, waiter);
    ciRefresh = input
      .runCommand(
        { kind: "schedule-run-now", scheduleId: schedule.scheduleId, idempotencyKey: `ci-refresh:${randomUUID()}` },
        binding,
      )
      .then((receipt) => {
        if (isSquadControlResult(receipt))
          throw context.cellCodedError("invalid_command", "CI refresh requires a write receipt.");
        return receipt;
      })
      .finally(() => {
        ciRefresh = null;
      });
    // Occurrence settlement answers every waiter the drain left unanswered — a transient provider
    // failure, rate-limit backoff, or an admission rejection surfaces exactly as it did when the
    // pull waited for the whole occurrence.
    ciRefresh.then(
      (receipt) => {
        for (const pending of ciWaiters.values()) pending.resolve(receipt);
        ciWaiters.clear();
      },
      (error) => {
        for (const pending of ciWaiters.values()) pending.reject(error);
        ciWaiters.clear();
      },
    );
    return waiter ? waiter.promise : ciRefresh;
  };
  return {
    refreshCi,
    requests: () => {
      const drained = ciRequests.splice(0),
        deduped: RepoTaskAction[] = [];
      for (const request of drained) {
        if (typeof request.taskId !== "string") {
          deduped.push(request);
          continue;
        }
        // Concurrent pulls for one task are one demand; the latest request answers them all.
        const previous = deduped.findIndex((kept) => kept.taskId === request.taskId);
        if (previous >= 0) deduped.splice(previous, 1);
        deduped.push(request);
      }
      return deduped.flatMap((request) => {
        if (typeof request.taskId !== "string") return [request];
        // Drain-time re-check: a witness the previous occurrence recorded after this pull queued
        // answers the pull from the ledger — the same recorded-verdict check the re-derivation
        // pass applies to durable submissions.
        const recorded = recordedWitnessReceipt(request.taskId);
        if (!recorded) return [request];
        ciWaiters.get(request.taskId)?.resolve(recorded);
        ciWaiters.delete(request.taskId);
        return [];
      });
    },
    answer: (taskId, receipt) => {
      const waiter = ciWaiters.get(taskId);
      if (waiter) {
        ciWaiters.delete(taskId);
        waiter.resolve(receipt);
      }
    },
  };
}
