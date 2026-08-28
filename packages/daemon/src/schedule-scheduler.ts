import { consumeKnownError, nextScheduleOccurrence, type ScheduleMissedReason } from "../../kernel/src/index.ts";
import type { DaemonCommandClass } from "./identity/types.ts";
import type { JsonObject } from "./protocol/json-rpc-types.ts";
import { parseScheduleListReceipt, type ScheduleListRow } from "./protocol/daemon-protocol-validate-results.ts";
import type { RepoCell, RepoCellBinding } from "./repo-cell.ts";

export const scheduleAdmissionWindowMs = 60_000;

type TimerHandle = ReturnType<typeof setTimeout>;
type ScheduleAction = Readonly<Record<string, unknown>> & { readonly kind: string };
type ScheduleTarget = {
  readonly repoId: string;
  readonly execute: (action: ScheduleAction) => Promise<Readonly<Record<string, unknown>>>;
};
type DueOccurrence = {
  readonly target: ScheduleTarget;
  readonly scheduleId: string;
  readonly scheduledFor: string;
  readonly wakeAt: string;
  readonly definitionRevision: number;
};
type MissedOccurrences = {
  readonly target: ScheduleTarget;
  readonly scheduleId: string;
  readonly from: string;
  readonly to: string;
  readonly count: number;
  readonly reason: ScheduleMissedReason;
  readonly definitionRevision: number;
};

export function makeScheduleScheduler(input: {
  readonly cells: ReadonlyMap<string, RepoCell>;
  readonly localBinding: (rootDir: string, required: DaemonCommandClass) => RepoCellBinding | Promise<RepoCellBinding>;
  readonly remoteEdgeAction?: (
    repoId: string,
    rootDir: string,
    action: JsonObject,
  ) => Promise<Readonly<Record<string, unknown>>>;
  readonly now?: () => string;
  readonly setTimer?: (callback: () => void, delayMs: number) => TimerHandle;
  readonly clearTimer?: (timer: TimerHandle) => void;
}) {
  const now = input.now ?? (() => new Date().toISOString()),
    setTimer = input.setTimer ?? ((callback, delayMs) => setTimeout(callback, delayMs)),
    clearTimer = input.clearTimer ?? clearTimeout,
    attempted = new Set<string>();
  let started = false,
    closed = false,
    timer: TimerHandle | null = null,
    tail = Promise.resolve();

  const start = async (): Promise<void> => {
    if (started || closed) return;
    started = true;
    await refresh();
  };

  const refresh = (): Promise<void> => {
    if (!started || closed) return Promise.resolve();
    const pending = tail.then(reconcile, reconcile);
    tail = pending.then(
      () => undefined,
      () => undefined,
    );
    return pending;
  };

  const close = (): void => {
    closed = true;
    if (timer) clearTimer(timer);
    timer = null;
  };

  async function reconcile(): Promise<void> {
    if (closed) return;
    if (timer) clearTimer(timer);
    timer = null;
    const plan = await evaluationPlan();
    if (plan.missed.length) {
      if (await applyMissed(plan.missed)) return reconcile();
      armRetry();
      return;
    }
    const first = plan.due.sort((left, right) => left.wakeAt.localeCompare(right.wakeAt))[0];
    if (!first) return;
    const delayMs = Math.max(0, Date.parse(first.wakeAt) - Date.parse(now()));
    timer = setTimer(
      () => {
        timer = null;
        const pending = tail.then(tick, tick);
        tail = pending.then(
          () => undefined,
          () => undefined,
        );
      },
      Math.min(delayMs, 2_147_483_647),
    );
    timer.unref?.();
  }

  async function tick(): Promise<void> {
    if (closed) return;
    const plan = await evaluationPlan();
    if (plan.missed.length) {
      if (await applyMissed(plan.missed)) await reconcile();
      else armRetry();
      return;
    }
    const observedAt = now(),
      due = plan.due.filter(({ wakeAt }) => wakeAt <= observedAt);
    await Promise.all(
      due.map(async (occurrence) => {
        const key = occurrenceKey(occurrence);
        if (attempted.has(key)) return;
        attempted.add(key);
        try {
          await occurrence.target.execute({
            kind: "schedule-run-now",
            scheduleId: occurrence.scheduleId,
            scheduledFor: occurrence.scheduledFor,
            observedDefinitionRevision: occurrence.definitionRevision,
            idempotencyKey: key,
          });
        } catch (error) {
          consumeKnownError(error);
          console.warn(
            `[schedule-scheduler] ${occurrence.target.repoId}/${occurrence.scheduleId} fire failed: ` +
              errorMessage(error),
          );
        }
      }),
    );
    await reconcile();
  }

  function armRetry(): void {
    timer = setTimer(() => {
      timer = null;
      void refresh();
    }, 1_000);
    timer.unref?.();
  }

  async function evaluationPlan(): Promise<{
    readonly due: DueOccurrence[];
    readonly missed: MissedOccurrences[];
  }> {
    const observedAt = now(),
      due: DueOccurrence[] = [],
      missed: MissedOccurrences[] = [],
      currentOccurrences = new Set<string>();
    for (const [repoId, cell] of input.cells) {
      const { mode } = cell.status();
      if (mode === "remote-center") continue;
      const target = targetFor(repoId, cell);
      if (!target) continue;
      let schedules: readonly ScheduleListRow[];
      try {
        schedules = await listSchedules(target);
      } catch (error) {
        consumeKnownError(error);
        console.warn(`[schedule-scheduler] ${repoId} refresh failed: ${errorMessage(error)}`);
        continue;
      }
      for (const schedule of schedules) {
        const evaluated = evaluateSchedule(target, schedule, observedAt);
        if (evaluated.due) {
          const key = occurrenceKey(evaluated.due);
          currentOccurrences.add(key);
          due.push(
            attempted.has(key) && evaluated.due.scheduledFor <= observedAt
              ? {
                  ...evaluated.due,
                  wakeAt: new Date(
                    Date.parse(evaluated.due.scheduledFor) + scheduleAdmissionWindowMs + 1,
                  ).toISOString(),
                }
              : evaluated.due,
          );
        }
        if (evaluated.missed) missed.push(evaluated.missed);
      }
    }
    for (const key of attempted) if (!currentOccurrences.has(key)) attempted.delete(key);
    return { due, missed };
  }

  function targetFor(repoId: string, cell: RepoCell): ScheduleTarget | null {
    const { mode, rootDir } = cell.status();
    if (mode === "local")
      return {
        repoId,
        execute: async (action) =>
          cell.run(
            action,
            await input.localBinding(rootDir, action.kind === "schedule-list" ? "repo-read" : "repo-write"),
          ) as unknown as Promise<Readonly<Record<string, unknown>>>,
      };
    if (mode !== "remote-edge" || !input.remoteEdgeAction) return null;
    return {
      repoId,
      execute: (action) => input.remoteEdgeAction!(repoId, rootDir, action as JsonObject),
    };
  }

  return { start, refresh, close };
}

async function listSchedules(target: ScheduleTarget): Promise<readonly ScheduleListRow[]> {
  const receipt = await target.execute({ kind: "schedule-list" }),
    schedules = parseScheduleListReceipt(receipt);
  if (!schedules) throw new Error("Schedule list receipt evidence is invalid.");
  return schedules;
}

function evaluateSchedule(
  target: ScheduleTarget,
  schedule: ScheduleListRow,
  observedAt: string,
): { readonly due: DueOccurrence | null; readonly missed: MissedOccurrences | null } {
  if (schedule.state !== "armed") return { due: null, missed: null };
  const cursor =
      Date.parse(schedule.updatedAt) > Date.parse(schedule.status.automaticEvaluatedThrough)
        ? schedule.updatedAt
        : schedule.status.automaticEvaluatedThrough,
    first = nextScheduleOccurrence(schedule.spec.trigger, cursor),
    firstMs = Date.parse(first),
    observedMs = Date.parse(observedAt);
  if (firstMs > observedMs)
    return {
      due: {
        target,
        scheduleId: schedule.scheduleId,
        scheduledFor: first,
        wakeAt: first,
        definitionRevision: schedule.definitionRevision,
      },
      missed: null,
    };
  const everyMs = schedule.spec.trigger.everyMs,
    count = Math.floor((observedMs - firstMs) / everyMs) + 1,
    latest = new Date(firstMs + (count - 1) * everyMs).toISOString(),
    latestAdmitted = observedMs - Date.parse(latest) <= scheduleAdmissionWindowMs,
    missedCount = schedule.status.activeRun ? count : latestAdmitted ? count - 1 : count,
    reason: ScheduleMissedReason = schedule.status.activeRun ? "single_flight" : "scheduler_unavailable";
  if (missedCount > 0)
    return {
      due: null,
      missed: {
        target,
        scheduleId: schedule.scheduleId,
        from: first,
        to: new Date(firstMs + (missedCount - 1) * everyMs).toISOString(),
        count: missedCount,
        reason,
        definitionRevision: schedule.definitionRevision,
      },
    };
  if (!latestAdmitted || schedule.status.activeRun) return { due: null, missed: null };
  return {
    due: {
      target,
      scheduleId: schedule.scheduleId,
      scheduledFor: latest,
      wakeAt: latest,
      definitionRevision: schedule.definitionRevision,
    },
    missed: null,
  };
}

async function recordMissed(input: MissedOccurrences): Promise<void> {
  await input.target.execute({
    kind: "schedule-settle",
    phase: "missed",
    scheduleId: input.scheduleId,
    from: input.from,
    to: input.to,
    count: input.count,
    reason: input.reason,
    observedDefinitionRevision: input.definitionRevision,
    idempotencyKey: ["schedule-missed", input.target.repoId, input.scheduleId, input.from, input.to, input.reason].join(
      ":",
    ),
  });
}

async function applyMissed(inputs: readonly MissedOccurrences[]): Promise<boolean> {
  const outcomes = await Promise.allSettled(inputs.map(recordMissed));
  for (const [index, outcome] of outcomes.entries())
    if (isRejected(outcome)) {
      consumeKnownError(outcome.reason);
      const input = inputs[index]!;
      console.warn(
        `[schedule-scheduler] ${input.target.repoId}/${input.scheduleId} missed settlement failed: ` +
          errorMessage(outcome.reason),
      );
    }
  return !outcomes.some(isRejected);
}

function occurrenceKey(input: DueOccurrence): string {
  return ["schedule-timer", input.target.repoId, input.scheduleId, input.scheduledFor].join(":");
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isRejected(outcome: PromiseSettledResult<unknown>): outcome is PromiseRejectedResult {
  return outcome.status === "rejected";
}
