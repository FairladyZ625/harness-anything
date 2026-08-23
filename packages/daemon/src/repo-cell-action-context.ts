import {
  closeoutTask as closeoutTaskImpl,
  declareExecutionExecutor as declareExecutionExecutorImpl,
  executeAction as executeActionImpl,
  lifecycleAction as lifecycleActionImpl,
} from "./repo-cell-action-dispatch.ts";
import {
  decisionProposalAction,
  taskCreateAction,
} from "./repo-cell-action-parse.ts";
import { buildCommand, withServerMeta } from "./repo-cell-command.ts";
import {
  completionKillpoint as completionKillpointImpl,
  publishCiWitness as publishCiWitnessImpl,
  showTask as showTaskImpl,
} from "./repo-cell-completion.ts";
import {
  cellCodedError,
  errorOperationId,
  publishGeneratedArtifact,
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
import { leaseTtlMs, runtimeIngressEventTypes } from "./repo-cell-types.ts";

export function createRepoCellActionContext(bindings: {
  readonly input: any;
  readonly rootDir: any;
  readonly now: () => string;
  readonly publicPublication: (value: any) => any;
  readonly getProjection: () => any;
  readonly getStore: () => any;
  readonly getFactActions: () => any;
  readonly getDecisionActions: () => any;
  readonly getService: () => any;
  readonly getRecovery: () => any;
  readonly getRecoveryUncertain: () => boolean;
  readonly setRecoveryUncertain: (value: boolean) => void;
  readonly getKnownTaskIds: () => Set<string> | null;
  readonly setKnownTaskIds: (value: Set<string> | null) => void;
}): any {
  const bind =
    <Args extends readonly unknown[], Result>(
      implementation: (context: any, ...args: Args) => Result,
    ) =>
    (...args: Args): Result =>
      implementation(context, ...args);

  const context: any = {
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
    publishGeneratedArtifact,
    rootDir: bindings.rootDir,
    get factActions() {
      return bindings.getFactActions();
    },
    decisionProposalAction,
    get decisionActions() {
      return bindings.getDecisionActions();
    },
    upgradePresetSnapshot: bind(upgradePresetSnapshotImpl),
    installAgentEntity: bind(installAgentEntityImpl),
    readResult: bind(readResultImpl),
    taskWipEnteringAction: bind(taskWipEnteringActionImpl),
    assertTaskWipCapacity: bind(assertTaskWipCapacityImpl),
    createTask: bind(createTaskImpl),
    taskCreateAction,
    runTaskCommandWithDocs: bind(runTaskCommandWithDocsImpl),
    appendProgress: bind(appendProgressImpl),
    previewStart: bind(previewStartImpl),
    migrateTaskContracts: bind(migrateTaskContractsImpl),
    archiveTasks: bind(archiveTasksImpl),
    supersedeWithNewTask: bind(supersedeWithNewTaskImpl),
    declareExecutionExecutor: bind(declareExecutionExecutorImpl),
    closeoutTask: bind(closeoutTaskImpl),
    completeTask: bind(completeTaskImpl),
    taskSurfaceWriteKind,
    taskSurfaceWrite: bind(taskSurfaceWriteImpl),
    taskWriteKind,
    rejected,
    lifecycleAction: bind(lifecycleActionImpl),
    get service() {
      return bindings.getService();
    },
    workspaceText,
    buildCommand,
    withServerMeta,
    proofFor,
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
    startExecutionId,
    leaseTtlMs,
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

  return context;
}
