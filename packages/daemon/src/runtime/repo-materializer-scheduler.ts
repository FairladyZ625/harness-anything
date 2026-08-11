import type { DaemonWriteQueue } from "./write-queue.ts";

export type RepoMaterializerPriority = "foreground" | "recovery";

/** Keeps recovery projection work behind live admissions and live settlement. */
export class RepoMaterializerScheduler {
  private readonly queue: DaemonWriteQueue;
  private activeAuthorityAdmissions = 0;
  private authorityAdmissionEpoch = 0;
  private authorityAdmissionWaiters: Array<() => void> = [];
  private activeForegroundMaterializers = 0;
  private foregroundMaterializerEpoch = 0;
  private foregroundMaterializerWaiters: Array<() => void> = [];

  constructor(queue: DaemonWriteQueue) {
    this.queue = queue;
  }

  beginAuthorityAdmission(): () => void {
    this.activeAuthorityAdmissions += 1;
    this.authorityAdmissionEpoch += 1;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.activeAuthorityAdmissions -= 1;
      if (this.activeAuthorityAdmissions !== 0) return;
      for (const resolve of this.authorityAdmissionWaiters.splice(0)) resolve();
    };
  }

  beginForegroundMaterializer(): () => void {
    this.activeForegroundMaterializers += 1;
    this.foregroundMaterializerEpoch += 1;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.activeForegroundMaterializers -= 1;
      if (this.activeForegroundMaterializers !== 0) return;
      for (const resolve of this.foregroundMaterializerWaiters.splice(0)) resolve();
    };
  }

  async schedule<Result>(
    source: string,
    run: () => Result | Promise<Result>,
    priority: RepoMaterializerPriority = "foreground"
  ): Promise<Result> {
    for (;;) {
      await this.waitForAuthorityAdmissions();
      if (priority === "recovery") await this.waitForForegroundMaterializers();
      const readyEpoch = this.authorityAdmissionEpoch;
      const readyForegroundEpoch = this.foregroundMaterializerEpoch;
      await new Promise<void>((resolve) => setImmediate(resolve));
      if (!this.canRun(priority, readyEpoch, readyForegroundEpoch)) continue;
      const attempt = await this.queue.enqueueBackground({
        source,
        priority: priority === "foreground" ? "normal" : "background",
        run: async () => this.canRun(priority, readyEpoch, readyForegroundEpoch)
          ? { ready: true as const, value: await run() }
          : { ready: false as const }
      });
      if (attempt.ready) return attempt.value;
    }
  }

  private canRun(priority: RepoMaterializerPriority, authorityEpoch: number, foregroundEpoch: number): boolean {
    return this.activeAuthorityAdmissions === 0
      && this.authorityAdmissionEpoch === authorityEpoch
      && (priority !== "recovery" || (
        this.activeForegroundMaterializers === 0
        && this.foregroundMaterializerEpoch === foregroundEpoch
      ));
  }

  private waitForAuthorityAdmissions(): Promise<void> {
    if (this.activeAuthorityAdmissions === 0) return Promise.resolve();
    return new Promise<void>((resolve) => this.authorityAdmissionWaiters.push(resolve));
  }

  private waitForForegroundMaterializers(): Promise<void> {
    if (this.activeForegroundMaterializers === 0) return Promise.resolve();
    return new Promise<void>((resolve) => this.foregroundMaterializerWaiters.push(resolve));
  }
}
