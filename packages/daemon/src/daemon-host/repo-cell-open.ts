import type { RepoCellOpenInput } from "./repo-cell-types.ts";
import { publicPublication } from "./repo-cell-receipts.ts";
import { nodeMaterializationStorage } from "./node-materialization-settings.ts";
import { writerLifecyclePolicy } from "@harness-anything/kernel/internal/domain/writer-lifecycle-policy.ts";
import { readRuntimeCanAttach } from "./agent-runtime-read.ts";
import { continueReviewRework } from "./task-return-dispatch.ts";
import { makeRuntimeRecoveryWork } from "./runtime-recovery-work.ts";
import { localOperatorBinding } from "./daemon-host-binding.ts";
import { scheduleOccurrenceSettlementOwner } from "./schedule-runtime-outcome.ts";
import { reviewDispatchKey } from "./review-dispatch-key.ts";
import { resolveAgentRuntimeDeclaration } from "./agent-declaration-resolution.ts";
import { createEntityStore } from "@harness-anything/storage";
import { readLocalAgentRecord, removeLocalAgentDeclaration, writeLocalAgentDeclaration } from "./local-agent-store.ts";

import {
  bindWriterGenerationToken,
  consumeKnownError,
  isSameExecution,
  isSamePerson,
  runtimeSessionActionIds,
  type AgentRuntimeEventV1,
  type SettingsV1,
  type WriteReceiptDraft,
  type WriterGeneration,
} from "@harness-anything/kernel";
import { createPresetProcessService, presetUserRoot } from "@harness-anything/preset";
import {
  prepareAgentEntityDelete,
  prepareAgentEntityInstall,
  prepareAgentEntityRetire,
  readAgentDeclaration,
  resolveSquadDispatch,
} from "./agent-entities.ts";

import { makeAgentRuntimeStreamHub, type AgentRuntimeStreamHub } from "./agent-runtime-stream.ts";
import { scheduleArchivedDispatchStreamCompaction } from "./dispatch-stream-archive.ts";
import { scheduleLocalRootReclamation } from "./local-root-storage.ts";
import { createRuntimeOutcomeWaiters } from "./runtime-settlement.ts";

import type { JsonObject } from "./protocol/json-rpc-types.ts";
import { makeRecoveryProbe } from "./recovery-state.ts";
import { bootstrapRepo, type RepoBootstrapReceipt } from "./repo-bootstrap.ts";
import { initializeBootstrapLedger } from "./repo-cell-bootstrap-ledger.ts";
import { createRepoCellActionContext } from "./repo-cell-action-context.ts";
import type { RepoCellOperationalContext, RepoCellRuntimeContext } from "./repo-cell-types.ts";
import { taskWorktreeInput } from "./task-worktree.ts";
import { createRepoCellApi } from "./repo-cell-api.ts";
import { dispatchRead } from "./repo-cell-command.ts";
import {
  cellCodedError,
  cellErrorCode,
  cellErrorMessage,
  errorOperationId,
  fatalCellError,
  unavailableRuntimeInstanceStore,
} from "./repo-cell-errors.ts";
import { chainRepoCellWrite, initializeRepoCell } from "./repo-cell.ts";
import { acquireWorkspaceLock, causeClassOf, latchReprobeThrottleMs } from "./repo-cell-lock.ts";
import { operationId } from "./repo-cell-proof.ts";
import { makeScheduleActionRuntime, settleScheduledRuntime } from "./schedule-action-runtime.ts";
import { commitRuntimeSessionAction, runtimeSessionActionPreparer } from "./runtime-session-action-runtime.ts";
import {
  makeRepoCellSettingsState,
  projectedRepositorySettings,
  readEffectiveDispatchArchiveRetention,
} from "./repo-cell-settings-state.ts";
import { makePersonActionRuntime } from "./person-action-runtime.ts";
import { authorizeRuntimeRepoAction } from "./repo-cell-authorization.ts";
import { commitRuntimeSettlement } from "./repo-cell-runtime-settlement.ts";
import { failed, rejected, requiredCellText } from "./repo-cell-settlement.ts";
import type {
  RepoCell,
  RepoCellBinding,
  RepoCellStatus,
  RepoCellWriteQueueState,
  RepoTaskAction,
} from "./repo-cell-types.ts";
import type {
  EntityActionCatalogPreparer,
  EntityActionCatalogRuntimes,
} from "@harness-anything/application/internal/commands/entity-action-catalog-executor.ts";
import { makeRuntimeSpawner, type RuntimeAttemptTerminal } from "./runtime-spawn.ts";
import { withOnlineRuntimeSession } from "./runtime-online-binding.ts";
import { makeRepoCellSquadCoordinator } from "./repo-cell-squad-coordinator.ts";
import { reconcileAbandonedTaskWorktrees } from "./task-worktree.ts";
import { makeAgentActionRuntime, makeSquadActionRuntime } from "./squad-action-runtime.ts";

import { withWriterEpochFenceDescriptor } from "@harness-anything/storage";
import { repoCellLatchedMessage } from "./repo-cell-latched-message.ts";
import { backupRepo, drillRepoBackup } from "./repo-all-purge.ts";
import { makeRepoCellFleetBackup } from "./repo-cell-fleet-backup.ts";
import { reviewerArtifactsFromCarriedReview } from "./reviewer-artifact-publication.ts";

export async function openRepoCell(input: RepoCellOpenInput): Promise<RepoCell> {
  const { openRepoCellProxy } = await import("./repo-cell-proxy.ts");
  return openRepoCellProxy(input);
}

// The host proxy owns terminal sessions and their registry across writer isolate replacement.
export async function openRepoWriterCell(
  input: RepoCellOpenInput,
  lock: Awaited<ReturnType<typeof acquireWorkspaceLock>>,
): Promise<Omit<RepoCell, "terminal">> {
  input = { ...input, storage: nodeMaterializationStorage(input) };
  const rootDir = input.rootDir,
    mode = input.mode ?? "local",
    now = input.now ?? (() => new Date().toISOString());
  // Opening is a transient state, not a missing entity: the settings reader is installed when the
  // cell finishes attaching, so this code is the honest one here and must stay distinct from the
  // `settings_entity_missing` a fully attached cell reports.
  let readSettings = (): SettingsV1 => {
    throw cellCodedError(
      "projection_pending",
      "The repository is still opening; repository Settings become readable once it finishes attaching.",
    );
  };
  const generation = input.writerGeneration ?? Date.now() * 1_000 + (process.pid % 1_000);
  const activeWriter: WriterGeneration = {
      workspaceId: input.repoId,
      generation,
      ownerId: input.ownerId,
    },
    writerToken = bindWriterGenerationToken(activeWriter);
  let authoredBranch = input.authoredBranch,
    bootstrapReceipt: RepoBootstrapReceipt | undefined;
  if (input.bootstrap) {
    bootstrapReceipt = bootstrapRepo(input.bootstrap, activeWriter, writerToken, authoredBranch);
    authoredBranch = bootstrapReceipt.authoredBranch;
    input.onBootstrap?.(bootstrapReceipt);
  }
  const presetProcess = createPresetProcessService({
    rootDir,
    userRoot: presetUserRoot(rootDir),
    readSettings: () => readSettings(),
  });
  const readSession = (runtimeSessionId: string) => projection.readRuntimeSession(runtimeSessionId);
  const workerRuntimeStream = makeAgentRuntimeStreamHub({
      repoId: input.repoId,
      readSession,
      canAttach: (session) => readRuntimeCanAttach(projection, session),
      now: () => new Date(now()),
    }),
    runtimeStream: AgentRuntimeStreamHub = {
      ...workerRuntimeStream,
      publish: (runtimeSessionId, signal) => {
        const event = workerRuntimeStream.publish(runtimeSessionId, signal);
        input.onRuntimeSignal?.(runtimeSessionId, signal);
        if (signal.type === "exit") outcomeWaiters.notify();
        return event;
      },
    };
  const outcomeWaiters = createRuntimeOutcomeWaiters({
    readLifecycle: (runtimeSessionId) => projection.readDispatchLifecycle({ by: "session", runtimeSessionId }),
  });
  // The ledger core is rebuildable in place: the variables below are rebound wholesale by
  // attemptRecovery, so a latched cell re-attaches to repaired data without reopening.
  const cellWriterEpochFence = input.defaultWriterEpochFence,
    defaultWriterEpochFence = cellWriterEpochFence
      ? <T>(operation: () => T) => withWriterEpochFenceDescriptor(cellWriterEpochFence, operation)
      : null;
  let activeWriterEpochFence: (<T>(operation: () => T) => T) | null = null,
    activeWriterEpochFenceDescriptor: NonNullable<RepoCellBinding["writerEpochFence"]> | null = null,
    queueDepth = 0,
    tail = Promise.resolve();
  const writeQueue: RepoCellWriteQueueState = {
    waiting: [],
    nowMs: () => Number(process.hrtime.bigint() / 1_000_000n),
  };
  const initialize = () =>
    initializeRepoCell({
      input,
      rootDir,
      authoredBranch,
      get activeWriterEpochFence() {
        return activeWriterEpochFence ?? defaultWriterEpochFence;
      },
      get activeWriterEpochFenceDescriptor() {
        return activeWriterEpochFenceDescriptor ?? cellWriterEpochFence ?? null;
      },
      mode,
      now,
      runtimeStream,
    });
  let core: Awaited<ReturnType<typeof initialize>>;
  try {
    core = await initialize();
  } catch (error) {
    runtimeStream.close();
    await presetProcess.close();
    throw error;
  }
  let { store, recovery, projection, entityActionExecutor, runtimeReads, service, replica } = core;
  let knownTaskIds: Set<string> | null = null,
    state: RepoCellStatus["state"] = recovery.status === "indeterminate" ? "unavailable" : "attached",
    recoveryUncertain = recovery.status === "indeterminate";
  let lastError: string | null =
    state === "attached"
      ? null
      : (recovery.error ?? `startup recovery ${recovery.status} after ${recovery.elapsedMs.toFixed(3)}ms`);
  let causeClass: RepoCellStatus["causeClass"] =
    state === "attached"
      ? null
      : causeClassOf(cellCodedError(recovery.errorCode ?? "publication_indeterminate", lastError!));
  const recoveryProbe = makeRecoveryProbe(latchReprobeThrottleMs);
  const isClosed = (): boolean => state === "closed";
  const latched = (): string => repoCellLatchedMessage(causeClass, lastError);
  const latchWith = (error: unknown): void => {
    state = "unavailable";
    lastError = cellErrorMessage(error);
    causeClass = causeClassOf(error);
    recoveryProbe.latch();
  };
  // Latch self-heal reopens the ledger and catches the projection up before reattaching. It never
  // reruns the user command that caused the latch. Probes are throttled, and each fresh latch earns
  // one immediate probe.
  let coreClosedForReplacement = false;
  let recoveryReplacement: Promise<void> | null = null;
  const attemptRecovery = async (force = false): Promise<void> => {
    if (state !== "unavailable") return;
    if (recoveryReplacement !== null) return recoveryReplacement;
    if (!force && !recoveryProbe.begin(Date.parse(now()))) return;
    if (force) recoveryProbe.begin(Date.parse(now()));
    recoveryReplacement = (async () => {
      let candidate: Awaited<ReturnType<typeof initialize>> | undefined;
      let adoptedIndeterminate = false;
      try {
        // A replacement is a single-owner lifecycle transaction. Quiesce and close the
        // old mutable SQLite owner before a candidate can even be initialized, then publish
        // only a candidate whose recovery and projection probe both completed.
        if (!coreClosedForReplacement) {
          try {
            await store.drain();
          } catch (error) {
            // The durable SQLite ledger remains the recovery source. A failed outbox publication must
            // not keep the stale owner alive; the candidate will retry from disk.
            consumeKnownError(error);
          } finally {
            replica.close();
            projection.close();
            coreClosedForReplacement = true;
          }
        }
        candidate = await initialize();
        if (isClosed()) {
          candidate.replica.close();
          candidate.projection.close();
          try {
            await candidate.store.drain();
          } catch (cleanupError) {
            consumeKnownError(cleanupError);
          }
          candidate = undefined;
          return;
        }
        // The prior store is closed. Adopt the candidate so projection repair reads
        // the live SQLite ledger even if the projection probe is still indeterminate.
        ({ store, recovery, projection, entityActionExecutor, runtimeReads, service, replica } = candidate);
        candidate = undefined;
        coreClosedForReplacement = false;
        knownTaskIds = null;
        if (recovery.status === "indeterminate") {
          adoptedIndeterminate = true;
          throw cellCodedError(
            recovery.errorCode ?? "publication_indeterminate",
            recovery.error ?? `startup recovery ${recovery.status} after ${recovery.elapsedMs.toFixed(3)}ms`,
          );
        }
        // Opening a reader generation is also a structural probe: a watermark can be current
        // while a persisted snapshot row is corrupt.
        projection.readTaskIndex({ limit: writerLifecyclePolicy.defaultValue.activeProbeLimit });
        state = "attached";
        lastError = null;
        causeClass = null;
        recoveryUncertain = false;
        recoveryProbe.clear();
      } catch (error) {
        consumeKnownError(error);
        if (candidate) {
          // initialize() itself threw before a store ever opened: nothing to adopt.
          candidate.replica.close();
          candidate.projection.close();
          try {
            await candidate.store.drain();
          } catch (cleanupError) {
            consumeKnownError(cleanupError);
          }
          recoveryUncertain = true;
        } else if (!adoptedIndeterminate) {
          // The adopted candidate's post-catch-up structural probe failed:
          // a stronger signal than the plain indeterminate recovery.status above.
          recoveryUncertain = true;
        }
        lastError = cellErrorMessage(error);
        causeClass = causeClassOf(error);
      }
    })().finally(() => {
      recoveryReplacement = null;
    });
    return recoveryReplacement;
  };
  const withWriterEpochBinding = async <T>(binding: RuntimeAttemptTerminal["binding"], work: () => T | Promise<T>) => {
    const fenced = binding as RuntimeAttemptTerminal["binding"] & RepoCellBinding,
      previousFence = activeWriterEpochFence,
      previousDescriptor = activeWriterEpochFenceDescriptor,
      descriptor = fenced.writerEpochFence;
    activeWriterEpochFence =
      fenced.withWriterEpochFence ??
      (descriptor ? <Value>(operation: () => Value) => withWriterEpochFenceDescriptor(descriptor, operation) : null);
    activeWriterEpochFenceDescriptor = descriptor ?? null;
    try {
      return await work();
    } finally {
      activeWriterEpochFence = previousFence;
      activeWriterEpochFenceDescriptor = previousDescriptor;
    }
  };
  const recoveryWork = makeRuntimeRecoveryWork(
    async <T>(work: () => T | Promise<T>, binding: RuntimeAttemptTerminal["binding"]) => {
      let result!: T;
      await schedule(async () => {
        result = await work();
      }, binding);
      if (state === "closed") throw cellCodedError("daemon_closed", "Runtime recovery writer closed.");
      return result;
    },
  );
  const schedule = (work: () => void | Promise<void>, binding?: RuntimeAttemptTerminal["binding"]): Promise<void> => {
    const releaseAuthorization = binding?.retainAuthorization?.();
    queueDepth += 1;
    input.onQueueDepthChange?.(queueDepth);
    const pending = chainRepoCellWrite(
      tail,
      async () => {
        // Runtime terminal work (exit publication, Schedule settlement) queued here must survive the
        // latched window: the durable SQLite ledger still accepts appends while Git publication and
        // projection recovery run behind them, and the writer-epoch fence rejects appends whose epoch
        // a replacement already superseded. Only a closed cell skips the work entirely.
        if (state !== "closed")
          await recoveryWork.queued(() => (binding ? withWriterEpochBinding(binding, work) : work()));
      },
      {
        queue: writeQueue,
        label: { command: "runtime-settlement", requestId: null },
        onDequeued: () => {
          queueDepth -= 1;
          input.onQueueDepthChange?.(queueDepth);
        },
      },
    ).finally(() => {
      releaseAuthorization?.();
      input.onQueueDepthChange?.(queueDepth);
    });
    tail = pending.catch(() => undefined);
    void pending.then(
      () => {
        if (state !== "closed") replica.kick();
      },
      (error: unknown) => {
        console.error(error);
        if (state !== "closed") replica.kick();
      },
    );
    return pending;
  };
  const backgroundImmediates = new Set<ReturnType<typeof setImmediate>>();
  const backgroundWork = new Set<Promise<void>>();
  const trackBackground = (work: () => Promise<unknown>): void => {
    if (state === "closed") return;
    const pending = Promise.resolve()
      .then(work)
      .then(
        () => undefined,
        (error: unknown) => {
          console.error("[repo-cell-background]", error);
        },
      )
      .finally(() => {
        backgroundWork.delete(pending);
      });
    backgroundWork.add(pending);
  };
  const scheduleBackgroundImmediate = (work: () => Promise<unknown>): void => {
    if (state === "closed") return;
    const handle = setImmediate(() => {
      backgroundImmediates.delete(handle);
      trackBackground(work);
    });
    backgroundImmediates.add(handle);
  };
  const drainBackgroundWork = async (): Promise<void> => {
    for (const handle of backgroundImmediates) clearImmediate(handle);
    backgroundImmediates.clear();
    let settledTail: Promise<void> | null = null;
    while (backgroundWork.size > 0 || recoveryReplacement !== null || tail !== settledTail) {
      const pending: Promise<unknown>[] = [...backgroundWork];
      if (recoveryReplacement !== null) pending.push(recoveryReplacement);
      settledTail = tail;
      pending.push(settledTail);
      await Promise.allSettled(pending);
    }
  };
  const backup: NonNullable<RepoCell["backup"]> = (request, queueObservation) => {
    queueDepth += 1;
    input.onQueueDepthChange?.(queueDepth);
    const pending = chainRepoCellWrite(
      tail,
      async () => {
        if (request.kind === "backup")
          return backupRepo({
            rootDir,
            backupDir: request.backupDir,
            registration: request.registration,
            writerEpoch: request.writerEpoch,
          });
        return await drillRepoBackup({
          rootDir,
          backupDir: request.backupDir,
          ...(request.shadowParent ? { shadowParent: request.shadowParent } : {}),
        });
      },
      {
        queue: writeQueue,
        label: queueObservation?.label ?? { command: "ledger-backup", requestId: null },
        onDequeued: () => {
          queueDepth -= 1;
          input.onQueueDepthChange?.(queueDepth);
        },
        ...(queueObservation ? { observation: queueObservation } : {}),
      },
    ).finally(() => input.onQueueDepthChange?.(queueDepth));
    tail = pending.then(
      () => undefined,
      () => undefined,
    );
    return pending;
  };
  const pruneReplicationLog: NonNullable<RepoCell["pruneReplicationLog"]> = (beforeSequence, queueObservation) => {
    const pending = chainRepoCellWrite(tail, () => store.pruneReplicationLog?.(beforeSequence), {
      queue: writeQueue,
      label: queueObservation?.label ?? { command: "replication-prune", requestId: null },
      ...(queueObservation ? { observation: queueObservation } : {}),
    });
    tail = pending.then(
      () => undefined,
      () => undefined,
    );
    return pending;
  };
  let settleScheduledOutcome: (terminal: RuntimeAttemptTerminal) => Promise<void> = async () => {
    throw cellCodedError("runtime_preconditions_unavailable", "RepoCell Schedule settlement is not ready.");
  };
  let handoffTaskLease: NonNullable<Parameters<typeof makeRuntimeSpawner>[0]["handoffTaskLease"]> = async () => {
    throw cellCodedError("runtime_preconditions_unavailable", "RepoCell task lease handoff is not ready.");
  };
  // Async work outlives its initiating RPC. Resolve the daemon's current local session at acceptance;
  // a device request must keep its own verified session and can never borrow this local one.
  const onlineBinding = async (binding: RepoCellBinding): Promise<RepoCellBinding> =>
    input.keycloakSession
      ? withOnlineRuntimeSession(
          binding,
          () => input.keycloakSession!(input.rootDir),
          input.keycloakCenter ? () => input.keycloakCenter!() : undefined,
        )
      : binding;
  const authorizeRuntimeAction = async (
    action: RepoTaskAction,
    binding: RuntimeAttemptTerminal["binding"],
    actionId: string,
  ): Promise<RepoCellBinding> => {
    const resolvedBinding = await onlineBinding(binding);
    if (state === "closed") throw cellCodedError("daemon_closed", "Runtime recovery writer closed.");
    return authorizeRuntimeRepoAction({
      repoId: input.repoId,
      action,
      binding: resolvedBinding,
      actionId,
      revision: store.readHead()?.revision ?? 0,
      now: now(),
      projection,
    });
  };
  const runtimeSpawner = makeRuntimeSpawner({
    repoId: input.repoId,
    rootDir,
    daemonGeneration: generation,
    ...(input.runtimeDaemonRoute ? { runtimeDaemonRoute: input.runtimeDaemonRoute } : {}),
    store: () => store,
    projection: () => projection,
    readSettings: () => readSettings(),
    stream: runtimeStream,
    now,
    schedule,
    writeRuntime: recoveryWork.write,
    ...(input.keycloakSession
      ? {
          localRecoveryBinding: async () =>
            localOperatorBinding(await input.keycloakSession!(rootDir), input.defaultWriterEpochFence),
        }
      : {}),
    runtimeInstances: input.runtimeInstances,
    runtimeInstanceDispatchState: input.runtimeInstanceDispatchState,
    selectRuntimeInstance: input.selectRuntimeInstance,
    runtimeInstanceCapacities: input.runtimeInstanceCapacities,
    runtimeProviderHealth: input.runtimeProviderHealth,
    keycloakCenter: input.keycloakCenter,
    cloudRuntime: input.cloudRuntime,
    prepareLaunch: input.prepareRuntimeLaunch ?? unavailableRuntimeInstanceStore,
    ...(input.prepareCloudRelay ? { prepareCloudRelay: input.prepareCloudRelay } : {}),
    ...(input.reclaimRuntimeTempDirectory ? { reclaimRuntimeTempDirectory: input.reclaimRuntimeTempDirectory } : {}),
    ...(input.listRuntimeTempSessionIds ? { listRuntimeTempSessionIds: input.listRuntimeTempSessionIds } : {}),
    ...(input.reclaimSettledRuntimeTempDirectories
      ? { reclaimSettledRuntimeTempDirectories: input.reclaimSettledRuntimeTempDirectories }
      : {}),
    ...(input.prepareDaemonGitEnvironment ? { prepareDaemonGitEnvironment: input.prepareDaemonGitEnvironment } : {}),
    resolveAgent: (agentId, verticalId) => {
      const projected = projection.getEntity("agent", agentId);
      const entityStore = createEntityStore(store),
        declaration = readAgentDeclaration({
          rootDir,
          agentId,
          ...(input.userRoot ? { userRoot: input.userRoot } : {}),
          repoId: input.repoId,
          entityStore,
          verticalId: verticalId ?? projectedRepositorySettings(projection)?.defaultVertical,
        });
      return resolveAgentRuntimeDeclaration(declaration, projected);
    },
    resolveSquadDispatch: (squadId, leaderId, workerId, _binding, verticalId) =>
      resolveSquadDispatch({
        rootDir,
        ...(squadId ? { squadId } : {}),
        leaderId,
        ...(workerId ? { workerId } : {}),
        entityStore: createEntityStore(store),
        ...(input.userRoot ? { userRoot: input.userRoot } : {}),
        repoId: input.repoId,
        verticalId: verticalId ?? projectedRepositorySettings(projection)?.defaultVertical,
      }),
    onRuntimeOutcome: (event) => {
      schedule(() => squadCoordinator.observeOutcome(event));
      outcomeWaiters.notify();
      input.onRuntimeOutcome?.(event);
    },
    onStalledReviewer: (continuation) => {
      if (mode !== "local" || state === "closed") return;
      const releaseAuthorization = continuation.binding.retainAuthorization?.();
      trackBackground(() =>
        (async () => {
          if (state === "closed") return;
          const dispatch = projection.readRuntimeDispatchById(continuation.dispatchId)?.event,
            taskId = continuation.task.taskId,
            executionId = continuation.task.executionId;
          if (
            !dispatch ||
            dispatch.payload.role !== "reviewer" ||
            dispatch.payload.taskId !== taskId ||
            dispatch.payload.executionId !== executionId ||
            typeof dispatch.payload.agentId !== "string" ||
            typeof dispatch.payload.dispatchKey !== "string"
          )
            return;
          const current = await service.read(taskId);
          if (isClosed()) return;
          const execution = current.snapshot.executions.find((value) => value.executionId === executionId);
          if (
            current.snapshot.task?.status !== "in_review" ||
            execution?.state !== "submitted" ||
            !execution.submission
          )
            return;
          const baseKey = reviewDispatchKey(taskId, execution, dispatch.payload.agentId);
          // Only the original automatic cut key may start this recovery. Its one existing manual
          // attempt key is the bound: an already-created attempt1 (manual or automatic) is never
          // advanced by another stalled terminal callback.
          if (
            dispatch.payload.dispatchKey !== baseKey ||
            projection.readRuntimeDispatchByDispatchKey(`${baseKey}:attempt1`) !== null
          )
            return;
          const binding = {
            ...continuation.binding,
            actor: { principal: continuation.binding.actor.principal, executor: null },
          };
          const receipt = await api.run({ kind: "task-dispatch-review", taskIds: [taskId] }, binding);
          if (receipt.outcome !== "applied")
            console.warn(`[review-stall-recovery] task ${taskId} automatic attempt failed: ${JSON.stringify(receipt)}`);
        })()
          .finally(() => releaseAuthorization?.())
          .catch((error: unknown) => console.error("[review-stall-recovery]", error)),
      );
    },
    onAttemptTerminal: async (terminal) => {
      // A squad-owned scheduled dispatch settles its occurrence with the run, not with its
      // first leader session; the coordinator's terminal settlement owns the claim.
      if (terminal.schedule && scheduleOccurrenceSettlementOwner(projection, terminal.dispatchId) === "runtime-attempt")
        schedule(() => settleScheduledOutcome(terminal), terminal.binding);
      outcomeWaiters.notify();
      return input.onAttemptTerminal?.(terminal);
    },
    handoffTaskLease: (handoff) => handoffTaskLease(handoff),
    authorizeRuntimeContinuation: async (payload, binding, actionId) =>
      await authorizeRuntimeAction({ ...payload, kind: "runtime-spawn" }, binding, actionId),
    commitRuntimeEvent: async (draft, binding) => {
      const action = { kind: "event" as const, ...draft },
        livenessControlRequest =
          draft.type === "runtime_session_liveness_changed" &&
          typeof draft.payload === "object" &&
          draft.payload !== null &&
          "controlRequest" in draft.payload &&
          draft.payload.controlRequest !== undefined,
        trustedControl =
          draft.type === "runtime_cancel_requested" ||
          draft.type === "runtime_steer_requested" ||
          livenessControlRequest,
        commitBinding = trustedControl ? { ...binding, trustedRemoteControl: true as const } : binding,
        receipt = runtimeSessionActionIds.includes(draft.type as never)
          ? await commitRuntimeSessionAction(extracted, action, commitBinding)
          : extracted.appendAuxiliaryRuntimeIngress(action, commitBinding, false, trustedControl),
        event = (receipt as typeof receipt & { readonly event?: AgentRuntimeEventV1 }).event,
        runtimeReceipt = { ...(receipt as unknown as JsonObject) };
      delete runtimeReceipt.event;
      return {
        ...(event ? { event } : {}),
        receipt: runtimeReceipt,
      };
    },
    authorizeRuntimeEvent: async ({ type, payload, opId, binding }) => {
      const livenessControlAction =
        type === "runtime_session_liveness_changed" &&
        typeof payload === "object" &&
        payload !== null &&
        "controlRequest" in payload &&
        typeof (payload as { readonly controlRequest?: { readonly action?: unknown } }).controlRequest === "object" &&
        (payload as { readonly controlRequest?: { readonly action?: unknown } }).controlRequest !== null
          ? (payload as { readonly controlRequest: { readonly action?: unknown } }).controlRequest.action
          : null;
      return await authorizeRuntimeAction(
        {
          kind:
            type === "runtime_cancel_requested" || livenessControlAction === "cancel"
              ? "runtime-cancel"
              : type === "runtime_steer_requested" || livenessControlAction === "steer"
                ? "runtime-steer"
                : "runtime-run",
          runtimeEventType: type,
          ...(Object.hasOwn(payload, "runtimeSessionId")
            ? { runtimeSessionId: (payload as { readonly runtimeSessionId: string }).runtimeSessionId }
            : {}),
        },
        binding,
        `runtime-event:${opId}`,
      );
    },
    authorizeRuntimeArchive: async (archive, binding) =>
      await authorizeRuntimeAction(
        {
          kind: "runtime-run",
          taskId: archive.taskId,
          executionId: archive.executionId,
          runtimeSessionId: archive.runtimeSessionId,
        },
        binding,
        `runtime-archive:${archive.dispatchId}`,
      ),
    recoverReviewerReview: async ({ taskId, executionId, dispatchId, runtimeSessionId, binding, packet, report }) => {
      const action: RepoTaskAction = {
          kind: "task-review-execution",
          taskId,
          executionId,
          reviewId: `review-${dispatchId}`,
          jsonInput: packet.body,
        },
        authorized = await authorizeRuntimeAction(
          action,
          binding as RuntimeAttemptTerminal["binding"] & RepoCellBinding,
          `runtime-review-recovery:${runtimeSessionId}`,
        ),
        carried = reviewerArtifactsFromCarriedReview(operationalContext, action, { packet, report }),
        receipt = await recoveryWork.write(() => extracted.lifecycleAction(action, authorized, carried), authorized);
      if (receipt.outcome !== "applied" && receipt.outcome !== "no_changes")
        throw cellCodedError(
          "review_result_missing",
          `Recovered Review ${action.reviewId as string} was not applied: ${JSON.stringify(receipt)}.`,
        );
      if (receipt.outcome === "applied") {
        const event = store.readTaskEvent(receipt.opId);
        if (event)
          scheduleBackgroundImmediate(() =>
            recoveryWork
              .run(() =>
                continueReviewRework(operationalContext, event, authorized, receipt, (nextAction, nextBinding, work) =>
                  recoveryWork.write(
                    async () => {
                      const auth = await authorizeRuntimeAction(
                        nextAction,
                        nextBinding as RuntimeAttemptTerminal["binding"],
                        operationId(nextAction, nextBinding, input.repoId, store.readHead()?.revision ?? 0),
                      );
                      return (
                        work ? work(auth) : extracted.lifecycleAction(nextAction, auth)
                      ) as Promise<WriteReceiptDraft>;
                    },
                    nextBinding as RuntimeAttemptTerminal["binding"],
                  ),
                ),
              )
              .catch((error: unknown) => console.error("[review-rework]", error)),
          );
      }
    },
    ...(input.recordLifecycle ? { recordLifecycle: input.recordLifecycle } : {}),
    ...(input.runGitHistoryAsync ? { runGitHistoryAsync: input.runGitHistoryAsync } : {}),
    ...(input.runtimeLaunch ? { launch: input.runtimeLaunch } : {}),
  });
  let catalogPromise: Promise<ReturnType<typeof import("./gui-catalog.ts").openGuiCatalog>> | undefined;
  const getCatalog = () =>
    (catalogPromise ??= import("./gui-catalog.ts").then(({ openGuiCatalog }) =>
      openGuiCatalog({ repoId: input.repoId, rootDir, readSettings: () => readSettings(), now }),
    ));
  const catalog: RepoCell["catalog"] = {
    snapshot: async () => (await getCatalog()).snapshot(),
    preset: async (payload) => (await getCatalog()).preset(payload),
    reread: async (payload) => (await getCatalog()).reread(payload),
  };
  const extracted = createRepoCellActionContext({
    input: {
      ...input,
      get nodeTaskMaterializationPolicy() {
        return input.storage?.nodeTaskMaterializationPolicy;
      },
    },
    rootDir,
    now,
    publicPublication,
    getProjection: () => projection,
    getStore: () => store,
    getEntityActionExecutor: () => entityActionExecutor,
    getEntityActionRuntimes: () => entityActionRuntimes,
    getService: () => service,
    getSettings: () => readSettings(),
    getRecovery: () => recovery,
    getRecoveryUncertain: () => recoveryUncertain,
    setRecoveryUncertain: (value) => {
      recoveryUncertain = value;
    },
    getKnownTaskIds: () => knownTaskIds,
    setKnownTaskIds: (value) => {
      knownTaskIds = value;
    },
    getSquadCoordinator: () => squadCoordinator,
  });
  const runtimeContext = Object.assign(extracted, { mode, runtimeSpawner });
  runtimeContext satisfies RepoCellRuntimeContext;
  const settings = makeRepoCellSettingsState({
      input: extracted.input,
      now,
      get projection() {
        return projection;
      },
      rootDir,
      get store() {
        return store;
      },
    }),
    scheduleActionRuntime = makeScheduleActionRuntime(runtimeContext, () => settings.read().worktree),
    agentActionRuntime = makeAgentActionRuntime(runtimeContext),
    squadActionRuntime = makeSquadActionRuntime(runtimeContext),
    prepareAgentAction: EntityActionCatalogPreparer = (contract, action, _binding, opId) => {
      if (contract.target.kind === "agent" && contract.id === "retire")
        prepareAgentEntityRetire({
          rootDir,
          action,
          replayed: store.readEvent(opId),
        });
      if (contract.id === "delete") {
        const existing = store.readEvent(opId);
        if (
          existing?.schema === "entity-event/v1" &&
          existing.type === "entity_deleted" &&
          existing.payload.entityKind === contract.target.kind
        )
          return {
            ...action,
            entityId: existing.payload.entityId,
            baseBlobSha256: existing.payload.ownedContent.retirements[0]!.baseBlobSha256,
            reason: existing.payload.reason,
          };
        const prepared = prepareAgentEntityDelete({
          rootDir,
          action,
          entityStore: createEntityStore(store),
          projection,
        });
        return { ...action, ...prepared };
      }
      if (contract.id !== "install") return action;
      const existing = store.readEvent(opId),
        prepared = prepareAgentEntityInstall({
          rootDir,
          action,
          entityStore: createEntityStore(store),
          projection,
          runtimeInstances: input.runtimeInstances?.(),
          ...(input.userRoot
            ? {
                localAgent: (agentId: string) => readLocalAgentRecord(input.userRoot!, input.repoId, agentId),
              }
            : {}),
          replay: existing?.schema === "entity-event/v1" && existing.payload.entityKind === contract.target.kind,
        });
      return {
        ...action,
        declaration: prepared.declaration,
        entityId: prepared.declaration.id,
        ...(prepared.localPublishExpectedVersion === undefined
          ? {}
          : { expectedVersion: prepared.localPublishExpectedVersion }),
        ...(prepared.localUnshareVersion === undefined ? {} : { localUnshareVersion: prepared.localUnshareVersion }),
        preparedEntityAction: { report: prepared.report },
      };
    };
  const personActionRuntime = makePersonActionRuntime(runtimeContext);
  const entityActionRuntimes: EntityActionCatalogRuntimes = {
    commitRuntimeSession: (bundle: Parameters<typeof commitRuntimeSettlement>[1], binding: RepoCellBinding) =>
      commitRuntimeSettlement(runtimeContext, bundle, binding),
    localAgentInstall: ({ action, opId, authorizationDecision }) => {
      if (!input.userRoot)
        throw cellCodedError("local_agent_store_unavailable", "The daemon user root is required for local Agents.");
      const declaration = action.declaration as import("@harness-anything/kernel").AgentDeclarationV1,
        current = readLocalAgentRecord(input.userRoot, input.repoId, declaration.id),
        expectedVersion =
          typeof action.localUnshareVersion === "number"
            ? (current?.revision ?? 0)
            : typeof action.expectedVersion === "number"
              ? action.expectedVersion
              : (current?.revision ?? 0),
        revision = writeLocalAgentDeclaration(input.userRoot, input.repoId, declaration, expectedVersion),
        cut = projection.readCut();
      return {
        outcome: "applied",
        status: "settled_no_write",
        effects: [],
        opId,
        revision,
        expectedVersion: revision,
        updatedProjection: null,
        evidence: JSON.stringify(action.preparedEntityAction ?? { entityId: declaration.id }),
        proof: {
          committedRevision: revision,
          appliedCut: cut.watermark,
          durable: true,
          canonicalVisible: false,
          worktreeVisible: false,
        },
        authorizationDecision,
      };
    },
    afterAgentInstall: ({ action, receipt }) => {
      const declaration = action.declaration as import("@harness-anything/kernel").AgentDeclarationV1;
      if (
        declaration.scope === "shared" &&
        input.userRoot &&
        receipt.proof?.durable === true &&
        readLocalAgentRecord(input.userRoot, input.repoId, declaration.id)
      )
        removeLocalAgentDeclaration(input.userRoot, input.repoId, declaration.id);
    },
    afterLocalAgentInstall: async ({ action, binding, opId }) => {
      const expectedVersion = action.localUnshareVersion,
        declaration = action.declaration as import("@harness-anything/kernel").AgentDeclarationV1;
      if (expectedVersion === undefined) return;
      if (!input.userRoot) throw cellCodedError("local_agent_store_unavailable", "The daemon user root is required.");
      try {
        const deletion = await entityActionExecutor.run(
          {
            kind: "agent-delete",
            agentId: declaration.id,
            reason: "Agent returned to local scope.",
            expectedVersion,
          },
          binding,
          `${opId}:unshare`,
          entityActionRuntimes,
        );
        if (deletion.outcome !== "applied")
          throw cellCodedError("agent_unshare_incomplete", `Agent ${declaration.id} remains shared.`);
      } catch (error) {
        removeLocalAgentDeclaration(input.userRoot, input.repoId, declaration.id);
        throw error;
      }
    },
    entity: {
      agent: agentActionRuntime,
      schedule: scheduleActionRuntime,
      person: personActionRuntime,
      squad: squadActionRuntime,
    },
    prepare: {
      agent: prepareAgentAction,
      squad: prepareAgentAction,
      "runtime-session": runtimeSessionActionPreparer(() => projection),
    },
  };
  const squadCoordinator = makeRepoCellSquadCoordinator(runtimeContext, {
    readWorktreeSetup: () => readSettings().worktree,
    authorizeRuntimeAction,
    onlineBinding,
  });
  const operationalContext = Object.defineProperty(runtimeContext, "settings", {
    value: settings,
    writable: true,
    enumerable: true,
    configurable: true,
  }) as RepoCellOperationalContext;
  handoffTaskLease = async ({ taskId, runtimeSessionId, fromRuntimeSessionId, binding, arrangementId }) => {
    const runtimeExecutor = { kind: "agent" as const, id: `runtime-session:${runtimeSessionId}` },
      runtimeBinding = { ...binding, actor: { principal: binding.actor.principal, executor: runtimeExecutor } };
    let lease = projection.currentLease(taskId, now());
    const snapshot = projection.read(taskId).snapshot,
      executionId = snapshot.executions.find(
        (execution) =>
          execution.executionId === lease?.executionId &&
          execution.iteration === snapshot.task?.iteration &&
          execution.state === "active",
      )?.executionId;
    if (
      (lease?.phase === "held" || lease?.phase === "orphaned") &&
      !isSameExecution(lease.actor, runtimeBinding.actor)
    ) {
      const heldRuntimeSessionId =
          lease.actor.executor?.kind === "agent" && lease.actor.executor.id.startsWith("runtime-session:")
            ? lease.actor.executor.id.slice("runtime-session:".length)
            : null,
        barePersonLease =
          lease.actor.executor === null &&
          isSamePerson(lease.actor, binding.actor) &&
          !binding.actor.executor?.id.startsWith("runtime-session:"),
        dispatcherOwnsLease = isSameExecution(lease.actor, binding.actor) || barePersonLease,
        trustedRuntimeHandoff =
          heldRuntimeSessionId !== null &&
          heldRuntimeSessionId === fromRuntimeSessionId &&
          isSamePerson(lease.actor, binding.actor);
      // An orphaned lease is past expiresAt; the release rule decides who may reclaim it.
      if (lease.phase === "held" && !dispatcherOwnsLease && !trustedRuntimeHandoff) {
        throw cellCodedError(
          "lease_conflict",
          `Task ${taskId} is held by another RuntimeSession; wait for it to settle before dispatching again.`,
        );
      }
      const releaseAction = {
          kind: "task-release",
          taskId,
          reason: `Runtime dispatch hands execution ${lease.executionId} to ${runtimeSessionId}.`,
        },
        releaseBinding = await authorizeRuntimeAction(
          releaseAction,
          lease.phase === "orphaned" ? binding : { ...binding, actor: lease.actor },
          `runtime-task-handoff-release:${taskId}:${runtimeSessionId}:${String(lease.version)}`,
        ),
        released = await operationalContext.taskSurfaceWrite(releaseAction, releaseBinding);
      if (released.outcome !== "applied")
        throw cellCodedError(
          released.code ?? "runtime_task_lease_required",
          `Task ${taskId} lease could not be released for runtime dispatch.`,
        );
      lease = projection.currentLease(taskId, now());
      if (lease?.phase === "held" || lease?.phase === "reserving")
        throw cellCodedError("lease_conflict", `Task ${taskId} lease remained active after dispatch handoff release.`);
    }
    operationalContext.assertTaskWipCapacity(taskId, "active");
    const startAction = {
        kind: "task-start",
        taskId,
        ...(executionId ? { executionId } : {}),
        ...(arrangementId ? { arrangementId } : {}),
      },
      startBinding = await authorizeRuntimeAction(
        startAction,
        runtimeBinding,
        `runtime-task-handoff-start:${taskId}:${runtimeSessionId}`,
      ),
      started = await operationalContext.lifecycleAction(startAction, startBinding);
    if (started.outcome !== "applied")
      throw Object.assign(
        cellCodedError(
          started.code ?? "runtime_task_lease_required",
          `Task ${taskId} could not acquire a RuntimeSession execution lease.`,
        ),
        started.diagnostic ? { diagnostic: started.diagnostic } : {},
      );
    return {
      binding: startBinding,
      releaseUnadmittedLease: async () => {
        const releaseAction = {
            kind: "task-release",
            taskId,
            claimOpId: started.opId,
            reason: `Runtime dispatch ${runtimeSessionId} was not admitted.`,
          },
          releaseBinding = await authorizeRuntimeAction(
            releaseAction,
            startBinding,
            `runtime-rejected-${runtimeSessionId}`,
          );
        operationalContext.taskSurfaceWrite(releaseAction, releaseBinding);
      },
    };
  };
  if (input.bootstrap && !input.bootstrap.configureOnly) {
    const appended = await initializeBootstrapLedger(extracted, settings, input.bootstrap);
    if (appended && bootstrapReceipt) {
      bootstrapReceipt = { ...bootstrapReceipt, outcome: "applied" };
      input.onBootstrap?.(bootstrapReceipt);
    }
  }
  readSettings = settings.read;
  settleScheduledOutcome = (terminal) =>
    settleScheduledRuntime(runtimeContext, terminal, async (action, actionId) => {
      const binding = await authorizeRuntimeAction(action, terminal.binding, actionId);
      return entityActionExecutor.run(
        action,
        binding,
        operationId(action, binding, input.repoId, 0),
        entityActionRuntimes,
      );
    });
  let restoringRuntimes = true;
  scheduleBackgroundImmediate(() =>
    recoveryWork
      .run(async () => {
        const [recoveryResults, squadRecoveryDispatchIds] = await Promise.all([
          runtimeSpawner.adopt(),
          squadCoordinator.retentionProtectedDispatchIds(),
        ]);
        return { recoveryResults, squadRecoveryDispatchIds };
      })
      .then(
        ({ recoveryResults, squadRecoveryDispatchIds }) => {
          if (state === "closed") return;
          const adoptionProtectedIds = recoveryResults.flatMap((entry) =>
            entry.outcome !== "settled" && entry.dispatchId !== null ? [entry.dispatchId] : [],
          );
          scheduleLocalRootReclamation({
            rootDir,
            projection: () => projection,
            readRetention: () => readEffectiveDispatchArchiveRetention(projection),
            schedule,
            recoveryDispatchIds: [...squadRecoveryDispatchIds, ...adoptionProtectedIds],
            onComplete: () => {
              if (state !== "closed") scheduleArchivedDispatchStreamCompaction(rootDir, schedule);
            },
          });
        },
        (error: unknown) => {
          console.error("[runtime-recovery]", error);
          if (state !== "closed") scheduleArchivedDispatchStreamCompaction(rootDir, schedule);
        },
      )
      .finally(() => {
        restoringRuntimes = false;
      }),
  );
  schedule(() => squadCoordinator.reconcile());
  // The close-run reconciliation, once more at attach: failed reclaims and rejected Squad children get another chance.
  schedule(() =>
    reconcileAbandonedTaskWorktrees(taskWorktreeInput(operationalContext), {
      cancelSquadOrphans: () =>
        squadCoordinator.cancelRejectedChildren({
          readTask: (taskId) => projection.read(taskId).snapshot.task,
          cancel: async (action, binding, actionId) =>
            operationalContext.lifecycleAction(action, await authorizeRuntimeAction(action, binding, actionId)),
        }),
    }),
  );

  const apiContext = {
    canHibernate: () => {
      if (restoringRuntimes || !runtimeSpawner.isIdle()) return false;
      // The active index includes a fallback waiting for its next attempt, with no live process.
      // Existence needs one indexed row, not a scan of historical sessions/tasks.
      const active = projection.readDispatchLifecycle({
        by: "active",
        limit: writerLifecyclePolicy.defaultValue.activeProbeLimit,
      });
      return active.status === "ready" && active.rows.length === 0;
    },
    drainBackgroundWork,
    onlineBinding,
    extracted: operationalContext,
    mode,
    // Resolved per read so the schedule GUI join sees the host's current admission
    // snapshot even when this cell attached before the fleet center started.
    input,
    rejected,
    operationId,
    failed,
    fatalCellError,
    errorOperationId,
    cellCodedError,
    cellErrorCode,
    cellErrorMessage,
    requiredCellText,
    dispatchRead,
    get state() {
      return state;
    },
    set state(value) {
      state = value;
    },
    attemptRecovery,
    get causeClass() {
      return causeClass;
    },
    set causeClass(value) {
      causeClass = value;
    },
    latched,
    latchWith,
    get queueDepth() {
      return queueDepth;
    },
    set queueDepth(value) {
      queueDepth = value;
    },
    get tail() {
      return tail;
    },
    set tail(value) {
      tail = value;
    },
    writeQueue,
    activeWriter,
    writerToken,
    get activeWriterEpochFence() {
      return activeWriterEpochFence ?? defaultWriterEpochFence;
    },
    set activeWriterEpochFence(value) {
      activeWriterEpochFence = value;
    },
    get activeWriterEpochFenceDescriptor() {
      return activeWriterEpochFenceDescriptor ?? cellWriterEpochFence ?? null;
    },
    set activeWriterEpochFenceDescriptor(value) {
      activeWriterEpochFenceDescriptor = value;
    },
    withHumanSummary: extracted.withHumanSummary,
    get lastError() {
      return lastError;
    },
    set lastError(value) {
      lastError = value;
    },
    get recoveryUncertain() {
      return recoveryUncertain;
    },
    set recoveryUncertain(value) {
      recoveryUncertain = value;
    },
    recoveryProbe,
    get replica() {
      return replica;
    },
    rootDir,
    get store() {
      return store;
    },
    get projection() {
      return projection;
    },
    now,
    executeAction: extracted.executeAction,
    squadCoordinator,
    presetProcess,
    get runtimeReads() {
      return runtimeReads;
    },
    awaitRuntimeOutcome: outcomeWaiters.awaitOutcome,
    runtimeSignalVersion: outcomeWaiters.signalVersion,
    awaitRuntimeSignal: outcomeWaiters.awaitSignal,
    runtimeSpawner,
    settings,
    appendAuxiliaryRuntimeIngress: extracted.appendAuxiliaryRuntimeIngress,
    get bootstrapReceipt() {
      return bootstrapReceipt;
    },
    set bootstrapReceipt(value) {
      bootstrapReceipt = value;
    },
    catalog,
    runtimeStream,
    generation,
    get recovery() {
      return recovery;
    },
    lock,
  };
  const api = createRepoCellApi(apiContext);
  return Object.assign(api, {
    backup,
    pruneReplicationLog,
    fleetBackup: makeRepoCellFleetBackup(apiContext, input.storage),
  });
}
