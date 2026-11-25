import { runDossierAction } from "./dossier-actions.ts";
import { prepareOrphanRuntimeLeaseRelease } from "./runtime-orphan-recovery.ts";
import { makeSettingsActionRuntime } from "./settings-action-runtime.ts";
import { storageReadPolicy } from "@harness-anything/kernel/internal/domain/storage-read-policy.ts";
import { runStorageMigrationAction } from "./storage-migration-action.ts";
import { runTodoAction } from "./todo-action.ts";
import { dispatchPeerAction, enforceTaskActionStewardshipFence } from "./peer-action.ts";
import { runTaskWitnessAction } from "@harness-anything/application/internal/commands/task-witness-action.ts";
import { readTaskWitnessRequest } from "./task-witness-request.ts";
import { runRuntimeHandoffAction } from "./runtime-handoff-store.ts";
import { settleTask, submitTask } from "./repo-cell-submit.ts";
import { doctorHealth } from "./repo-cell-doctor.ts";
import { isAgentVersionRead, runAgentVersionRead } from "./agent-version-action.ts";
import { createHash } from "node:crypto";
import path from "node:path";
import {
  compileExecutionExecutorDeclaration,
  compileTaskLifecycleWrite,
  declaredRelationTriples,
  executionExecutorDeclarationCandidates,
  getExecutableEntityAction,
  lifecycleDocumentPaths,
  type AgentRuntimeEventV1,
  requireEntityTypeContract,
  type WriteReceiptDraft as WriteReceipt,
} from "@harness-anything/kernel";
import { runPresetAction } from "@harness-anything/preset";
import { compiledArtifactKinds, resolveEntityReadKind } from "./artifact-entity-action.ts";
import { distillPromotionAction, prepareDistillCandidate, readDistillEntity } from "./distill-actions.ts";
import { runEntityDocumentRematerialize } from "./entity-document-rematerialize.ts";
import { isDocAction, runArtifactAdd, runDocAction } from "./doc-sync-actions.ts";
import { runMigrationImport } from "./migration-import.ts";
import { assertExecutionExecutorDeclarationEligible } from "./repo-cell-execution-selection.ts";
import { runLedgerReconcileAction } from "./repo-cell-migration-actions.ts";
import { type RepoCellBinding, type RepoTaskAction, type Snapshot } from "./repo-cell-types.ts";
import { selectExecutorDeclaration, taskLineageExecutorCandidates } from "./dispatch-read.ts";
import { readCompletionContext } from "./task-completion-read.ts";
import { taskShowFromProjection } from "./repo-cell-completion.ts";
import { dispatchDecisionReview } from "./task-review-dispatch.ts";
import type { RepoCellOperationalContext } from "./repo-cell-types.ts";
import { runFactAction } from "./repo-cell-fact-action.ts";
import { deriveActionResult } from "@harness-anything/application/internal/commands/entity-action-catalog-executor.ts";
import type { TaskCommandWithDocsAction } from "./repo-cell-task-command-docs.ts";
import { runVerticalDeclarationAction } from "./vertical-declaration-action.ts";
import { attestGateWitness } from "./repo-cell-witness-adapters.ts";
import { projectedTaskWriteRefusal } from "./projection-readiness.ts";
import { applyTaskWorktreeLifecycle, taskWorktreeInput } from "./task-worktree.ts";
import { runEntityPinAction } from "@harness-anything/application/internal/commands/entity-pin-action.ts";
import { runIncidentDismissAction } from "./runtime-incident-dismiss-action.ts";
import { readWork } from "@harness-anything/application/internal/queries/work-read.ts";
import { runAssignmentMigrationAction } from "@harness-anything/application/internal/commands/assignment-migration-action.ts";
import { readVerticalKindAction } from "./vertical-kind-read.ts";
import {
  parseRulingArtifact,
  runtimeRulingPath,
  runtimeRulingResolutionPath,
} from "../runtime-engine/runtime-ruling.ts";
import { squadRulingResumeNext } from "./squad-ruling-resume.ts";
import { dispatchLifecyclePendingError } from "./runtime-dispatch-admission.ts";
import { commitRuntimeSessionAction } from "./runtime-session-action-runtime.ts";
import { readCanonicalRuntimeResult } from "./runtime-result-read.ts";

export async function executeAction(
  cell: RepoCellOperationalContext,
  action: RepoTaskAction,
  binding: RepoCellBinding,
): Promise<WriteReceipt> {
  return applyTaskWorktreeLifecycle(taskWorktreeInput(cell), action, binding.source, () =>
    Promise.resolve(executeRepoAction(cell, action, binding)),
  );
}

function runRepoArtifactAdd(cell: RepoCellOperationalContext, action: RepoTaskAction, binding: RepoCellBinding) {
  return runArtifactAdd({
    action,
    binding,
    workspaceId: cell.input.repoId,
    rootDir: cell.rootDir,
    store: cell.store,
    projection: cell.projection,
    now: cell.now,
    killpoint: cell.input.killpoint,
  });
}

export function executeRepoAction(
  cell: RepoCellOperationalContext,
  action: RepoTaskAction,
  binding: RepoCellBinding,
): WriteReceipt | Promise<WriteReceipt> {
  validateCanonicalIdentityInputs(cell, action);
  if (["dossier-status", "dossier-context", "dossier-synthesize"].includes(action.kind))
    return runDossierAction(cell, action, binding);
  // doc sync has one writer: publishing a DocEventIntent. Its catalog binding (document/*) names the
  // stream for Policy and explanations, never a second compile path, so it stays ahead of the generic
  // catalog runtime below.
  if (isDocAction(action.kind))
    return runDocAction({
      action,
      binding,
      workspaceId: cell.input.repoId,
      rootDir: cell.rootDir,
      store: cell.store,
      projection: cell.projection,
      nodeTaskMaterializationPolicy: cell.input.nodeTaskMaterializationPolicy,
      now: cell.now,
      killpoint: cell.input.killpoint,
    });
  if (["runtime-handoff-export", "runtime-handoff-claim", "runtime-handoff-revoke"].includes(action.kind))
    return runRuntimeHandoffAction(cell, action, binding);
  if (
    [
      "vertical-declaration-migrate",
      "vertical-kind-upsert",
      "vertical-kind-publish-schema",
      "vertical-kind-retire",
    ].includes(action.kind)
  )
    return runVerticalDeclarationAction({
      action,
      binding,
      rootDir: cell.rootDir,
      verticalId: cell.settings.readRepository().defaultVertical,
      store: cell.store,
      projection: cell.projection,
      now: cell.now,
    });
  if (action.kind === "migrate-import")
    return runMigrationImport({
      action,
      binding,
      rootDir: cell.rootDir,
      store: cell.store,
      projection: cell.projection,
      now: cell.now,
      ...(cell.input.shouldStop ? { shouldStop: cell.input.shouldStop } : {}),
    });
  if (action.kind === "assignment-migrate") return runAssignmentMigrationAction(cell, action, binding);
  if (action.kind === "projection-rebuild") {
    // A rebuild re-derives the projection from the events that already exist; it never creates one.
    // Minting here would let any actor holding this action's `repo-write`/`contributor` policy write
    // repository Settings around the principal-only gate that guards `settings-update`, and the
    // receipt would not disclose it. Settings are minted only by `settings-update`.
    const rebuilt = cell.projection.rebuild(),
      sourceRevision = cell.store.readHead()?.revision ?? 0,
      opId = cell.operationId(action, binding, cell.input.repoId, sourceRevision),
      visible = rebuilt.watermark === sourceRevision,
      evidence = JSON.stringify({
        watermark: rebuilt.watermark,
        sourceRevision,
        stateDigest: rebuilt.stateDigest,
        metrics: rebuilt.metrics,
        relationCycleAudit: rebuilt.relationCycleAudit,
      }),
      proof = {
        committedRevision: sourceRevision,
        appliedCut: rebuilt.watermark,
        durable: true,
        canonicalVisible: visible,
        worktreeVisible: null,
      };
    return visible
      ? {
          outcome: "applied",
          opId,
          revision: sourceRevision,
          evidence,
          visibility: "center",
          proof,
        }
      : {
          outcome: "pending",
          opId,
          revision: sourceRevision,
          evidence,
          visibility: "center",
          proof,
        };
  }
  if (action.kind === "vertical-kind-list" || action.kind === "vertical-kind-show")
    return readVerticalKindAction(cell, action, binding);
  if (["migrate-storage"].includes(action.kind)) return runStorageMigrationAction(cell, action, binding);
  if (action.kind === "ledger-reconcile") return runLedgerReconcileAction(cell, action, binding);
  if (action.kind === "entity-pin" || action.kind === "entity-unpin") return runEntityPinAction(cell, action, binding);
  if (action.kind === "runtime-incident-dismiss") return runIncidentDismissAction(cell, action, binding);
  if (action.kind === "receipt-show") {
    const opId = String(action.opId ?? "");
    return cell.receiptForOperation(opId, binding);
  }
  if (action.kind === "task-show")
    return taskShowFromProjection(
      cell.rootDir,
      cell.projection,
      String(action.taskId ?? ""),
      undefined,
      binding.actor,
      cell.input.nodeTaskMaterializationPolicy,
    );
  if (action.kind === "task-list") return cell.listTasks(action, binding);
  if (action.kind === "work-list" || action.kind === "work-show") return readWork(cell, action, binding);
  if (action.kind === "relation-list") return cell.listRelations(action, binding);
  if (action.kind === "event-list") return cell.listEvents(action, binding);
  if (action.kind === "event-show") return cell.showEvent(action, binding);
  if (action.kind === "ledger-audit-export") return cell.auditExportPage(action, binding);
  if (action.kind === "task-delivery-certificate") return cell.taskDeliveryCertificate(action, binding);
  if (action.kind === "relation-triples") {
    const revision = cell.projection.readCut().sourceRevision,
      rows = declaredRelationTriples({
        ...(typeof action.sourceKind === "string" ? { sourceKind: action.sourceKind } : {}),
        ...(typeof action.targetKind === "string" ? { targetKind: action.targetKind } : {}),
      });
    return cell.readResult(
      cell.operationId(action, binding, cell.input.repoId, revision),
      { rows, count: rows.length },
      revision,
      null,
    );
  }
  if (action.kind === "task-read-set") return cell.taskReadSet(action, binding);
  if (action.kind === "graph") return cell.graphView(action, binding);
  if (action.kind === "trace") return cell.traceView(action, binding);
  if (action.kind === "task-review") return cell.reviewTask(action, binding);
  if (action.kind === "decision-dispatch-review") return dispatchDecisionReview(cell, action, binding);
  if (
    action.kind === "decision-rematerialize" ||
    action.kind === "fact-rematerialize" ||
    action.kind === "task-rematerialize"
  )
    return runEntityDocumentRematerialize(cell, action, binding);
  if (action.kind === "distill-candidate") {
    const taskId = cell.requiredCellText(action.taskId, "taskId");
    if (!cell.projection.read(taskId).snapshot.task)
      throw cell.cellCodedError("entity_not_found", `Task ${taskId} does not exist.`);
    const revision = cell.store.readHead()?.revision ?? 0,
      candidate = prepareDistillCandidate({
        rootDir: cell.rootDir,
        action,
        opId: cell.operationId(action, binding, cell.input.repoId, revision),
        revision,
        now: cell.now,
        readEntity: (entityRef) => readDistillEntity(cell.projection, entityRef),
      });
    cell.publishGeneratedArtifact(candidate);
    return candidate.receipt;
  }
  if (action.kind === "distill-promote") {
    const promoted = distillPromotionAction(cell.rootDir, action);
    return cell.entityActionExecutor.run(
      promoted,
      binding,
      cell.operationId(
        action,
        binding,
        cell.input.repoId,
        cell.projection.read(cell.requiredCellText(action.taskId, "taskId")).snapshot.revision,
      ),
    );
  }
  if (["entity-import", "entity-update", "entity-archive", "entity-delete"].includes(action.kind))
    return cell.entityActionExecutor.run(
      action,
      binding,
      cell.operationId(
        action,
        binding,
        cell.input.repoId,
        Number(action.expectedVersion ?? cell.store.readHead()?.revision ?? 0),
      ),
    );
  // Progress has a legacy writer that owns its operation id and document adjudication. Keep that
  // single route when the declaration is catalog-bound so catalog admission does not hash twice or
  // bypass carried document claims.
  enforceTaskActionStewardshipFence(cell, action, binding);
  if (action.kind === "task-submit") return submitTask(cell, action, binding);
  if (Array.isArray(action.docChanges))
    return cell.runTaskCommandWithDocs(action as TaskCommandWithDocsAction, binding);
  if (action.kind === "task-progress-append") return cell.appendProgress(action, binding);
  const actionContract = getExecutableEntityAction(action.kind);
  if (actionContract?.target.kind === "todo" && actionContract.execution) {
    const sourceRevision = actionContract.execution.read
      ? cell.projection.readCut().sourceRevision
      : (cell.store.readHead()?.revision ?? 0);
    return cell.entityActionExecutor.run(
      action,
      binding,
      cell.operationId(action, binding, cell.input.repoId, sourceRevision),
      { entity: { todo: (_contract, intent, actor, opId) => runTodoAction(cell, intent, actor, opId) } },
    );
  }
  if (actionContract?.target.kind === "peer-request" && actionContract.execution) {
    const sourceRevision = actionContract.execution.read
      ? cell.projection.readCut().sourceRevision
      : (cell.store.readHead()?.revision ?? 0);
    if (action.kind === "peer-takeover") {
      return prepareOrphanRuntimeLeaseRelease(cell, action, binding).then((preparedBinding) =>
        dispatchPeerAction(cell, action, preparedBinding, sourceRevision),
      );
    }
    return dispatchPeerAction(cell, action, binding, sourceRevision);
  }
  if (actionContract?.target.kind === "task" && actionContract.execution) {
    if (action.kind === "task-create") {
      const entering = cell.taskWipEnteringAction(action);
      if (entering) cell.assertTaskWipCapacity(entering.taskId, entering.nextStatus);
      return cell.createTask(cell.taskCreateAction(cell.rootDir, action), binding);
    }
    const targetIdField = actionContract.execution.targetIdField ?? "taskId",
      targetId =
        typeof action[targetIdField] === "string" && action[targetIdField] ? String(action[targetIdField]) : null,
      targetRevision = targetId
        ? (action.kind === "task-contract-migrate"
            ? cell.projection.readForTaskContractMigration(targetId)
            : cell.projection.read(targetId)
          ).snapshot.revision
        : (cell.store.readHead()?.revision ?? 0),
      lifecycle = actionContract.execution.lifecycle;
    if (lifecycle?.coordination === "reserve" && targetId) cell.assertTaskWipCapacity(targetId, "active");
    return cell.entityActionExecutor.run(
      action,
      binding,
      cell.operationId(action, binding, cell.input.repoId, targetRevision),
      {
        ...cell.entityActionRuntimes,
        task: async (contract, catalogAction, catalogBinding) => {
          if (catalogAction.kind === "task-escalate") return runTaskEscalation(cell, catalogAction, catalogBinding);
          if (catalogAction.kind === "task-escalation-resolve")
            return resolveTaskEscalation(cell, catalogAction, catalogBinding);
          if (catalogAction.kind === "task-submit") return submitTask(cell, catalogAction, catalogBinding);
          if (catalogAction.kind === "task-release")
            catalogBinding = await prepareOrphanRuntimeLeaseRelease(cell, catalogAction, catalogBinding);
          if (Array.isArray(catalogAction.docChanges))
            return cell.runTaskCommandWithDocs(catalogAction as TaskCommandWithDocsAction, catalogBinding);
          if (catalogAction.kind === "preset-upgrade") return cell.upgradePresetSnapshot(catalogAction, catalogBinding);
          if (catalogAction.kind === "task-artifact-add")
            return runRepoArtifactAdd(cell, catalogAction, catalogBinding);
          if (catalogAction.kind === "task-settle") return settleTask(cell, catalogAction, catalogBinding);
          if (catalogAction.kind === "task-progress-append") return cell.appendProgress(catalogAction, catalogBinding);
          if (catalogAction.kind === "task-annotate") return cell.annotateExecution(catalogAction, catalogBinding);
          if (catalogAction.kind === "task-attest") return attestGateWitness(cell, catalogAction, catalogBinding);
          if (catalogAction.kind === "task-witness-run") {
            const request = {
                taskId: cell.requiredCellText(catalogAction.taskId, "taskId"),
                executionId: cell.requiredCellText(catalogAction.executionId, "executionId"),
                gateId: cell.requiredCellText(catalogAction.gateId, "gateId"),
              },
              read = readTaskWitnessRequest(cell, request);
            return {
              outcome: "no_changes",
              opId: cell.operationId(catalogAction, catalogBinding, cell.input.repoId, read.snapshot.revision),
              revision: read.snapshot.revision,
              witness: read.result,
            };
          }
          if (catalogAction.kind === "task-declare-executor")
            return cell.declareExecutionExecutor(catalogAction, catalogBinding);
          if (contract.execution?.implementation === "catalog-runtime") {
            if (catalogAction.kind.startsWith("task-witness-"))
              return runTaskWitnessAction(cell, catalogAction, catalogBinding);
            if (catalogAction.kind === "task-contract-migrate")
              return cell.migrateTaskContracts(catalogAction, catalogBinding);
            if (
              catalogAction.kind === "task-archive" &&
              (Array.isArray(catalogAction.taskIds) || typeof catalogAction.filter === "string")
            )
              return cell.archiveTasks(catalogAction, catalogBinding);
            if (catalogAction.kind === "task-supersede" && typeof catalogAction.title === "string")
              return cell.supersedeWithNewTask(catalogAction, catalogBinding);
            return cell.taskSurfaceWrite(catalogAction, catalogBinding);
          }
          return contract.execution?.implementation === "task-completion"
            ? cell.completeTask(catalogAction, catalogBinding)
            : cell.lifecycleAction(catalogAction, catalogBinding);
        },
      },
    );
  }
  if (actionContract?.target.kind === "relation" && actionContract.execution)
    return cell.entityActionExecutor.run(
      action,
      binding,
      cell.operationId(action, binding, cell.input.repoId, Number(action.expectedVersion ?? 0)),
    );
  if (action.kind.startsWith("fact-")) return runFactAction(cell, action, binding);
  if (action.kind.startsWith("decision-")) {
    const resolved = cell.decisionProposalAction(cell.rootDir, action, () => cell.settings.read());
    return cell.entityActionExecutor.run(
      resolved,
      binding,
      cell.operationId(
        resolved,
        binding,
        cell.input.repoId,
        resolved.kind === "decision-reckon" ? (cell.store.readHead()?.revision ?? 0) : 0,
      ),
    );
  }
  if (actionContract?.execution)
    return cell.entityActionExecutor.run(
      action,
      binding,
      cell.operationId(
        action,
        binding,
        cell.input.repoId,
        actionContract.execution.read
          ? cell.projection.readCut().sourceRevision
          : Number(action.expectedVersion ?? cell.store.readHead()?.revision ?? 0),
      ),
      actionContract.target.kind === "settings"
        ? { entity: { settings: makeSettingsActionRuntime(cell, cell.settings) } }
        : cell.entityActionRuntimes,
    );
  if (action.kind === "preset-upgrade") return cell.upgradePresetSnapshot(action, binding);
  if (/^entity-(?:get|list)$/u.test(action.kind)) {
    const revision = cell.projection.readCut().sourceRevision,
      requestedKind = cell.requiredCellText(action.entityKind, "entityKind"),
      kind = resolveEntityReadKind(requestedKind, compiledArtifactKinds(cell.projection, cell.input.repoId));
    if (action.kind === "entity-list")
      return cell.readResult(
        cell.operationId(action, binding, cell.input.repoId, revision),
        { schema: "entity-list/v1", kind, entities: cell.projection.listEntities(kind) },
        revision,
        null,
      );
    const entityId = cell.requiredCellText(action.entityId, "entityId"),
      entity = cell.projection.getEntity(kind, entityId);
    if (entity === null) throw cell.cellCodedError("entity_not_found", `Entity ${kind}/${entityId} is not installed.`);
    const result = { schema: "entity-get/v1", kind, entity };
    return cell.readResult(cell.operationId(action, binding, cell.input.repoId, revision), result, revision, null);
  }
  if (
    action.kind.startsWith("preset-") ||
    /^(?:vertical-(?:list|init|validate|simulate)|template-(?:list|render)|script-(?:list|inspect))$/u.test(action.kind)
  ) {
    // Execution credentials scope their reads to the dispatched repository (dec_9DFDC635180975FDFC0CDB33D7):
    // a caller-supplied validator source resolving outside the repository root would turn the
    // catalog validators into an arbitrary file read. path.resolve accepts ../ and absolute paths,
    // so the bound is checked here, where the repository root is known.
    const source =
      action.kind === "vertical-validate" || action.kind === "vertical-simulate"
        ? action.verticalSource
        : action.kind === "preset-validate"
          ? action.packageSource
          : undefined;
    if (binding.executionPrincipal && typeof source === "string") {
      const resolved = path.resolve(cell.rootDir, source);
      if (resolved !== cell.rootDir && !resolved.startsWith(`${cell.rootDir}${path.sep}`))
        throw cell.cellCodedError(
          "execution_credential_rejected",
          "Validator sources must stay inside the dispatched repository.",
        );
    }
    return runPresetAction({
      rootDir: cell.rootDir,
      action,
      settings: cell.settings.read(),
    }).then((result) => {
      const revision = cell.store.readHead()?.revision ?? 0,
        opId = cell.operationId(action, binding, cell.input.repoId, revision),
        // Install, seed, uninstall, and scaffold writes mutate local/repository declaration files, never the ledger:
        // a finished write carries no committed proof and settles as a determinate no-write; only a dry run stays a preview.
        preview =
          action.dryRun === true &&
          ["preset-init", "preset-install", "preset-seed", "preset-uninstall", "vertical-init"].includes(action.kind);
      if (!preview) {
        const cut = cell.projection.readCut(),
          base = { opId, revision, evidence: JSON.stringify(result), visibility: "center" as const };
        return cut.status === "ready"
          ? { outcome: "applied", ...base }
          : {
              outcome: "pending",
              ...base,
              proof: {
                committedRevision: revision,
                appliedCut: cut.watermark,
                durable: false,
                canonicalVisible: false,
                worktreeVisible: null,
              },
            };
      }
      return {
        outcome: "pending",
        opId,
        revision,
        evidence: JSON.stringify(result),
        visibility: "center",
        proof: {
          committedRevision: revision,
          appliedCut: cell.projection.readCut().watermark,
          durable: false,
          canonicalVisible: false,
          worktreeVisible: false,
        },
      };
    });
  }
  if (action.kind === "task-artifact-add") return runRepoArtifactAdd(cell, action, binding);
  if (action.kind === "task-settle") return settleTask(cell, action, binding);
  if (
    Array.isArray(
      (
        action as {
          readonly docChanges?: unknown;
        }
      ).docChanges,
    )
  )
    return cell.runTaskCommandWithDocs(action as TaskCommandWithDocsAction, binding);
  if (action.kind === "task-submit") return submitTask(cell, action, binding);
  if (action.kind === "doctor-health") return doctorHealth(cell, action, binding);
  if (isAgentVersionRead(action.kind)) return runAgentVersionRead(cell, action, binding);
  if (action.kind === "task-progress-append") return cell.appendProgress(action, binding);
  if (action.kind === "task-annotate") return cell.annotateExecution(action, binding);
  if (action.kind === "task-attest") return attestGateWitness(cell, action, binding);
  if (action.kind === "task-declare-executor") return cell.declareExecutionExecutor(action, binding);
  return cell.lifecycleAction(action, binding);
}

async function runTaskEscalation(
  cell: RepoCellOperationalContext,
  action: RepoTaskAction,
  binding: RepoCellBinding,
): Promise<WriteReceipt> {
  const principal = binding.executionPrincipal,
    taskId = cell.requiredCellText(action.taskId, "taskId"),
    dispatchId = principal?.dispatchId,
    question = cell.requiredCellText(action.question, "question"),
    options = Array.isArray(action.options)
      ? action.options
          .filter((value): value is string => typeof value === "string" && value.trim() !== "")
          .map((value) => value.trim())
      : [],
    recommendation = typeof action.recommendation === "string" ? action.recommendation.trim() : "",
    reason = typeof action.reason === "string" ? action.reason.trim() : "";
  if (principal?.role !== "implementation" || principal.taskId !== taskId || !dispatchId)
    throw cell.cellCodedError(
      "execution_credential_rejected",
      "Escalation requires the implementation credential for this task dispatch.",
    );
  const expectedDispatch = /^dispatch_[a-f0-9]{24}$/u.test(dispatchId);
  if (!expectedDispatch)
    throw cell.cellCodedError("invalid_escalation", "The dispatch credential has no valid dispatch id.");
  const body = JSON.stringify(
    {
      schema: "worker-escalation/v1",
      status: "awaiting",
      taskId,
      dispatchId,
      executionId: principal.executionId,
      question,
      options,
      ...(recommendation ? { recommendation } : {}),
      ...(reason ? { reason } : {}),
      createdAt: cell.now(),
    },
    null,
    2,
  );
  const artifact = await runRepoArtifactAdd(
    cell,
    { kind: "task-artifact-add", taskId, content: body, destination: `rulings/${dispatchId}.md` },
    binding,
  );
  // A center-forwarded edge action cannot cancel through the center's local spawner: the runtime
  // owner is the edge node. The edge RPC route performs the owner-local cancel after this artifact
  // is durably accepted. Local dispatches still stop through their resident spawner here.
  const remoteOwner = typeof binding.source === "object" && binding.source !== null && binding.source.kind === "node",
    cancel = remoteOwner
      ? null
      : await cell.runtimeSpawner.cancel({ runtimeSessionId: principal.runtimeSessionId, escalation: true }, binding);
  return {
    ...artifact,
    evidence: JSON.stringify({
      escalation: JSON.parse(body),
      artifact: artifact.evidence ?? null,
      cancel,
      ...(remoteOwner ? { cancelOwner: "edge" } : {}),
    }),
  };
}

async function resolveTaskEscalation(
  cell: RepoCellOperationalContext,
  action: RepoTaskAction,
  binding: RepoCellBinding,
): Promise<WriteReceipt> {
  const taskId = cell.requiredCellText(action.taskId, "taskId"),
    dispatchId = cell.requiredCellText(action.dispatchId, "dispatchId"),
    answer = cell.requiredCellText(action.answer, "answer"),
    task = cell.projection.read(taskId),
    packagePath = task.packagePath;
  if (!packagePath) throw cell.cellCodedError("task_not_found", `Task ${taskId} is not ready.`);
  const dispatch = cell.projection.readRuntimeDispatchById(dispatchId)?.event;
  if (dispatch?.payload.taskId !== taskId)
    throw cell.cellCodedError(
      "invalid_escalation_resolution",
      `Dispatch ${dispatchId} does not belong to Task ${taskId}.`,
    );
  const lifecycle = cell.projection.readDispatchLifecycle({ by: "dispatch", dispatchIds: [dispatchId] });
  if (lifecycle.status !== "ready") throw dispatchLifecyclePendingError(lifecycle, cell.cellCodedError);
  const attempt = lifecycle.rows[0];
  const path = `${packagePath}/${runtimeRulingPath(dispatchId)}`,
    rulingDocument = cell.projection.readDocument(path).document,
    existing = rulingDocument?.body ?? null;
  if (rulingDocument === undefined || rulingDocument === null)
    throw cell.cellCodedError("entity_not_found", `Escalation ${dispatchId} was not found for Task ${taskId}.`);
  const ruling = parseRulingArtifact(existing ?? "", path),
    resolutionPath = `${packagePath}/${runtimeRulingResolutionPath(dispatchId)}`;
  if (ruling?.kind === "valid" && ruling.dispatchId !== undefined) {
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(existing ?? "") as Record<string, unknown>;
    } catch {
      throw cell.cellCodedError("invalid_escalation_resolution", `Escalation ${dispatchId} is not structured.`);
    }
    if (parsed.taskId !== taskId || parsed.dispatchId !== dispatchId || parsed.status !== "awaiting")
      throw cell.cellCodedError(
        "invalid_escalation_resolution",
        `Escalation ${dispatchId} is not awaiting for Task ${taskId}.`,
      );
  }
  const existingResolution = cell.projection.readDocument(resolutionPath).document,
    existingResolutionBody = existingResolution?.body ?? null;
  const resolutionOpId = `escalation-resolved-${dispatchId}`,
    accepted = cell.store.readEvent(resolutionOpId),
    completing =
      accepted?.schema === "agent-runtime-event/v1" &&
      accepted.type === "runtime_session_outcome_observed" &&
      accepted.payload.runtimeSessionId === dispatch.payload.runtimeSessionId &&
      accepted.payload.reasonCode === "ruling_resolved";
  // canResolveRuling owns waiting admission. An already accepted resolution instead resumes
  // its unfinished Task transition; it must still pass the immutable answer check below.
  if (!attempt?.policy.canResolveRuling && !(completing && existingResolution))
    throw cell.cellCodedError("invalid_escalation_resolution", `Task ${taskId} is not waiting for an owner ruling.`);
  let artifact: WriteReceipt | null = null;
  if (existingResolution !== undefined && existingResolution !== null) {
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(existingResolutionBody ?? "") as Record<string, unknown>;
    } catch {
      throw cell.cellCodedError(
        "invalid_escalation_resolution",
        `Escalation ${dispatchId} has an invalid answer record.`,
      );
    }
    if (
      parsed.schema !== "worker-escalation-resolution/v1" ||
      parsed.dispatchId !== dispatchId ||
      parsed.taskId !== taskId ||
      parsed.answer !== answer
    )
      throw cell.cellCodedError("invalid_escalation_resolution", `Escalation ${dispatchId} has already been answered.`);
  } else {
    const updated = JSON.stringify(
      { schema: "worker-escalation-resolution/v1", dispatchId, taskId, answer, answeredAt: cell.now() },
      null,
      2,
    );
    artifact = await runRepoArtifactAdd(
      cell,
      {
        kind: "task-artifact-add",
        taskId,
        content: updated,
        destination: `rulings/${runtimeRulingResolutionPath(dispatchId).slice("artifacts/rulings/".length)}`,
      },
      binding,
    );
    if (artifact.outcome !== "applied") return artifact;
  }
  const terminal = cell.projection
      .readRuntimeSessionEventsByType(dispatch.payload.runtimeSessionId, ["runtime_session_outcome_observed"])
      .findLast(
        (event): event is Extract<AgentRuntimeEventV1, { type: "runtime_session_outcome_observed" }> =>
          event.type === "runtime_session_outcome_observed",
      )!,
    resolved = completing
      ? cell.receiptForOperation(resolutionOpId, binding)
      : await commitRuntimeSessionAction(
          cell,
          {
            kind: "event",
            type: "runtime_session_outcome_observed",
            opId: resolutionOpId,
            payload: {
              ...terminal.payload,
              dispatchId,
              reasonCode: "ruling_resolved",
            },
            resultBody: readCanonicalRuntimeResult(cell.store, terminal.payload.resultRef),
          },
          { ...binding, source: dispatch.source },
        );
  if (resolved.outcome !== "applied") return resolved;
  // A later explicit Task transition supersedes restoration, and a Task that is already out of
  // `blocked` (e.g. manually unblocked/started before answering an old escalation) must never be
  // forced back to `planned`. Replaying an old answer must also not reopen a newer owner block;
  // the indexed latest transition is bounded to this Task.
  const transitionType = "task_transitioned",
    laterTransition =
      completing &&
      cell.store.queryEvents!({
        type: transitionType,
        entity: `task/${taskId}`,
        limit: storageReadPolicy.defaultValue.pageSizes.one,
      })[0],
    alreadyUnblocked = task.snapshot.task?.status !== "blocked",
    rawTransitioned =
      (laterTransition && laterTransition.workspaceRevision > accepted.workspaceRevision) || alreadyUnblocked
        ? resolved
        : await cell.lifecycleAction(
            { kind: "task-transition", taskId, status: "planned", reason: `Owner answered escalation ${dispatchId}.` },
            binding,
          ),
    // A nested task-transition rejection carries criteria from task.transition (such as
    // lifecycle-status/explainStatusTransition) that task.escalation-resolve does not declare.
    // Strip foreign unmetCriteria so settlement returns a structured op_rejected receipt instead
    // of throwing invalid_store (data-shape) and tripping the repo cell into unavailable.
    transitioned =
      rawTransitioned.outcome === "op_rejected" ? { ...rawTransitioned, unmetCriteria: [] } : rawTransitioned,
    escalatedDispatch = cell.projection.readRuntimeDispatchById(dispatchId)?.event,
    // A leader turn owns its ruling. The answered task is planned, but its old execution is
    // consumed: the run can only continue as a new Squad run under the execution `ha task start`
    // opens next, so the receipt names that continuation instead of leaving the operator to bridge
    // it by hand.
    squadResume =
      transitioned.outcome === "op_rejected"
        ? null
        : squadRulingResumeNext({
            runs: cell.projection.readSquadRuns(),
            dispatchId,
            runtimeInstanceId:
              escalatedDispatch?.type === "runtime_dispatch_requested" ? escalatedDispatch.payload.instanceId : null,
          }),
    next = Array.isArray(transitioned.next) ? transitioned.next : [];
  return {
    ...transitioned,
    ...(squadResume === null ? {} : { next: [...next, squadResume] }),
    evidence: JSON.stringify({ answer, dispatchId, artifact: artifact?.evidence ?? null, retried: artifact === null }),
  };
}

export function executeRepoReadAction(
  cell: RepoCellOperationalContext,
  action: RepoTaskAction,
  binding: RepoCellBinding,
): WriteReceipt | Promise<WriteReceipt> {
  try {
    return executeRepoAction(cell, action, binding);
  } catch (error) {
    const contract = getExecutableEntityAction(action.kind),
      receipt = cell.failed(
        cell.errorOperationId(error) ?? cell.operationId(action, binding, cell.input.repoId, 0),
        error,
        contract,
        contract ? action : undefined,
      );
    return contract ? deriveActionResult(contract, action, receipt) : receipt;
  }
}

export function validateCanonicalIdentityInputs(cell: RepoCellOperationalContext, action: RepoTaskAction): void {
  const fields = [
    ["taskId", "task"],
    ["executionId", "execution"],
    ["reviewId", "review"],
  ] as const;
  for (const [field, kind] of fields) {
    const value = action[field];
    if (typeof value !== "string" || value.length === 0) continue;
    const identity = requireEntityTypeContract(kind).id,
      pattern = identity.refPattern ?? identity.pattern;
    if (!new RegExp(`(?:${pattern})`, "u").test(value))
      throw cell.cellCodedError("invalid_field", `${field} must match the canonical ${kind} identifier pattern.`);
  }
}

export function declareExecutionExecutor(
  cell: RepoCellOperationalContext,
  action: RepoTaskAction,
  binding: RepoCellBinding,
): WriteReceipt {
  const taskId = cell.requiredCellText(action.taskId, "taskId"),
    reason = cell.requiredCellText(action.reason, "reason"),
    current = cell.projection.read(taskId),
    snapshot = current.snapshot,
    requestedExecutionId = cell.explicitExecutionId(action);
  if (!cell.projectionReady(current) || !snapshot.task)
    throw projectedTaskWriteRefusal(
      cell.projection,
      current,
      taskId,
      { repoId: cell.input.repoId, rootDir: cell.rootDir },
      cell.cellCodedError(
        "content_not_ready",
        [
          "Task ",
          `${taskId}`,
          " is not ready for executor declaration; run ha daemon projection ",
          "rebuild, then retry ha task declare-executor ",
          `${taskId}`,
          " --execution-id ",
          `${requestedExecutionId ?? "<execution-id>"}`,
          " --reason <reason>.",
        ].join(""),
      ),
    );
  const candidates = executionExecutorDeclarationCandidates(snapshot, taskId, binding.actor),
    executionId =
      requestedExecutionId ??
      cell.uniqueDerivedExecutionId(
        candidates,
        "Eligible executor-declaration execution",
        [
          `Run ha task show ${taskId}; unblock the Task if needed, then retry when`,
          "one submitted review-node execution with no executor is eligible.",
        ].join(" "),
        (candidate: string) => `ha task declare-executor ${taskId} --execution-id ${candidate} --reason <reason>`,
      );
  const dispatchProof = dispatchedExecutor(cell, action, taskId, executionId, snapshot, candidates);
  assertExecutionExecutorDeclarationEligible(snapshot, taskId, executionId, candidates);
  const canonicalAction = { ...action, agent: dispatchProof.executor.id },
    opId = cell.operationId(canonicalAction, binding, cell.input.repoId, snapshot.revision),
    existing = cell.store.readEvent(opId);
  if (existing) return cell.receiptForOperation(opId, binding);
  const declaration = compileExecutionExecutorDeclaration({
      snapshot,
      taskId,
      executionId,
      actor: binding.actor,
      executor: dispatchProof.executor,
      ...(dispatchProof.dispatchTaskId === undefined ? {} : { dispatchTaskId: dispatchProof.dispatchTaskId }),
      source: binding.source,
      reason,
      opId,
      eventId: `event-${createHash("sha256").update(opId).digest("hex")}`,
      workspaceRevision: (cell.store.readHead()?.revision ?? 0) + 1,
      occurredAt: cell.now(),
    }),
    paths = current.packagePath ? lifecycleDocumentPaths(declaration.event, current.packagePath) : [],
    compiled = compileTaskLifecycleWrite({
      event: declaration.event,
      snapshot: declaration.snapshot,
      packagePath: current.packagePath,
      currentDocuments: paths.flatMap((target) => {
        const document =
          cell.projection.readDocument(target).document ?? cell.projection.readDocumentHistory?.(target).document;
        return document ? [document] : [];
      }),
      completionContext: readCompletionContext(
        cell.projection,
        taskId,
        declaration.snapshot,
        current.status,
        cell.rootDir,
      ),
    }),
    appended = cell.store.append(compiled),
    publication = cell.publicPublication(appended);
  cell.projection.apply(compiled.event, compiled.plan);
  return cell.lifecycleReceipt(
    compiled.event,
    cell.projection.read(taskId).snapshot,
    publication,
    cell.receiptProof(compiled.event, publication),
  );
}

function dispatchedExecutor(
  cell: RepoCellOperationalContext,
  action: RepoTaskAction,
  taskId: string,
  executionId: string,
  snapshot: Snapshot,
  declarationCandidates: readonly { readonly executionId: string }[],
): {
  readonly executor: { readonly kind: "agent"; readonly id: string };
  readonly dispatchTaskId?: string;
} {
  const requested = action.agent === undefined ? undefined : cell.requiredCellText(action.agent, "agent"),
    lineage = taskLineageExecutorCandidates({
      projection: cell.projection,
      taskId,
      executionId,
    }),
    selection = selectExecutorDeclaration({
      requested,
      exact: lineage.exact,
      fallback: lineage.fallback,
      reviewerIdentities: lineage.reviewerIdentities,
    });
  if (selection.kind === "replay")
    return {
      executor: { kind: "agent", id: selection.candidate.executorId },
      dispatchTaskId: selection.candidate.dispatchTaskId,
    };
  if (selection.kind === "external") {
    assertExecutionExecutorDeclarationEligible(snapshot, taskId, executionId, declarationCandidates);
    // Out-of-ledger work has no dispatch to replay: the caller's explicit agent id and the reason
    // are the attribution record, written through the same declaration event as a replayed dispatch.
    return { executor: { kind: "agent", id: selection.executorId } };
  }
  if (selection.kind === "reviewer-alias")
    throw cell.cellCodedError(
      "invalid_proof",
      `--agent ${selection.requested} is a reviewer identity on this lineage; reviewer sessions never carry ` +
        "executor attribution. Name the authoring agent that performed the work.",
    );
  if (selection.kind === "owner-declaration-required") {
    assertExecutionExecutorDeclarationEligible(snapshot, taskId, executionId, declarationCandidates);
    throw cell.cellCodedError(
      "invalid_proof",
      `Task ${taskId} has no authoring dispatch to replay. Declare the agent that performed the work with ` +
        `ha task declare-executor ${taskId} --execution-id ${executionId} --agent <agent-id> ` +
        "--reason <auditable-recovery-reason>; reviewer sessions never carry executor attribution.",
    );
  }
  if (selection.requested !== undefined)
    throw cell.cellCodedError(
      "invalid_proof",
      `--agent ${selection.requested} does not name exactly one dispatch for execution ${executionId}. ` +
        `Choose ${selection.choices.join(" or ")} from ha task dispatches ${taskId}.`,
    );
  throw cell.cellCodedError(
    "invalid_command",
    `Execution ${executionId} has multiple dispatched executors. Choose one explicitly with ${selection.choices
      .map(
        (agent) =>
          `ha task declare-executor ${taskId} --execution-id ${executionId} --agent ${agent} --reason <reason>`,
      )
      .join(" or ")}.`,
  );
}
