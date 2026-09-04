import {
  bindWriterGenerationToken,
  consumeKnownError,
  createEntityStore,
  isSameExecution,
  isSamePerson,
  makeTaskEventStore,
  runtimeSessionActionIds,
  type AgentRuntimeEventV1,
  type CanonicalEventAppendReceipt,
  type CanonicalEventStore,
  type DaemonRepoMode,
  type DispatchRecordLeaseSettlement,
  type EventPublicationKillpoint,
  type SettingsV1,
  type WriterGeneration,
} from "../../kernel/src/index.ts";
import { createPresetProcessService, presetUserRoot } from "../../preset/src/index.ts";
import { ledgerWriteCommandTopology } from "../../preset/src/preset-command-contract.ts";
import { prepareAgentEntityInstall, readAgentDeclaration, resolveSquadDispatch } from "./agent-entities.ts";
import type { PreparedRuntimeLaunch, RuntimeInstanceSummary } from "./agent-runtime-instances.ts";
import {
  makeAgentRuntimeStreamHub,
  type AgentRuntimeNativeSignal,
  type AgentRuntimeStreamHub,
} from "./agent-runtime-stream.ts";
import { openGuiCatalog } from "./gui-catalog.ts";
import type { FleetRoster } from "./fleet-center-admission.ts";
import { type CanonicalRoot, type WorkspaceId } from "./protocol/daemon-protocol.contract.ts";
import type { JsonObject } from "./protocol/json-rpc-types.ts";
import { makeRecoveryProbe } from "./recovery-state.ts";
import { bootstrapRepo, type RepoBootstrapInput, type RepoBootstrapReceipt } from "./repo-bootstrap.ts";
import {
  createRepoCellActionContext,
  type RepoCellOperationalContext,
  type RepoCellRuntimeContext,
} from "./repo-cell-action-context.ts";
import { createRepoCellApi } from "./repo-cell-api.ts";
import { dispatchRead } from "./repo-cell-command.ts";
import { publishTaskArtifact } from "./doc-sync-actions.ts";
import {
  cellCodedError,
  cellCriterionError,
  cellErrorCode,
  cellErrorMessage,
  errorOperationId,
  fatalCellError,
  unavailableRuntimeInstanceStore,
} from "./repo-cell-errors.ts";
import { chainRepoCellWrite, initializeRepoCell } from "./repo-cell.ts";
import { acquireWorkspaceLock, causeClassOf, latchReprobeThrottleMs } from "./repo-cell-lock.ts";
import { operationId } from "./repo-cell-proof.ts";
import { taskSurfaceWriteAt } from "./repo-cell-task-command-docs.ts";
import { makeScheduleActionRuntime } from "./schedule-action-runtime.ts";
import { scheduleSettlementDetail } from "./schedule-occurrence-workspace.ts";
import { makeSettingsActionRuntime } from "./settings-action-runtime.ts";
import { commitRuntimeSessionAction, runtimeSessionActionPreparer } from "./runtime-session-action-runtime.ts";
import { makeRepoCellSettingsState } from "./repo-cell-settings-state.ts";
import { makePersonActionRuntime } from "./person-action-runtime.ts";
import { authorizeRepoCellAction } from "./repo-cell-authorization.ts";
import { declaredRoleBindingsForActor } from "./identity/declared-role-binding-projection.ts";
import { failed, rejected, requiredCellText } from "./repo-cell-settlement.ts";
import type {
  PublicPublication,
  RepoCell,
  RepoCellBinding,
  RepoCellStatus,
  RepoCellTerminal,
  RepoTaskAction,
  Snapshot,
} from "./repo-cell-types.ts";
import type { EntityActionCatalogPreparer, EntityActionCatalogRuntimes } from "./entity-action-catalog-executor.ts";
import { admitRepoMode } from "./repo-mode.ts";
import {
  makeRuntimeSpawner,
  type RuntimeAttemptTerminal,
  type RuntimeDaemonRoute,
  type RuntimeLauncher,
} from "./runtime-spawn.ts";
import { openTerminalHost } from "./terminal-host.ts";
import { makeSquadCoordinator } from "./squad-coordinator.ts";
import { makeSquadActionRuntime } from "./squad-action-runtime.ts";
import type { DaemonLifecycleRecorder } from "./lifecycle-log.ts";

export function publicPublication(value: Pick<CanonicalEventAppendReceipt, "commitSha" | "cut">): PublicPublication {
  return { commitSha: value.commitSha?.sha ?? null, cut: value.cut };
}

export async function reacquireSquadTaskLease(input: {
  readonly taskId: string;
  readonly binding: RepoCellBinding;
  readonly snapshot: Snapshot;
  readonly start: (executionId?: string) => Promise<{
    readonly outcome: string;
    readonly code?: string;
  }>;
}): Promise<void> {
  const execution = input.snapshot.executions.find(
    (candidate) => candidate.iteration === input.snapshot.task?.iteration && candidate.state === "active",
  );
  if (!execution) {
    const started = await input.start();
    if (started.outcome === "applied") return;
    throw cellCriterionError(
      started.code ?? "runtime_task_lease_required",
      `Task ${input.taskId} could not acquire an execution lease for squad dispatch.`,
      "run",
      "squad/execution-lease-reacquisition",
      [`Run ha task show ${input.taskId}, resolve its execution state, then retry the Squad run.`],
    );
  }
  const lease = input.snapshot.lease;
  if (lease) {
    if (lease.executionId === execution.executionId && isSameExecution(lease.actor, input.binding.actor)) return;
    throw cellCriterionError(
      "lease_conflict",
      `Task ${input.taskId} is leased by another execution or actor; the squad continuation stopped.`,
      "run",
      "squad/execution-lease-holder",
      [`The current holder must run ha task release ${input.taskId}; wait for release before retrying.`],
    );
  }
  const started = await input.start(execution.executionId);
  if (started.outcome !== "applied")
    throw cellCriterionError(
      "runtime_task_lease_required",
      `Squad continuation could not reacquire execution ${execution.executionId} for task ${input.taskId}.`,
      "run",
      "squad/execution-lease-reacquisition",
      [`Inspect task/${input.taskId} and retry after the same actor can reacquire execution ${execution.executionId}.`],
    );
}

export interface RepoCellOpenInput {
  readonly repoId: WorkspaceId;
  readonly rootDir: CanonicalRoot;
  readonly ownerId: string;
  readonly mode?: DaemonRepoMode;
  readonly authoredBranch?: string;
  readonly runtimeLaunch?: RuntimeLauncher;
  readonly runtimeDaemonRoute?: RuntimeDaemonRoute;
  readonly runtimeInstances?: () => readonly RuntimeInstanceSummary[];
  readonly prepareRuntimeLaunch?: (
    instanceId: string,
    request: {
      readonly cwd: string;
      readonly prompt: string;
      readonly model?: string;
      readonly effort?: string;
      readonly providerSessionId?: string;
      readonly permissionMode?: string;
    },
  ) => Promise<PreparedRuntimeLaunch>;
  readonly prepareWorkerGitEnvironment?: (instanceId: string) => Promise<NodeJS.ProcessEnv | null>;
  readonly bootstrap?: RepoBootstrapInput;
  readonly onBootstrap?: (receipt: RepoBootstrapReceipt) => void;
  readonly onRuntimeOutcome?: (
    event: Extract<
      import("../../kernel/src/index.ts").AgentRuntimeEventV1,
      { readonly type: "runtime_session_outcome_observed" }
    >,
  ) => void;
  /** Relays validated live provider frames to the host-side read-only stream hub. */
  readonly onRuntimeSignal?: (runtimeSessionId: string, signal: AgentRuntimeNativeSignal) => void;
  readonly onAttemptTerminal?: (terminal: RuntimeAttemptTerminal) => void;
  /** Test seam for controlling WAL materialization without wall-clock scheduling. */
  readonly onStoreOpened?: (store: CanonicalEventStore) => void;
  /** Internal writer status bridge for asynchronous materialization health changes. */
  readonly onMaterializationHealthChange?: Parameters<typeof makeTaskEventStore>[0]["onMaterializationHealthChange"];
  /** Test seam for injecting a failure inside the WAL materialization worker. */
  readonly walMaterializationTestFault?: Parameters<typeof makeTaskEventStore>[0]["walMaterializationTestFault"];
  readonly now?: () => string;
  readonly killpoint?: (point: EventPublicationKillpoint) => void;
  readonly shouldStop?: () => boolean;
  readonly recordLifecycle?: DaemonLifecycleRecorder;
  /** Host-owned fleet roster snapshot (remote-center schedule reads); resolved per read. */
  readonly fleetRoster?: () => FleetRoster | null;
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
  let readSettings = (): SettingsV1 => {
    throw cellCodedError("projection_pending", "Settings projection is unavailable while the RepoCell is opening.");
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
  const workerRuntimeStream = makeAgentRuntimeStreamHub({
      readSession: (runtimeSessionId) => projection.readRuntimeSession(runtimeSessionId),
      canAttach: (session) =>
        session.attachable &&
        Boolean(projection.readRuntimeInstallation(session.installationId)?.effectiveCapabilities.includes("attach")),
      now: () => new Date(now()),
    }),
    runtimeStream: AgentRuntimeStreamHub = {
      ...workerRuntimeStream,
      publish: (runtimeSessionId, signal) => {
        const event = workerRuntimeStream.publish(runtimeSessionId, signal);
        input.onRuntimeSignal?.(runtimeSessionId, signal);
        return event;
      },
    };
  // The ledger core is rebuildable in place: the variables below are rebound wholesale by
  // attemptRecovery, so a latched cell re-attaches to repaired data without reopening.
  let activeWriterEpochGuard: (() => void) | null = null,
    activeWriterEpochFence: (<T>(operation: () => T) => T) | null = null,
    activeWriterEpochFenceDescriptor: NonNullable<RepoCellBinding["writerEpochFence"]> | null = null,
    queueDepth = 0,
    tail = Promise.resolve();
  const initialize = () =>
    initializeRepoCell({
      input,
      rootDir,
      authoredBranch,
      get activeWriterEpochGuard() {
        return activeWriterEpochGuard;
      },
      get activeWriterEpochFence() {
        return activeWriterEpochFence;
      },
      get activeWriterEpochFenceDescriptor() {
        return activeWriterEpochFenceDescriptor;
      },
      mode,
      now,
      runtimeStream,
      enqueueAfterFlush: (work) => {
        queueDepth += 1;
        const pending = chainRepoCellWrite(tail, async () => {
          queueDepth -= 1;
          await work();
        });
        tail = pending.catch(() => undefined);
        return pending;
      },
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
  const latched = (): string =>
    causeClass === "infrastructure"
      ? [
          "this workspace stays latched until its Git or lock infrastructure ",
          "recovers: repair the infrastructure cause below, then rerun the command; ",
          "the next attempt re-probes the workspace and re-attaches automatically ",
          "once it verifies. Cause: ",
          `${lastError ?? "RepoCell is unavailable."}`,
          "",
        ].join("")
      : causeClass === "projection"
        ? [
            "this workspace stays latched until its projection verifies: run ha ",
            "daemon projection rebuild to repair the projection cause below; this ",
            "command remains available while latched and re-attaches automatically ",
            "once the projection verifies. Cause: ",
            `${lastError ?? "RepoCell is unavailable."}`,
            "",
          ].join("")
        : [
            "this workspace stays latched until its ledger data verifies: repair the ",
            "data-shape cause below, then rerun the command; the next attempt ",
            "re-probes the ledger and re-attaches automatically once the data ",
            "verifies. Cause: ",
            `${lastError ?? "RepoCell is unavailable."}`,
            "",
          ].join("");
  const latchWith = (error: unknown): void => {
    state = "unavailable";
    lastError = cellErrorMessage(error);
    causeClass = causeClassOf(error);
    recoveryProbe.latch();
  };
  // Latch self-heal: while unavailable, the next command replays the failed judgment against a
  // freshly built ledger view (publication refs re-read from Git, recovery replayed, projection
  // catch-up replayed). Pass -> rebind the core and return to attached; fail -> stay unavailable
  // with the replayed cause. Probes are throttled so frequent read retries cannot hot-loop them,
  // and every fresh latch earns one immediate probe.
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
        // old mutable WAL owner before a candidate can even be initialized, then publish
        // only a candidate whose recovery and projection probe both completed.
        if (!coreClosedForReplacement) {
          try {
            await store.drain();
          } catch (error) {
            // The durable WAL remains the recovery source. A failed materialization must
            // not keep the stale owner alive; the candidate will retry from disk.
            consumeKnownError(error);
          } finally {
            replica.close();
            projection.close();
            coreClosedForReplacement = true;
          }
        }
        candidate = await initialize();
        // Adopt the candidate's store as soon as it opens: the quiesce above already closed
        // the prior store, so this is the only live store left, and a store-only recovery
        // command (relation-events-migrate, decision-digests-migrate, projection-rebuild's own
        // store.readHead(), ...) must be able to run against it even while the probes below
        // stay indeterminate -- repairing that indeterminate state is what those commands exist
        // to do. Only `state` gates on the probes; the store is live regardless.
        ({ store, recovery, projection, entityActionExecutor, runtimeReads, service, replica } = candidate);
        candidate = undefined;
        coreClosedForReplacement = false;
        knownTaskIds = null;
        const probeIndeterminate = recovery.status === "indeterminate";
        adoptedIndeterminate = probeIndeterminate;
        if (probeIndeterminate)
          throw cellCodedError(
            recovery.errorCode ?? "publication_indeterminate",
            recovery.error ?? `startup recovery ${recovery.status} after ${recovery.elapsedMs.toFixed(3)}ms`,
          );
        // Opening a reader generation is also a structural probe: a watermark can be current
        // while a persisted snapshot row is corrupt.
        projection.list();
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
          // The adopted candidate's post-catch-up structural probe (projection.list()) failed:
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
  const schedule = (work: () => void | Promise<void>): void => {
    queueDepth += 1;
    const pending = chainRepoCellWrite(tail, async () => {
      queueDepth -= 1;
      if (state === "attached") await work();
    });
    tail = pending.catch(() => undefined);
    void pending.then(
      () => replica.kick(),
      (error: unknown) => {
        console.error(error);
        replica.kick();
      },
    );
  };
  let settleExecutionLease: (terminal: RuntimeAttemptTerminal) => Promise<void> = async () => {
    throw cellCodedError("runtime_preconditions_unavailable", "RepoCell execution settlement is not ready.");
  };
  let settleRuntimeExecutionLease: (
    task: NonNullable<RuntimeAttemptTerminal["task"]>,
    runtimeSessionId: string,
    leaseAt: string,
    occurredAt: string,
    binding: RuntimeAttemptTerminal["binding"],
  ) => Promise<void> = async () => {
    throw cellCodedError("runtime_preconditions_unavailable", "RepoCell execution settlement is not ready.");
  };
  let settleScheduledOutcome: (terminal: RuntimeAttemptTerminal) => Promise<void> = async () => {
    throw cellCodedError("runtime_preconditions_unavailable", "RepoCell Schedule settlement is not ready.");
  };
  let handoffTaskLease: NonNullable<Parameters<typeof makeRuntimeSpawner>[0]["handoffTaskLease"]> = async () => {
    throw cellCodedError("runtime_preconditions_unavailable", "RepoCell task lease handoff is not ready.");
  };
  const authorizeRuntimeAction = (
    action: RepoTaskAction,
    binding: RuntimeAttemptTerminal["binding"],
    actionId: string,
  ): RuntimeAttemptTerminal["binding"] => {
    const { authorizationDecision: _previousDecision, ...unframed } = binding,
      currentBinding =
        binding.source !== "local" || binding.authorizationBindingMode !== "declared"
          ? unframed
          : (() => {
              const {
                  roleBindings: _previousRoleBindings,
                  authorizationBindingMode: _previousBindingMode,
                  ...local
                } = unframed,
                roleBindings = declaredRoleBindingsForActor(rootDir, binding.actor);
              return roleBindings === undefined
                ? { ...local, authorizationBindingMode: "default" as const }
                : { ...local, authorizationBindingMode: "declared" as const, roleBindings };
            })(),
      revision = store.readHead()?.revision ?? 0,
      authorizationDecision = authorizeRepoCellAction({
        action,
        binding: currentBinding,
        actionId,
        revision,
        now: now(),
      });
    if (authorizationDecision.outcome === "denied")
      throw cellCodedError(
        "authorization_denied",
        authorizationDecision.nextActions.join(" ") || `${action.kind} requires repository write authority.`,
      );
    return { ...currentBinding, authorizationDecision };
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
    runtimeInstances: input.runtimeInstances,
    prepareLaunch: input.prepareRuntimeLaunch ?? unavailableRuntimeInstanceStore,
    ...(input.prepareWorkerGitEnvironment ? { prepareWorkerGitEnvironment: input.prepareWorkerGitEnvironment } : {}),
    resolveAgent: (agentId) => readAgentDeclaration({ rootDir, agentId, entityStore: createEntityStore(store) }),
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
      input.onRuntimeOutcome?.(event);
    },
    onAttemptTerminal: async (terminal) => {
      if (terminal.task) await settleExecutionLease(terminal);
      if (terminal.schedule) schedule(() => settleScheduledOutcome(terminal));
      input.onAttemptTerminal?.(terminal);
    },
    handoffTaskLease: (handoff) => handoffTaskLease(handoff),
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
    authorizeRuntimeEvent: ({ type, payload, opId, binding }) =>
      authorizeRuntimeAction(
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
    authorizeRuntimeArchive: (archive, binding) =>
      authorizeRuntimeAction(
        {
          kind: "runtime-run",
          taskId: archive.taskId,
          executionId: archive.executionId,
          runtimeSessionId: archive.runtimeSessionId,
        },
        binding,
        `runtime-archive:${archive.dispatchId}`,
      ),
    ...(input.recordLifecycle ? { recordLifecycle: input.recordLifecycle } : {}),
    ...(input.runtimeLaunch ? { launch: input.runtimeLaunch } : {}),
  });
  const squadCoordinator = makeSquadCoordinator({
    rootDir,
    projection: () => projection,
    store: () => store,
    reacquireTaskLease: async (taskId, binding) => {
      await reacquireSquadTaskLease({
        taskId,
        binding,
        snapshot: projection.read(taskId).snapshot as Snapshot,
        start: (executionId) => {
          const action = { kind: "task-start", taskId, ...(executionId ? { executionId } : {}) },
            revision = store.readHead()?.revision ?? 0,
            authorizationDecision = authorizeRepoCellAction({
              action,
              binding,
              actionId: `squad-task-start:${taskId}:${revision}`,
              revision,
              now: now(),
            });
          if (authorizationDecision.outcome === "denied")
            throw cellCodedError(
              "authorization_denied",
              authorizationDecision.nextActions.join(" ") || "Squad lease reacquisition requires repo-write authority.",
            );
          return extracted.lifecycleAction(action, { ...binding, authorizationDecision });
        },
      });
    },
    publishSynthesisReport: async (report, binding) => {
      const action = { kind: "task-artifact-add", taskId: report.taskId },
        authorizedBinding = authorizeRuntimeAction(action, binding, `squad-synthesis-report:${report.squadRunId}`),
        receipt = publishTaskArtifact(
          {
            binding: authorizedBinding,
            workspaceId: input.repoId,
            rootDir,
            store,
            projection,
            now,
            killpoint: input.killpoint,
          },
          {
            taskId: report.taskId,
            destination: report.reportPath,
            bytes: Buffer.from(report.body),
          },
        );
      if (receipt.outcome !== "applied" && receipt.outcome !== "pending")
        throw cellCodedError(
          receipt.code ?? "squad_report_publication_failed",
          `Squad synthesis report was ${receipt.outcome}.`,
        );
    },
    runtimeSpawner: () => ({
      spawn: (payload, binding) => {
        const action = { kind: "runtime-spawn", ...payload },
          revision = store.readHead()?.revision ?? 0,
          authorizationDecision = authorizeRepoCellAction({
            action,
            binding,
            actionId: `squad-runtime-spawn:${String(payload.idempotencyKey ?? "current")}:${revision}`,
            revision,
            now: now(),
          });
        if (authorizationDecision.outcome === "denied")
          return Promise.reject(
            cellCodedError(
              "authorization_denied",
              authorizationDecision.nextActions.join(" ") || "Squad runtime dispatch requires repo-write authority.",
            ),
          );
        return runtimeSpawner.spawnCoordinated(payload, { ...binding, authorizationDecision });
      },
      cancel: (payload, binding) => {
        const action = { kind: "runtime-cancel", ...payload },
          revision = store.readHead()?.revision ?? 0,
          authorizationDecision = authorizeRepoCellAction({
            action,
            binding,
            actionId: `squad-runtime-cancel:${String(payload.runtimeSessionId ?? "current")}:${revision}`,
            revision,
            now: now(),
          });
        if (authorizationDecision.outcome === "denied")
          return Promise.reject(
            cellCodedError(
              "authorization_denied",
              authorizationDecision.nextActions.join(" ") ||
                "Squad runtime cancellation requires repo-write authority.",
            ),
          );
        return runtimeSpawner.cancel(payload, { ...binding, authorizationDecision });
      },
    }),
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
    scheduleActionRuntime = makeScheduleActionRuntime(runtimeContext),
    settingsActionRuntime = makeSettingsActionRuntime(runtimeContext, settings),
    squadActionRuntime = makeSquadActionRuntime(runtimeContext),
    prepareAgentAction: EntityActionCatalogPreparer = (contract, action, _binding, opId) => {
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
    if (lease?.phase === "held" && !isSameExecution(lease.actor, runtimeBinding.actor)) {
      const heldRuntimeSessionId =
          lease.actor.executor?.kind === "agent" && lease.actor.executor.id.startsWith("runtime-session:")
            ? lease.actor.executor.id.slice("runtime-session:".length)
            : null,
        dispatcherOwnsLease = isSameExecution(lease.actor, binding.actor),
        trustedRuntimeHandoff =
          heldRuntimeSessionId !== null &&
          heldRuntimeSessionId === fromRuntimeSessionId &&
          isSamePerson(lease.actor, binding.actor);
      if (!dispatcherOwnsLease && !trustedRuntimeHandoff)
        throw cellCodedError(
          "lease_conflict",
          `Task ${taskId} is held by another RuntimeSession; wait for it to settle before dispatching again.`,
        );
      const releaseAction = {
          kind: "task-release",
          taskId,
          reason: `Runtime dispatch hands execution ${lease.executionId} to ${runtimeSessionId}.`,
        },
        releaseBinding = authorizeRuntimeAction(
          releaseAction,
          { ...binding, actor: lease.actor },
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
    const startAction = { kind: "task-start", taskId, ...(executionId ? { executionId } : {}) },
      startBinding = authorizeRuntimeAction(
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
    const roleBindings = declaredRoleBindingsForActor(rootDir, input.bootstrap.actor),
      baseBinding = {
        actor: input.bootstrap.actor,
        source: "local" as const,
        ...(roleBindings === undefined
          ? { authorizationBindingMode: "default" as const }
          : { authorizationBindingMode: "declared" as const, roleBindings }),
      },
      revision = store.readHead()?.revision ?? 0,
      authorizationDecision = authorizeRepoCellAction({
        action: { kind: "repo-bootstrap" },
        binding: baseBinding,
        actionId: `repo-bootstrap:${input.repoId}:${revision}`,
        revision,
        now: now(),
      });
    if (authorizationDecision.outcome === "denied")
      throw cellCodedError(
        "authorization_denied",
        authorizationDecision.nextActions.join(" ") || "Repository bootstrap requires owner authority.",
      );
    const appended = settings.initialize(...input.bootstrap.settingsBootstrap, {
      ...baseBinding,
      authorizationDecision,
    });
    if (appended && bootstrapReceipt) {
      bootstrapReceipt = { ...bootstrapReceipt, outcome: "applied" };
      input.onBootstrap?.(bootstrapReceipt);
    }
  }
  readSettings = settings.read;
  settleScheduledOutcome = async (terminal) => {
    const scheduled = terminal.schedule;
    if (!scheduled) return;
    const detail = scheduleSettlementDetail(rootDir, scheduled, terminal.resultRef ?? terminal.reason);
    const settlement = {
        scheduleId: scheduled.scheduleId,
        claimFence: scheduled.claimFence,
        outcome: terminal.outcome,
        endedAt: terminal.endedAt,
        ...(detail ? { detail } : {}),
        idempotencyKey: `${terminal.runtimeSessionId}:attempt-terminal`,
      },
      binding = authorizeRuntimeAction(
        { kind: "schedule-settle", ...settlement },
        terminal.binding,
        `runtime-schedule-settle:${terminal.runtimeSessionId}`,
      ),
      receipt = await entityActionExecutor.run(
        { kind: "schedule-settle", ...settlement },
        binding,
        operationId({ kind: "schedule-settle", ...settlement }, binding, input.repoId, 0),
        entityActionRuntimes,
      );
    if (receipt.outcome !== "applied")
      throw cellCodedError(
        "schedule_settlement_pending",
        `Schedule ${scheduled.scheduleId} settlement was ${receipt.outcome}.`,
      );
  };
  settleRuntimeExecutionLease = async (
    task: NonNullable<RuntimeAttemptTerminal["task"]>,
    runtimeSessionId: string,
    leaseAt: string,
    occurredAt: string,
    terminalBinding: RuntimeAttemptTerminal["binding"],
  ): Promise<void> => {
    const lease = extracted.projection.currentLease(task.taskId, leaseAt);
    if (!lease || lease.phase === "released" || lease.executionId !== task.executionId) return;
    // executionId survives release and reacquisition, so it cannot tell one lease generation from
    // the next: a sibling dispatch that settles late would otherwise release the lease its own
    // batch just reacquired. The version is the generation, so settle only against that one.
    if (task.leaseVersion !== null && lease.version !== task.leaseVersion) return;
    const action = {
        kind: "task-release",
        taskId: task.taskId,
        terminalExecutionId: task.executionId,
        terminalRuntimeSessionId: runtimeSessionId,
        reason: `Runtime session ${runtimeSessionId} reached a terminal dispatch state.`,
      },
      binding = authorizeRuntimeAction(action, terminalBinding, `runtime-task-release:${runtimeSessionId}`),
      settled = taskSurfaceWriteAt(extracted, action, binding, occurredAt);
    if (settled.outcome !== "applied")
      throw cellCodedError("runtime_lease_release_failed", `Runtime terminal lease settlement was ${settled.outcome}.`);
  };
  settleExecutionLease = async (terminal) => {
    if (!terminal.task) return;
    await settleRuntimeExecutionLease(
      terminal.task,
      terminal.runtimeSessionId,
      terminal.endedAt,
      now(),
      terminal.binding,
    );
  };
  await runtimeSpawner.adopt();
  schedule(() => squadCoordinator.reconcile());

  const apiContext = {
    extracted: operationalContext,
    mode,
    // Resolved per read so the schedule GUI join sees the host's current admission
    // snapshot even when this cell attached before the fleet center started.
    get fleetRoster() {
      return input.fleetRoster?.() ?? null;
    },
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
    get activeWriterEpochGuard() {
      return activeWriterEpochGuard;
    },
    set activeWriterEpochGuard(value) {
      activeWriterEpochGuard = value;
    },
    get activeWriterEpochFence() {
      return activeWriterEpochFence;
    },
    set activeWriterEpochFence(value) {
      activeWriterEpochFence = value;
    },
    get activeWriterEpochFenceDescriptor() {
      return activeWriterEpochFenceDescriptor;
    },
    set activeWriterEpochFenceDescriptor(value) {
      activeWriterEpochFenceDescriptor = value;
    },
    withLayoutAdvisory: extracted.withLayoutAdvisory,
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
  return createRepoCellApi(apiContext);
}
