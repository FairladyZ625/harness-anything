import { createHash } from "node:crypto";
import {
  compileRelationCreatedEvent,
  compileRelationDocumentWrite,
  deriveRelationId,
  sessionProvenance,
  taskBootstrapWritePlan,
  type CanonicalWriteBundle,
  type WriteReceiptDraft as WriteReceipt,
  type TaskMetadataV1,
} from "@harness-anything/kernel";
import { compileRepoPresetSnapshotUpgrade, compileRepoTaskBootstrap } from "@harness-anything/preset";
import type { PublicPublication, RepoCellBinding, RepoTaskAction, TaskCreateReceipt } from "./repo-cell-types.ts";
import { resolveWriteSessionIdentity } from "./session-identity/index.ts";
import type { RepoCellOperationalContext } from "./repo-cell-action-context.ts";
import { receiptLayoutRoots, taskCreateGuidance, workspaceRelativePath } from "./receipt-guidance.ts";
import { workReceiptLine } from "./work-read.ts";
import { relationDocumentUpdates } from "./entity-action-relation.ts";
import { relationDirectionRegistry } from "./artifact-entity-action.ts";
import { taskDecisionGuidance } from "@harness-anything/preset/internal/preset-command-contract";

export function readResult(
  cell: RepoCellOperationalContext,
  opId: string,
  value: object,
  revision: number,
  worktreeVisible: boolean | null,
  projectedCut?: { readonly status: "ready" | "pending"; readonly watermark: number; readonly sourceRevision: number },
): WriteReceipt {
  const cut = projectedCut ?? cell.projection.readCut(),
    ready = cut.status === "ready",
    base = {
      opId,
      revision,
      evidence: JSON.stringify({
        ...value,
        status: cut.status,
        watermark: cut.watermark,
        sourceRevision: cut.sourceRevision,
      }),
      visibility: "center" as const,
      proof: {
        committedRevision: revision,
        appliedCut: cut.watermark,
        durable: true,
        canonicalVisible: ready,
        worktreeVisible,
      },
    };
  return ready
    ? { outcome: "applied", ...base }
    : {
        outcome: "pending",
        ...base,
      };
}

export function previewResult(
  cell: RepoCellOperationalContext,
  opId: string,
  value: object,
  revision: number,
  command: string,
): WriteReceipt {
  const cut = cell.projection.readCut();
  return {
    outcome: "pending",
    opId,
    revision,
    evidence: JSON.stringify({
      ...value,
      status: cut.status,
      watermark: cut.watermark,
      sourceRevision: cut.sourceRevision,
    }),
    visibility: "center",
    proof: {
      committedRevision: revision,
      appliedCut: cut.watermark,
      durable: false,
      canonicalVisible: false,
      worktreeVisible: false,
    },
    guidance: [{ kind: "remove-dry-run", args: { command } }],
  };
}

export function withHumanSummary(cell: RepoCellOperationalContext, receipt: WriteReceipt): WriteReceipt {
  const existing = (receipt as { readonly summary?: unknown }).summary,
    payload =
      typeof existing === "string" || typeof receipt.evidence !== "string"
        ? undefined
        : cell.decodeEvidencePayload(receipt.evidence),
    lines = [
      typeof existing === "string" ? existing : payload === undefined ? null : cell.renderEvidencePayload(payload),
      // An edge answer says how current it is, and warns when it may be stale.
      ...(receipt.freshness
        ? [
            `freshness=${receipt.freshness.state}  confirmedAt=${receipt.freshness.confirmedAt ?? "never"}`,
            ...(receipt.warnings ?? []),
          ]
        : []),
    ].filter((line): line is string => line !== null);
  return lines.length === 0 || (typeof existing === "string" && lines.length === 1)
    ? receipt
    : ({ ...receipt, summary: lines.join("\n") } as WriteReceipt);
}

export function createTask(
  cell: RepoCellOperationalContext,
  action: RepoTaskAction,
  binding: RepoCellBinding,
): WriteReceipt {
  const prepared = prepareTaskCreateAt(cell, action, binding);
  if (!("compiled" in prepared)) return prepared;
  const appended = cell.store.append(
    prepared.relation === undefined ? prepared.compiled : { ...prepared.relation, preceding: [prepared.compiled] },
  );
  // Append has accepted this exact operation. Later publication/receipt failures cannot reject it.
  try {
    const publication = cell.publicPublication(appended);
    applyPreparedTaskCreate(cell, prepared);
    cell.input.killpoint?.("after_store_commit");
    const receipt = preparedTaskCreateReceipt(cell, prepared, publication);
    cell.input.killpoint?.("before_response_write");
    cell.input.killpoint?.("after_response_write");
    return receipt;
  } catch (error) {
    throw Object.assign(
      cell.cellCodedError("publication_indeterminate", error instanceof Error ? error.message : String(error)),
      { opId: prepared.compiled.event.opId, cause: error },
    );
  }
}

type PreparedTaskCreateFields = Pick<
  TaskCreateReceipt,
  | "taskId"
  | "taskStatus"
  | "packagePath"
  | "generatedPaths"
  | "presetDigest"
  | "scaffoldDigest"
  | "presetId"
  | "profileId"
  | "outputShape"
  | "completionGates"
  | "dryRun"
>;

export interface PreparedTaskCreate {
  readonly compiled: ReturnType<typeof compileRepoTaskBootstrap> & {
    readonly plan: ReturnType<typeof taskBootstrapWritePlan>;
  };
  readonly relation?: CanonicalWriteBundle;
  readonly fields: PreparedTaskCreateFields;
}

export function prepareTaskCreateAt(
  cell: RepoCellOperationalContext,
  action: RepoTaskAction,
  binding: RepoCellBinding,
  assigned?: { readonly workspaceRevision: number },
): WriteReceipt | PreparedTaskCreate {
  const dryRun = action.dryRun === true,
    canonicalAction = cell.withoutDryRun(action),
    canonicalOpId = cell.operationId(canonicalAction, binding, cell.input.repoId, 0),
    opId = dryRun ? `preview:${createHash("sha256").update(canonicalOpId).digest("hex")}` : canonicalOpId,
    existing = dryRun ? null : cell.store.readEvent(opId);
  if (existing) {
    return cell.receiptForOperation(opId, binding);
  }
  if (
    canonicalAction.profileId === "lightweight" &&
    !["migration", "import"].includes(String(canonicalAction.createMode ?? ""))
  )
    throw cell.cellCodedError(
      "invalid_field",
      "The lightweight profile is selected automatically for low-risk tasks when the preset provides it; choose --risk-tier low instead.",
    );
  const idempotent =
    !dryRun && typeof canonicalAction.idempotencyKey === "string"
      ? cell.projection.readTaskByIdempotencyKey(canonicalAction.idempotencyKey)
      : null;
  if (idempotent) {
    const current = cell.projection.read(idempotent.taskId);
    return {
      ...cell.readResult(
        opId,
        {
          reused: true,
          taskId: idempotent.taskId,
          idempotencyKey: canonicalAction.idempotencyKey,
        },
        current.sourceRevision,
        true,
      ),
      outcome: "no_changes",
      taskId: idempotent.taskId,
      taskStatus: idempotent.status as TaskCreateReceipt["taskStatus"],
      packagePath: idempotent.packagePath,
      summary: `reused task ${idempotent.taskId} for the supplied idempotency key${
        current.snapshot.task ? workReceiptLine(cell.projection, current.snapshot.task) : ""
      }`,
    } as WriteReceipt;
  }
  const decisionTarget = taskDecisionTarget(cell, canonicalAction);
  const taskId = cell.createTaskId(canonicalAction, binding, cell.input.repoId);
  if (cell.projection.readTaskExists(taskId)) return cell.rejected(opId, "task_exists");
  if (typeof canonicalAction.parentTaskId === "string" && !cell.projection.readTaskExists(canonicalAction.parentTaskId))
    return cell.rejected(opId, "parent_not_found");
  const parent =
      typeof canonicalAction.parentTaskId === "string" ? cell.projection.read(canonicalAction.parentTaskId) : undefined,
    parentMetadata = parent?.snapshot.task?.metadata,
    parentContract = parent?.packagePath
      ? cell.projection.readDocument(`${parent.packagePath}/task-contract.json`).document
      : null,
    parentContractBody = parentContract ? (JSON.parse(parentContract.body) as Record<string, unknown>) : null,
    parentLocale = typeof parentContractBody?.locale === "string" ? parentContractBody.locale : undefined;
  // A subtask inherits the parent's vertical and locale context; its preset/profile resolve
  // from repository defaults or explicit flags, never from the parent's own preset identity.
  // The operation id stays keyed on the caller's literal action rather than the derived fields.
  const createInput =
    parentMetadata === undefined
      ? { ...canonicalAction, riskTier: canonicalAction.riskTier ?? "medium" }
      : {
          ...canonicalAction,
          verticalId: canonicalAction.verticalId ?? parentMetadata.verticalId,
          locale: canonicalAction.locale ?? parentLocale,
          riskTier: canonicalAction.riskTier ?? "medium",
        };
  const currentRevision = cell.store.readHead()?.revision ?? 0,
    workspaceRevision = assigned?.workspaceRevision ?? currentRevision + 1,
    eventId = `event-${createHash("sha256").update(opId).digest("hex")}`,
    occurredAt = cell.now(),
    riskTierFlowVersion = ["migration", "import"].includes(String(canonicalAction.createMode ?? "")) ? null : 1;
  let baseCompiled: ReturnType<typeof compileRepoTaskBootstrap>;
  try {
    baseCompiled = compileRepoTaskBootstrap({
      rootDir: cell.rootDir,
      settings: cell.settings.read(),
      action: createInput,
      taskId,
      actor: binding.actor,
      source: binding.source,
      workspaceRevision,
      eventId,
      opId,
      occurredAt,
      riskTierFlowVersion,
    });
    if (
      canonicalAction.riskTier === "low" &&
      canonicalAction.profileId === undefined &&
      baseCompiled.lightweightPresetIds.includes(baseCompiled.snapshot.identity.id) &&
      baseCompiled.snapshot.profile.id !== "lightweight"
    )
      baseCompiled = compileRepoTaskBootstrap({
        rootDir: cell.rootDir,
        settings: cell.settings.read(),
        action: { ...createInput, profileId: "lightweight" },
        taskId,
        actor: binding.actor,
        source: binding.source,
        workspaceRevision,
        eventId,
        opId,
        occurredAt,
        riskTierFlowVersion,
      });
    else if (
      canonicalAction.riskTier !== "low" &&
      canonicalAction.profileId === undefined &&
      baseCompiled.snapshot.profile.id === "lightweight"
    ) {
      const profileId = baseCompiled.defaultNonLightweightProfileId;
      if (profileId === null)
        throw cell.cellCodedError(
          "invalid_field",
          `Preset ${baseCompiled.snapshot.identity.id} declares only the lightweight profile; medium and high tasks require a non-lightweight default profile.`,
        );
      baseCompiled = compileRepoTaskBootstrap({
        rootDir: cell.rootDir,
        settings: cell.settings.read(),
        action: { ...createInput, profileId },
        taskId,
        actor: binding.actor,
        source: binding.source,
        workspaceRevision,
        eventId,
        opId,
        occurredAt,
        riskTierFlowVersion,
      });
    }
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "plan_placeholder") {
      const source = typeof action.planFile === "string" ? action.planFile : "the supplied plan body";
      Object.assign(error, {
        diagnostic: {
          kind: "validation",
          entity: "task create",
          field: typeof action.planFile === "string" ? "planFile" : "plan",
          actual: source,
          expectation: `Edit ${source}, then rerun ha task create with the same inputs; no task was created. ${error.message}`,
        },
      });
    }
    throw error;
  }
  const event = {
      ...baseCompiled.event,
      payload: {
        ...baseCompiled.event.payload,
        task: {
          ...baseCompiled.event.payload.task,
          metadata: {
            ...(baseCompiled.event.payload.task.metadata as TaskMetadataV1),
            ...(!["migration", "import"].includes(String(canonicalAction.createMode ?? ""))
              ? { riskTierFlowVersion: 1 as const }
              : {}),
          },
          provenance: [sessionProvenance(resolveWriteSessionIdentity(binding, cell.projection), occurredAt)],
        },
      },
    },
    compiled = {
      ...baseCompiled,
      event,
      plan: taskBootstrapWritePlan(event),
    },
    relation =
      decisionTarget === null ? undefined : compileTaskDecisionRelation(cell, compiled, decisionTarget, binding),
    commonFields = {
      taskId,
      taskStatus: "planned" as const,
      packagePath: compiled.packagePath,
      generatedPaths: compiled.documents.map((document) => document.path),
      presetDigest: compiled.snapshot.digest,
      scaffoldDigest: compiled.scaffoldDigest,
      presetId: compiled.snapshot.identity.id,
      profileId: compiled.snapshot.profile.id,
      outputShape: compiled.snapshot.profile.outputShape,
      completionGates: compiled.snapshot.profile.completionGateIds,
      dryRun,
    },
    common = commonFields;
  if (dryRun) {
    const roots = receiptLayoutRoots(cell.store, cell.rootDir);
    const preview: TaskCreateReceipt = {
      outcome: "pending",
      opId,
      revision: currentRevision,
      evidence: JSON.stringify(common),
      visibility: "center",
      proof: {
        committedRevision: currentRevision,
        appliedCut: currentRevision,
        durable: false,
        canonicalVisible: false,
        worktreeVisible: false,
      },
      ...common,
      guidance: taskCreateGuidance(roots, {
        taskId,
        packagePath: compiled.packagePath,
        outputShape: compiled.snapshot.profile.outputShape,
        dryRun,
        opId,
        canonicalVisible: false,
      }),
      ...(decisionTarget === null ? { next: [{ command: taskDecisionGuidance }] } : {}),
      commitSha: null,
      summary: `would create task ${taskId} at ${workspaceRelativePath(
        roots,
        compiled.packagePath,
      )}${workReceiptLine(cell.projection, compiled.event.payload.task)}`,
    };
    return preview;
  }
  return { compiled, ...(relation === undefined ? {} : { relation }), fields: common };
}

function taskDecisionTarget(cell: RepoCellOperationalContext, action: RepoTaskAction): string | null {
  const decisionRef = action.decisionRef;
  if (decisionRef === undefined || decisionRef === null || decisionRef === "") {
    if (
      (action.presetId === "create-work" || action.taskClass === "work") &&
      action.createMode !== "import" &&
      action.createMode !== "migration"
    )
      throw cell.cellCodedError(
        "decision_required",
        'Work requires an in_effect Decision. Run ha decision list; if none fits, run ha decision propose --help, then accept the selected Decision with ha decision accept <decision-id> --rationale "<reason>" --judgment-only "<judgment>"; retry with ha work create --title "<name>" --decision <decision-id>.',
      );
    return null;
  }
  if (typeof decisionRef !== "string" || !/^dec_[A-Za-z0-9_-]+(?:\/CH[1-9][0-9]*)?$/u.test(decisionRef))
    throw cell.cellCodedError("invalid_field", "--decision must be <decision-id>[/CH<n>], for example dec_.../CH1.");
  const [decisionId, clauseId = "CH1"] = decisionRef.split("/"),
    decision = cell.projection.readDecision(decisionId!).decision;
  if (decision === null)
    throw cell.cellCodedError(
      "decision_not_found",
      `Decision ${decisionId} does not exist. Run ha decision list; if none fits, run ha decision propose --help, then accept the selected Decision with ha decision accept <decision-id> --rationale "<reason>" --judgment-only "<judgment>"; retry with ha work create --title "<name>" --decision <decision-id>.`,
    );
  if (decision.state !== "in_effect")
    throw cell.cellCodedError(
      "decision_not_in_effect",
      `Decision ${decisionId} is ${decision.state}. Run ha decision list; if it is the selected direction, accept it with ha decision accept ${decisionId} --rationale "<reason>" --judgment-only "<judgment>"; retry with ha work create --title "<name>" --decision ${decisionId}.`,
    );
  if (!decision.chosen.some(({ id }) => id === clauseId))
    throw cell.cellCodedError(
      "decision_clause_not_found",
      `Decision ${decisionId} has no chosen clause ${clauseId}; use a clause shown by ha decision show ${decisionId}.`,
    );
  return `decision/${decisionId}/${clauseId}`;
}

function compileTaskDecisionRelation(
  cell: RepoCellOperationalContext,
  compiled: PreparedTaskCreate["compiled"],
  target: string,
  binding: RepoCellBinding,
): CanonicalWriteBundle {
  const source = `task/${compiled.event.payload.task.taskId}`,
    targetVersion = cell.projection.readEntityVersionWitness(target).currentVersion;
  if (targetVersion === null)
    throw cell.cellCodedError("decision_clause_not_found", `Decision target ${target} is unavailable.`);
  const event = compileRelationCreatedEvent({
    record: {
      relation_id: deriveRelationId({ source, target, type: "implements", direction: "directed" }),
      source,
      target,
      type: "implements",
      direction: "directed",
      origin: "declared",
      state: "active",
      rationale: "Task created to implement its accepted Decision.",
      targetObservedVersion: targetVersion,
    },
    directions: relationDirectionRegistry(cell.projection, cell.input.repoId),
    actor: binding.actor,
    source: binding.source,
    opId: `${compiled.event.opId}-decision-relation`,
    occurredAt: compiled.event.occurredAt,
    workspaceRevision: compiled.event.workspaceRevision + 1,
  });
  return compileRelationDocumentWrite(event, relationDocumentUpdates(cell.projection, event, null));
}

export function applyPreparedTaskCreate(cell: RepoCellOperationalContext, prepared: PreparedTaskCreate): void {
  cell.projection.apply(prepared.compiled.event, prepared.compiled.plan);
  if (prepared.relation) cell.projection.apply(prepared.relation.event, prepared.relation.plan);
  cell.knownTaskIds?.add(prepared.fields.taskId);
}

export function preparedTaskCreateReceipt(
  cell: RepoCellOperationalContext,
  prepared: PreparedTaskCreate,
  publication: PublicPublication,
): TaskCreateReceipt {
  const proof = cell.receiptProof(prepared.compiled.event, publication),
    roots = receiptLayoutRoots(cell.store, cell.rootDir),
    { fields, compiled } = prepared;
  const receipt: TaskCreateReceipt = {
    outcome: proof.canonicalVisible ? "applied" : "pending",
    opId: compiled.event.opId,
    revision: compiled.event.workspaceRevision,
    evidence: `event-object:${compiled.event.opId}`,
    visibility: "center",
    proof,
    ...fields,
    guidance: taskCreateGuidance(roots, {
      taskId: fields.taskId,
      packagePath: compiled.packagePath,
      outputShape: compiled.snapshot.profile.outputShape,
      dryRun: fields.dryRun,
      opId: compiled.event.opId,
      canonicalVisible: proof.canonicalVisible,
    }),
    ...(prepared.relation === undefined ? { next: [{ command: taskDecisionGuidance }] } : {}),
    commitSha: publication.commitSha,
    cut: publication.cut,
    summary: proof.canonicalVisible
      ? `created task ${fields.taskId} at ${workspaceRelativePath(
          roots,
          compiled.packagePath,
        )}${workReceiptLine(cell.projection, compiled.event.payload.task)}`
      : `task ${fields.taskId} is awaiting exact canonical settlement${workReceiptLine(
          cell.projection,
          compiled.event.payload.task,
        )}`,
  };
  return receipt;
}

export function upgradePresetSnapshot(
  cell: RepoCellOperationalContext,
  action: RepoTaskAction,
  binding: RepoCellBinding,
): WriteReceipt {
  const taskId = cell.requiredCellText(action.taskId, "taskId"),
    projected = cell.projection.read(taskId),
    taskReady = projected.status === "ready";
  if (!projected.snapshot.task || !projected.packagePath || !taskReady)
    throw cell.cellCodedError("content_not_ready", `Task ${taskId} is not ready for preset upgrade.`);
  const contract = cell.projection.readDocument(`${projected.packagePath}/task-contract.json`),
    contractReady = contract.status === "ready";
  if (!contract.document || !contractReady)
    throw cell.cellCodedError("content_not_ready", `Task ${taskId} contract is not ready for preset upgrade.`);
  const opId = cell.operationId(action, binding, cell.input.repoId, projected.snapshot.revision),
    existing = cell.store.readEvent(opId);
  if (existing) return cell.receiptForOperation(opId, binding);
  const compiled = compileRepoPresetSnapshotUpgrade({
      rootDir: cell.rootDir,
      settings: cell.settings.read(),
      task: projected.snapshot.task,
      taskContractBody: contract.document.body,
      documentExists: (relativePath) => {
        const document = cell.projection.readDocument(`${projected.packagePath}/${relativePath}`);
        return document.status === "ready" && document.document !== null;
      },
      actor: binding.actor,
      source: binding.source,
      workspaceRevision: (cell.store.readHead()?.revision ?? 0) + 1,
      eventId: `event-${createHash("sha256").update(opId).digest("hex")}`,
      opId,
      occurredAt: cell.now(),
    }),
    appended = cell.store.append(compiled),
    publication = cell.publicPublication(appended);
  cell.projection.apply(compiled.event, compiled.plan);
  const projectedCut = cell.projection.read(taskId).watermark,
    proof = cell.receiptProof(compiled.event, publication),
    base = {
      opId,
      revision: appended.revision,
      evidence: JSON.stringify({
        taskId,
        previousDigest: compiled.event.payload.previousDigest,
        digest: compiled.snapshot.digest,
      }),
      visibility: "center" as const,
      proof,
      ...publication,
    };
  return proof.canonicalVisible && projectedCut >= compiled.event.workspaceRevision
    ? {
        outcome: "applied",
        ...base,
      }
    : {
        outcome: "pending",
        ...base,
      };
}
