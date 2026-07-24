import type { DaemonRepoRuntimeOptions } from "./repo-runtime-options.ts";

export class ReservationReconcilerRunner {
  private readonly reconcile: DaemonRepoRuntimeOptions["reservationReconciler"];
  private readonly input: Parameters<
    NonNullable<DaemonRepoRuntimeOptions["reservationReconciler"]>
  >[0];
  private active: Promise<void> | undefined;

  constructor(
    reconcile: DaemonRepoRuntimeOptions["reservationReconciler"],
    input: Parameters<
      NonNullable<DaemonRepoRuntimeOptions["reservationReconciler"]>
    >[0]
  ) {
    this.reconcile = reconcile;
    this.input = input;
  }

  run(): Promise<void> {
    if (!this.reconcile) return Promise.resolve();
    // The reconciler orchestrates writes that are themselves serialized by
    // the daemon queue. Single-flight excludes poll overlap without making
    // the orchestrator a queue item that can wait for a write behind itself.
    if (this.active) return this.active;
    const run = this.reconcile(this.input).finally(() => {
      if (this.active === run) this.active = undefined;
    });
    this.active = run;
    return run;
  }
}
