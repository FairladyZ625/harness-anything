import path from "node:path";
import { Effect } from "effect";
import type { RecoveryReport, WriteCoordinator } from "../ports/write-coordinator.ts";
import type { WriteAttribution } from "../schemas/actor-attribution.ts";
import type { ProjectionSourceFenceFactory } from "../ports/projection-source-fence.ts";
import type { WriteError } from "../domain/index.ts";
import {
  createHarnessRuntimeContext,
  type HarnessLayoutOverrides,
  resolveHarnessLayout
} from "../layout/index.ts";
import { runLedgerMaterializer, type LedgerMaterializerReport } from "./ledger-materializer.ts";
import { DaemonWriteQueue } from "./daemon-runtime-queue.ts";
import {
  type BackgroundBatchRequest,
  type DaemonQueueSnapshot,
  type DaemonWritePriority,
  type InteractiveWriteReceipt,
  type InteractiveWriteAttribution,
  type InteractiveWriteRequest
} from "./daemon-runtime-queue.ts";
import { acquireDaemonGlobalLock, assertDaemonGlobalLockHeld, type DaemonGlobalLock } from "./write-journal-locks.ts";
import { makeJournaledWriteCoordinator, makeOperationalJournaledWriteCoordinator, recoverJournaledWrites } from "./write-journal-coordinator.ts";
import type { OperationalActor } from "./write-journal-types.ts";
import { writeOpTouchedPaths } from "./write-journal-operations.ts";
import {
  createDaemonProjectionGenerationManager,
  type DaemonProjectionGenerationManager,
  type DaemonProjectionGenerationSnapshot
} from "./daemon-projection-generation-manager.ts";
import type {
  ExecutionEvidencePage,
  ExecutionEvidencePageQuery
} from "../projection/sqlite-execution-evidence-reader.ts";

const defaultDaemonOperationalActor: OperationalActor = { scope: "operational", kind: "system", id: "daemon-runtime" };
const defaultLockTtlMs = 60_000;
const defaultInteractiveMicroBatchMs = 10;
const defaultMaxInteractiveOpsPerCommit = 32;
const defaultMaterializerMaxBranchesPerBatch = 1;

export type {
  BackgroundBatchRequest,
  DaemonQueueSnapshot,
  DaemonWritePriority,
  InteractiveWriteReceipt,
  InteractiveWriteRequest
};

export interface DaemonRuntimeOptions {
  readonly rootDir: string;
  readonly layoutOverrides?: HarnessLayoutOverrides;
  readonly operationalActor?: OperationalActor;
  readonly lockTtlMs?: number;
  readonly interactiveMicroBatchMs?: number;
  readonly maxInteractiveOpsPerCommit?: number;
  readonly materializerPollMs?: number | false;
  readonly materializerMaxBranchesPerBatch?: number;
  readonly projectionSourceFenceFactory?: ProjectionSourceFenceFactory;
  readonly reservationReconciler?: (input: {
    readonly rootDir: string;
    readonly layoutOverrides?: HarnessLayoutOverrides;
  }) => Promise<void>;
}

export interface DaemonRuntimeStatus {
  readonly started: boolean;
  readonly rootDir: string;
  readonly lockPath?: string;
  readonly lockOwnerToken?: string;
  readonly queue: DaemonQueueSnapshot;
  readonly lastRecovery?: RecoveryReport;
  readonly projectionGeneration: DaemonProjectionGenerationSnapshot;
}

export interface HarnessDaemonRuntime {
  readonly start: () => Promise<DaemonRuntimeStatus>;
  readonly stop: () => Promise<void>;
  readonly status: () => DaemonRuntimeStatus;
  readonly enqueueInteractiveWrite: (request: InteractiveWriteRequest) => Promise<InteractiveWriteReceipt>;
  readonly enqueueBackgroundBatch: <Result>(request: BackgroundBatchRequest<Result>) => Promise<Result>;
  readonly enqueueMaterializerBatch: (options?: DaemonMaterializerBatchOptions) => Promise<LedgerMaterializerReport>;
  readonly queryExecutionEvidencePage: (query: ExecutionEvidencePageQuery) => Promise<ExecutionEvidencePage>;
  /** Authority/application port backed by this runtime's current held global lock. */
  readonly createAttributedCoordinator: (input: {
    readonly attribution: WriteAttribution;
    readonly sessionId: string;
  }) => WriteCoordinator;
  readonly assertWriteFenceHeld: () => Promise<void>;
}

export interface DaemonMaterializerBatchOptions {
  readonly dryRun?: boolean;
  readonly sessionId?: string;
}

export type DaemonRepoRuntimeState = "attached" | "unavailable" | "detaching" | "detached";

export interface DaemonRepoRuntimeOptions extends DaemonRuntimeOptions {
  readonly repoId: string;
  readonly displayName?: string;
}

export interface DaemonRepoRuntimeStatus extends DaemonRuntimeStatus {
  readonly repoId: string;
  readonly canonicalRoot: string;
  readonly displayName?: string;
  readonly state: DaemonRepoRuntimeState;
  readonly lastError?: string;
  readonly lastMaterializerError?: string;
}

export interface MultiRepoDaemonRuntimeOptions extends Omit<DaemonRuntimeOptions, "rootDir" | "layoutOverrides"> {
  readonly repos: ReadonlyArray<DaemonRepoRuntimeOptions>;
}

export interface MultiRepoDaemonRuntimeStatus {
  readonly started: boolean;
  readonly repoCount: number;
  readonly attachedCount: number;
  readonly unavailableCount: number;
  readonly repos: ReadonlyArray<DaemonRepoRuntimeStatus>;
}

export interface MultiRepoHarnessDaemonRuntime {
  readonly start: () => Promise<MultiRepoDaemonRuntimeStatus>;
  readonly stop: () => Promise<void>;
  readonly status: () => MultiRepoDaemonRuntimeStatus;
  readonly attachRepo: (repo: DaemonRepoRuntimeOptions) => Promise<DaemonRepoRuntimeStatus>;
  readonly detachRepo: (repoId: string) => Promise<DaemonRepoRuntimeStatus>;
  readonly retryUnavailableRepos: () => Promise<ReadonlyArray<DaemonRepoRuntimeStatus>>;
  readonly getRepoRuntime: (repoId: string) => HarnessDaemonRuntime | undefined;
  readonly enqueueInteractiveWrite: (repoId: string, request: InteractiveWriteRequest) => Promise<InteractiveWriteReceipt>;
  readonly enqueueBackgroundBatch: <Result>(repoId: string, request: BackgroundBatchRequest<Result>) => Promise<Result>;
  readonly enqueueMaterializerBatch: (repoId: string, options?: DaemonMaterializerBatchOptions) => Promise<LedgerMaterializerReport>;
}

export function createDaemonRuntime(options: DaemonRuntimeOptions): HarnessDaemonRuntime {
  const context = new DaemonRepoRuntimeContext({ ...options, repoId: "canonical" });
  return {
    start: async () => toDaemonRuntimeStatus(await context.attach({ failOnError: true })),
    stop: () => context.stop(),
    status: () => toDaemonRuntimeStatus(context.status()),
    enqueueInteractiveWrite: (request) => context.enqueueInteractiveWrite(request),
    enqueueBackgroundBatch: (request) => context.enqueueBackgroundBatch(request),
    enqueueMaterializerBatch: (batchOptions) => context.enqueueMaterializerBatch(batchOptions),
    queryExecutionEvidencePage: (query) => context.queryExecutionEvidencePage(query),
    createAttributedCoordinator: (input) => context.createAttributedCoordinator(input),
    assertWriteFenceHeld: () => context.assertWriteFenceHeld()
  };
}

export function createMultiRepoDaemonRuntime(options: MultiRepoDaemonRuntimeOptions): MultiRepoHarnessDaemonRuntime {
  const contexts = new Map<string, DaemonRepoRuntimeContext>();
  let started = false;

  for (const repo of sortedRepoOptions(options.repos)) {
    addContext(mergeRepoDefaults(repo, options));
  }

  const runtime: MultiRepoHarnessDaemonRuntime = {
    start: async () => {
      started = true;
      for (const context of sortedContexts(contexts)) {
        await context.attach({ failOnError: false });
      }
      return status();
    },
    stop: async () => {
      const errors: unknown[] = [];
      for (const context of sortedContexts(contexts)) {
        try {
          await context.stop();
        } catch (error) {
          errors.push(error);
        }
      }
      started = false;
      if (errors.length > 0) throw new AggregateError(errors, "failed to stop one or more repo runtimes");
    },
    status,
    attachRepo: async (repo) => {
      const context = contexts.get(repo.repoId) ?? addContext(mergeRepoDefaults(repo, options));
      started = true;
      return context.attach({ failOnError: false });
    },
    detachRepo: async (repoId) => {
      const context = requireContext(contexts, repoId);
      await context.stop();
      return context.status();
    },
    retryUnavailableRepos: async () => {
      const retried: DaemonRepoRuntimeStatus[] = [];
      for (const context of sortedContexts(contexts)) {
        if (context.state !== "unavailable") continue;
        retried.push(await context.attach({ failOnError: false }));
      }
      return retried;
    },
    getRepoRuntime: (repoId) => contexts.get(repoId),
    enqueueInteractiveWrite: (repoId, request) => requireContext(contexts, repoId).enqueueInteractiveWrite(request),
    enqueueBackgroundBatch: (repoId, request) => requireContext(contexts, repoId).enqueueBackgroundBatch(request),
    enqueueMaterializerBatch: (repoId, batchOptions) => requireContext(contexts, repoId).enqueueMaterializerBatch(batchOptions)
  };
  return runtime;

  function status(): MultiRepoDaemonRuntimeStatus {
    const repos = sortedContexts(contexts).map((context) => context.status());
    return {
      started,
      repoCount: repos.length,
      attachedCount: repos.filter((repo) => repo.state === "attached").length,
      unavailableCount: repos.filter((repo) => repo.state === "unavailable").length,
      repos
    };
  }

  function addContext(repo: DaemonRepoRuntimeOptions): DaemonRepoRuntimeContext {
    if (contexts.has(repo.repoId)) throw new Error(`duplicate daemon repoId: ${repo.repoId}`);
    const rootDir = path.resolve(repo.rootDir);
    for (const existing of contexts.values()) {
      if (existing.rootDir === rootDir) throw new Error(`duplicate daemon repo root: ${rootDir}`);
    }
    const context = new DaemonRepoRuntimeContext({ ...repo, rootDir });
    contexts.set(repo.repoId, context);
    return context;
  }
}

class DaemonRepoRuntimeContext implements HarnessDaemonRuntime {
  readonly repoId: string;
  readonly rootDir: string;
  readonly displayName: string | undefined;
  state: DaemonRepoRuntimeState = "detached";

  private readonly runtimeContext: ReturnType<typeof createHarnessRuntimeContext>;
  private readonly layout: ReturnType<typeof resolveHarnessLayout>;
  private readonly operationalActor: OperationalActor;
  private readonly lockTtlMs: number;
  private readonly materializerMaxBranchesPerBatch: number;
  private readonly queue: DaemonWriteQueue;
  private readonly options: DaemonRepoRuntimeOptions;
  private projectionGeneration: DaemonProjectionGenerationManager;
  private projectionGenerationClosed = false;
  private lock: DaemonGlobalLock | undefined;
  private lastRecovery: RecoveryReport | undefined;
  private lastError: string | undefined;
  private lastMaterializerError: string | undefined;
  private materializerTimer: ReturnType<typeof setInterval> | undefined;

  constructor(options: DaemonRepoRuntimeOptions) {
    this.options = options;
    this.repoId = options.repoId;
    this.rootDir = path.resolve(options.rootDir);
    this.displayName = options.displayName;
    this.runtimeContext = createHarnessRuntimeContext(this.rootDir, options.layoutOverrides);
    this.layout = resolveHarnessLayout(this.runtimeContext);
    this.operationalActor = options.operationalActor ?? defaultDaemonOperationalActor;
    this.lockTtlMs = options.lockTtlMs ?? defaultLockTtlMs;
    this.materializerMaxBranchesPerBatch = options.materializerMaxBranchesPerBatch ?? defaultMaterializerMaxBranchesPerBatch;
    this.queue = new DaemonWriteQueue(
      options.maxInteractiveOpsPerCommit ?? defaultMaxInteractiveOpsPerCommit,
      options.interactiveMicroBatchMs ?? defaultInteractiveMicroBatchMs
    );
    this.projectionGeneration = this.createProjectionGenerationManager();
  }

  start(): Promise<DaemonRuntimeStatus> {
    return this.attach({ failOnError: true });
  }

  async attach(input: { readonly failOnError: boolean }): Promise<DaemonRepoRuntimeStatus> {
    if (this.lock && this.state === "attached") return this.status();
    if (this.projectionGenerationClosed) {
      this.projectionGeneration = this.createProjectionGenerationManager();
      this.projectionGenerationClosed = false;
    }
    this.projectionGeneration.reset();
    try {
      this.lock = acquireDaemonGlobalLock(this.rootDir, this.runtimeContext, this.layout.journalPath, this.operationalActor, this.lockTtlMs);
      this.lastRecovery = Effect.runSync(recoverJournaledWrites({
        rootDir: this.rootDir,
        layoutOverrides: this.options.layoutOverrides,
        operationalActor: this.operationalActor,
        lockTtlMs: this.lockTtlMs,
        heldGlobalLock: this.lock,
        autoMaterialize: false
      }));
      this.lastError = undefined;
      this.lastMaterializerError = undefined;
      this.state = "attached";
      await this.enqueueReservationReconciler();
      this.startMaterializerTimer();
      return this.status();
    } catch (error) {
      await this.releaseStartedParts();
      this.state = "unavailable";
      this.lastError = describeError(error);
      if (input.failOnError) throw error;
      return this.status();
    }
  }

  async stop(): Promise<void> {
    this.state = "detaching";
    this.projectionGeneration.reset();
    this.stopMaterializerTimer();
    await this.queue.idle();
    let projectionCloseError: unknown;
    try {
      await this.closeProjectionGenerationManager();
    } catch (error) {
      projectionCloseError = error;
    }
    try {
      this.lock?.release();
      if (projectionCloseError !== undefined) throw projectionCloseError;
      this.lastError = undefined;
    } catch (error) {
      this.lastError = describeError(error);
      throw error;
    } finally {
      this.lock = undefined;
      this.state = "detached";
    }
  }

  status(): DaemonRepoRuntimeStatus {
    return {
      started: Boolean(this.lock && this.state === "attached"),
      rootDir: this.rootDir,
      repoId: this.repoId,
      canonicalRoot: this.rootDir,
      ...(this.displayName ? { displayName: this.displayName } : {}),
      state: this.state,
      ...(this.lock ? { lockPath: path.relative(this.rootDir, this.lock.path).split(path.sep).join("/"), lockOwnerToken: this.lock.ownerToken } : {}),
      queue: this.queue.snapshot(),
      projectionGeneration: this.projectionGeneration.snapshot(),
      ...(this.lastRecovery ? { lastRecovery: this.lastRecovery } : {}),
      ...(this.lastError ? { lastError: this.lastError } : {}),
      ...(this.lastMaterializerError ? { lastMaterializerError: this.lastMaterializerError } : {})
    };
  }

  enqueueInteractiveWrite(request: InteractiveWriteRequest): Promise<InteractiveWriteReceipt> {
    const started = this.requireAttached();
    let touchedPaths: ReadonlyArray<string>;
    try {
      touchedPaths = request.ops.flatMap((op) => writeOpTouchedPaths(this.runtimeContext, op));
    } catch (error) {
      this.lastError = describeError(error);
      return Promise.reject(error);
    }
    const projectionWrite = this.projectionGeneration.beginCanonicalWrite(touchedPaths);
    return this.queue.enqueueInteractive(request, (batch) => this.makeStartedCoordinator(started, batch))
      .catch((error: unknown) => {
        this.lastError = describeError(error);
        throw error;
      })
      .finally(() => projectionWrite.settle());
  }

  enqueueBackgroundBatch<Result>(request: BackgroundBatchRequest<Result>): Promise<Result> {
    this.requireAttached();
    return this.queue.enqueueBackground(request)
      .catch((error: unknown) => {
        this.lastError = describeError(error);
        throw error;
      });
  }

  enqueueMaterializerBatch(batchOptions: DaemonMaterializerBatchOptions = {}): Promise<LedgerMaterializerReport> {
    return this.enqueueBackgroundBatch({
      source: "ledger-materializer",
      priority: "background",
      run: () => {
        const started = this.requireAttached();
        const report = runLedgerMaterializer(this.runtimeContext, {
          heldGlobalLock: started.lock,
          ...(batchOptions.dryRun ? { dryRun: true } : {}),
          ...(batchOptions.sessionId
            ? { sessionId: batchOptions.sessionId }
            : { maxBranches: this.materializerMaxBranchesPerBatch })
        });
        if (report.projectionRebuilt) {
          this.projectionGeneration.invalidate();
        }
        if (report.warnings.length > 0) {
          this.lastMaterializerError = report.warnings.join("; ");
        } else if (!batchOptions.sessionId) {
          this.lastMaterializerError = undefined;
        }
        return report;
      }
    }).catch((error: unknown) => {
      this.lastMaterializerError = describeError(error);
      this.projectionGeneration.invalidate();
      throw error;
    });
  }

  queryExecutionEvidencePage(query: ExecutionEvidencePageQuery): Promise<ExecutionEvidencePage> {
    this.requireAttached();
    return this.projectionGeneration.queryExecutionEvidencePage(query);
  }

  createAttributedCoordinator(input: {
    readonly attribution: WriteAttribution;
    readonly sessionId: string;
  }): WriteCoordinator {
    const started = this.requireAttached();
    const coordinator = this.makeStartedCoordinator(started, input);
    const projectionWrites: Array<ReturnType<DaemonProjectionGenerationManager["beginCanonicalWrite"]>> = [];
    return {
      enqueue: (op) => Effect.suspend(() => {
        const touchedPaths = writeOpTouchedPaths(this.runtimeContext, op);
        const projectionWrite = this.projectionGeneration.beginCanonicalWrite(touchedPaths);
        projectionWrites.push(projectionWrite);
        return coordinator.enqueue(op);
      }),
      flush: (reason) => Effect.ensuring(
        coordinator.flush(reason),
        Effect.sync(() => {
          for (const projectionWrite of projectionWrites.splice(0, projectionWrites.length)) {
            projectionWrite.settle();
          }
        })
      ),
      recover: coordinator.recover
    };
  }

  async assertWriteFenceHeld(): Promise<void> {
    const { lock } = this.requireAttached();
    assertDaemonGlobalLockHeld(lock);
  }

  private requireAttached(): { readonly lock: DaemonGlobalLock } {
    if (!this.lock || this.state !== "attached") {
      throw { _tag: "JournalUnavailable", cause: new Error(`daemon repo "${this.repoId}" is not attached`) } satisfies WriteError;
    }
    return { lock: this.lock };
  }

  private makeStartedCoordinator(
    started: ReturnType<DaemonRepoRuntimeContext["requireAttached"]>,
    request: InteractiveWriteAttribution & { readonly commitAuthor?: InteractiveWriteRequest["commitAuthor"]; readonly sessionId?: string }
  ) {
    const common = {
      rootDir: this.rootDir,
      layoutOverrides: this.options.layoutOverrides,
      operationalActor: this.operationalActor,
      lockTtlMs: this.lockTtlMs,
      heldGlobalLock: started.lock,
      autoMaterialize: false,
      ...(request.sessionId ? { sessionId: request.sessionId } : {}),
      ...(request.commitAuthor ? { commitAuthor: request.commitAuthor } : {})
    };
    return request.attribution
      ? makeJournaledWriteCoordinator({ ...common, attribution: request.attribution })
      : makeOperationalJournaledWriteCoordinator({ ...common, operationalActor: request.operationalActor });
  }

  private startMaterializerTimer(): void {
    this.stopMaterializerTimer();
    if (this.options.materializerPollMs === false || typeof this.options.materializerPollMs !== "number" || this.options.materializerPollMs <= 0) {
      return;
    }
    this.materializerTimer = setInterval(() => {
      void this.enqueueReservationReconciler().catch(() => undefined);
      void this.enqueueMaterializerBatch().catch(() => undefined);
    }, this.options.materializerPollMs);
    this.materializerTimer.unref();
  }

  private enqueueReservationReconciler(): Promise<void> {
    if (!this.options.reservationReconciler) return Promise.resolve();
    return this.enqueueBackgroundBatch({
      source: "execution-reservation-reconciler",
      priority: "background",
      run: () => this.options.reservationReconciler!({
        rootDir: this.rootDir,
        ...(this.options.layoutOverrides ? { layoutOverrides: this.options.layoutOverrides } : {})
      })
    });
  }

  private stopMaterializerTimer(): void {
    if (this.materializerTimer) clearInterval(this.materializerTimer);
    this.materializerTimer = undefined;
  }

  private async releaseStartedParts(): Promise<void> {
    this.stopMaterializerTimer();
    this.projectionGeneration.reset();
    try {
      await this.closeProjectionGenerationManager();
    } catch {
      // Attach failure reporting should keep the original attach error.
    }
    try {
      this.lock?.release();
    } catch {
      // Attach failure reporting should keep the original attach error.
    }
    this.lock = undefined;
  }

  private createProjectionGenerationManager(): DaemonProjectionGenerationManager {
    return createDaemonProjectionGenerationManager({
      rootDir: this.rootDir,
      ...(this.options.layoutOverrides ? { layoutOverrides: this.options.layoutOverrides } : {}),
      ...(this.options.projectionSourceFenceFactory ? {
        sourceFence: this.options.projectionSourceFenceFactory({
          rootDir: this.rootDir,
          ...(this.options.layoutOverrides ? { layoutOverrides: this.options.layoutOverrides } : {})
        })
      } : {})
    });
  }

  private closeProjectionGenerationManager(): Promise<void> {
    if (!this.projectionGenerationClosed) this.projectionGenerationClosed = true;
    return this.projectionGeneration.close();
  }
}

function toDaemonRuntimeStatus(status: DaemonRepoRuntimeStatus): DaemonRuntimeStatus {
  return {
    started: status.started,
    rootDir: status.rootDir,
    ...(status.lockPath ? { lockPath: status.lockPath, lockOwnerToken: status.lockOwnerToken } : {}),
    queue: status.queue,
    projectionGeneration: status.projectionGeneration,
    ...(status.lastRecovery ? { lastRecovery: status.lastRecovery } : {})
  };
}

function mergeRepoDefaults(repo: DaemonRepoRuntimeOptions, options: MultiRepoDaemonRuntimeOptions): DaemonRepoRuntimeOptions {
  return {
    ...repo,
    ...(repo.operationalActor ? {} : options.operationalActor ? { operationalActor: options.operationalActor } : {}),
    ...(repo.lockTtlMs !== undefined ? {} : options.lockTtlMs !== undefined ? { lockTtlMs: options.lockTtlMs } : {}),
    ...(repo.interactiveMicroBatchMs !== undefined ? {} : options.interactiveMicroBatchMs !== undefined ? { interactiveMicroBatchMs: options.interactiveMicroBatchMs } : {}),
    ...(repo.maxInteractiveOpsPerCommit !== undefined ? {} : options.maxInteractiveOpsPerCommit !== undefined ? { maxInteractiveOpsPerCommit: options.maxInteractiveOpsPerCommit } : {}),
    ...(repo.materializerPollMs !== undefined ? {} : options.materializerPollMs !== undefined ? { materializerPollMs: options.materializerPollMs } : {}),
    ...(repo.materializerMaxBranchesPerBatch !== undefined ? {} : options.materializerMaxBranchesPerBatch !== undefined ? { materializerMaxBranchesPerBatch: options.materializerMaxBranchesPerBatch } : {}),
    ...(repo.projectionSourceFenceFactory ? {} : options.projectionSourceFenceFactory ? { projectionSourceFenceFactory: options.projectionSourceFenceFactory } : {})
  };
}

function sortedRepoOptions(repos: ReadonlyArray<DaemonRepoRuntimeOptions>): ReadonlyArray<DaemonRepoRuntimeOptions> {
  return [...repos].sort((left, right) => left.repoId.localeCompare(right.repoId) || path.resolve(left.rootDir).localeCompare(path.resolve(right.rootDir)));
}

function sortedContexts(contexts: Map<string, DaemonRepoRuntimeContext>): ReadonlyArray<DaemonRepoRuntimeContext> {
  return [...contexts.values()].sort((left, right) => left.repoId.localeCompare(right.repoId) || left.rootDir.localeCompare(right.rootDir));
}

function requireContext(contexts: Map<string, DaemonRepoRuntimeContext>, repoId: string): DaemonRepoRuntimeContext {
  const context = contexts.get(repoId);
  if (!context) throw { _tag: "JournalUnavailable", cause: new Error(`unknown daemon repo "${repoId}"`) } satisfies WriteError;
  return context;
}

function describeError(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "object" && error !== null && "cause" in error) {
    return describeError((error as { readonly cause?: unknown }).cause);
  }
  return String(error);
}
