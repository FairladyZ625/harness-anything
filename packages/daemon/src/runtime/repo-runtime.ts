import path from "node:path";
import { randomUUID } from "node:crypto";
import { Effect } from "effect";
import {
  createHarnessRuntimeContext,
  makeLocalVersionControlSystem,
  type DaemonAdmissionBudget,
  type LedgerMaterializerReport,
  type OperationalActor,
  type RecoveryReport,
  type WriteError,
  resolveHarnessLayout
} from "@harness-anything/kernel";
import {
  assertDaemonGlobalLockHeld,
  createProjectionChangePublisher,
  createRuntimeAdmissionBudget,
  recoverJournaledWrites,
  rememberTrustedAuthoredProjectionFingerprint,
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
import type { DaemonProjectionGenerationManager } from "./projection-generation-manager.ts";
import { toDaemonRuntimeStatus } from "./repo-runtime-status.ts";
import { defaultDaemonRuntimePolicy } from "./runtime-policy.ts";
import { ReservationReconcilerRunner } from "./reservation-reconciler-runner.ts";
import { mergeRepoRuntimeDefaults, sortedRepoOptions } from "./repo-runtime-options-merge.ts";
import { describeRepoRuntimeError } from "./repo-runtime-error.ts";
import { acquireRepoRuntimeGlobalLock } from "./repo-runtime-lock.ts";
import { bindCurrentRepoWriteTelemetry } from "./repo-write-telemetry-context.ts";
import { resolveAuthoritySessionCommit } from "./authority-session-commit.ts";
import { canonicalCommitContaining } from "./canonical-commit-ancestry.ts";
import { requireContext, sortedContexts } from "./repo-runtime-context-map.ts";
import { RepoMaterializerWorker } from "./repo-materializer-worker.ts";
import { RepoMaterializerScheduler } from "./repo-materializer-scheduler.ts";
import { runRepoMaterializerBatch } from "./repo-materializer-execution.ts";
import { makeStartedRepoWriteCoordinator } from "./repo-started-coordinator.ts";
import { createRepoProjectionGenerationManager } from "./repo-projection-generation.ts";
const defaultDaemonOperationalActor: OperationalActor = { scope: "operational", kind: "system", id: "daemon-runtime" };
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
    beginAuthorityAdmission: () => context.beginAuthorityAdmission(),
    queryExecutionEvidencePage: (query) => context.queryExecutionEvidencePage(query),
    createAttributedCoordinator: (input) => context.createAttributedCoordinator(input),
    assertWriteFenceHeld: () => context.assertWriteFenceHeld(),
    daemonGenerationContext: () => context.daemonGenerationContext(),
    daemonGenerationCapability: () => context.daemonGenerationCapability(),
    admissionBudget: context.admissionBudget,
    subscribeProjectionChanges: (listener) => context.subscribeProjectionChanges(listener)
  };
}
export function createMultiRepoDaemonRuntime(options: MultiRepoDaemonRuntimeOptions): MultiRepoHarnessDaemonRuntime {
  const contexts = new Map<string, DaemonRepoRuntimeContext>();
  let started = false;
  let assertBuildCurrent = options.assertBuildCurrent;
  for (const repo of sortedRepoOptions(options.repos)) {
    addContext(mergeRepoRuntimeDefaults(repo, options));
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
      const context = contexts.get(repo.repoId) ?? addContext(mergeRepoRuntimeDefaults(repo, options));
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
    installWriteGuard: (guard) => {
      assertBuildCurrent = guard;
      for (const context of contexts.values()) context.installWriteGuard(guard);
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
    const context = new DaemonRepoRuntimeContext({
      ...repo,
      rootDir,
      ...(assertBuildCurrent ? { assertBuildCurrent } : {})
    });
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
  private readonly writeOwnership: "writer" | "reader";
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
  private readonly knownPendingMaterializerSessions = new Set<string>();
  private readonly materializerWorker = new RepoMaterializerWorker();
  private readonly materializerScheduler: RepoMaterializerScheduler;
  private readonly runtimeVersionControlSystem = makeLocalVersionControlSystem({ cacheRepositoryDiscovery: true });
  private readonly reservationReconciler: ReservationReconcilerRunner;
  private assertBuildCurrent: () => void;
  private runtimeRegistrationId: string | undefined;

  constructor(options: DaemonRepoRuntimeOptions) {
    this.options = options;
    this.repoId = options.repoId;
    this.rootDir = path.resolve(options.rootDir);
    this.displayName = options.displayName;
    this.runtimeContext = createHarnessRuntimeContext(this.rootDir, options.layoutOverrides);
    this.layout = resolveHarnessLayout(this.runtimeContext);
    this.operationalActor = options.operationalActor ?? defaultDaemonOperationalActor;
    this.writeOwnership = options.writeOwnership ?? "writer";
    this.lockTtlMs = options.lockTtlMs ?? defaultDaemonRuntimePolicy.write.lockTtlMs;
    this.materializerMaxBranchesPerBatch = options.materializerMaxBranchesPerBatch ?? defaultDaemonRuntimePolicy.materializer.maxBranchesPerBatch;
    this.admissionBudget = createRuntimeAdmissionBudget(options);
    this.queue = new DaemonWriteQueue(
      options.maxInteractiveOpsPerCommit ?? defaultDaemonRuntimePolicy.write.maxInteractiveOpsPerCommit,
      options.interactiveMicroBatchMs ?? defaultDaemonRuntimePolicy.write.interactiveMicroBatchMs,
      this.admissionBudget
    );
    this.materializerScheduler = new RepoMaterializerScheduler(this.queue);
    this.projectionGeneration = this.createProjectionGenerationManager();
    this.reservationReconciler = new ReservationReconcilerRunner(
      options.reservationReconciler,
      {
        rootDir: this.rootDir,
        ...(options.layoutOverrides ? {
          layoutOverrides: options.layoutOverrides
        } : {})
      }
    );
    this.assertBuildCurrent = options.assertBuildCurrent ?? (() => undefined);
  }

  installWriteGuard(assertBuildCurrent: () => void): void {
    this.assertBuildCurrent = assertBuildCurrent;
  }

  start(): Promise<DaemonRuntimeStatus> {
    return this.attach({ failOnError: true });
  }

  async attach(input: { readonly failOnError: boolean }): Promise<DaemonRepoRuntimeStatus> {
    if (this.state === "attached"
      && (this.writeOwnership === "reader" || this.lock)) return this.status();
    if (this.projectionGenerationClosed) {
      this.projectionGeneration = this.createProjectionGenerationManager();
      this.projectionGenerationClosed = false;
    }
    this.projectionGeneration.reset();
    try {
      if (this.writeOwnership === "reader") {
        this.lastRecovery = undefined;
        this.lastError = undefined;
        this.lastMaterializerError = undefined;
        this.runtimeRegistrationId = undefined;
        this.state = "attached";
        return this.status();
      }
      this.assertBuildCurrent();
      this.lock = acquireRepoRuntimeGlobalLock({
        rootDir: this.rootDir,
        runtimeContext: this.runtimeContext,
        journalPath: this.layout.journalPath,
        operationalActor: this.operationalActor,
        lockTtlMs: this.lockTtlMs,
        repoId: this.repoId,
        lockProvenance: this.options.lockProvenance
      });
      this.assertBuildCurrent();
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
      this.assertBuildCurrent();
      await this.reservationReconciler.run();
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
      await this.materializerWorker.stop();
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
      started: this.state === "attached"
        && (this.writeOwnership === "reader" || Boolean(this.lock)),
      rootDir: this.rootDir,
      writeOwnership: this.writeOwnership,
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
    const started = this.requireWriterAttached();
    let touchedPaths: ReadonlyArray<string>;
    try {
      touchedPaths = request.ops.flatMap((op) => writeOpTouchedPaths(this.runtimeContext, op));
    } catch (error) {
      this.lastError = describeRepoRuntimeError(error);
      return Promise.reject(error);
    }
    const projectionWrite = this.projectionGeneration.beginCanonicalWrite(touchedPaths);
    return this.queue.enqueueInteractive(request, (batch) => this.makeStartedCoordinator(started, batch), <Result>(operation: () => Result): Result => bindCurrentRepoWriteTelemetry(operation)())
      .then((receipt) => {
        if (request.sessionId && receipt.flush.committed && receipt.flush.opCount > 0) {
          this.knownPendingMaterializerSessions.add(request.sessionId);
        }
        return receipt;
      })
      .catch((error: unknown) => {
        this.lastError = describeRepoRuntimeError(error);
        throw error;
      })
      .finally(() => projectionWrite.settle());
  }

  enqueueBackgroundBatch<Result>(request: BackgroundBatchRequest<Result>): Promise<Result> {
    this.requireWriterAttached();
    return this.queue.enqueueBackground(request)
      .catch((error: unknown) => {
        this.lastError = describeRepoRuntimeError(error);
        throw error;
      });
  }

  async enqueueMaterializerBatch(batchOptions: DaemonMaterializerBatchOptions = {}): Promise<LedgerMaterializerReport> {
    const priority = batchOptions.priority ?? "foreground";
    const releaseForeground = priority === "foreground"
      ? this.materializerScheduler.beginForegroundMaterializer()
      : undefined;
    try {
      return await this.materializerScheduler.schedule("ledger-materializer", () =>
        this.runMaterializerBatch(batchOptions),
        priority
      );
    } catch (error) {
      this.lastMaterializerError = describeRepoRuntimeError(error);
      this.projectionGeneration.invalidate();
      throw error;
    } finally {
      releaseForeground?.();
    }
  }

  enqueueAuthorityPublication(options: DaemonAuthorityPublicationOptions): Promise<DaemonAuthorityPublicationReport> {
    this.requireWriterAttached();
    this.knownPendingMaterializerSessions.add(options.sessionId);
    const releaseForeground = this.materializerScheduler.beginForegroundMaterializer();
    return enqueueDaemonAuthorityPublication(
      this.queue,
      options,
      (sessionId) => this.runMaterializerBatch({ sessionId }),
      (sessionId) => resolveAuthoritySessionCommit(this.layout.authoredRoot, sessionId),
      (acceptedCommitSha) => canonicalCommitContaining(this.layout.authoredRoot, acceptedCommitSha),
      (run) => this.materializerScheduler.schedule("authority-publication", run, "foreground")
    ).finally(releaseForeground).catch((error: unknown) => {
      this.lastError = describeRepoRuntimeError(error);
      throw error;
    });
  }

  beginAuthorityAdmission(): () => void {
    return this.materializerScheduler.beginAuthorityAdmission();
  }

  queryExecutionEvidencePage(query: ExecutionEvidencePageQuery): Promise<ExecutionEvidencePage> {
    this.requireReadAttached();
    return this.projectionGeneration.queryExecutionEvidencePage(query);
  }

  createAttributedCoordinator(
    input: Parameters<HarnessDaemonRuntime["createAttributedCoordinator"]>[0]
  ): ReturnType<HarnessDaemonRuntime["createAttributedCoordinator"]> {
    this.requireWriterAttached();
    return makeDeferredAuthorityCoordinator({
      beginProjectionWrite: (op) => {
        const touchedPaths = writeOpTouchedPaths(this.runtimeContext, op);
        return this.projectionGeneration.beginCanonicalWrite(touchedPaths);
      },
      makeDurableCoordinator: () => this.makeStartedCoordinator(this.requireWriterAttached(), input),
      ...(input.exactWriteScope ? { exactWriteScope: input.exactWriteScope } : {})
    });
  }

  async assertWriteFenceHeld(): Promise<void> {
    const { lock } = this.requireWriterAttached();
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

  daemonGenerationCapability(): ReturnType<NonNullable<HarnessDaemonRuntime["daemonGenerationCapability"]>> {
    if (this.options.generationAxes && this.options.generationWitness) return { mode: "generation" };
    return this.options.generationCapability ?? { mode: "unconfigured" };
  }

  subscribeProjectionChanges(listener: (event: ProjectionChangeEvent) => void): () => void {
    return this.projectionChanges.subscribe(listener);
  }

  private requireReadAttached(): void {
    if (this.state !== "attached") {
      throw { _tag: "JournalUnavailable", cause: new Error(`daemon repo "${this.repoId}" is not attached`) } satisfies WriteError;
    }
  }

  private requireWriterAttached(): { readonly lock: DaemonGlobalLock } {
    this.requireReadAttached();
    if (this.writeOwnership !== "writer" || !this.lock) {
      throw {
        _tag: "JournalUnavailable",
        cause: new Error(`daemon repo "${this.repoId}" write ownership belongs to its child capsule`)
      } satisfies WriteError;
    }
    this.assertBuildCurrent();
    return { lock: this.lock };
  }

  private makeStartedCoordinator(
    started: ReturnType<DaemonRepoRuntimeContext["requireWriterAttached"]>,
    request: InteractiveWriteAttribution & Partial<Parameters<HarnessDaemonRuntime["createAttributedCoordinator"]>[0]>
  ) {
    return makeStartedRepoWriteCoordinator({
      rootDir: this.rootDir,
      layoutOverrides: this.options.layoutOverrides,
      operationalActor: this.operationalActor,
      lockTtlMs: this.lockTtlMs,
      lock: started.lock,
      onProjectionChange: this.projectionChanges.publish,
      versionControlSystem: this.runtimeVersionControlSystem,
      request
    });
  }

  private startMaterializerTimer(): void {
    this.stopMaterializerTimer();
    if (this.options.materializerPollMs === false || typeof this.options.materializerPollMs !== "number" || this.options.materializerPollMs <= 0) {
      return;
    }
    this.materializerTimer = setInterval(() => {
      void this.runMaterializerTimerCycle();
    }, this.options.materializerPollMs);
    this.materializerTimer.unref();
  }

  private async runMaterializerTimerCycle(): Promise<void> {
    try {
      this.requireWriterAttached();
      await this.reservationReconciler.run();
      const sessionId = this.knownPendingMaterializerSessions.values().next().value as string | undefined;
      if (sessionId) await this.enqueueMaterializerBatch({ sessionId, priority: "recovery" });
    } catch (error) {
      this.lastMaterializerError = describeRepoRuntimeError(error);
    }
  }

  private async runMaterializerBatch(batchOptions: DaemonMaterializerBatchOptions): Promise<LedgerMaterializerReport> {
    const started = this.requireWriterAttached();
    return runRepoMaterializerBatch({
      rootInput: this.runtimeContext,
      lock: started.lock,
      options: batchOptions,
      maxBranches: this.materializerMaxBranchesPerBatch,
      worker: this.materializerWorker,
      knownPendingSessions: this.knownPendingMaterializerSessions,
      invalidateProjection: () => this.projectionGeneration.invalidate(),
      rememberFingerprint: (sourceHash) => rememberTrustedAuthoredProjectionFingerprint(
        this.runtimeContext,
        sourceHash,
        this.runtimeVersionControlSystem
      ),
      setLastError: (value) => { this.lastMaterializerError = value; }
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
      await this.materializerWorker.stop();
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
    return createRepoProjectionGenerationManager(this.rootDir, this.options);
  }

  private closeProjectionGenerationManager(): Promise<void> {
    if (!this.projectionGenerationClosed) this.projectionGenerationClosed = true;
    return this.projectionGeneration.close();
  }
}
