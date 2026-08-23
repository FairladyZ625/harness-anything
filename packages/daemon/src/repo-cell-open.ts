import {
  bindWriterGenerationToken,
  consumeKnownError,
  type CanonicalEventAppendReceipt,
  type DaemonRepoMode,
  type EventPublicationKillpoint,
  type WriterGeneration,
} from "../../kernel/src/index.ts";
import { createPresetProcessService, presetUserRoot } from "../../preset/src/index.ts";
import { readAgentDeclaration, resolveSquadDispatchTarget } from "./agent-entities.ts";
import type { PreparedRuntimeLaunch, RuntimeInstanceSummary } from "./agent-runtime-instances.ts";
import { makeAgentRuntimeStreamHub } from "./agent-runtime-stream.ts";
import { openGuiCatalog } from "./gui-catalog.ts";
import { type CanonicalRoot, type WorkspaceId } from "./protocol/daemon-protocol.contract.ts";
import { makeRecoveryProbe } from "./recovery-state.ts";
import { bootstrapRepo, type RepoBootstrapInput, type RepoBootstrapReceipt } from "./repo-bootstrap.ts";
import {
  closeoutTask as closeoutTaskImpl,
  declareExecutionExecutor as declareExecutionExecutorImpl,
  executeAction as executeActionImpl,
  lifecycleAction as lifecycleActionImpl,
} from "./repo-cell-action-dispatch.ts";
import { decisionProposalAction, taskCreateAction } from "./repo-cell-action-parse.ts";
import { createRepoCellApi } from "./repo-cell-api.ts";
import { buildCommand, dispatchRead, withServerMeta } from "./repo-cell-command.ts";
import {
  completionKillpoint as completionKillpointImpl,
  publishCiWitness as publishCiWitnessImpl,
  showTask as showTaskImpl,
} from "./repo-cell-completion.ts";
import {
  cellCodedError,
  cellErrorCode,
  cellErrorMessage,
  errorOperationId,
  fatalCellError,
  publishGeneratedArtifact,
  unavailableRuntimeInstanceStore,
} from "./repo-cell-errors.ts";
import {
  decodeEvidencePayload,
  renderEvidencePayload,
  taskSurfaceWriteKind,
  taskWriteKind,
} from "./repo-cell-evidence.ts";
import {
  completeExecutionId,
  completeRetryCommand,
  explicitExecutionId,
  uniqueDerivedExecutionId,
} from "./repo-cell-execution-selection.ts";
import { chainRepoCellWrite, initializeRepoCell } from "./repo-cell.ts";
import { acquireWorkspaceLock, causeClassOf, latchReprobeThrottleMs } from "./repo-cell-lock.ts";
import { lifecycleReceipt, workspaceText } from "./repo-cell-packets.ts";
import {
  createTaskId,
  operationId,
  proofFor,
  receiptProof,
  startExecutionId,
  withoutDryRun,
} from "./repo-cell-proof.ts";
import {
  canonicalSettlement as canonicalSettlementImpl,
  progressReceipt as progressReceiptImpl,
  projectedTaskIds as projectedTaskIdsImpl,
  receiptForOperation as receiptForOperationImpl,
} from "./repo-cell-receipts.ts";
import { legacyReviewLint } from "./repo-cell-review-lint.ts";
import {
  appendRuntimeIngress as appendRuntimeIngressImpl,
  runtimeIngressReceipt as runtimeIngressReceiptImpl,
} from "./repo-cell-runtime-actions.ts";
import {
  cellStringList,
  completionApplied,
  completionSettlement,
  completionStopped,
  failed,
  progressEvidence,
  projectionReady,
  rejected,
  requiredCellText,
} from "./repo-cell-settlement.ts";
import {
  runTaskCommandWithDocs as runTaskCommandWithDocsImpl,
  taskMutation as taskMutationImpl,
  taskSurfaceWrite as taskSurfaceWriteImpl,
} from "./repo-cell-task-command.ts";
import {
  createTask as createTaskImpl,
  dependencyPath as dependencyPathImpl,
  previewResult as previewResultImpl,
  readResult as readResultImpl,
  relationEndpointExists as relationEndpointExistsImpl,
  upgradePresetSnapshot as upgradePresetSnapshotImpl,
  withHumanSummary as withHumanSummaryImpl,
  withLayoutAdvisory as withLayoutAdvisoryImpl,
} from "./repo-cell-task-create.ts";
import {
  archiveTasks as archiveTasksImpl,
  installAgentEntity as installAgentEntityImpl,
  migrateTaskContracts as migrateTaskContractsImpl,
  supersedeWithNewTask as supersedeWithNewTaskImpl,
} from "./repo-cell-task-maintenance.ts";
import {
  appendProgress as appendProgressImpl,
  completeTask as completeTaskImpl,
  completionContext as completionContextImpl,
} from "./repo-cell-task-progress.ts";
import {
  assertTaskWipCapacity as assertTaskWipCapacityImpl,
  directChildCounts as directChildCountsImpl,
  listRelations as listRelationsImpl,
  listTasks as listTasksImpl,
  previewStart as previewStartImpl,
  reviewTask as reviewTaskImpl,
  taskWipEnteringAction as taskWipEnteringActionImpl,
  wipSnapshotEntries as wipSnapshotEntriesImpl,
} from "./repo-cell-task-query.ts";
import type {
  PublicPublication,
  RepoCell,
  RepoCellBinding,
  RepoCellStatus,
  RepoCellTerminal,
} from "./repo-cell-types.ts";
import { leaseTtlMs, runtimeIngressEventTypes } from "./repo-cell-types.ts";
import { admitRepoMode } from "./repo-mode.ts";
import { makeDaemonRuntimeAdmissionGuard } from "./runtime-admission.ts";
import { makeRuntimeSpawner, type RuntimeDaemonRoute, type RuntimeLauncher } from "./runtime-spawn.ts";
import { openTerminalHost } from "./terminal-host.ts";

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
  readonly bootstrap?: RepoBootstrapInput;
  readonly onBootstrap?: (receipt: RepoBootstrapReceipt) => void;
  readonly now?: () => string;
  readonly killpoint?: (point: EventPublicationKillpoint) => void;
  readonly shouldStop?: () => boolean;
}): Promise<RepoCell> {
  const rootDir = input.rootDir,
    mode = input.mode ?? "local",
    now = input.now ?? (() => new Date().toISOString()),
    runtimeAdmission = makeDaemonRuntimeAdmissionGuard({
      nowMs: () => Date.parse(now()),
    });
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
  const runtimeSpawner = makeRuntimeSpawner({
    repoId: input.repoId,
    rootDir,
    daemonGeneration: generation,
    ...(input.runtimeDaemonRoute ? { runtimeDaemonRoute: input.runtimeDaemonRoute } : {}),
    store: () => store,
    projection: () => projection,
    stream: runtimeStream,
    now,
    schedule,
    runtimeInstances: input.runtimeInstances,
    prepareLaunch: input.prepareRuntimeLaunch ?? unavailableRuntimeInstanceStore,
    resolveAgent: (agentId) => readAgentDeclaration({ rootDir, agentId }),
    resolveSquadDispatchTarget: (leaderId, workerId) => resolveSquadDispatchTarget({ rootDir, leaderId, workerId }),
    ...(input.runtimeLaunch ? { launch: input.runtimeLaunch } : {}),
  });
  function assertRuntimeAdmission(force = false): void {
    runtimeAdmission.assert(rootDir, force);
  }
  const catalog = openGuiCatalog({ repoId: input.repoId, rootDir, now }),
    terminalHost = openTerminalHost({
      repoId: input.repoId,
      rootDir,
      daemonGeneration: generation,
      now,
    });
  const admitTerminalWrite = (binding: RepoCellBinding): void => {
    const admission = admitRepoMode(mode, "repo-write", binding.source);
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
  const bindExtracted =
    <Args extends readonly unknown[], Result>(implementation: (context: any, ...args: Args) => Result) =>
    (...args: Args): Result =>
      implementation(extracted, ...args);
  const extracted: any = {
    cellCodedError,
    input,
    runtimeIngressEventTypes,
    get projection() {
      return projection;
    },
    get store() {
      return store;
    },
    runtimeIngressReceipt: bindExtracted(runtimeIngressReceiptImpl),
    appendRuntimeIngress: bindExtracted(appendRuntimeIngressImpl),
    requiredCellText,
    now,
    operationId,
    receiptForOperation: bindExtracted(receiptForOperationImpl),
    showTask: bindExtracted(showTaskImpl),
    listTasks: bindExtracted(listTasksImpl),
    listRelations: bindExtracted(listRelationsImpl),
    reviewTask: bindExtracted(reviewTaskImpl),
    publishGeneratedArtifact,
    rootDir,
    get factActions() {
      return factActions;
    },
    decisionProposalAction,
    get decisionActions() {
      return decisionActions;
    },
    upgradePresetSnapshot: bindExtracted(upgradePresetSnapshotImpl),
    installAgentEntity: bindExtracted(installAgentEntityImpl),
    readResult: bindExtracted(readResultImpl),
    taskWipEnteringAction: bindExtracted(taskWipEnteringActionImpl),
    assertTaskWipCapacity: bindExtracted(assertTaskWipCapacityImpl),
    createTask: bindExtracted(createTaskImpl),
    taskCreateAction,
    runTaskCommandWithDocs: bindExtracted(runTaskCommandWithDocsImpl),
    appendProgress: bindExtracted(appendProgressImpl),
    previewStart: bindExtracted(previewStartImpl),
    migrateTaskContracts: bindExtracted(migrateTaskContractsImpl),
    archiveTasks: bindExtracted(archiveTasksImpl),
    supersedeWithNewTask: bindExtracted(supersedeWithNewTaskImpl),
    declareExecutionExecutor: bindExtracted(declareExecutionExecutorImpl),
    closeoutTask: bindExtracted(closeoutTaskImpl),
    completeTask: bindExtracted(completeTaskImpl),
    taskSurfaceWriteKind,
    taskSurfaceWrite: bindExtracted(taskSurfaceWriteImpl),
    taskWriteKind,
    rejected,
    lifecycleAction: bindExtracted(lifecycleActionImpl),
    get service() {
      return service;
    },
    workspaceText,
    buildCommand,
    withServerMeta,
    proofFor,
    lifecycleReceipt,
    publicPublication,
    explicitExecutionId,
    projectionReady,
    uniqueDerivedExecutionId,
    receiptProof,
    taskMutation: bindExtracted(taskMutationImpl),
    withoutDryRun,
    previewResult: bindExtracted(previewResultImpl),
    projectedTaskIds: bindExtracted(projectedTaskIdsImpl),
    dependencyPath: bindExtracted(dependencyPathImpl),
    relationEndpointExists: bindExtracted(relationEndpointExistsImpl),
    directChildCounts: bindExtracted(directChildCountsImpl),
    wipSnapshotEntries: bindExtracted(wipSnapshotEntriesImpl),
    legacyReviewLint,
    startExecutionId,
    leaseTtlMs,
    cellStringList,
    decodeEvidencePayload,
    renderEvidencePayload,
    createTaskId,
    progressReceipt: bindExtracted(progressReceiptImpl),
    progressEvidence,
    completeExecutionId,
    completionApplied,
    completionContext: bindExtracted(completionContextImpl),
    completeRetryCommand,
    failed,
    completionSettlement,
    publishCiWitness: bindExtracted(publishCiWitnessImpl),
    errorOperationId,
    completionStopped,
    completionKillpoint: bindExtracted(completionKillpointImpl),
    executeAction: bindExtracted(executeActionImpl),
    withHumanSummary: bindExtracted(withHumanSummaryImpl),
    withLayoutAdvisory: bindExtracted(withLayoutAdvisoryImpl),
    get recoveryUncertain() {
      return recoveryUncertain;
    },
    set recoveryUncertain(value) {
      recoveryUncertain = value;
    },
    get recovery() {
      return recovery;
    },
    canonicalSettlement: bindExtracted(canonicalSettlementImpl),
    get knownTaskIds() {
      return knownTaskIds;
    },
    set knownTaskIds(value) {
      knownTaskIds = value;
    },
  };

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
    presetProcess,
    get runtimeReads() {
      return runtimeReads;
    },
    runtimeSpawner,
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
