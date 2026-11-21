import { annotateExecution as annotateExecutionImpl } from "./repo-cell-execution-selection.ts";
import type { RepoCellActionContext, RepoCellOperationalContext } from "./repo-cell-types.ts";
import type { RepoCellCore } from "./repo-cell.ts";
import type { makeTaskLifecycleService } from "@harness-anything/application/internal/task-lifecycle-service";
import {
  resolveHarnessLayout,
  type CanonicalEventAppendReceipt,
  type CanonicalEventStore,
  type EventPublicationKillpoint,
  type SettingsV1,
  type TaskProjection,
} from "@harness-anything/kernel";
import type { NodeTaskMaterializationPolicy } from "@harness-anything/kernel/internal/domain/task-wip-policy.ts";
import {
  declareExecutionExecutor as declareExecutionExecutorImpl,
  executeAction as executeActionImpl,
} from "./repo-cell-action-dispatch.ts";
import { runTaskActionCatalogRuntime as lifecycleActionImpl } from "./task-action-catalog-runtime.ts";
import { decisionProposalAction, taskCreateAction } from "./repo-cell-action-parse.ts";
import { buildCommand, withServerMeta } from "./repo-cell-command.ts";
import {
  completionKillpoint as completionKillpointImpl,
  publishGateWitness as publishGateWitnessImpl,
} from "./repo-cell-completion.ts";
import { cellCodedError, errorOperationId, publishGeneratedArtifact } from "./repo-cell-errors.ts";
import { decodeEvidencePayload } from "@harness-anything/application/internal/queries/evidence-payload.ts";
import { renderEvidencePayload } from "@harness-anything/application/internal/queries/repo-cell-evidence.ts";
import {
  completeRetryCommand,
  explicitExecutionId,
  uniqueDerivedExecutionId,
} from "./repo-cell-execution-selection.ts";
import { lifecycleReceipt, workspaceText } from "./repo-cell-packets.ts";
import { createTaskId, operationId, proofFor, receiptProof, withoutDryRun } from "./repo-cell-proof.ts";
import {
  canonicalSettlement as canonicalSettlementImpl,
  progressReceipt as progressReceiptImpl,
  projectedTaskIds as projectedTaskIdsImpl,
  receiptForOperation as receiptForOperationImpl,
} from "./repo-cell-receipts.ts";
import { legacyReviewLint } from "./repo-cell-review-lint.ts";
import { appendAuxiliaryRuntimeIngress as appendAuxiliaryRuntimeIngressImpl } from "./repo-cell-runtime-ingress.ts";
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
  taskSurfaceWrite as taskSurfaceWriteImpl,
} from "./repo-cell-task-command-docs.ts";
import { taskMutation as taskMutationImpl } from "./repo-cell-task-mutation.ts";
import { assertTaskTransitionDocumentReady } from "./transition-document-access.ts";
import {
  createTask as createTaskImpl,
  previewResult as previewResultImpl,
  readResult as readResultImpl,
  upgradePresetSnapshot as upgradePresetSnapshotImpl,
  withHumanSummary as withHumanSummaryImpl,
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
  listRelations as listRelationsImpl,
  listTasks as listTasksImpl,
  reviewTask as reviewTaskImpl,
  taskReadSet as taskReadSetImpl,
  taskWipEnteringAction as taskWipEnteringActionImpl,
  wipSnapshotEntries as wipSnapshotEntriesImpl,
} from "./repo-cell-task-query.ts";
import { graphView as graphViewImpl } from "@harness-anything/application/internal/queries/repo-cell-graph-view.ts";
import {
  listEvents as listEventsImpl,
  showEvent as showEventImpl,
} from "@harness-anything/application/internal/queries/repo-cell-event-query.ts";
import { readAuditExportPage as readAuditExportPageImpl } from "@harness-anything/application/internal/queries/ledger-audit-export.ts";
import { readTaskDeliveryCertificate as readTaskDeliveryCertificateImpl } from "@harness-anything/application/internal/queries/task-delivery-certificate.ts";
import { type PublicPublication, type RepoTaskAction } from "./repo-cell-types.ts";
import type { TaskQueryReadModel } from "./task-query-read.ts";
import type { makeSquadCoordinator } from "./squad-coordinator.ts";
import type {
  EntityActionCatalogRuntimes,
  makeEntityActionCatalogExecutor,
} from "@harness-anything/application/internal/commands/entity-action-catalog-executor.ts";
import type { RuntimeInstanceSummary } from "./agent-runtime-instances.ts";

export function createRepoCellActionContext(bindings: {
  readonly input: {
    readonly repoId: string;
    readonly edgeConfig?: () => import("./client/fleet-edge-config.ts").FleetEdgeConfig | null;
    readonly nodeTaskMaterializationPolicy?: NodeTaskMaterializationPolicy;
    readonly runtimeDaemonRoute?: import("./runtime-spawn.ts").RuntimeDaemonRoute;
    readonly killpoint?: (point: EventPublicationKillpoint) => void;
    readonly shouldStop?: () => boolean;
    readonly runtimeInstances?: () => readonly RuntimeInstanceSummary[];
    readonly runtimeInstanceCapacities?: Readonly<Record<string, number>>;
  };
  readonly rootDir: string;
  readonly now: () => string;
  readonly publicPublication: (value: Pick<CanonicalEventAppendReceipt, "commitSha" | "cut">) => PublicPublication;
  readonly getProjection: () => TaskProjection;
  readonly getStore: () => CanonicalEventStore;
  readonly getEntityActionExecutor: () => ReturnType<typeof makeEntityActionCatalogExecutor>;
  readonly getEntityActionRuntimes: () => EntityActionCatalogRuntimes;
  readonly getService: () => ReturnType<typeof makeTaskLifecycleService>;
  readonly getSettings: () => SettingsV1;
  readonly getRecovery: () => RepoCellCore["recovery"];
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
  const boundProofFor = (
    command: Parameters<typeof proofFor>[0],
    snapshot: Parameters<typeof proofFor>[1],
    binding: Parameters<typeof proofFor>[2],
    projection: Parameters<typeof proofFor>[3],
  ) => proofFor(command, snapshot, binding, projection, bindings.rootDir, bindings.getSettings);
  const layout = resolveHarnessLayout(bindings.rootDir);
  const leafContext = {
    cellCodedError,
    input: bindings.input,
    get projection() {
      return bindings.getProjection();
    },
    get store() {
      return bindings.getStore();
    },
    requiredCellText,
    now: bindings.now,
    operationId,
    rootDir: bindings.rootDir,
    layout,
    rejected,
    get service() {
      return bindings.getService();
    },
    workspaceText,
    buildCommand,
    withServerMeta,
    proofFor: boundProofFor,
    publicPublication: bindings.publicPublication,
    explicitExecutionId,
    projectionReady,
    uniqueDerivedExecutionId,
    receiptProof,
    withoutDryRun,
    legacyReviewLint,
    cellStringList,
    decodeEvidencePayload,
    renderEvidencePayload,
    createTaskId,
    progressEvidence,
    completionApplied,
    completeRetryCommand,
    failed,
    completionSettlement,
    errorOperationId,
    completionStopped,
    assertTaskTransitionDocumentReady,
    get recoveryUncertain() {
      return bindings.getRecoveryUncertain();
    },
    set recoveryUncertain(value: boolean) {
      bindings.setRecoveryUncertain(value);
    },
    get recovery() {
      return bindings.getRecovery();
    },
    get knownTaskIds() {
      return bindings.getKnownTaskIds();
    },
    set knownTaskIds(value: Set<string> | null) {
      bindings.setKnownTaskIds(value);
    },
  };
  const boundProjectedTaskIds: RepoCellActionContext["projectedTaskIds"] = () => projectedTaskIdsImpl(leafContext),
    boundCanonicalSettlement: RepoCellActionContext["canonicalSettlement"] = (receipt, event) =>
      canonicalSettlementImpl(leafContext as unknown as RepoCellActionContext, receipt, event),
    boundProgressReceipt: RepoCellActionContext["progressReceipt"] = (event, publication) =>
      progressReceiptImpl(leafContext as unknown as RepoCellActionContext, event, publication),
    boundLifecycleReceipt: RepoCellActionContext["lifecycleReceipt"] = (event, snapshot, publication, proof) =>
      lifecycleReceipt(leafContext as unknown as RepoCellActionContext, event, snapshot, publication, proof),
    boundPreviewResult: RepoCellActionContext["previewResult"] = (opId, value, revision, command) =>
      previewResultImpl(leafContext as unknown as RepoCellOperationalContext, opId, value, revision, command);
  const settlementContext = {
    cellCodedError,
    input: bindings.input,
    get projection() {
      return bindings.getProjection();
    },
    get store() {
      return bindings.getStore();
    },
    requiredCellText,
    now: bindings.now,
    operationId,
    rootDir: bindings.rootDir,
    layout,
    rejected,
    get service() {
      return bindings.getService();
    },
    workspaceText,
    buildCommand,
    withServerMeta,
    proofFor: boundProofFor,
    publicPublication: bindings.publicPublication,
    explicitExecutionId,
    projectionReady,
    uniqueDerivedExecutionId,
    receiptProof,
    withoutDryRun,
    legacyReviewLint,
    cellStringList,
    decodeEvidencePayload,
    renderEvidencePayload,
    createTaskId,
    progressEvidence,
    completionApplied,
    completeRetryCommand,
    failed,
    completionSettlement,
    errorOperationId,
    completionStopped,
    assertTaskTransitionDocumentReady,
    get recoveryUncertain() {
      return bindings.getRecoveryUncertain();
    },
    set recoveryUncertain(value: boolean) {
      bindings.setRecoveryUncertain(value);
    },
    get recovery() {
      return bindings.getRecovery();
    },
    get knownTaskIds() {
      return bindings.getKnownTaskIds();
    },
    set knownTaskIds(value: Set<string> | null) {
      bindings.setKnownTaskIds(value);
    },
    projectedTaskIds: boundProjectedTaskIds,
    canonicalSettlement: boundCanonicalSettlement,
    progressReceipt: boundProgressReceipt,
    lifecycleReceipt: boundLifecycleReceipt,
    previewResult: boundPreviewResult,
  };
  const boundReceiptForOperation: RepoCellActionContext["receiptForOperation"] = (opId, binding) =>
      receiptForOperationImpl(settlementContext as unknown as RepoCellActionContext, opId, binding),
    boundLifecycleAction: RepoCellActionContext["lifecycleAction"] = (action, binding, carriedReview) =>
      lifecycleActionImpl(settlementContext as unknown as RepoCellOperationalContext, action, binding, carriedReview);

  const context: RepoCellActionContext = {
    cellCodedError,
    input: bindings.input,
    get projection() {
      return bindings.getProjection();
    },
    get store() {
      return bindings.getStore();
    },
    appendAuxiliaryRuntimeIngress: bind(appendAuxiliaryRuntimeIngressImpl),
    requiredCellText,
    now: bindings.now,
    operationId,
    receiptForOperation: boundReceiptForOperation,
    listTasks: bind(listTasksImpl),
    listRelations: bind(listRelationsImpl),
    listEvents: bind(listEventsImpl),
    showEvent: bind(showEventImpl),
    auditExportPage: bind(readAuditExportPageImpl),
    taskDeliveryCertificate: bind(readTaskDeliveryCertificateImpl),
    reviewTask: bind(reviewTaskImpl),
    taskReadSet: bind(taskReadSetImpl),
    graphView: bind(graphViewImpl),
    taskListQueryFromAction: (_action: RepoTaskAction) => unavailableTaskQuery(),
    relationQueryFromAction: (_action: RepoTaskAction) => unavailableTaskQuery(),
    queryRead: (): TaskQueryReadModel => unavailableTaskQuery(),
    publishGeneratedArtifact,
    rootDir: bindings.rootDir,
    layout,
    get entityActionExecutor() {
      return bindings.getEntityActionExecutor();
    },
    get entityActionRuntimes() {
      return bindings.getEntityActionRuntimes();
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
    annotateExecution: bind(annotateExecutionImpl),
    completeTask: bind(completeTaskImpl),
    taskSurfaceWrite: bind(taskSurfaceWriteImpl),
    rejected,
    lifecycleAction: boundLifecycleAction,
    get service() {
      return bindings.getService();
    },
    get squadCoordinator() {
      return bindings.getSquadCoordinator();
    },
    workspaceText,
    buildCommand,
    withServerMeta,
    proofFor: boundProofFor,
    lifecycleReceipt: boundLifecycleReceipt,
    publicPublication: bindings.publicPublication,
    explicitExecutionId,
    projectionReady,
    uniqueDerivedExecutionId,
    receiptProof,
    taskMutation: bind(taskMutationImpl),
    withoutDryRun,
    previewResult: boundPreviewResult,
    projectedTaskIds: boundProjectedTaskIds,
    wipSnapshotEntries: bind(wipSnapshotEntriesImpl),
    legacyReviewLint,
    cellStringList,
    decodeEvidencePayload,
    renderEvidencePayload,
    createTaskId,
    progressReceipt: boundProgressReceipt,
    progressEvidence,
    completionApplied,
    completionContext: bind(completionContextImpl),
    completeRetryCommand,
    failed,
    completionSettlement,
    publishGateWitness: bind(publishGateWitnessImpl),
    errorOperationId,
    completionStopped,
    completionKillpoint: bind(completionKillpointImpl),
    executeAction: (action, binding) => executeActionImpl(context as RepoCellOperationalContext, action, binding),
    withHumanSummary: bind(withHumanSummaryImpl),
    get recoveryUncertain() {
      return bindings.getRecoveryUncertain();
    },
    set recoveryUncertain(value) {
      bindings.setRecoveryUncertain(value);
    },
    get recovery() {
      return bindings.getRecovery();
    },
    canonicalSettlement: boundCanonicalSettlement,
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
