import { createHash } from "node:crypto";
import {
  compileExecutionExecutorDeclaration,
  compileTaskLifecycleWrite,
  createEntityStore,
  eventShapeMigrations,
  executionExecutorDeclarationCandidates,
  getExecutableEntityAction,
  isLedgerLayoutMigrationEvent,
  lifecycleDocumentPaths,
  type WriteReceiptDraft as WriteReceipt,
} from "../../kernel/src/index.ts";
import { runPresetAction } from "../../preset/src/index.ts";
import { runAgentEntityAction } from "./agent-entities.ts";
import { distillPromotionAction, prepareDistillCandidate } from "./distill-actions.ts";
import { isDocAction, runArtifactAdd, runDocAction } from "./doc-sync-actions.ts";
import { runMigrationImport } from "./migration-import.ts";
import { runFactRekey } from "./fact-rekey.ts";
import { runDispatchRecordMigrationAction, runEventShapeMigrationAction } from "./repo-cell-migration-actions.ts";
import { runSquadEntityMigration } from "./squad-entity-migration.ts";
import { type RepoCellBinding, type RepoTaskAction } from "./repo-cell-types.ts";
import { pullAndIngestCiObservations } from "./ci-observation-actions.ts";
import { readTaskLineageDispatches } from "./dispatch-read.ts";
import type { RepoCellOperationalContext } from "./repo-cell-action-context.ts";
import { runFactAction } from "./repo-cell-fact-action.ts";
import type { TaskCommandWithDocsAction } from "./repo-cell-task-command-docs.ts";

export async function executeAction(
  cell: RepoCellOperationalContext,
  action: RepoTaskAction,
  binding: RepoCellBinding,
): Promise<WriteReceipt> {
  if (action.kind === "ci-observe-pull") return pullAndIngestCiObservations(cell, action, binding);
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
  if (action.kind === "fact-rekey") {
    if (action.dryRun !== true) await cell.store.settlePendingMaterialization?.("fact rekey");
    return runFactRekey({
      action,
      binding,
      rootDir: cell.rootDir,
      store: cell.store,
      projection: cell.projection,
      now: cell.now,
    });
  }
  if (action.kind === "relation-events-migrate" || action.kind === "decision-digests-migrate")
    return runEventShapeMigrationAction(cell, eventShapeMigrations[action.kind], action, binding);
  if (action.kind === "dispatch-records-migrate") return runDispatchRecordMigrationAction(cell, action, binding);
  if (action.kind === "entity-migrate-squads") return runSquadEntityMigration(cell, action, binding);
  if (action.kind === "projection-rebuild") {
    cell.settings.initializeFromAuthoredDocument(binding);
    const rebuilt = cell.projection.rebuild(),
      sourceRevision = cell.store.readHead()?.revision ?? 0,
      opId = cell.operationId(action, binding, cell.input.repoId, sourceRevision),
      visible = rebuilt.watermark === sourceRevision,
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
          evidence: JSON.stringify({
            watermark: rebuilt.watermark,
            sourceRevision,
            stateDigest: rebuilt.stateDigest,
            metrics: rebuilt.metrics,
          }),
          visibility: "center",
          proof,
        }
      : {
          outcome: "pending",
          opId,
          revision: sourceRevision,
          evidence: JSON.stringify({
            watermark: rebuilt.watermark,
            sourceRevision,
            stateDigest: rebuilt.stateDigest,
            metrics: rebuilt.metrics,
          }),
          visibility: "center",
          proof,
          nextAction: `Retry projection rebuild after the canonical source settles at revision ${sourceRevision}.`,
        };
  }
  if (action.kind === "ledger-migrate") {
    await cell.store.settlePendingMaterialization?.("layout migration");
    const appended = cell.store.migrateLayout({
      actor: binding.actor,
      source: binding.source,
      occurredAt: cell.now(),
    });
    if (!isLedgerLayoutMigrationEvent(appended.event))
      throw cell.cellCodedError("invalid_store", "Ledger migration returned the wrong event type.");
    cell.projection.catchUp?.();
    const projected = cell.projection.list(),
      visible = projected.watermark === appended.revision && projected.sourceRevision === appended.revision,
      proof = {
        committedRevision: appended.revision,
        appliedCut: projected.watermark,
        durable: true,
        canonicalVisible: visible,
        worktreeVisible: true,
      },
      receipt = {
        opId: appended.event.opId,
        revision: appended.revision,
        evidence: JSON.stringify({
          ...appended.event.payload,
          commitSha: appended.commitSha?.sha ?? null,
          projection: {
            status: projected.status,
            watermark: projected.watermark,
            sourceRevision: projected.sourceRevision,
          },
        }),
        visibility: "center" as const,
        proof,
        commitSha: appended.commitSha?.sha ?? null,
        cut: appended.cut,
        worktreeVisible: true,
      };
    return visible
      ? ({ outcome: "applied", ...receipt } as WriteReceipt)
      : ({
          outcome: "pending",
          ...receipt,
          nextAction: [
            "Retry after the task projection catches up from revision ",
            `${projected.watermark}`,
            " to ",
            `${projected.sourceRevision}`,
            ".",
          ].join(""),
        } as WriteReceipt);
  }
  if (action.kind === "receipt-show") {
    const opId = String(action.opId ?? "");
    // A provably absent operation can be answered from the durable read model.
    // Do not let unrelated recovery WAL mask that negative receipt.
    if (cell.store.readEvent(opId) !== null) await cell.store.settleRecoveryMaterialization?.();
    return cell.receiptForOperation(opId, binding);
  }
  if (action.kind === "task-show") return cell.showTask(String(action.taskId ?? ""));
  if (action.kind === "task-list") return cell.listTasks(action, binding);
  if (action.kind === "relation-list") return cell.listRelations(action, binding);
  if (action.kind === "task-review") return cell.reviewTask(action, binding);
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
  if (action.kind === "entity-import" || action.kind === "entity-migrate-adrs")
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
  const actionContract = getExecutableEntityAction(action.kind);
  if (actionContract?.target.kind === "task" && actionContract.execution) {
    const targetIdField = actionContract.execution.targetIdField ?? "taskId",
      targetId =
        typeof action[targetIdField] === "string" && action[targetIdField] ? String(action[targetIdField]) : null,
      targetRevision = targetId
        ? cell.projection.read(targetId).snapshot.revision
        : (cell.store.readHead()?.revision ?? 0),
      lifecycle = actionContract.execution.lifecycle,
      leasedStart =
        lifecycle?.coordination === "reserve" &&
        targetId !== null &&
        ["held", "reserving"].includes(cell.projection.currentLease(targetId, cell.now())?.phase ?? "");
    if (lifecycle?.coordination === "reserve" && targetId && !leasedStart)
      cell.assertTaskWipCapacity(targetId, "active");
    return cell.entityActionExecutor.run(
      action,
      binding,
      cell.operationId(action, binding, cell.input.repoId, targetRevision),
      {
        ...cell.entityActionRuntimes,
        task: async (contract, catalogAction, catalogBinding) => {
          if (Array.isArray(catalogAction.docChanges))
            return cell.runTaskCommandWithDocs(catalogAction as TaskCommandWithDocsAction, catalogBinding);
          if (contract.execution?.implementation === "catalog-runtime") {
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
    const resolved = cell.decisionProposalAction(cell.rootDir, action);
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
  const actionVersion = Number(action.expectedVersion ?? cell.store.readHead()?.revision ?? 0);
  if (actionContract?.execution && (!actionContract.execution.read || actionContract.target.kind !== "agent"))
    return cell.entityActionExecutor.run(
      action,
      binding,
      cell.operationId(action, binding, cell.input.repoId, actionVersion),
      cell.entityActionRuntimes,
    );
  if (action.kind === "preset-upgrade") return cell.upgradePresetSnapshot(action, binding);
  if (/^entity-(?:get|list)$/u.test(action.kind)) {
    const revision = cell.store.readHead()?.revision ?? 0,
      kind = cell.requiredCellText(action.entityKind, "entityKind");
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
    actionContract?.execution?.read &&
    (actionContract.target.kind === "agent" || actionContract.target.kind === "squad") &&
    ["list", "inspect", "validate"].includes(actionContract.id)
  ) {
    const revision = cell.store.readHead()?.revision ?? 0,
      result = runAgentEntityAction({
        rootDir: cell.rootDir,
        entityStore: createEntityStore(cell.store),
        action,
        runtimeInstances: cell.input.runtimeInstances?.(),
      });
    return cell.readResult(
      cell.operationId(action, binding, cell.input.repoId, revision),
      result as object,
      revision,
      null,
    );
  }
  if (
    action.kind.startsWith("preset-") ||
    /^(?:vertical-validate|template-(?:list|render)|script-(?:list|inspect))$/u.test(action.kind)
  ) {
    const result = await runPresetAction({
        rootDir: cell.rootDir,
        action,
        settings: cell.settings.read(),
      }),
      revision = cell.store.readHead()?.revision ?? 0,
      opId = cell.operationId(action, binding, cell.input.repoId, revision),
      localWrite = ["preset-install", "preset-seed", "preset-uninstall"].includes(action.kind);
    if (!localWrite) {
      const cut = cell.projection.list(),
        canonicalVisible = cut.status === "ready",
        base = {
          opId,
          revision,
          evidence: JSON.stringify(result),
          visibility: "center" as const,
          proof: {
            committedRevision: revision,
            appliedCut: cut.watermark,
            durable: canonicalVisible,
            canonicalVisible,
            worktreeVisible: null,
          },
        };
      return canonicalVisible
        ? { outcome: "applied", ...base }
        : {
            outcome: "pending",
            ...base,
            nextAction: [
              "Retry after the task projection catches up from revision ",
              `${cut.watermark}`,
              " to ",
              `${cut.sourceRevision}`,
              ".",
            ].join(""),
          };
    }
    const durable = action.dryRun !== true;
    return {
      outcome: "pending",
      opId,
      revision,
      evidence: JSON.stringify(result),
      visibility: "center",
      proof: {
        committedRevision: revision,
        appliedCut: cell.projection.list().watermark,
        durable,
        canonicalVisible: false,
        worktreeVisible: durable,
      },
      nextAction: durable
        ? "This local preset write has no canonical event; do not treat it as canonical settlement."
        : "Remove --dry-run to perform the local preset write; it will remain non-canonical.",
    };
  }
  const entering = cell.taskWipEnteringAction(action);
  if (entering) cell.assertTaskWipCapacity(entering.taskId, entering.nextStatus);
  if (action.kind === "task-create") return cell.createTask(cell.taskCreateAction(cell.rootDir, action), binding);
  if (isDocAction(action.kind))
    return runDocAction({
      action,
      binding,
      workspaceId: cell.input.repoId,
      rootDir: cell.rootDir,
      store: cell.store,
      projection: cell.projection,
      now: cell.now,
      killpoint: cell.input.killpoint,
    });
  if (action.kind === "task-artifact-add")
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
  if (action.kind === "task-progress-append") return cell.appendProgress(action, binding);
  if (action.kind === "task-declare-executor") return cell.declareExecutionExecutor(action, binding);
  if (action.kind === "task-closeout") return cell.closeoutTask(action, binding);
  return cell.lifecycleAction(action, binding);
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
    throw cell.cellCodedError(
      "content_not_ready",
      [
        "Task ",
        `${taskId}`,
        " is not ready for executor declaration; run ha daemon projection ",
        "rebuild, then retry ha task declare-executor ",
        `${taskId}`,
        " --execution-id ",
        `${requestedExecutionId ?? "<execution-id>"}`,
        " --agent <dispatch-agent>",
        " --reason <reason>.",
      ].join(""),
    );
  const executionId =
      requestedExecutionId ??
      cell.uniqueDerivedExecutionId(
        executionExecutorDeclarationCandidates(snapshot, taskId, binding.actor),
        "Eligible executor-declaration execution",
        [
          `Run ha task show ${taskId}; unblock the Task if needed, then retry when`,
          "one submitted review-node execution with no executor is eligible.",
        ].join(" "),
        (candidate: string) =>
          `ha task declare-executor ${taskId} --execution-id ${candidate} --agent <dispatch-agent> --reason <reason>`,
      ),
    dispatchProof = dispatchedExecutor(cell, action, taskId, executionId),
    canonicalAction = { ...action, agent: dispatchProof.executor.id },
    opId = cell.operationId(canonicalAction, binding, cell.input.repoId, snapshot.revision),
    existing = cell.store.readEvent(opId);
  if (existing) return cell.receiptForOperation(opId, binding);
  const declaration = compileExecutionExecutorDeclaration({
      snapshot,
      taskId,
      executionId,
      actor: binding.actor,
      executor: dispatchProof.executor,
      dispatchTaskId: dispatchProof.dispatchTaskId,
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
        const document = cell.projection.readDocument(target).document;
        return document ? [document] : [];
      }),
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
): {
  readonly executor: { readonly kind: "agent"; readonly id: string };
  readonly dispatchTaskId: string;
} {
  const requested = action.agent === undefined ? undefined : cell.requiredCellText(action.agent, "agent"),
    rows = readTaskLineageDispatches({ rootDir: cell.rootDir, projection: cell.projection, taskId }),
    exactRows = rows.filter((dispatch) => dispatch.executionId === executionId),
    eligibleRows = exactRows.length ? exactRows : rows,
    candidates = [
      ...new Map(
        eligibleRows.map((dispatch) => [
          dispatch.runtimeSessionId,
          {
            runtimeSessionId: dispatch.runtimeSessionId,
            executorId: `runtime-session:${dispatch.runtimeSessionId}`,
            agentId: dispatch.agentId,
            dispatchTaskId: dispatch.taskId,
          },
        ]),
      ).values(),
    ],
    matches = requested
      ? candidates.filter(
          (candidate) =>
            requested === candidate.executorId ||
            requested === candidate.runtimeSessionId ||
            requested === candidate.agentId,
        )
      : candidates;
  if (matches.length === 1)
    return {
      executor: { kind: "agent", id: matches[0]!.executorId },
      dispatchTaskId: matches[0]!.dispatchTaskId,
    };
  const choices = candidates.map((candidate) => candidate.executorId);
  if (candidates.length === 0)
    throw cell.cellCodedError(
      "invalid_proof",
      `Task ${taskId} has no recorded runtime dispatch on itself or its parent chain. ` +
        `Run ha task dispatches ${taskId}; ` +
        "executor declaration remains unavailable until a real dispatch record exists.",
    );
  if (requested)
    throw cell.cellCodedError(
      "invalid_proof",
      `--agent ${requested} does not name exactly one dispatch for execution ${executionId}. ` +
        `Choose ${choices.join(" or ")} from ha task dispatches ${taskId}.`,
    );
  throw cell.cellCodedError(
    "invalid_command",
    `Execution ${executionId} has multiple dispatched executors. Choose one explicitly with ${choices
      .map(
        (agent) =>
          `ha task declare-executor ${taskId} --execution-id ${executionId} --agent ${agent} --reason <reason>`,
      )
      .join(" or ")}.`,
  );
}
