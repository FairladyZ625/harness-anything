import {
  bindWriterGenerationToken,
  consumeKnownError,
  createEntityStore,
  type CanonicalEventAppendReceipt,
  type DaemonRepoMode,
  type EventPublicationKillpoint,
  type SettingsV1,
  type WriterGeneration,
} from "../../kernel/src/index.ts";
import { createPresetProcessService, presetUserRoot } from "../../preset/src/index.ts";
import { ledgerWriteCommandTopology } from "../../preset/src/preset-command-contract.ts";
import { readAgentDeclaration, resolveSquadDispatch } from "./agent-entities.ts";
import type { PreparedRuntimeLaunch, RuntimeInstanceSummary } from "./agent-runtime-instances.ts";
import { makeAgentRuntimeStreamHub } from "./agent-runtime-stream.ts";
import { localRepairBinding } from "./daemon-host-binding.ts";
import { openGuiCatalog } from "./gui-catalog.ts";
import { type CanonicalRoot, type WorkspaceId } from "./protocol/daemon-protocol.contract.ts";
import { makeRecoveryProbe } from "./recovery-state.ts";
import { bootstrapRepo, type RepoBootstrapInput, type RepoBootstrapReceipt } from "./repo-bootstrap.ts";
import { createRepoCellActionContext } from "./repo-cell-action-context.ts";
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
import { makeRepoCellScheduleActions } from "./repo-cell-schedule-actions.ts";
import { makeRepoCellSettingsActions } from "./repo-cell-settings-actions.ts";
import { failed, rejected, requiredCellText } from "./repo-cell-settlement.ts";
import type {
  PublicPublication,
  RepoCell,
  RepoCellBinding,
  RepoCellStatus,
  RepoCellTerminal,
} from "./repo-cell-types.ts";
import { admitRepoMode } from "./repo-mode.ts";
import { makeDaemonRuntimeAdmissionGuard } from "./runtime-admission.ts";
import {
  makeRuntimeSpawner,
  type RuntimeAttemptTerminal,
  type RuntimeDaemonRoute,
  type RuntimeLauncher,
} from "./runtime-spawn.ts";
import { openTerminalHost } from "./terminal-host.ts";
import { makeSquadCoordinator } from "./squad-coordinator.ts";
import type { DaemonLifecycleRecorder } from "./lifecycle-log.ts";

export function publicPublication(value: Pick<CanonicalEventAppendReceipt, "commitSha" | "cut">): PublicPublication {
  return { commitSha: value.commitSha?.sha ?? null, cut: value.cut };
}

export async function openRepoCell(input: {
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
  readonly onAttemptTerminal?: (terminal: RuntimeAttemptTerminal) => void;
  readonly now?: () => string;
  readonly killpoint?: (point: EventPublicationKillpoint) => void;
  readonly shouldStop?: () => boolean;
  readonly recordLifecycle?: DaemonLifecycleRecorder;
}): Promise<RepoCell> {
  const rootDir = input.rootDir,
    mode = input.mode ?? "local",
    now = input.now ?? (() => new Date().toISOString()),
    runtimeAdmission = makeDaemonRuntimeAdmissionGuard({
      nowMs: () => Date.parse(now()),
    });
  let readSettings = (): SettingsV1 => {
    throw cellCodedError("projection_pending", "Settings projection is unavailable while the RepoCell is opening.");
  };
  assertRuntimeAdmission(true);
  const lock = await acquireWorkspaceLock(rootDir),
    generation = Date.now() * 1_000 + (process.pid % 1_000);
  const activeWriter: WriterGeneration = {
      workspaceId: input.repoId,
      generation,
      ownerId: input.ownerId,
    },
    writerToken = bindWriterGenerationToken(activeWriter);
  let authoredBranch = input.authoredBranch,
    bootstrapReceipt: RepoBootstrapReceipt | undefined;
  try {
    if (input.bootstrap) {
      bootstrapReceipt = bootstrapRepo(input.bootstrap, activeWriter, writerToken, authoredBranch);
      authoredBranch = bootstrapReceipt.authoredBranch;
      input.onBootstrap?.(bootstrapReceipt);
    }
  } catch (error) {
    await lock.close();
    throw error;
  }
  const presetProcess = createPresetProcessService({
    rootDir,
    userRoot: presetUserRoot(rootDir),
    readSettings: () => readSettings(),
  });
  const runtimeStream = makeAgentRuntimeStreamHub({
    readSession: (runtimeSessionId) => {
      projection.list();
      return projection.readRuntimeSession(runtimeSessionId);
    },
    canAttach: (session) =>
      session.attachable &&
      Boolean(projection.readRuntimeInstallation(session.installationId)?.effectiveCapabilities.includes("attach")),
    now: () => new Date(now()),
  });
  // The ledger core is rebuildable in place: the variables below are rebound wholesale by
  // attemptRecovery, so a latched cell re-attaches to repaired data without reopening.
  let activeWriterEpochGuard: (() => void) | null = null,
    activeWriterEpochFence: (<T>(operation: () => T) => T) | null = null;
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
      mode,
      now,
      runtimeStream,
    });
  let core: ReturnType<typeof initialize>;
  try {
    core = initialize();
  } catch (error) {
    runtimeStream.close();
    await presetProcess.close();
    await lock.close();
    throw error;
  }
  let { store, recovery, projection, factActions, decisionActions, runtimeReads, service, replica } = core;
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
  let queueDepth = 0,
    tail = Promise.resolve();
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
  const recheckRuntime = (): void => {
    try {
      assertRuntimeAdmission();
    } catch (error) {
      latchWith(error);
      throw error;
    }
  };
  // Latch self-heal: while unavailable, the next command replays the failed judgment against a
  // freshly built ledger view (publication refs re-read from Git, recovery replayed, projection
  // catch-up replayed). Pass -> rebind the core and return to attached; fail -> stay unavailable
  // with the replayed cause. Probes are throttled so frequent read retries cannot hot-loop them,
  // and every fresh latch earns one immediate probe.
  const attemptRecovery = (): void => {
    if (state !== "unavailable") return;
    if (!recoveryProbe.begin(Date.parse(now()))) return;
    let candidate: ReturnType<typeof initialize> | undefined;
    try {
      candidate = initialize();
      assertRuntimeAdmission(true);
      const probeIndeterminate = candidate.recovery.status === "indeterminate";
      if (probeIndeterminate)
        throw cellCodedError(
          candidate.recovery.errorCode ?? "publication_indeterminate",
          candidate.recovery.error ??
            `startup recovery ${candidate.recovery.status} after ${candidate.recovery.elapsedMs.toFixed(3)}ms`,
        );
      candidate.projection.list();
      replica.close();
      projection.close();
      ({ store, recovery, projection, factActions, decisionActions, runtimeReads, service, replica } = candidate);
      knownTaskIds = null;
      state = "attached";
      lastError = null;
      causeClass = null;
      recoveryUncertain = false;
      recoveryProbe.clear();
    } catch (error) {
      consumeKnownError(error);
      candidate?.replica.close();
      candidate?.projection.close();
      if (candidate) recoveryUncertain = true;
      lastError = cellErrorMessage(error);
      causeClass = causeClassOf(error);
    }
  };
  const schedule = (work: () => void | Promise<void>): void => {
    queueDepth += 1;
    const pending = chainRepoCellWrite(tail, async () => {
      queueDepth -= 1;
      if (state === "attached") await work();
    });
    tail = pending.then(
      () => undefined,
      () => undefined,
    );
    void pending.then(
      () => replica.kick(),
      () => replica.kick(),
    );
  };
  let settleFallbackExhaustion: (value: {
    readonly taskId: string;
    readonly executionId: string;
    readonly reason: string;
    readonly binding: RepoCellBinding;
  }) => Promise<void> = async () => {
    throw cellCodedError("runtime_preconditions_unavailable", "RepoCell fallback settlement is not ready.");
  };
  let settleScheduledOutcome: (terminal: RuntimeAttemptTerminal) => Promise<void> = async () => {
    throw cellCodedError("runtime_preconditions_unavailable", "RepoCell Schedule settlement is not ready.");
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
      if (terminal.fallbackExhausted && terminal.task)
        await settleFallbackExhaustion({
          ...terminal.task,
          reason: terminal.reason ?? "Provider fallback exhausted.",
          binding: terminal.binding,
        });
      if (terminal.schedule) schedule(() => settleScheduledOutcome(terminal));
      input.onAttemptTerminal?.(terminal);
    },
    ...(input.recordLifecycle ? { recordLifecycle: input.recordLifecycle } : {}),
    ...(input.runtimeLaunch ? { launch: input.runtimeLaunch } : {}),
  });
  const squadCoordinator = makeSquadCoordinator({
    rootDir,
    projection: () => projection,
    store: () => store,
    runtimeSpawner: () => runtimeSpawner,
  });
  function assertRuntimeAdmission(force = false): void {
    runtimeAdmission.assert(rootDir, force);
  }
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
    if (state !== "attached") attemptRecovery();
    if (state !== "attached") throw cellCodedError("repo_unavailable", latched());
    recheckRuntime();
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
    getFactActions: () => factActions,
    getDecisionActions: () => decisionActions,
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
  const scheduleActions = makeRepoCellScheduleActions(extracted);
  const settingsActions = makeRepoCellSettingsActions(extracted);
  Object.assign(extracted, { mode, runtimeSpawner, scheduleActions, settingsActions });
  readSettings = settingsActions.read;
  if (mode !== "remote-edge") settingsActions.initialize(localRepairBinding);
  settleScheduledOutcome = async (terminal) => {
    const scheduled = terminal.schedule,
      detail = terminal.resultRef ?? terminal.reason;
    if (!scheduled) return;
    const receipt = scheduleActions.settle(
      {
        scheduleId: scheduled.scheduleId,
        claimFence: scheduled.claimFence,
        outcome: terminal.outcome,
        endedAt: terminal.endedAt,
        ...(detail ? { detail } : {}),
        idempotencyKey: `${terminal.runtimeSessionId}:attempt-terminal`,
      },
      terminal.binding,
    );
    if (receipt.outcome !== "applied")
      throw cellCodedError(
        "schedule_settlement_pending",
        `Schedule ${scheduled.scheduleId} settlement was ${receipt.outcome}.`,
      );
  };
  settleFallbackExhaustion = async ({ taskId, executionId, reason, binding }) => {
    const settled = await extracted.taskSurfaceWrite(
      { kind: "task-fallback-exhausted", taskId, executionId, reason },
      binding,
    );
    if (settled.outcome !== "applied")
      throw cellCodedError("fallback_block_failed", `Fallback exhaustion settlement was ${settled.outcome}.`);
  };
  await runtimeSpawner.adopt();
  schedule(() => squadCoordinator.reconcile());

  const apiContext = {
    extracted,
    mode,
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
    recheckRuntime,
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
    scheduleActions,
    settingsActions,
    appendRuntimeIngress: extracted.appendRuntimeIngress,
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
