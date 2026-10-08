import { readFileSync } from "node:fs";
import {
  consumeKnownError,
  INITIAL_SETTINGS_V1,
  nextScheduleOccurrence,
  readSettingsFacet,
  resolveHarnessLayout,
  type ScheduleMissedReason,
  type ScheduleActiveRunV1,
} from "@harness-anything/kernel";
import type { ScheduleTriggerV1 } from "@harness-anything/kernel";
import type { JsonObject } from "./protocol/json-rpc-types.ts";
import {
  daemonCommandReceiptRejectionCode,
  makeDaemonCommandReceipt,
  parseScheduleListReceipt,
  type ScheduleListRow,
} from "./protocol/daemon-protocol-validate-results.ts";
import { fleetEdgeBackoffMs } from "./fleet-edge-task.ts";
import { cellErrorCode } from "./repo-cell-errors.ts";
import type { RepoCell, RepoCellBinding } from "./repo-cell.ts";

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
  readonly localBinding: (
    repoId: string,
    rootDir: string,
    action: ScheduleAction,
  ) => RepoCellBinding | Promise<RepoCellBinding>;
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
  // Consecutive unanswered Schedule reads per remote-edge repository; cleared by the first answer.
  let unreachable: ReadonlyMap<string, number> = new Map();
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
      const settlement = await applyMissed(plan.missed);
      if (settlement === "transient") {
        armRetry();
        return;
      }
      // A clean settlement re-evaluates at once. A receipt rejection is the cell's final verdict
      // on that interval — recorded, never retried on a timer — and the due batch below still
      // arms, so one repository's verdict cannot freeze every other schedule.
      if (settlement === "clean") return reconcile();
    }
    if (plan.pending) {
      armRetry();
      return;
    }
    const first = plan.due.sort((left, right) => left.wakeAt.localeCompare(right.wakeAt))[0],
      delayMs = first ? Math.max(0, Date.parse(first.wakeAt) - Date.parse(now())) : Infinity;
    if (plan.retryAfterMs < delayMs) {
      armRetry(plan.retryAfterMs);
      return;
    }
    if (!first) return;
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
      const settlement = await applyMissed(plan.missed);
      if (settlement === "transient") {
        armRetry();
        return;
      }
      if (settlement === "clean") {
        await reconcile();
        return;
      }
    }
    if (plan.pending) {
      armRetry();
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

  function armRetry(delayMs = 1_000): void {
    timer = setTimer(() => {
      timer = null;
      void refresh();
    }, delayMs);
    timer.unref?.();
  }

  async function evaluationPlan(): Promise<{
    readonly due: DueOccurrence[];
    readonly missed: MissedOccurrences[];
    readonly pending: boolean;
    readonly retryAfterMs: number;
  }> {
    const observedAt = now(),
      due: DueOccurrence[] = [],
      missed: MissedOccurrences[] = [],
      currentOccurrences = new Set<string>(),
      stillUnreachable = new Map<string, number>();
    let pending = false;
    for (const [repoId, cell] of input.cells) {
      const { mode, state } = cell.status();
      if (state !== "attached") continue;
      const target = targetFor(repoId, cell);
      if (!target) continue;
      let schedules: readonly ScheduleListRow[], admissionWindowMs: number;
      try {
        schedules = await listSchedules(target);
        admissionWindowMs = scheduleAdmissionWindowMs(cell.status().rootDir);
      } catch (error) {
        consumeKnownError(error);
        if (cellErrorCode(error) === "projection_pending") {
          pending = true;
          continue;
        }
        if (cell.status().state !== "attached") {
          console.warn(`[schedule-scheduler] ${repoId} skipped: ${errorMessage(error)}`);
          continue;
        }
        if (mode === "remote-edge") {
          // The center answers every remote-edge read, so an unanswered one is retried on the edge's
          // own backoff; nothing else would wake this node again. One warning per outage.
          const failures = (unreachable.get(repoId) ?? 0) + 1;
          stillUnreachable.set(repoId, failures);
          if (failures === 1)
            console.warn(`[schedule-scheduler] ${repoId} refresh failed, retrying: ${errorMessage(error)}`);
          continue;
        }
        console.warn(`[schedule-scheduler] ${repoId} refresh failed: ${errorMessage(error)}`);
        continue;
      }
      for (const schedule of schedules) {
        // A builtin occurrence executes on the node holding the canonical cell; a remote-edge
        // mirror must never claim one (the kernel also rejects assignment-sourced claims). Every
        // other occurrence executes where its runtime lives, which is never a remote-center.
        const builtin = schedule.state !== "invalid" && schedule.spec.target.kind === "builtin";
        if (mode === "remote-edge" ? builtin : mode === "remote-center" && !builtin) continue;
        if (
          builtin &&
          schedule.status.activeRun &&
          !(await cell.hasBuiltinExecutor((schedule.status.activeRun as ScheduleActiveRunV1).claimFence))
        ) {
          const active = schedule.status.activeRun as ScheduleActiveRunV1;
          await target.execute({
            kind: "schedule-settle",
            scheduleId: schedule.scheduleId,
            claimFence: active.claimFence,
            outcome: "unknown",
            endedAt: observedAt,
            detail: "In-process builtin executor absent after center restart; resume durable checkpoint.",
            idempotencyKey: `builtin-recovery:${active.claimFence}`,
          });
          pending = true;
          continue;
        }
        const evaluated = evaluateSchedule(target, schedule, observedAt, admissionWindowMs);
        if (evaluated.due) {
          const key = occurrenceKey(evaluated.due);
          currentOccurrences.add(key);
          due.push(
            attempted.has(key) && evaluated.due.scheduledFor <= observedAt
              ? {
                  ...evaluated.due,
                  wakeAt: new Date(Date.parse(evaluated.due.scheduledFor) + admissionWindowMs + 1).toISOString(),
                }
              : evaluated.due,
          );
        }
        if (evaluated.missed) missed.push(evaluated.missed);
      }
    }
    for (const key of attempted) if (!currentOccurrences.has(key)) attempted.delete(key);
    unreachable = stillUnreachable;
    const retryAfterMs = Math.min(...[...unreachable.values()].map((failures) => fleetEdgeBackoffMs(failures - 1)));
    return { due, missed, pending, retryAfterMs };
  }

  function targetFor(repoId: string, cell: RepoCell): ScheduleTarget | null {
    const { mode, rootDir } = cell.status();
    if (mode !== "remote-edge")
      return {
        repoId,
        execute: async (action) =>
          cell.run(action, await input.localBinding(repoId, rootDir, action)) as unknown as Promise<
            Readonly<Record<string, unknown>>
          >,
      };
    if (!input.remoteEdgeAction) return null;
    return {
      repoId,
      execute: (action) => input.remoteEdgeAction!(repoId, rootDir, action as JsonObject),
    };
  }

  return { start, refresh, close };
}

/** Every node reads the same Settings: an edge's materialized harness.yaml is the center's facet. */
function scheduleAdmissionWindowMs(rootDir: string): number {
  const { configPath } = resolveHarnessLayout(rootDir);
  return (configPath ? readSettingsFacet(readFileSync(configPath, "utf8")) : INITIAL_SETTINGS_V1).schedule
    .admissionWindowMs;
}

async function listSchedules(target: ScheduleTarget): Promise<readonly ScheduleListRow[]> {
  const receipt = makeDaemonCommandReceipt("schedule-list", await target.execute({ kind: "schedule-list" })),
    rejectionCode = daemonCommandReceiptRejectionCode(receipt);
  if (rejectionCode)
    throw Object.assign(new Error(`Schedule list rejected: ${rejectionCode}.`), { code: rejectionCode });
  const schedules = parseScheduleListReceipt(receipt);
  if (!schedules) throw new Error("Schedule list receipt evidence is invalid.");
  return schedules;
}

function evaluateSchedule(
  target: ScheduleTarget,
  schedule: ScheduleListRow,
  observedAt: string,
  admissionWindowMs: number,
): { readonly due: DueOccurrence | null; readonly missed: MissedOccurrences | null } {
  if (schedule.state === "invalid") return { due: null, missed: null };
  if (schedule.state !== "armed" || (schedule.spec.target.kind !== "agent" && schedule.spec.target.kind !== "builtin"))
    return { due: null, missed: null };
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
  const { count, latest } = occurrencesThrough(schedule.spec.trigger, first, observedAt),
    latestAdmitted = observedMs - Date.parse(latest) <= admissionWindowMs,
    missedCount = schedule.status.activeRun ? count : latestAdmitted ? count - 1 : count,
    reason: ScheduleMissedReason = schedule.status.activeRun ? "single_flight" : "scheduler_unavailable";
  if (missedCount > 0)
    return {
      due: null,
      missed: {
        target,
        scheduleId: schedule.scheduleId,
        from: first,
        to: occurrenceAt(schedule.spec.trigger, first, missedCount - 1),
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

function occurrencesThrough(
  trigger: ScheduleTriggerV1,
  first: string,
  observedAt: string,
): { readonly count: number; readonly latest: string } {
  if (trigger.kind === "interval") {
    const count = Math.floor((Date.parse(observedAt) - Date.parse(first)) / trigger.everyMs) + 1;
    return { count, latest: new Date(Date.parse(first) + (count - 1) * trigger.everyMs).toISOString() };
  }
  let count = 1,
    latest = first;
  while (true) {
    const next = nextScheduleOccurrence(trigger, latest);
    if (next > observedAt) return { count, latest };
    latest = next;
    count += 1;
  }
}

function occurrenceAt(trigger: ScheduleTriggerV1, first: string, offset: number): string {
  if (offset < 1) return first;
  if (trigger.kind === "interval") return new Date(Date.parse(first) + offset * trigger.everyMs).toISOString();
  let occurrence = first;
  for (let index = 0; index < offset; index += 1) occurrence = nextScheduleOccurrence(trigger, occurrence);
  return occurrence;
}

async function recordMissed(input: MissedOccurrences): Promise<"settled" | "rejected"> {
  const result = await input.target.execute({
    kind: "schedule-missed",
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
  const receipt = makeDaemonCommandReceipt("schedule-missed", result),
    rejectionCode = daemonCommandReceiptRejectionCode(receipt);
  if (rejectionCode) {
    // The cell has ruled on this interval; replaying the identical settlement cannot change the
    // verdict. Record it and leave the interval to be outgrown by the schedule's own cadence.
    console.warn(
      `[schedule-scheduler] ${input.target.repoId}/${input.scheduleId} missed settlement rejected: ${rejectionCode}.`,
    );
    return "rejected";
  }
  return "settled";
}

/** Every missed interval settled, receipt-rejected, or left waiting on a transient failure. */
type MissedSettlement = "clean" | "rejected" | "transient";

async function applyMissed(inputs: readonly MissedOccurrences[]): Promise<MissedSettlement> {
  const outcomes = await Promise.allSettled(inputs.map(recordMissed));
  let settlement: MissedSettlement = "clean";
  for (const [index, outcome] of outcomes.entries()) {
    if (outcome.status === "rejected") {
      consumeKnownError(outcome.reason);
      const input = inputs[index]!;
      console.warn(
        `[schedule-scheduler] ${input.target.repoId}/${input.scheduleId} missed settlement failed: ` +
          errorMessage(outcome.reason),
      );
      settlement = "transient";
    } else if (outcome.value === "rejected" && settlement === "clean") settlement = "rejected";
  }
  return settlement;
}

function occurrenceKey(input: DueOccurrence): string {
  return ["schedule-timer", input.target.repoId, input.scheduleId, input.scheduledFor].join(":");
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
