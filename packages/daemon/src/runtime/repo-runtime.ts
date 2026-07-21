import path from "node:path";
import { randomUUID } from "node:crypto";
import { Effect } from "effect";
import {
  createHarnessRuntimeContext,
  makeJournaledWriteCoordinator,
  makeOperationalJournaledWriteCoordinator,
  runLedgerMaterializer,
  type DaemonAdmissionBudget,
  type LedgerMaterializerReport,
  type OperationalActor,
  type RecoveryReport,
  type WriteAttribution,
  type WriteCoordinator,
  type WriteError,
  resolveHarnessLayout
} from "@harness-anything/kernel";
import {
  acquireDaemonGlobalLock,
  assertDaemonGlobalLockHeld,
  createProjectionChangePublisher,
  createRuntimeAdmissionBudget,
  recoverJournaledWrites,
  writeOpTouchedPaths,
  type ExecutionEvidencePage,
  type ExecutionEvidencePageQuery,
  type DaemonGlobalLock,
  type ProjectionChangeEvent
} from "@harness-anything/kernel/daemon-runtime-support";
import { DaemonWriteQueue } from "./write-queue.ts";
import {
  type BackgroundBatchRequest,
  type DaemonQueueSnapshot,
  type DaemonWritePriority,
  type InteractiveWriteReceipt,
  type InteractiveWriteAttribution,
  type InteractiveWriteRequest
} from "./write-queue.ts";
import { waitForDaemonQueueIdle } from "./repo-runtime-drain.ts";
import { makeDeferredAuthorityCoordinator } from "./authority-write-coordinator.ts";
import {
  enqueueDaemonAuthorityPublication,
  type DaemonAuthorityPublicationOptions,
  type DaemonAuthorityPublicationReport
} from "./authority-publication.ts";
import type {
  DaemonDrainOptions,
  DaemonMaterializerBatchOptions,
  DaemonRepoRuntimeOptions,
  DaemonRepoRuntimeState,
  DaemonRepoRuntimeStatus,
  DaemonRuntimeOptions,
  DaemonRuntimeStatus,
  HarnessDaemonRuntime,
  MultiRepoDaemonRuntimeOptions,
  MultiRepoDaemonRuntimeStatus,
  MultiRepoHarnessDaemonRuntime
} from "./repo-runtime-options.ts";
export type {
  DaemonDrainOptions,
  DaemonMaterializerBatchOptions,
  DaemonRepoRuntimeOptions,
  DaemonRepoRuntimeState,
  DaemonRepoRuntimeStatus,
  DaemonRuntimeOptions,
  DaemonRuntimeStatus,
  HarnessDaemonRuntime,
  MultiRepoDaemonRuntimeOptions,
  MultiRepoDaemonRuntimeStatus,
  MultiRepoHarnessDaemonRuntime
} from "./repo-runtime-options.ts";
import {
  createDaemonProjectionGenerationManager,
  type DaemonProjectionGenerationManager
} from "./projection-generation-manager.ts";
import { toDaemonRuntimeStatus } from "./repo-runtime-status.ts";

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
export function createDaemonRuntime(options: DaemonRuntimeOptions): HarnessDaemonRuntime {
  const context = new DaemonRepoRuntimeContext({ ...options, repoId: "canonical" });
  return {
    start: async () => toDaemonRuntimeStatus(await context.attach({ failOnError: true })),
    stop: (drainOptions) => context.stop(drainOptions),
    status: () => toDaemonRuntimeStatus(context.status()),
    enqueueInteractiveWrite: (request) => context.enqueueInteractiveWrite(request),
    enqueueBackgroundBatch: (request) => context.enqueueBackgroundBatch(request),
    enqueueMaterializerBatch: (batchOptions) => context.enqueueMaterializerBatch(batchOptions),
    enqueueAuthorityPublication: (publication) => context.enqueueAuthorityPublication(publication),
    queryExecutionEvidencePage: (query) => context.queryExecutionEvidencePage(query),
    createAttributedCoordinator: (input) => context.createAttributedCoordinator(input),
    assertWriteFenceHeld: () => context.assertWriteFenceHeld(),
    admissionBudget: context.admissionBudget,
    subscribeProjectionChanges: (listener) => context.subscribeProjectionChanges(listener)
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
    stop: async (drainOptions) => {
      const errors: unknown[] = [];
      const deadlineAt = drainOptions?.drainTimeoutMs === undefined ? undefined : Date.now() + drainOptions.drainTimeoutMs;
      for (const context of sortedContexts(contexts)) {
        try {
          const remainingMs = deadlineAt === undefined ? undefined : Math.max(0, deadlineAt - Date.now());
          await context.stop(remainingMs === undefined ? undefined : { drainTimeoutMs: remainingMs });
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
  readonly admissionBudget: DaemonAdmissionBudget;
  private readonly options: DaemonRepoRuntimeOptions;
  private readonly projectionChanges = createProjectionChangePublisher();
  private projectionGeneration: DaemonProjectionGenerationManager;
  private projectionGenerationClosed = false;
  private lock: DaemonGlobalLock | undefined;
  private lastRecovery: RecoveryReport | undefined;
  private lastError: string | undefined;
  private lastMaterializerError: string | undefined;
  private materializerTimer: ReturnType<typeof setInterval> | undefined;
  private runtimeRegistrationId: string | undefined;

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
    this.admissionBudget = createRuntimeAdmissionBudget(options);
    this.queue = new DaemonWriteQueue(
      options.maxInteractiveOpsPerCommit ?? defaultMaxInteractiveOpsPerCommit,
      options.interactiveMicroBatchMs ?? defaultInteractiveMicroBatchMs,
      this.admissionBudget
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
      if (this.options.generationAxes) this.runtimeRegistrationId = randomUUID();
      this.startMaterializerTimer();
      return this.status();
    } catch (error) {
      this.runtimeRegistrationId = undefined;
      await this.releaseStartedParts();
      this.state = "unavailable";
      this.lastError = describeRepoRuntimeError(error);
      if (input.failOnError) throw error;
      return this.status();
    }
  }

  async stop(options?: DaemonDrainOptions): Promise<void> {
    this.state = "detaching";
    this.runtimeRegistrationId = undefined;
    this.projectionGeneration.reset();
    this.stopMaterializerTimer();
    try {
      await waitForDaemonQueueIdle(this.queue, this.rootDir, options?.drainTimeoutMs);
    } catch (error) {
      this.lastError = describeRepoRuntimeError(error);
      throw error;
    }
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
      this.lastError = describeRepoRuntimeError(error);
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
      ...(this.lastMaterializerError ? { lastMaterializerError: this.lastMaterializerError } : {}),
      ...(this.runtimeRegistrationId && this.options.generationAxes ? {
        runtimeRegistrationId: this.runtimeRegistrationId,
        daemonGeneration: this.options.generationAxes.daemonGeneration
      } : {})
    };
  }

  enqueueInteractiveWrite(request: InteractiveWriteRequest): Promise<InteractiveWriteReceipt> {
    const started = this.requireAttached();
    let touchedPaths: ReadonlyArray<string>;
    try {
      touchedPaths = request.ops.flatMap((op) => writeOpTouchedPaths(this.runtimeContext, op));
    } catch (error) {
      this.lastError = describeRepoRuntimeError(error);
      return Promise.reject(error);
    }
    const projectionWrite = this.projectionGeneration.beginCanonicalWrite(touchedPaths);
    return this.queue.enqueueInteractive(request, (batch) => this.makeStartedCoordinator(started, batch))
      .catch((error: unknown) => {
        this.lastError = describeRepoRuntimeError(error);
        throw error;
      })
      .finally(() => projectionWrite.settle());
  }

  enqueueBackgroundBatch<Result>(request: BackgroundBatchRequest<Result>): Promise<Result> {
    this.requireAttached();
    return this.queue.enqueueBackground(request)
      .catch((error: unknown) => {
        this.lastError = describeRepoRuntimeError(error);
        throw error;
      });
  }

  enqueueMaterializerBatch(batchOptions: DaemonMaterializerBatchOptions = {}): Promise<LedgerMaterializerReport> {
    return this.enqueueBackgroundBatch({
      source: "ledger-materializer",
      priority: "background",
      run: () => this.runMaterializerBatch(batchOptions)
    }).catch((error: unknown) => {
      this.lastMaterializerError = describeRepoRuntimeError(error);
      this.projectionGeneration.invalidate();
      throw error;
    });
  }

  enqueueAuthorityPublication(options: DaemonAuthorityPublicationOptions): Promise<DaemonAuthorityPublicationReport> {
    this.requireAttached();
    return enqueueDaemonAuthorityPublication(
      this.queue,
      options,
      (sessionId) => this.runMaterializerBatch({ sessionId })
    ).catch((error: unknown) => {
      this.lastError = describeRepoRuntimeError(error);
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
    readonly commitAuthor?: InteractiveWriteRequest["commitAuthor"];
  }): WriteCoordinator {
    this.requireAttached();
    return makeDeferredAuthorityCoordinator({
      beginProjectionWrite: (op) => {
        const touchedPaths = writeOpTouchedPaths(this.runtimeContext, op);
        return this.projectionGeneration.beginCanonicalWrite(touchedPaths);
      },
      makeDurableCoordinator: () => this.makeStartedCoordinator(this.requireAttached(), input)
    });
  }

  async assertWriteFenceHeld(): Promise<void> {
    const { lock } = this.requireAttached();
    assertDaemonGlobalLockHeld(lock);
  }

  daemonGenerationContext(): {
    readonly witness: NonNullable<DaemonRuntimeOptions["generationWitness"]>;
    readonly machineId: string;
    readonly daemonGeneration: number;
    readonly runtimeRegistrationId?: string;
  } | undefined {
    if (!this.options.generationAxes || !this.options.generationWitness) return undefined;
    return {
      witness: this.options.generationWitness,
      machineId: this.options.generationAxes.machineId,
      daemonGeneration: this.options.generationAxes.daemonGeneration,
      ...(this.runtimeRegistrationId ? { runtimeRegistrationId: this.runtimeRegistrationId } : {})
    };
  }

  subscribeProjectionChanges(listener: (event: ProjectionChangeEvent) => void): () => void {
    return this.projectionChanges.subscribe(listener);
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
      onProjectionChange: this.projectionChanges.publish,
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

  private runMaterializerBatch(batchOptions: DaemonMaterializerBatchOptions): LedgerMaterializerReport {
    const started = this.requireAttached();
    const report = runLedgerMaterializer(this.runtimeContext, {
      heldGlobalLock: started.lock,
      ...(batchOptions.dryRun ? { dryRun: true } : {}),
      ...(batchOptions.sessionId
        ? { sessionId: batchOptions.sessionId }
        : { maxBranches: this.materializerMaxBranchesPerBatch })
    });
    if (report.projectionRebuilt) this.projectionGeneration.invalidate();
    if (report.warnings.length > 0) {
      this.lastMaterializerError = report.warnings.join("; ");
    } else if (!batchOptions.sessionId) {
      this.lastMaterializerError = undefined;
    }
    return report;
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

function mergeRepoDefaults(repo: DaemonRepoRuntimeOptions, options: MultiRepoDaemonRuntimeOptions): DaemonRepoRuntimeOptions {
  return {
    ...repo,
    ...(repo.operationalActor ? {} : options.operationalActor ? { operationalActor: options.operationalActor } : {}),
    ...(repo.lockTtlMs !== undefined ? {} : options.lockTtlMs !== undefined ? { lockTtlMs: options.lockTtlMs } : {}),
    ...(repo.interactiveMicroBatchMs !== undefined ? {} : options.interactiveMicroBatchMs !== undefined ? { interactiveMicroBatchMs: options.interactiveMicroBatchMs } : {}),
    ...(repo.maxInteractiveOpsPerCommit !== undefined ? {} : options.maxInteractiveOpsPerCommit !== undefined ? { maxInteractiveOpsPerCommit: options.maxInteractiveOpsPerCommit } : {}),
    ...(repo.materializerPollMs !== undefined ? {} : options.materializerPollMs !== undefined ? { materializerPollMs: options.materializerPollMs } : {}),
    ...(repo.materializerMaxBranchesPerBatch !== undefined ? {} : options.materializerMaxBranchesPerBatch !== undefined ? { materializerMaxBranchesPerBatch: options.materializerMaxBranchesPerBatch } : {}),
    ...(repo.projectionSourceFenceFactory ? {} : options.projectionSourceFenceFactory ? { projectionSourceFenceFactory: options.projectionSourceFenceFactory } : {}),
    ...(repo.generationAxes ? {} : options.generationAxes ? { generationAxes: options.generationAxes } : {}),
    ...(repo.generationWitness ? {} : options.generationWitness ? { generationWitness: options.generationWitness } : {})
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

function describeRepoRuntimeError(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "object" && error !== null && "cause" in error) {
    return describeRepoRuntimeError((error as { readonly cause?: unknown }).cause);
  }
  return String(error);
}
