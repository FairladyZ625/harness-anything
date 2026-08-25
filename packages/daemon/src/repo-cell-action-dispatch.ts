import { createHash } from "node:crypto";
import { runTaskCloseoutAction } from "../../application/src/task-closeout-action.ts";
import {
  closeoutReadiness,
  compileExecutionExecutorDeclaration,
  compileTaskLifecycleWrite,
  createEntityStore,
  explainEntityKind,
  executionExecutorDeclarationCandidates,
  findTaskLifecycleTransition,
  isLedgerLayoutMigrationEvent,
  lifecycleDocumentPaths,
  requireEntityActionContractByTransition,
  type WriteReceipt,
} from "../../kernel/src/index.ts";
import { runPresetAction } from "../../preset/src/index.ts";
import { prepareAgentEntityInstall, runAgentEntityAction } from "./agent-entities.ts";
import { distillPromotionAction, prepareDistillCandidate } from "./distill-actions.ts";
import { isDocAction, runArtifactAdd, runDocAction } from "./doc-sync-actions.ts";
import { runMigrationImport } from "./migration-import.ts";
import { coordinateAction, executeActionCoordination } from "./action-coordination.ts";
import type { RepoCellBinding, RepoTaskAction, Snapshot } from "./repo-cell-types.ts";

export async function executeAction(
  cell: any,
  action: RepoTaskAction,
  binding: RepoCellBinding,
): Promise<WriteReceipt> {
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
  if (action.kind === "projection-rebuild") {
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
    const appended = cell.store.migrateLayout({
      actor: binding.actor,
      source: binding.source,
      occurredAt: cell.now(),
    });
    if (!isLedgerLayoutMigrationEvent(appended.event))
      throw cell.cellCodedError("invalid_store", "Ledger migration returned the wrong event type.");
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
  if (action.kind === "receipt-show") return cell.receiptForOperation(String(action.opId ?? ""), binding);
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
    return cell.factActions.run(
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
  if (action.kind.startsWith("fact-"))
    return cell.factActions.run(
      action,
      binding,
      cell.operationId(
        action,
        binding,
        cell.input.repoId,
        action.kind === "fact-record" && typeof action.taskId === "string"
          ? cell.projection.read(action.taskId).snapshot.revision
          : (cell.store.readHead()?.revision ?? 0),
      ),
    );
  if (action.kind.startsWith("decision-")) {
    const resolved = cell.decisionProposalAction(cell.rootDir, action);
    return cell.decisionActions.run(
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
  if (action.kind === "preset-upgrade") return cell.upgradePresetSnapshot(action, binding);
  if (/^entity-(?:explain|get|list)$/u.test(action.kind)) {
    const revision = cell.store.readHead()?.revision ?? 0,
      kind = cell.requiredCellText(action.entityKind, "entityKind"),
      entities = createEntityStore(cell.store);
    if (action.kind === "entity-explain")
      return cell.readResult(
        cell.operationId(action, binding, cell.input.repoId, revision),
        explainEntityKind(kind),
        revision,
        null,
      );
    if (action.kind === "entity-list")
      return cell.readResult(
        cell.operationId(action, binding, cell.input.repoId, revision),
        { schema: "entity-list/v1", kind, entities: entities.list(kind) },
        revision,
        null,
      );
    const entityId = cell.requiredCellText(action.entityId, "entityId"),
      entity = entities.get(kind, entityId);
    if (entity === null) throw cell.cellCodedError("entity_not_found", `Entity ${kind}/${entityId} is not installed.`);
    const result = { schema: "entity-get/v1", kind, entity };
    return cell.readResult(cell.operationId(action, binding, cell.input.repoId, revision), result, revision, null);
  }
  if (/^(?:agent|squad)-install$/u.test(action.kind)) {
    const prepared = prepareAgentEntityInstall({
      rootDir: cell.rootDir,
      action,
      entityStore: createEntityStore(cell.store),
      runtimeInstances: cell.input.runtimeInstances?.(),
    });
    return cell.upsertEntity(action, binding, {
      entityKind: prepared.kind,
      entity: prepared.declaration,
      report: prepared.report,
    });
  }
  if (/^(?:agent|squad)-(?:list|inspect|validate)$/u.test(action.kind)) {
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
    const result = await runPresetAction({ rootDir: cell.rootDir, action }),
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
    return cell.taskWriteKind(action.kind)
      ? cell.lifecycleAction(action, binding)
      : cell.runTaskCommandWithDocs(action as RepoTaskAction & { readonly docChanges: readonly any[] }, binding);
  if (action.kind === "task-progress-append") return cell.appendProgress(action, binding);
  if (action.kind === "task-contract-migrate") return cell.migrateTaskContracts(action, binding);
  if (action.kind === "task-archive" && (Array.isArray(action.taskIds) || typeof action.filter === "string"))
    return cell.archiveTasks(action, binding);
  if (action.kind === "task-supersede" && typeof action.title === "string")
    return cell.supersedeWithNewTask(action, binding);
  if (action.kind === "task-declare-executor") return cell.declareExecutionExecutor(action, binding);
  if (action.kind === "task-closeout") return cell.closeoutTask(action, binding);
  if (action.kind === "task-complete") return cell.completeTask(action, binding);
  if (cell.taskSurfaceWriteKind(action.kind)) return cell.taskSurfaceWrite(action, binding);
  if (!cell.taskWriteKind(action.kind))
    return cell.rejected(
      cell.operationId(action, binding, cell.input.repoId, 0),
      "unsupported_command",
      "No domain contract exists for this write command; run the leaf --help and select a supported repair command.",
    );
  return cell.lifecycleAction(action, binding);
}

export async function closeoutTask(cell: any, action: RepoTaskAction, binding: RepoCellBinding): Promise<WriteReceipt> {
  const taskId = cell.requiredCellText(action.taskId, "taskId"),
    initial = await cell.service.read(taskId),
    opId = cell.operationId(action, binding, cell.input.repoId, initial.snapshot.revision);
  return runTaskCloseoutAction({
    rootDir: cell.rootDir,
    action,
    caller: binding.actor,
    opId,
    readWorkspaceText: cell.workspaceText,
    read: async () =>
      (await cell.service.read(taskId)).snapshot as Parameters<typeof closeoutReadiness>[0] & {
        readonly revision: number;
        readonly task: NonNullable<Snapshot["task"]>;
        readonly lease: Snapshot["lease"];
      },
    invoke: async (stage, leaf, actor) => {
      const leafBinding = { ...binding, actor },
        leafAction = leaf as RepoTaskAction;
      if (stage === "task-show") return cell.showTask(taskId);
      if (stage === "complete") return cell.completeTask(leafAction, leafBinding);
      return cell.lifecycleAction(leafAction, leafBinding);
    },
  });
}

export async function lifecycleAction(
  cell: any,
  action: RepoTaskAction,
  binding: RepoCellBinding,
): Promise<WriteReceipt> {
  const taskId = cell.requiredCellText(action.taskId, "taskId"),
    current = await cell.service.read(taskId),
    expectedRevision = current.snapshot.revision;
  const normalized = cell.buildCommand(
    action,
    taskId,
    binding,
    cell.input.repoId,
    expectedRevision,
    cell.rootDir,
    current.snapshot,
  );
  const command = cell.withServerMeta(
    normalized,
    cell.store.readTaskEvent(normalized.opId),
    cell.store.readHead()?.revision ?? 0,
    cell.now(),
  );
  const execute = async (): Promise<WriteReceipt> => {
    if (
      Array.isArray(
        (
          action as {
            readonly docChanges?: unknown;
          }
        ).docChanges,
      )
    )
      return cell.runTaskCommandWithDocs(action as RepoTaskAction & { readonly docChanges: readonly any[] }, binding);
    const authorityProof = await cell.proofFor(command, current.snapshot, binding, cell.projection),
      result = await cell.service.execute(command, authorityProof);
    if (result.outcome === "applied" && result.event && result.proof)
      return cell.lifecycleReceipt(
        result.event,
        result.snapshot,
        cell.publicPublication(cell.store.publication(result.event)),
        result.proof,
        authorityProof.authorizationDecision ?? null,
      );
    if (result.outcome === "pending")
      return {
        outcome: "pending",
        opId: command.opId,
        revision: result.revision,
        evidence: result.evidence,
        visibility: result.visibility,
        proof: result.proof,
        nextAction: result.nextAction ?? "Retry receipt show.",
      };
    return cell.rejected(
      command.opId,
      result.code ?? "publication_unknown",
      result.nextAction ?? "Retry receipt show before resubmitting.",
    );
  };
  const transition = findTaskLifecycleTransition(command, current.snapshot);
  if (!transition) return execute();
  const declaration = requireEntityActionContractByTransition("task", transition.id);
  const coordination = coordinateAction(declaration.coordination, { dryRunRequested: action.dryRun === true });
  return executeActionCoordination(coordination, {
    admitWip: (nextStatus) => cell.assertTaskWipCapacity(command.taskId, nextStatus),
    preview: () => cell.previewStart(action, binding),
    execute,
  });
}

export function declareExecutionExecutor(cell: any, action: RepoTaskAction, binding: RepoCellBinding): WriteReceipt {
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
        (candidate: string) => `ha task declare-executor ${taskId} --execution-id ${candidate} --reason <reason>`,
      ),
    opId = cell.operationId(action, binding, cell.input.repoId, snapshot.revision),
    existing = cell.store.readEvent(opId);
  if (existing) return cell.receiptForOperation(opId, binding);
  const declaration = compileExecutionExecutorDeclaration({
      snapshot,
      taskId,
      executionId,
      actor: binding.actor,
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
