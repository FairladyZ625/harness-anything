import { RepoWriteStartupStalledError } from "./repo-write-client-errors.ts";
import type { RepoWriteStartupProgressFrame } from "./repo-write-protocol.ts";

interface PendingReady {
  readonly promise: Promise<void>;
  readonly resolve: () => void;
  readonly reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

/** Owns READY waiting and semantic pre-READY progress without request-lane state. */
export class RepoWriteClientReadyGate {
  private readonly stallTimeoutMs: number;
  private readonly onStall: (error: RepoWriteStartupStalledError) => void;
  private readonly progressSeen = new Set<string>();
  private pending: PendingReady | undefined;
  private lastProgress: RepoWriteStartupProgressFrame | undefined;
  private repeatedProgressFrames = 0;

  constructor(input: {
    readonly stallTimeoutMs: number;
    readonly onStall: (error: RepoWriteStartupStalledError) => void;
  }) {
    this.stallTimeoutMs = input.stallTimeoutMs;
    this.onStall = input.onStall;
  }

  wait(): Promise<void> {
    if (this.pending) return this.pending.promise;
    let resolveReady: (() => void) | undefined;
    let rejectReady: ((error: Error) => void) | undefined;
    const promise = new Promise<void>((resolve, reject) => {
      resolveReady = resolve;
      rejectReady = reject;
    });
    this.pending = {
      promise,
      resolve: resolveReady!,
      reject: rejectReady!,
      timer: this.armStallTimer()
    };
    return promise;
  }

  observe(message: RepoWriteStartupProgressFrame): void {
    const progressKey = `${message.phase}\u0000${message.workUnit}`;
    this.lastProgress = message;
    if (this.progressSeen.has(progressKey)) {
      this.repeatedProgressFrames += 1;
      return;
    }
    this.progressSeen.add(progressKey);
    this.repeatedProgressFrames = 0;
    if (!this.pending) return;
    clearTimeout(this.pending.timer);
    this.pending.timer = this.armStallTimer();
  }

  resolve(): void {
    if (!this.pending) return;
    clearTimeout(this.pending.timer);
    const pending = this.pending;
    this.pending = undefined;
    pending.resolve();
  }

  reject(error: Error): void {
    if (!this.pending) return;
    clearTimeout(this.pending.timer);
    const pending = this.pending;
    this.pending = undefined;
    pending.reject(error);
  }

  private armStallTimer(): NodeJS.Timeout {
    const timer = setTimeout(() => this.expire(), this.stallTimeoutMs);
    timer.unref();
    return timer;
  }

  private expire(): void {
    const pending = this.pending;
    if (!pending) return;
    this.pending = undefined;
    const error = new RepoWriteStartupStalledError({
      stallTimeoutMs: this.stallTimeoutMs,
      ...(this.lastProgress === undefined ? {} : {
        phase: this.lastProgress.phase,
        workUnit: this.lastProgress.workUnit
      }),
      repeatedProgressFrames: this.repeatedProgressFrames
    });
    this.onStall(error);
    pending.reject(error);
  }
}
