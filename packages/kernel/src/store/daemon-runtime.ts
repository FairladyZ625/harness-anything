import path from "node:path";
import { Effect } from "effect";
import type { FlushReport, RecoveryReport, WriteOp } from "../ports/write-coordinator.ts";
import type { WriteError } from "../domain/index.ts";
import {
  createHarnessRuntimeContext,
  type HarnessLayoutOverrides,
  resolveHarnessLayout
} from "../layout/index.ts";
import { runLedgerMaterializer, type LedgerMaterializerReport } from "./ledger-materializer.ts";
import { acquireDaemonGlobalLock, type DaemonGlobalLock } from "./write-journal-locks.ts";
import { makeJournaledWriteCoordinator } from "./write-journal-coordinator.ts";
import type { JournalActor } from "./write-journal-types.ts";

const defaultDaemonActor: JournalActor = { kind: "system", id: "daemon-runtime" };
const defaultLockTtlMs = 60_000;
const defaultInteractiveMicroBatchMs = 10;
const defaultMaxInteractiveOpsPerCommit = 32;
const defaultMaterializerMaxBranchesPerBatch = 1;

export type DaemonWritePriority = "interactive" | "normal" | "background" | "maintenance";

export interface DaemonRuntimeOptions {
  readonly rootDir: string;
  readonly layoutOverrides?: HarnessLayoutOverrides;
  readonly actor?: JournalActor;
  readonly lockTtlMs?: number;
  readonly interactiveMicroBatchMs?: number;
  readonly maxInteractiveOpsPerCommit?: number;
  readonly materializerPollMs?: number | false;
  readonly materializerMaxBranchesPerBatch?: number;
}

export interface InteractiveWriteRequest {
  readonly commandId: string;
  readonly ops: ReadonlyArray<WriteOp>;
  readonly deadlineMs?: number;
}

export interface InteractiveWriteReceipt {
  readonly commandId: string;
  readonly opIds: ReadonlyArray<string>;
  readonly durable: true;
  readonly flush: FlushReport;
}

export interface BackgroundBatchRequest<Result = unknown> {
  readonly source: string;
  readonly priority?: Exclude<DaemonWritePriority, "interactive">;
  readonly run: () => Result | Promise<Result>;
}

export interface DaemonQueueSnapshot {
  readonly interactive: number;
  readonly normal: number;
  readonly background: number;
  readonly maintenance: number;
  readonly running: boolean;
}

export interface DaemonRuntimeStatus {
  readonly started: boolean;
  readonly rootDir: string;
  readonly lockPath?: string;
  readonly lockOwnerToken?: string;
  readonly queue: DaemonQueueSnapshot;
  readonly lastRecovery?: RecoveryReport;
}

export interface HarnessDaemonRuntime {
  readonly start: () => Promise<DaemonRuntimeStatus>;
  readonly stop: () => Promise<void>;
  readonly status: () => DaemonRuntimeStatus;
  readonly enqueueInteractiveWrite: (request: InteractiveWriteRequest) => Promise<InteractiveWriteReceipt>;
  readonly enqueueBackgroundBatch: <Result>(request: BackgroundBatchRequest<Result>) => Promise<Result>;
  readonly enqueueMaterializerBatch: () => Promise<LedgerMaterializerReport>;
}

interface InteractiveQueueItem {
  readonly kind: "interactive";
  readonly commandId: string;
  readonly ops: ReadonlyArray<WriteOp>;
  readonly enqueuedAt: number;
  started: boolean;
  timeout?: ReturnType<typeof setTimeout>;
  readonly resolve: (receipt: InteractiveWriteReceipt) => void;
  readonly reject: (error: WriteError) => void;
}

interface BackgroundQueueItem<Result> {
  readonly kind: "background";
  readonly source: string;
  readonly priority: Exclude<DaemonWritePriority, "interactive">;
  readonly run: () => Result | Promise<Result>;
  readonly resolve: (result: Result) => void;
  readonly reject: (error: unknown) => void;
}

export function createDaemonRuntime(options: DaemonRuntimeOptions): HarnessDaemonRuntime {
  const rootDir = path.resolve(options.rootDir);
  const runtimeContext = createHarnessRuntimeContext(rootDir, options.layoutOverrides);
  const layout = resolveHarnessLayout(runtimeContext);
  const actor = options.actor ?? defaultDaemonActor;
  const lockTtlMs = options.lockTtlMs ?? defaultLockTtlMs;
  const maxInteractiveOpsPerCommit = options.maxInteractiveOpsPerCommit ?? defaultMaxInteractiveOpsPerCommit;
  const interactiveMicroBatchMs = options.interactiveMicroBatchMs ?? defaultInteractiveMicroBatchMs;
  const materializerMaxBranchesPerBatch = options.materializerMaxBranchesPerBatch ?? defaultMaterializerMaxBranchesPerBatch;
  const queue = new DaemonWriteQueue(maxInteractiveOpsPerCommit, interactiveMicroBatchMs);
  let lock: DaemonGlobalLock | undefined;
  let coordinator: ReturnType<typeof makeJournaledWriteCoordinator> | undefined;
  let lastRecovery: RecoveryReport | undefined;
  let materializerTimer: ReturnType<typeof setInterval> | undefined;

  const requireStarted = () => {
    if (!lock || !coordinator) {
      throw { _tag: "JournalUnavailable", cause: new Error("daemon runtime is not started") } satisfies WriteError;
    }
    return { lock, coordinator };
  };

  const enqueueMaterializerBatch = () => enqueueBackgroundBatch({
    source: "ledger-materializer",
    priority: "background",
    run: () => {
      const started = requireStarted();
      return runLedgerMaterializer(runtimeContext, {
        heldGlobalLock: started.lock,
        maxBranches: materializerMaxBranchesPerBatch
      });
    }
  });

  const enqueueBackgroundBatch = <Result>(request: BackgroundBatchRequest<Result>): Promise<Result> => {
    requireStarted();
    return queue.enqueueBackground(request);
  };

  return {
    start: async () => {
      if (lock && coordinator) return status();
      lock = acquireDaemonGlobalLock(rootDir, runtimeContext, layout.journalPath, actor, lockTtlMs);
      coordinator = makeJournaledWriteCoordinator({
        rootDir,
        layoutOverrides: options.layoutOverrides,
        actor,
        lockTtlMs,
        heldGlobalLock: lock,
        autoMaterialize: false
      });
      lastRecovery = Effect.runSync(coordinator.recover);
      if (options.materializerPollMs !== false && typeof options.materializerPollMs === "number" && options.materializerPollMs > 0) {
        materializerTimer = setInterval(() => {
          void enqueueMaterializerBatch().catch(() => undefined);
        }, options.materializerPollMs);
        materializerTimer.unref();
      }
      return status();
    },
    stop: async () => {
      if (materializerTimer) clearInterval(materializerTimer);
      materializerTimer = undefined;
      queue.close();
      await queue.idle();
      lock?.release();
      lock = undefined;
      coordinator = undefined;
    },
    status,
    enqueueInteractiveWrite: (request) => {
      const started = requireStarted();
      return queue.enqueueInteractive(request, started.coordinator);
    },
    enqueueBackgroundBatch,
    enqueueMaterializerBatch
  };

  function status(): DaemonRuntimeStatus {
    return {
      started: Boolean(lock && coordinator),
      rootDir,
      ...(lock ? { lockPath: path.relative(rootDir, lock.path).split(path.sep).join("/"), lockOwnerToken: lock.ownerToken } : {}),
      queue: queue.snapshot(),
      ...(lastRecovery ? { lastRecovery } : {})
    };
  }
}

class DaemonWriteQueue {
  private readonly interactive: InteractiveQueueItem[] = [];
  private readonly normal: BackgroundQueueItem<unknown>[] = [];
  private readonly background: BackgroundQueueItem<unknown>[] = [];
  private readonly maintenance: BackgroundQueueItem<unknown>[] = [];
  private running = false;
  private closed = false;
  private idleWaiters: Array<() => void> = [];
  private coordinator: ReturnType<typeof makeJournaledWriteCoordinator> | undefined;
  private readonly maxInteractiveOpsPerCommit: number;
  private readonly interactiveMicroBatchMs: number;

  constructor(
    maxInteractiveOpsPerCommit: number,
    interactiveMicroBatchMs: number
  ) {
    this.maxInteractiveOpsPerCommit = maxInteractiveOpsPerCommit;
    this.interactiveMicroBatchMs = interactiveMicroBatchMs;
  }

  enqueueInteractive(request: InteractiveWriteRequest, coordinator: ReturnType<typeof makeJournaledWriteCoordinator>): Promise<InteractiveWriteReceipt> {
    if (this.closed) return Promise.reject({ _tag: "JournalUnavailable", cause: new Error("daemon write queue is closed") } satisfies WriteError);
    this.coordinator = coordinator;
    return new Promise((resolve, reject) => {
      const item: InteractiveQueueItem = {
        kind: "interactive",
        commandId: request.commandId,
        ops: request.ops,
        enqueuedAt: Date.now(),
        started: false,
        resolve,
        reject
      };
      if (request.deadlineMs !== undefined) {
        item.timeout = setTimeout(() => {
          if (item.started) return;
          this.removeInteractive(item);
          reject({ _tag: "JournalUnavailable", cause: new Error(`daemon queue wait timeout after ${request.deadlineMs}ms`) } satisfies WriteError);
          this.resolveIdleIfNeeded();
        }, request.deadlineMs);
      }
      this.interactive.push(item);
      this.schedule();
    });
  }

  enqueueBackground<Result>(request: BackgroundBatchRequest<Result>): Promise<Result> {
    if (this.closed) return Promise.reject(new Error("daemon write queue is closed"));
    return new Promise((resolve, reject) => {
      const item: BackgroundQueueItem<Result> = {
        kind: "background",
        source: request.source,
        priority: request.priority ?? "background",
        run: request.run,
        resolve,
        reject
      };
      this.queueFor(item.priority).push(item as BackgroundQueueItem<unknown>);
      this.schedule();
    });
  }

  close(): void {
    this.closed = true;
  }

  async idle(): Promise<void> {
    if (this.isIdle()) return;
    await new Promise<void>((resolve) => this.idleWaiters.push(resolve));
  }

  snapshot(): DaemonQueueSnapshot {
    return {
      interactive: this.interactive.length,
      normal: this.normal.length,
      background: this.background.length,
      maintenance: this.maintenance.length,
      running: this.running
    };
  }

  private schedule(): void {
    if (this.running) return;
    this.running = true;
    queueMicrotask(() => {
      void this.drain().finally(() => {
        this.running = false;
        this.resolveIdleIfNeeded();
        if (!this.isIdle()) this.schedule();
      });
    });
  }

  private async drain(): Promise<void> {
    while (!this.isIdle()) {
      if (this.interactive.length > 0) {
        if (!this.coordinator) return;
        await this.drainInteractive(this.coordinator);
        continue;
      }
      const backgroundItem = this.normal.shift() ?? this.background.shift() ?? this.maintenance.shift();
      if (!backgroundItem) return;
      await this.runBackground(backgroundItem);
    }
  }

  private async drainInteractive(coordinator: ReturnType<typeof makeJournaledWriteCoordinator>): Promise<void> {
    if (this.interactiveMicroBatchMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, this.interactiveMicroBatchMs));
    }
    const batch: InteractiveQueueItem[] = [];
    let opCount = 0;
    while (this.interactive.length > 0 && opCount < this.maxInteractiveOpsPerCommit) {
      const item = this.interactive.shift()!;
      item.started = true;
      if (item.timeout) clearTimeout(item.timeout);
      batch.push(item);
      opCount += item.ops.length;
    }
    const accepted: InteractiveQueueItem[] = [];
    for (const item of batch) {
      try {
        for (const op of item.ops) {
          Effect.runSync(coordinator.enqueue(op));
        }
        accepted.push(item);
      } catch (error) {
        item.reject(toWriteError(error));
      }
    }
    if (accepted.length === 0) return;
    try {
      const report = Effect.runSync(coordinator.flush("explicit"));
      for (const item of accepted) {
        item.resolve({
          commandId: item.commandId,
          opIds: item.ops.map((op) => op.opId),
          durable: true,
          flush: report
        });
      }
    } catch (error) {
      const writeError = toWriteError(error);
      for (const item of accepted) item.reject(writeError);
    }
  }

  private async runBackground(item: BackgroundQueueItem<unknown>): Promise<void> {
    try {
      item.resolve(await item.run());
    } catch (error) {
      item.reject(error);
    }
  }

  private queueFor(priority: Exclude<DaemonWritePriority, "interactive">): BackgroundQueueItem<unknown>[] {
    if (priority === "normal") return this.normal;
    if (priority === "maintenance") return this.maintenance;
    return this.background;
  }

  private removeInteractive(item: InteractiveQueueItem): void {
    const index = this.interactive.indexOf(item);
    if (index >= 0) this.interactive.splice(index, 1);
  }

  private isIdle(): boolean {
    return this.interactive.length === 0
      && this.normal.length === 0
      && this.background.length === 0
      && this.maintenance.length === 0
      && !this.running;
  }

  private resolveIdleIfNeeded(): void {
    if (!this.isIdle()) return;
    const waiters = this.idleWaiters.splice(0, this.idleWaiters.length);
    for (const resolve of waiters) resolve();
  }
}

function toWriteError(error: unknown): WriteError {
  if (isWriteError(error)) return error;
  return { _tag: "JournalUnavailable", cause: error };
}

function isWriteError(error: unknown): error is WriteError {
  return typeof error === "object"
    && error !== null
    && "_tag" in error
    && (
      error._tag === "WriteRejected"
      || error._tag === "WriteConflict"
      || error._tag === "GlobalWriteConflict"
      || error._tag === "JournalUnavailable"
    );
}
