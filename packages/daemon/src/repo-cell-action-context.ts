import type { makeTaskLifecycleService } from "../../application/src/task-lifecycle-service.ts";
import type {
  CanonicalEventAppendReceipt,
  CanonicalEventStore,
  DaemonRepoMode,
  EventPublicationKillpoint,
  RepositorySettingsV1,
  SettingsV1,
  TaskProjection,
  WriteReceipt,
} from "../../kernel/src/index.ts";
import {
  closeoutTask as closeoutTaskImpl,
  declareExecutionExecutor as declareExecutionExecutorImpl,
  executeAction as executeActionImpl,
  lifecycleAction as lifecycleActionImpl,
} from "./repo-cell-action-dispatch.ts";
import { decisionProposalAction, taskCreateAction } from "./repo-cell-action-parse.ts";
import { buildCommand, withServerMeta } from "./repo-cell-command.ts";
import {
  completionKillpoint as completionKillpointImpl,
  publishCiWitness as publishCiWitnessImpl,
  showTask as showTaskImpl,
} from "./repo-cell-completion.ts";
import { cellCodedError, errorOperationId, publishGeneratedArtifact } from "./repo-cell-errors.ts";
import { decodeEvidencePayload, renderEvidencePayload, taskSurfaceWriteKind } from "./repo-cell-evidence.ts";
import {
  completeExecutionId,
  completeRetryCommand,
  explicitExecutionId,
  uniqueDerivedExecutionId,
} from "./repo-cell-execution-selection.ts";
import { lifecycleReceipt, workspaceText } from "./repo-cell-packets.ts";
import { resolveLifecycleAction } from "./repo-cell-lifecycle-action.ts";
import { createTaskId, operationId, proofFor, receiptProof, withoutDryRun } from "./repo-cell-proof.ts";
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
import { assertTaskTransitionDocumentReady } from "./transition-document-access.ts";
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
  upsertEntity as upsertEntityImpl,
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
  reviewTask as reviewTaskImpl,
  taskWipEnteringAction as taskWipEnteringActionImpl,
  wipSnapshotEntries as wipSnapshotEntriesImpl,
} from "./repo-cell-task-query.ts";
import type { TaskQueryCell } from "./repo-cell-task-query.ts";
import { runtimeIngressEventTypes, type PublicPublication, type RepoTaskAction } from "./repo-cell-types.ts";
import type { TaskQueryReadModel } from "./task-query-read.ts";
import type { makeSquadCoordinator } from "./squad-coordinator.ts";
import type { makeEntityActionCatalogExecutor } from "./entity-action-catalog-executor.ts";
import type { makeRuntimeSpawner } from "./runtime-spawn.ts";
import type { RepoCellBinding } from "./repo-cell-types.ts";
import type { RuntimeInstanceSummary } from "./agent-runtime-instances.ts";
import type {
  ScheduleClaimInput,
  ScheduleDispatchLinkInput,
  ScheduleMissedInput,
  ScheduleSettleInput,
} from "./repo-cell-schedule-actions.ts";

type Bound<Implementation> = Implementation extends (context: infer Context, ...args: infer Args) => infer Result
  ? Context extends object
    ? (...args: Args) => Result
    : never
  : never;

export interface RepoCellPeopleActions {
  readonly run: (action: RepoTaskAction, binding: RepoCellBinding) => WriteReceipt;
}

export interface RepoCellSettingsActions {
  readonly initialize: (
    settings: SettingsV1,
    documentBody: string,
    binding: RepoCellBinding,
  ) => ReturnType<CanonicalEventStore["append"]> | null;
  readonly initializeFromAuthoredDocument: (
    binding: RepoCellBinding,
  ) => ReturnType<CanonicalEventStore["append"]> | null;
  readonly read: () => SettingsV1;
  readonly readRepository: () => RepositorySettingsV1;
  readonly update: (action: RepoTaskAction, binding: RepoCellBinding) => Promise<WriteReceipt>;
}

export interface RepoCellScheduleActions {
  readonly run: (action: RepoTaskAction, binding: RepoCellBinding) => Promise<WriteReceipt>;
  readonly claimOccurrence: (input: ScheduleClaimInput, binding: RepoCellBinding) => WriteReceipt;
  readonly recordMissed: (input: ScheduleMissedInput, binding: RepoCellBinding) => WriteReceipt;
  readonly linkDispatch: (input: ScheduleDispatchLinkInput, binding: RepoCellBinding) => WriteReceipt;
  readonly settle: (input: ScheduleSettleInput, binding: RepoCellBinding) => WriteReceipt;
}

export interface RepoCellActionContext extends TaskQueryCell {
  readonly projection: TaskProjection;
  readonly store: CanonicalEventStore;
  readonly input: {
    readonly repoId: string;
    readonly killpoint?: (point: EventPublicationKillpoint) => void;
    readonly shouldStop?: () => boolean;
    readonly runtimeInstances?: () => readonly RuntimeInstanceSummary[];
  };
  readonly runtimeIngressEventTypes: typeof runtimeIngressEventTypes;
  readonly runtimeIngressReceipt: Bound<typeof runtimeIngressReceiptImpl>;
  readonly appendRuntimeIngress: Bound<typeof appendRuntimeIngressImpl>;
  readonly requiredCellText: typeof requiredCellText;
  readonly now: () => string;
  readonly operationId: typeof operationId;
  readonly receiptForOperation: Bound<typeof receiptForOperationImpl>;
  readonly showTask: Bound<typeof showTaskImpl>;
  readonly listTasks: Bound<typeof listTasksImpl>;
  readonly listRelations: Bound<typeof listRelationsImpl>;
  readonly reviewTask: Bound<typeof reviewTaskImpl>;
  readonly publishGeneratedArtifact: typeof publishGeneratedArtifact;
  readonly entityActionExecutor: ReturnType<typeof makeEntityActionCatalogExecutor>;
  readonly decisionProposalAction: typeof decisionProposalAction;
  readonly upgradePresetSnapshot: Bound<typeof upgradePresetSnapshotImpl>;
  readonly upsertEntity: Bound<typeof upsertEntityImpl>;
  readonly taskWipEnteringAction: Bound<typeof taskWipEnteringActionImpl>;
  readonly assertTaskWipCapacity: Bound<typeof assertTaskWipCapacityImpl>;
  readonly createTask: Bound<typeof createTaskImpl>;
  readonly taskCreateAction: typeof taskCreateAction;
  readonly runTaskCommandWithDocs: Bound<typeof runTaskCommandWithDocsImpl>;
  readonly assertTaskTransitionDocumentReady: typeof assertTaskTransitionDocumentReady;
  readonly appendProgress: Bound<typeof appendProgressImpl>;
  readonly migrateTaskContracts: Bound<typeof migrateTaskContractsImpl>;
  readonly archiveTasks: Bound<typeof archiveTasksImpl>;
  readonly supersedeWithNewTask: Bound<typeof supersedeWithNewTaskImpl>;
  readonly declareExecutionExecutor: Bound<typeof declareExecutionExecutorImpl>;
  readonly closeoutTask: Bound<typeof closeoutTaskImpl>;
  readonly completeTask: Bound<typeof completeTaskImpl>;
  readonly taskSurfaceWriteKind: typeof taskSurfaceWriteKind;
  readonly taskSurfaceWrite: Bound<typeof taskSurfaceWriteImpl>;
  readonly resolveLifecycleAction: typeof resolveLifecycleAction;
  readonly rejected: typeof rejected;
  readonly lifecycleAction: Bound<typeof lifecycleActionImpl>;
  readonly service: ReturnType<typeof makeTaskLifecycleService>;
  readonly squadCoordinator: ReturnType<typeof makeSquadCoordinator>;
  readonly workspaceText: typeof workspaceText;
  readonly buildCommand: typeof buildCommand;
  readonly withServerMeta: typeof withServerMeta;
  readonly proofFor: (
    command: Parameters<typeof proofFor>[0],
    snapshot: Parameters<typeof proofFor>[1],
    binding: Parameters<typeof proofFor>[2],
    projection: Parameters<typeof proofFor>[3],
  ) => ReturnType<typeof proofFor>;
  readonly lifecycleReceipt: typeof lifecycleReceipt;
  readonly publicPublication: (value: Pick<CanonicalEventAppendReceipt, "commitSha" | "cut">) => PublicPublication;
  readonly explicitExecutionId: typeof explicitExecutionId;
  readonly projectionReady: typeof projectionReady;
  readonly uniqueDerivedExecutionId: typeof uniqueDerivedExecutionId;
  readonly receiptProof: typeof receiptProof;
  readonly taskMutation: Bound<typeof taskMutationImpl>;
  readonly withoutDryRun: typeof withoutDryRun;
  readonly previewResult: Bound<typeof previewResultImpl>;
  readonly projectedTaskIds: Bound<typeof projectedTaskIdsImpl>;
  readonly dependencyPath: Bound<typeof dependencyPathImpl>;
  readonly relationEndpointExists: Bound<typeof relationEndpointExistsImpl>;
  readonly directChildCounts: Bound<typeof directChildCountsImpl>;
  readonly wipSnapshotEntries: Bound<typeof wipSnapshotEntriesImpl>;
  readonly legacyReviewLint: typeof legacyReviewLint;
  readonly cellStringList: typeof cellStringList;
  readonly decodeEvidencePayload: typeof decodeEvidencePayload;
  readonly renderEvidencePayload: typeof renderEvidencePayload;
  readonly createTaskId: typeof createTaskId;
  readonly progressReceipt: Bound<typeof progressReceiptImpl>;
  readonly progressEvidence: typeof progressEvidence;
  readonly completeExecutionId: typeof completeExecutionId;
  readonly completionApplied: typeof completionApplied;
  readonly completionContext: Bound<typeof completionContextImpl>;
  readonly completeRetryCommand: typeof completeRetryCommand;
  readonly failed: typeof failed;
  readonly completionSettlement: typeof completionSettlement;
  readonly publishCiWitness: Bound<typeof publishCiWitnessImpl>;
  readonly errorOperationId: typeof errorOperationId;
  readonly completionStopped: typeof completionStopped;
  readonly completionKillpoint: Bound<typeof completionKillpointImpl>;
  readonly executeAction: Bound<typeof executeActionImpl>;
  readonly withHumanSummary: Bound<typeof withHumanSummaryImpl>;
  readonly withLayoutAdvisory: Bound<typeof withLayoutAdvisoryImpl>;
  recoveryUncertain: boolean;
  readonly recovery: ReturnType<CanonicalEventStore["recover"]>;
  readonly canonicalSettlement: Bound<typeof canonicalSettlementImpl>;
  knownTaskIds: Set<string> | null;
}

export interface RepoCellRuntimeContext extends RepoCellActionContext {
  readonly mode: DaemonRepoMode;
  readonly runtimeSpawner: ReturnType<typeof makeRuntimeSpawner>;
}

export interface RepoCellOperationalContext extends RepoCellRuntimeContext {
  readonly peopleActions: RepoCellPeopleActions;
  readonly scheduleActions: RepoCellScheduleActions;
  readonly settingsActions: RepoCellSettingsActions;
}

export function createRepoCellActionContext(bindings: {
  readonly input: {
    readonly repoId: string;
    readonly killpoint?: (point: EventPublicationKillpoint) => void;
    readonly shouldStop?: () => boolean;
    readonly runtimeInstances?: () => readonly RuntimeInstanceSummary[];
  };
  readonly rootDir: string;
  readonly now: () => string;
  readonly publicPublication: (value: Pick<CanonicalEventAppendReceipt, "commitSha" | "cut">) => PublicPublication;
  readonly getProjection: () => TaskProjection;
  readonly getStore: () => CanonicalEventStore;
  readonly getEntityActionExecutor: () => ReturnType<typeof makeEntityActionCatalogExecutor>;
  readonly getService: () => ReturnType<typeof makeTaskLifecycleService>;
  readonly getRecovery: () => ReturnType<CanonicalEventStore["recover"]>;
  readonly getRecoveryUncertain: () => boolean;
  readonly setRecoveryUncertain: (value: boolean) => void;
  readonly getKnownTaskIds: () => Set<string> | null;
  readonly setKnownTaskIds: (value: Set<string> | null) => void;
  readonly getSquadCoordinator: () => ReturnType<typeof makeSquadCoordinator>;
}): RepoCellActionContext {
  const actionContext: { current: object | null } = { current: null };
  const bind =
    <Context extends object, Args extends readonly unknown[], Result>(
      implementation: (context: Context, ...args: Args) => Result,
    ) =>
    (...args: Args): Result => {
      if (actionContext.current === null) throw new Error("RepoCell action context is not initialized");
      return implementation(actionContext.current as Context, ...args);
    };
  const unavailableTaskQuery = (): never => {
    throw new Error("RepoCell task query functions are not installed");
  };

  const context: RepoCellActionContext = {
    cellCodedError,
    input: bindings.input,
    runtimeIngressEventTypes,
    get projection() {
      return bindings.getProjection();
    },
    get store() {
      return bindings.getStore();
    },
    runtimeIngressReceipt: bind(runtimeIngressReceiptImpl),
    appendRuntimeIngress: bind(appendRuntimeIngressImpl),
    requiredCellText,
    now: bindings.now,
    operationId,
    receiptForOperation: bind(receiptForOperationImpl),
    showTask: bind(showTaskImpl),
    listTasks: bind(listTasksImpl),
    listRelations: bind(listRelationsImpl),
    reviewTask: bind(reviewTaskImpl),
    taskListQueryFromAction: (_action: RepoTaskAction) => unavailableTaskQuery(),
    relationQueryFromAction: (_action: RepoTaskAction) => unavailableTaskQuery(),
    queryRead: (): TaskQueryReadModel => unavailableTaskQuery(),
    publishGeneratedArtifact,
    rootDir: bindings.rootDir,
    get entityActionExecutor() {
      return bindings.getEntityActionExecutor();
    },
    decisionProposalAction,
    upgradePresetSnapshot: bind(upgradePresetSnapshotImpl),
    upsertEntity: bind(upsertEntityImpl),
    readResult: bind(readResultImpl),
    taskWipEnteringAction: bind(taskWipEnteringActionImpl),
    assertTaskWipCapacity: bind(assertTaskWipCapacityImpl),
    createTask: bind(createTaskImpl),
    taskCreateAction,
    runTaskCommandWithDocs: bind(runTaskCommandWithDocsImpl),
    assertTaskTransitionDocumentReady,
    appendProgress: bind(appendProgressImpl),
    migrateTaskContracts: bind(migrateTaskContractsImpl),
    archiveTasks: bind(archiveTasksImpl),
    supersedeWithNewTask: bind(supersedeWithNewTaskImpl),
    declareExecutionExecutor: bind(declareExecutionExecutorImpl),
    closeoutTask: bind(closeoutTaskImpl),
    completeTask: bind(completeTaskImpl),
    taskSurfaceWriteKind,
    taskSurfaceWrite: bind(taskSurfaceWriteImpl),
    resolveLifecycleAction,
    rejected,
    lifecycleAction: bind(lifecycleActionImpl),
    get service() {
      return bindings.getService();
    },
    get squadCoordinator() {
      return bindings.getSquadCoordinator();
    },
    workspaceText,
    buildCommand,
    withServerMeta,
    proofFor: (
      command: Parameters<typeof proofFor>[0],
      snapshot: Parameters<typeof proofFor>[1],
      binding: Parameters<typeof proofFor>[2],
      projection: Parameters<typeof proofFor>[3],
    ) => proofFor(command, snapshot, binding, projection, bindings.rootDir),
    lifecycleReceipt,
    publicPublication: bindings.publicPublication,
    explicitExecutionId,
    projectionReady,
    uniqueDerivedExecutionId,
    receiptProof,
    taskMutation: bind(taskMutationImpl),
    withoutDryRun,
    previewResult: bind(previewResultImpl),
    projectedTaskIds: bind(projectedTaskIdsImpl),
    dependencyPath: bind(dependencyPathImpl),
    relationEndpointExists: bind(relationEndpointExistsImpl),
    directChildCounts: bind(directChildCountsImpl),
    wipSnapshotEntries: bind(wipSnapshotEntriesImpl),
    legacyReviewLint,
    cellStringList,
    decodeEvidencePayload,
    renderEvidencePayload,
    createTaskId,
    progressReceipt: bind(progressReceiptImpl),
    progressEvidence,
    completeExecutionId,
    completionApplied,
    completionContext: bind(completionContextImpl),
    completeRetryCommand,
    failed,
    completionSettlement,
    publishCiWitness: bind(publishCiWitnessImpl),
    errorOperationId,
    completionStopped,
    completionKillpoint: bind(completionKillpointImpl),
    executeAction: bind(executeActionImpl),
    withHumanSummary: bind(withHumanSummaryImpl),
    withLayoutAdvisory: bind(withLayoutAdvisoryImpl),
    get recoveryUncertain() {
      return bindings.getRecoveryUncertain();
    },
    set recoveryUncertain(value) {
      bindings.setRecoveryUncertain(value);
    },
    get recovery() {
      return bindings.getRecovery();
    },
    canonicalSettlement: bind(canonicalSettlementImpl),
    get knownTaskIds() {
      return bindings.getKnownTaskIds();
    },
    set knownTaskIds(value) {
      bindings.setKnownTaskIds(value);
    },
  };

  actionContext.current = context;
  return context;
}
