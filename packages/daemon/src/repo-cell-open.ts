import { makeRuntimeRecoveryWork } from "./runtime-recovery-work.ts";
import { scheduleOccurrenceSettlementOwner } from "./schedule-runtime-outcome.ts";
import { dispatchTaskReview } from "./task-review-dispatch.ts";
import { reviewDispatchKey } from "./review-dispatch-key.ts";
import { resolveAgentRuntimeDeclaration } from "./agent-declaration-resolution.ts";
import { readObservedRuntimeSession } from "./agent-runtime-read.ts";
import { createEntityStore, makeTaskEventStore, type DispatchRecordLeaseSettlement } from "@harness-anything/storage";
import {
  bindWriterGenerationToken,
  consumeKnownError,
  isSameExecution,
  isSamePerson,
  runtimeSessionActionIds,
  type AgentRuntimeEventV1,
  type CanonicalEventAppendReceipt,
  type DaemonRepoMode,
  type EventPublicationKillpoint,
  type SettingsV1,
  type WriterGeneration,
} from "@harness-anything/kernel";
import { createPresetProcessService, presetUserRoot } from "@harness-anything/preset";
import { ledgerWriteCommandTopology } from "@harness-anything/preset/internal/preset-command-contract";
import {
  prepareAgentEntityDelete,
  prepareAgentEntityInstall,
  prepareAgentEntityRetire,
  readAgentDeclaration,
  resolveSquadDispatch,
} from "./agent-entities.ts";
import type { PreparedRuntimeLaunch, RuntimeInstanceSummary, RuntimeLaunchRequest } from "./agent-runtime-instances.ts";
import {
  makeAgentRuntimeStreamHub,
  type AgentRuntimeNativeSignal,
  type AgentRuntimeStreamHub,
} from "./agent-runtime-stream.ts";
import { readRuntimeSessionActivityEvidence } from "./dispatch-read.ts";
import {
  pruneDispatchStreamArchive,
  readFactEvidenceSources,
  scheduleArchivedDispatchStreamCompaction,
} from "./dispatch-stream-archive.ts";
import { createRuntimeOutcomeWaiters } from "./runtime-settlement.ts";
import { openGuiCatalog } from "./gui-catalog.ts";
import { type CanonicalRoot, type WorkspaceId } from "./protocol/daemon-protocol.contract.ts";
import type { JsonObject } from "./protocol/json-rpc-types.ts";
import { makeRecoveryProbe } from "./recovery-state.ts";
import { bootstrapRepo, type RepoBootstrapInput, type RepoBootstrapReceipt } from "./repo-bootstrap.ts";
import { initializeBootstrapLedger } from "./repo-cell-bootstrap-ledger.ts";
import {
  createRepoCellActionContext,
  type RepoCellOperationalContext,
  type RepoCellRuntimeContext,
} from "./repo-cell-action-context.ts";
import { taskWorktreeInput } from "./repo-cell-action-dispatch.ts";
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
import { taskSurfaceWriteAt, taskSurfaceWriteAtForRuntimeTerminal } from "./repo-cell-task-command-docs.ts";
import { makeScheduleActionRuntime, settleScheduledRuntime } from "./schedule-action-runtime.ts";
import { makeSettingsActionRuntime } from "./settings-action-runtime.ts";
import { commitRuntimeSessionAction, runtimeSessionActionPreparer } from "./runtime-session-action-runtime.ts";
import { makeRepoCellSettingsState, readEffectiveDispatchArchiveRetention } from "./repo-cell-settings-state.ts";
import { makePersonActionRuntime } from "./person-action-runtime.ts";
import { authorizeRuntimeRepoAction } from "./repo-cell-authorization.ts";
import { failed, rejected, requiredCellText } from "./repo-cell-settlement.ts";
import type {
  PublicPublication,
  RepoCell,
  RepoCellAttachProgress,
  RepoCellBinding,
  RepoCellStatus,
  RepoCellTerminal,
  RepoTaskAction,
} from "./repo-cell-types.ts";
import type { EntityActionCatalogPreparer, EntityActionCatalogRuntimes } from "./entity-action-catalog-executor.ts";
import { admitRepoMode } from "./repo-mode.ts";
import {
  makeRuntimeSpawner,
  type RuntimeAttemptTerminal,
  type RuntimeDaemonRoute,
  type RuntimeLeaseReleasePending,
  type RuntimeLauncher,
} from "./runtime-spawn.ts";
import { withOnlineRuntimeSession, type RuntimeOperatorSession } from "./runtime-online-binding.ts";
import { openTerminalHost } from "./terminal-host.ts";
import { makeRepoCellSquadCoordinator } from "./repo-cell-squad-coordinator.ts";
import { cancelRejectedSquadChildren } from "./squad-run-state.ts";
import { reconcileAbandonedTaskWorktrees } from "./task-worktree.ts";
import { makeAgentActionRuntime, makeSquadActionRuntime } from "./squad-action-runtime.ts";
import type { DaemonLifecycleRecorder } from "./lifecycle-log.ts";
import { withWriterEpochFenceDescriptor } from "@harness-anything/storage";
import { repoCellLatchedMessage } from "./repo-cell-latched-message.ts";
import { backupRepo, drillRepoBackup } from "./repo-all-purge.ts";
import { reviewerArtifactsFromCarriedReview } from "./reviewer-artifact-publication.ts";

export function publicPublication(value: Pick<CanonicalEventAppendReceipt, "commitSha" | "cut">): PublicPublication {
  return { commitSha: value.commitSha?.sha ?? null, cut: value.cut };
}

export interface RepoCellOpenInput {
  readonly repoId: WorkspaceId;
  readonly rootDir: CanonicalRoot;
  readonly ownerId: string;
  readonly mode?: DaemonRepoMode;
  readonly authoredBranch?: string;
  readonly runtimeLaunch?: RuntimeLauncher;
  readonly runtimeDaemonRoute?: RuntimeDaemonRoute;
  readonly keycloakCenter?: import("./transport/auth-context.ts").KeycloakCenterAuthority;
  readonly keycloakSession?: (rootDir: string) => Promise<RuntimeOperatorSession>;
  readonly runtimeInstances?: () => readonly RuntimeInstanceSummary[];
  readonly runtimeProviderHealth?: import("./runtime-provider-health.ts").RuntimeProviderHealthStore;
  readonly prepareRuntimeLaunch?: (instanceId: string, request: RuntimeLaunchRequest) => Promise<PreparedRuntimeLaunch>;
  readonly prepareCloudRelay?: NonNullable<Parameters<typeof makeRuntimeSpawner>[0]["prepareCloudRelay"]>;
  readonly reclaimRuntimeTempDirectory?: (instanceId: string, runtimeSessionId: string) => Error | null;
  readonly reclaimSettledRuntimeTempDirectories?: (
    settledRuntimeSessionIds: readonly string[],
  ) => { readonly instanceId: string; readonly runtimeSessionId: string; readonly error: Error }[];
  readonly prepareDaemonGitEnvironment?: (
    instanceId: string,
    provider?: "github" | "gitlab",
  ) => Promise<NodeJS.ProcessEnv | null>;
  readonly bootstrap?: RepoBootstrapInput;
  readonly onBootstrap?: (receipt: RepoBootstrapReceipt) => void;
  readonly onRuntimeOutcome?: (
    event: Extract<
      import("@harness-anything/kernel").AgentRuntimeEventV1,
      { readonly type: "runtime_session_outcome_observed" }
    >,
  ) => void;
  /** Relays validated live provider frames to the host-side read-only stream hub. */
  readonly onRuntimeSignal?: (runtimeSessionId: string, signal: AgentRuntimeNativeSignal) => void;
  readonly onAttemptTerminal?: (terminal: RuntimeAttemptTerminal) => void;
  /** Internal writer status bridge for asynchronous materialization health changes. */
  readonly onMaterializationHealthChange?: Parameters<typeof makeTaskEventStore>[0]["onMaterializationHealthChange"];
  readonly onQueueDepthChange?: (queueDepth: number) => void;
  readonly onOpenProgress?: (progress: RepoCellAttachProgress) => void;
  readonly now?: () => string;
  readonly killpoint?: (point: EventPublicationKillpoint) => void;
  readonly shouldStop?: () => boolean;
  readonly recordLifecycle?: DaemonLifecycleRecorder;
  /** Host-owned fleet roster snapshot (remote-center schedule reads); resolved per read. */
  /** Daemon-owned fallback for writes produced inside the cell rather than a request. */
  readonly defaultWriterEpochFence?: NonNullable<RepoCellBinding["writerEpochFence"]>;
}

export async function openRepoCell(input: RepoCellOpenInput): Promise<RepoCell> {
  const { openRepoCellProxy } = await import("./repo-cell-proxy.ts");
  return openRepoCellProxy(input);
}

export async function openRepoWriterCell(
  input: RepoCellOpenInput,
  lock: Awaited<ReturnType<typeof acquireWorkspaceLock>>,
): Promise<RepoCell> {
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
  const generation = Date.now() * 1_000 + (process.pid % 1_000);
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
  const readSession = (runtimeSessionId: string) => readObservedRuntimeSession(projection, rootDir, runtimeSessionId);
  const workerRuntimeStream = makeAgentRuntimeStreamHub({
      readSession,
      canAttach: (session) =>
        session.liveness !== "exited" &&
        (() => {
          const dispatch = projection.readRuntimeDispatch(session.runtimeSessionId, session.definitionSnapshotRef);
          return dispatch
            ? readRuntimeSessionActivityEvidence(rootDir, dispatch.payload.dispatchId)?.workerHostAlive === true
            : false;
        })() &&
        Boolean(projection.readRuntimeInstallation(session.installationId)?.effectiveCapabilities.includes("attach")),
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
    readSession,
    now,
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
  let entityActionRuntimes: EntityActionCatalogRuntimes = Object.freeze({});
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
        projection.readTaskIndex({ limit: 1 });
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
    queueDepth += 1;
    input.onQueueDepthChange?.(queueDepth);
    const pending = chainRepoCellWrite(tail, async () => {
      queueDepth -= 1;
      input.onQueueDepthChange?.(queueDepth);
      // Runtime terminal work (exit publication, Schedule settlement) queued here must survive the
      // latched window: the durable SQLite ledger still accepts appends while Git publication and
      // projection recovery run behind them, and the writer-epoch fence rejects appends whose epoch
      // a replacement already superseded. Only a closed cell skips the work entirely.
      if (state !== "closed")
        await recoveryWork.queued(() => (binding ? withWriterEpochBinding(binding, work) : work()));
    }).finally(() => input.onQueueDepthChange?.(queueDepth));
    tail = pending.catch(() => undefined);
    void pending.then(
      () => replica.kick(),
      (error: unknown) => {
        console.error(error);
        replica.kick();
      },
    );
    return pending;
  };
  const backup: NonNullable<RepoCell["backup"]> = (request) => {
    queueDepth += 1;
    input.onQueueDepthChange?.(queueDepth);
    const pending = chainRepoCellWrite(tail, async () => {
      queueDepth -= 1;
      input.onQueueDepthChange?.(queueDepth);
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
    }).finally(() => input.onQueueDepthChange?.(queueDepth));
    tail = pending.then(
      () => undefined,
      () => undefined,
    );
    return pending;
  };
  const pruneReplicationLog: NonNullable<RepoCell["pruneReplicationLog"]> = (beforeSequence) => {
    const pending = chainRepoCellWrite(tail, () => store.pruneReplicationLog(beforeSequence));
    tail = pending.then(
      () => undefined,
      () => undefined,
    );
    return pending;
  };
  let settleExecutionLease: (
    terminal: RuntimeAttemptTerminal,
  ) => Promise<void | RuntimeLeaseReleasePending> = async () => {
    throw cellCodedError("runtime_preconditions_unavailable", "RepoCell execution settlement is not ready.");
  };
  let settleRuntimeExecutionLease: (
    task: NonNullable<RuntimeAttemptTerminal["task"]>,
    runtimeSessionId: string,
    leaseAt: string,
    occurredAt: string,
    binding: RuntimeAttemptTerminal["binding"],
    processGroupPid: number | undefined,
  ) => Promise<void> = async () => {
    throw cellCodedError("runtime_preconditions_unavailable", "RepoCell execution settlement is not ready.");
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
  ): Promise<RepoCellBinding> =>
    authorizeRuntimeRepoAction({
      repoId: input.repoId,
      action,
      binding: await onlineBinding(binding),
      actionId,
      revision: store.readHead()?.revision ?? 0,
      now: now(),
      projection,
    });
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
    runtimeInstances: input.runtimeInstances,
    runtimeProviderHealth: input.runtimeProviderHealth,
    keycloakCenter: input.keycloakCenter,
    prepareLaunch: input.prepareRuntimeLaunch ?? unavailableRuntimeInstanceStore,
    ...(input.prepareCloudRelay ? { prepareCloudRelay: input.prepareCloudRelay } : {}),
    ...(input.reclaimRuntimeTempDirectory ? { reclaimRuntimeTempDirectory: input.reclaimRuntimeTempDirectory } : {}),
    ...(input.reclaimSettledRuntimeTempDirectories
      ? { reclaimSettledRuntimeTempDirectories: input.reclaimSettledRuntimeTempDirectories }
      : {}),
    ...(input.prepareDaemonGitEnvironment ? { prepareDaemonGitEnvironment: input.prepareDaemonGitEnvironment } : {}),
    resolveAgent: (agentId) => {
      const projected = projection.getEntity("agent", agentId);
      const entityStore = createEntityStore(store),
        declaration = readAgentDeclaration({
          rootDir,
          agentId,
          entityStore,
        });
      return resolveAgentRuntimeDeclaration(declaration, projected);
    },
    resolveSquadDispatch: (squadId, leaderId, workerId) =>
      resolveSquadDispatch({
        rootDir,
        ...(squadId ? { squadId } : {}),
        leaderId,
        ...(workerId ? { workerId } : {}),
        entityStore: createEntityStore(store),
      }),
    onRuntimeOutcome: (event) => {
      schedule(() => squadCoordinator.observeOutcome(event));
      outcomeWaiters.notify();
      input.onRuntimeOutcome?.(event);
    },
    onStalledReviewer: (continuation) => {
      if (mode !== "local") return;
      schedule(async () => {
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
        const current = await service.read(taskId),
          execution = current.snapshot.executions.find((value) => value.executionId === executionId);
        if (current.snapshot.task?.status !== "in_review" || execution?.state !== "submitted" || !execution.submission)
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
        const receipt = await dispatchTaskReview(
          operationalContext,
          { kind: "task-dispatch-review", taskIds: [taskId] },
          binding,
        );
        if (receipt.outcome !== "applied")
          console.warn(`[review-stall-recovery] task ${taskId} automatic attempt failed: ${JSON.stringify(receipt)}`);
      }, continuation.binding);
    },
    onAttemptTerminal: async (terminal) => {
      const leaseSettlement = terminal.task ? await settleExecutionLease(terminal) : undefined;
      if (leaseSettlement?.outcome === "lease_unproven") {
        if (terminal.preservePrimaryError) return leaseSettlement;
        throw cellCodedError(leaseSettlement.code, leaseSettlement.reason);
      }
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
        receipt = runtimeSessionActionIds.includes(draft.type as never)
          ? await commitRuntimeSessionAction(extracted, action, binding)
          : extracted.appendAuxiliaryRuntimeIngress(action, binding),
        event = (receipt as typeof receipt & { readonly event?: AgentRuntimeEventV1 }).event,
        runtimeReceipt = { ...(receipt as unknown as JsonObject) };
      delete runtimeReceipt.event;
      return {
        ...(event ? { event } : {}),
        receipt: runtimeReceipt,
      };
    },
    authorizeRuntimeEvent: async ({ type, payload, opId, binding }) =>
      await authorizeRuntimeAction(
        {
          kind: "runtime-run",
          runtimeEventType: type,
          ...(Object.hasOwn(payload, "runtimeSessionId")
            ? { runtimeSessionId: (payload as { readonly runtimeSessionId: string }).runtimeSessionId }
            : {}),
        },
        binding,
        `runtime-event:${opId}`,
      ),
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
    },
    ...(input.recordLifecycle ? { recordLifecycle: input.recordLifecycle } : {}),
    ...(input.runtimeLaunch ? { launch: input.runtimeLaunch } : {}),
  });
  const catalog = openGuiCatalog({ repoId: input.repoId, rootDir, readSettings: () => readSettings(), now }),
    terminalHost = openTerminalHost({
      repoId: input.repoId,
      rootDir,
      daemonGeneration: generation,
      now,
    });
  const admitTerminalWrite = (binding: RepoCellBinding): void => {
    const admission = admitRepoMode(mode, ledgerWriteCommandTopology, binding.source);
    if (!admission.ok) throw cellCodedError(admission.code, admission.nextAction);
    if (state !== "attached") throw cellCodedError("repo_unavailable", latched());
  };
  const terminal: RepoCellTerminal = {
    list: terminalHost.list,
    attach: terminalHost.attach,
    detach: terminalHost.detach,
    close: terminalHost.close,
    spawn: (payload, binding) => {
      admitTerminalWrite(binding);
      return terminalHost.spawn(payload);
    },
    spawnTrusted: (launch, binding) => {
      admitTerminalWrite(binding);
      return terminalHost.spawnTrusted(launch);
    },
    input: (payload, binding) => {
      admitTerminalWrite(binding);
      return terminalHost.input(payload);
    },
    resize: (payload, binding) => {
      admitTerminalWrite(binding);
      return terminalHost.resize(payload);
    },
    terminate: (payload, binding) => {
      admitTerminalWrite(binding);
      return terminalHost.terminate(payload);
    },
  };
  const extracted = createRepoCellActionContext({
    input,
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
  const settings = makeRepoCellSettingsState(extracted),
    scheduleActionRuntime = makeScheduleActionRuntime(runtimeContext, () => settings.read().worktree),
    settingsActionRuntime = makeSettingsActionRuntime(runtimeContext, settings),
    agentActionRuntime = makeAgentActionRuntime(runtimeContext),
    squadActionRuntime = makeSquadActionRuntime(runtimeContext),
    prepareAgentAction: EntityActionCatalogPreparer = (contract, action, _binding, opId) => {
      if (contract.target.kind === "agent" && contract.id === "retire")
        prepareAgentEntityRetire({ action, replayed: store.readEvent(opId) });
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
        const prepared = prepareAgentEntityDelete({ action, entityStore: createEntityStore(store), projection });
        return { ...action, ...prepared };
      }
      if (contract.id !== "install") return action;
      const existing = store.readEvent(opId),
        prepared = prepareAgentEntityInstall({
          rootDir,
          action,
          entityStore: createEntityStore(store),
          runtimeInstances: input.runtimeInstances?.(),
          replay: existing?.schema === "entity-event/v1" && existing.payload.entityKind === contract.target.kind,
        });
      return {
        ...action,
        declaration: prepared.declaration,
        entityId: prepared.declaration.id,
        preparedEntityAction: { report: prepared.report },
      };
    };
  const personActionRuntime = makePersonActionRuntime(runtimeContext);
  entityActionRuntimes = Object.freeze({
    entity: Object.freeze({
      agent: agentActionRuntime,
      schedule: scheduleActionRuntime,
      settings: settingsActionRuntime,
      person: personActionRuntime,
      squad: squadActionRuntime,
    }),
    prepare: Object.freeze({
      agent: prepareAgentAction,
      squad: prepareAgentAction,
      "runtime-session": runtimeSessionActionPreparer(() => projection),
    }),
  });
  const squadCoordinator = makeRepoCellSquadCoordinator({
    rootDir,
    repoId: input.repoId,
    now,
    readWorktreeSetup: () => readSettings().worktree,
    projection,
    store,
    runtimeContext,
    extracted,
    runtimeSpawner,
    entityActionExecutor,
    entityActionRuntimes,
    authorizeRuntimeAction,
    onlineBinding,
    ...(input.killpoint ? { killpoint: input.killpoint } : {}),
  });
  const operationalContext = Object.assign(runtimeContext, {
    settings,
    settleRuntimeExecutionLease: (settlement: DispatchRecordLeaseSettlement, binding: RepoCellBinding) =>
      settleRuntimeExecutionLease(
        {
          taskId: settlement.taskId,
          executionId: settlement.executionId,
          leaseVersion: settlement.leaseVersion,
        },
        settlement.runtimeSessionId,
        settlement.endedAt,
        settlement.endedAt,
        binding,
        undefined,
      ),
  });
  operationalContext satisfies RepoCellOperationalContext;
  handoffTaskLease = async ({ taskId, runtimeSessionId, fromRuntimeSessionId, binding }) => {
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
        dispatcherOwnsLease = isSameExecution(lease.actor, binding.actor),
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
    const startAction = { kind: "task-start", taskId, ...(executionId ? { executionId } : {}) },
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
    return startBinding;
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
  const settleRuntimeExecutionLeaseWithStopResult = async (
    task: NonNullable<RuntimeAttemptTerminal["task"]>,
    runtimeSessionId: string,
    leaseAt: string,
    occurredAt: string,
    terminalBinding: RuntimeAttemptTerminal["binding"],
    processGroupPid: number | undefined,
    preservePrimaryError: boolean,
  ): Promise<void | RuntimeLeaseReleasePending> => {
    const lease = extracted.projection.currentLease(task.taskId, leaseAt);
    // The terminal runtime can release only its own current lease. Its dispatch execution/version
    // is historical: release/start may have advanced both while this same runtime was running.
    if (
      !lease ||
      lease.phase === "released" ||
      lease.actor.executor?.id !== `runtime-session:${runtimeSessionId}` ||
      !isSameExecution(lease.actor, terminalBinding.actor)
    )
      return;
    const action = {
        kind: "task-release",
        taskId: task.taskId,
        terminalExecutionId: lease.executionId,
        terminalRuntimeSessionId: runtimeSessionId,
        terminalProcessGroupPid: processGroupPid,
        reason: `Runtime session ${runtimeSessionId} reached a terminal dispatch state.`,
      },
      binding = await authorizeRuntimeAction(action, terminalBinding, `runtime-task-release:${runtimeSessionId}`),
      settled = await recoveryWork.write(
        () =>
          preservePrimaryError
            ? taskSurfaceWriteAtForRuntimeTerminal(extracted, action, binding, occurredAt)
            : taskSurfaceWriteAt(extracted, action, binding, occurredAt),
        binding,
      );
    if (settled.outcome === "lease_unproven") return settled;
    if (settled.outcome !== "applied")
      throw cellCodedError("runtime_lease_release_failed", `Runtime terminal lease settlement was ${settled.outcome}.`);
  };
  settleRuntimeExecutionLease = async (
    task,
    runtimeSessionId,
    leaseAt,
    occurredAt,
    terminalBinding,
    processGroupPid,
  ) => {
    const settlement = await settleRuntimeExecutionLeaseWithStopResult(
      task,
      runtimeSessionId,
      leaseAt,
      occurredAt,
      terminalBinding,
      processGroupPid,
      false,
    );
    if (settlement?.outcome === "lease_unproven") throw cellCodedError(settlement.code, settlement.reason);
  };
  settleExecutionLease = async (terminal) => {
    if (!terminal.task) return;
    const settlement = terminal.preservePrimaryError
      ? await settleRuntimeExecutionLeaseWithStopResult(
          terminal.task,
          terminal.runtimeSessionId,
          terminal.endedAt,
          now(),
          terminal.binding,
          terminal.processGroupPid,
          true,
        )
      : await settleRuntimeExecutionLease(
          terminal.task,
          terminal.runtimeSessionId,
          terminal.endedAt,
          now(),
          terminal.binding,
          terminal.processGroupPid,
        );
    if (settlement?.outcome === "lease_unproven") return settlement;
    if (!terminal.waitingOnOwner) return;
    // The release above is deliberately a separate canonical event: task-transition's domain
    // invariant rejects blocked tasks that still carry a lease. A newer dispatch may have claimed
    // the task while this terminal was being replayed; in that case this stale wait must not park
    // the newer execution.
    const current = projection.read(terminal.task.taskId).snapshot;
    if (current.task?.status !== "active" || current.lease !== null) return;
    const action = {
        kind: "task-transition" as const,
        taskId: terminal.task.taskId,
        status: "blocked" as const,
        reason: terminal.reason
          ? `Worker is waiting for owner ruling: ${terminal.reason}`
          : `Worker is waiting for owner ruling (${terminal.runtimeSessionId}).`,
      },
      binding = await authorizeRuntimeAction(
        action,
        terminal.binding,
        `runtime-task-awaiting-owner:${terminal.runtimeSessionId}`,
      ),
      parked = await recoveryWork.write(() => extracted.lifecycleAction(action, binding), binding);
    if (parked.outcome !== "applied")
      throw cellCodedError(
        "runtime_waiting_task_block_failed",
        `Runtime terminal waiting settlement was ${parked.outcome}.`,
      );
  };
  setImmediate(() => {
    if (state === "closed") return;
    void recoveryWork
      .run(() => runtimeSpawner.adopt())
      .then(
        () => undefined,
        (error: unknown) => console.error("[runtime-recovery]", error),
      );
  });
  // Retention first: pruning doomed streams before the compaction pass keeps it from rewriting
  // files the same queue is about to delete.
  schedule(() =>
    pruneDispatchStreamArchive(
      rootDir,
      readEffectiveDispatchArchiveRetention(projection),
      readFactEvidenceSources(projection),
    ),
  );
  scheduleArchivedDispatchStreamCompaction(rootDir, schedule);
  schedule(() => squadCoordinator.reconcile());
  // The close-run reconciliation, once more at attach: failed reclaims and rejected Squad children get another chance.
  schedule(() =>
    reconcileAbandonedTaskWorktrees(taskWorktreeInput(operationalContext), {
      cancelSquadOrphans: () =>
        cancelRejectedSquadChildren({
          rootDir,
          readTask: (taskId) => projection.read(taskId).snapshot.task,
          cancel: async (action, binding, actionId) =>
            operationalContext.lifecycleAction(action, await authorizeRuntimeAction(action, binding, actionId)),
        }),
    }),
  );

  const apiContext = {
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
    squadCoordinator: extracted.squadCoordinator,
    presetProcess,
    get runtimeReads() {
      return runtimeReads;
    },
    awaitRuntimeOutcome: outcomeWaiters.awaitOutcome,
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
    terminal,
    runtimeStream,
    generation,
    get recovery() {
      return recovery;
    },
    lock,
  };
  return { ...createRepoCellApi(apiContext), backup, pruneReplicationLog };
}
