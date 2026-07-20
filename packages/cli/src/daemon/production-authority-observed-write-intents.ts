import {
  encodeTaskDecisionModuleCommandPayloadV2,
  type ProductionAuthorityCommand,
  type TaskDecisionModuleCommandPayloadV2
} from "@harness-anything/application";
import {
  decisionEntityId,
  decisionSemanticMutationActions,
  deriveRelationId,
  taskEntityId,
  type DecisionPackage,
  type EntityRelationRecord,
  type RegistryEntityRefV2,
  type WriteOp
} from "@harness-anything/kernel";
import { resolveHostedDocument } from "@harness-anything/daemon";
import type { CanonicalAttemptIntent } from "./production-authority-attempt-compiler.ts";

export function productionObservedWriteAttemptIntent(
  command: ProductionAuthorityCommand,
  operation: WriteOp,
  authoredRoot: string
): CanonicalAttemptIntent {
  const action = command.action;
  if (action.kind === "decision-amend") {
    const payload = decisionWritePayload(operation, "decision_amend", action.decisionId);
    return observedIntent({
      commandName: "decision.amend",
      payload: { schema: "decision.amend/v1", decision: payload.decision, ...(payload.body === undefined ? {} : { body: payload.body }) },
      mutations: [{ entity: observedWriteRef("decision", `decision/${action.decisionId}`), action: decisionSemanticMutationActions.amend }],
      baseRefs: [observedWriteRef("decision", `decision/${action.decisionId}`)],
      portablePaths: [`decisions/decision-${action.decisionId}/decision.md`],
      requiredPathCasPaths: [`decisions/decision-${action.decisionId}/decision.md`],
      physicalEntityId: decisionEntityId(action.decisionId),
      authoredRoot
    });
  }
  if (action.kind === "decision-relation-retire") {
    const payload = decisionWritePayload(operation, "relation_retire", action.decisionId);
    return observedIntent({
      commandName: "decision.relation-retire",
      payload: { schema: "decision.relation-retire/v1", decisionId: action.decisionId, relationId: action.relationId, decision: payload.decision, ...(payload.body === undefined ? {} : { body: payload.body }) },
      mutations: [
        { entity: observedWriteRef("decision", `decision/${action.decisionId}`), action: decisionSemanticMutationActions.relation },
        { entity: observedWriteRef("relation", `relation/${action.relationId}`), action: "retire" }
      ],
      baseRefs: [observedWriteRef("decision", `decision/${action.decisionId}`), observedWriteRef("relation", `relation/${action.relationId}`)],
      portablePaths: [`decisions/decision-${action.decisionId}/decision.md`],
      requiredPathCasPaths: [`decisions/decision-${action.decisionId}/decision.md`],
      physicalEntityId: decisionEntityId(action.decisionId),
      authoredRoot
    });
  }
  if (action.kind === "decision-relation-replace") {
    const payload = decisionWritePayload(operation, "relation_replace", action.decisionId);
    const replacement = payload.decision.relations.at(-1);
    if (!replacement || replacement.relation_id === action.relationId || replacement.state !== "active") {
      throw new Error("AUTHORITY_DECISION_RELATION_REPLACEMENT_REQUIRED");
    }
    const taskWrites = documentWrites(payload.taskWrites, "AUTHORITY_DECISION_RELATION_TASK_WRITES_INVALID");
    return observedIntent({
      commandName: "decision.relation-replace",
      payload: {
        schema: "decision.relation-replace/v1", decisionId: action.decisionId, relationId: action.relationId,
        replacement, decision: payload.decision,
        ...(taskWrites.length === 0 ? {} : { taskWrites }),
        ...(payload.body === undefined ? {} : { body: payload.body })
      },
      mutations: [
        { entity: observedWriteRef("decision", `decision/${action.decisionId}`), action: decisionSemanticMutationActions.relation },
        { entity: observedWriteRef("relation", `relation/${action.relationId}`), action: "retire" },
        { entity: observedWriteRef("relation", `relation/${replacement.relation_id}`), action: "create" },
        ...taskWrites.map((write) => ({ entity: observedWriteRef("task", `task/${write.taskId}`), action: "document" }))
      ],
      baseRefs: [
        observedWriteRef("decision", `decision/${action.decisionId}`), observedWriteRef("relation", `relation/${action.relationId}`),
        observedWriteRef("relation", `relation/${replacement.relation_id}`), ...taskWrites.map((write) => observedWriteRef("task", `task/${write.taskId}`))
      ],
      portablePaths: [`decisions/decision-${action.decisionId}/decision.md`, ...taskWrites.map((write) => `tasks/${write.taskId}/${write.path}`)],
      requiredPathCasPaths: [`decisions/decision-${action.decisionId}/decision.md`, ...taskWrites.map((write) => `tasks/${write.taskId}/${write.path}`)],
      physicalEntityId: decisionEntityId(action.decisionId),
      authoredRoot
    });
  }
  if (action.kind === "task-delete" && action.mode === "hard") {
    throw new Error("AUTHORITY_TASK_HARD_DELETE_UNAVAILABLE: production path does not offer hard delete; use task archive or task supersede after distilling evidence");
  }
  if (action.kind === "task-amend") {
    const body = singleTaskBody(operation, "doc_write", action.taskId);
    return taskIntent("task.amend", { schema: "task.amend/v1", taskId: action.taskId, fields: action.patches.map((patch) => patch.field), body }, action.taskId, "document", [action.taskId], authoredRoot);
  }
  if (action.kind === "task-archive") {
    const taskId = singleArchiveTaskId(action, operation);
    const body = singleTaskBody(operation, "package_archive", taskId);
    return taskIntent("task.archive", { schema: "task.archive/v1", taskId, reason: action.reason, body }, taskId, "document", [taskId], authoredRoot);
  }
  if (action.kind === "task-delete") {
    const body = singleTaskBody(operation, "package_tombstone", action.taskId);
    return taskIntent("task.delete", { schema: "task.delete/v1", taskId: action.taskId, mode: "soft", reason: action.reason, body }, action.taskId, "document", [action.taskId], authoredRoot);
  }
  if (action.kind === "task-reopen") {
    const body = singleTaskBody(operation, "package_reopen", action.taskId);
    return taskIntent("task.reopen", { schema: "task.reopen/v1", taskId: action.taskId, reason: action.reason, body }, action.taskId, "document", [action.taskId], authoredRoot);
  }
  if (action.kind === "task-relate") {
    const body = singleTaskBody(operation, "doc_write", action.sourceTaskId);
    const relation = taskRelation(action);
    return taskIntent("task.relate", {
      schema: "task.relate/v1", taskId: action.sourceTaskId, targetTaskId: action.targetTaskId, relation, body
    }, action.sourceTaskId, "document", [action.sourceTaskId, action.targetTaskId], authoredRoot, [
      { entity: observedWriteRef("relation", `relation/${relation.relation_id}`), action: "create" }
    ]);
  }
  if (action.kind === "task-supersede") {
    if (action.byTaskId) {
      const body = singleTaskBody(operation, "package_archive", action.oldTaskId);
      return taskIntent("task.supersede", {
        schema: "task.supersede/v1", taskId: action.oldTaskId, body, replacementTaskId: action.byTaskId
      }, action.oldTaskId, "document", [action.oldTaskId, action.byTaskId], authoredRoot);
    }
    if (operation.kind !== "package_supersede" || operation.entityId !== taskEntityId(action.oldTaskId)) {
      throw new Error("AUTHORITY_TASK_SUPERSEDE_OPERATION_MISMATCH");
    }
    const raw = exactObservedRecord(operation.payload, "AUTHORITY_TASK_SUPERSEDE_PAYLOAD_INVALID");
    const writes = documentWrites(raw.writes, "AUTHORITY_TASK_SUPERSEDE_PAYLOAD_INVALID", true);
    const replacement = writes.find((write) => write.taskId !== action.oldTaskId && write.path === "INDEX.md")?.taskId;
    if (!replacement) throw new Error("AUTHORITY_TASK_SUPERSEDE_REPLACEMENT_REQUIRED");
    return observedIntent({
      commandName: "task.supersede",
      payload: { schema: "task.supersede/v1", taskId: action.oldTaskId, replacementTaskId: replacement, writes },
      mutations: [
        { entity: observedWriteRef("task", `task/${action.oldTaskId}`), action: "document" },
        { entity: observedWriteRef("task", `task/${replacement}`), action: "create" }
      ],
      baseRefs: [observedWriteRef("task", `task/${action.oldTaskId}`), observedWriteRef("task", `task/${replacement}`)],
      portablePaths: writes.map((write) => `tasks/${write.taskId}/${write.path}`),
      requiredPathCasPaths: [`tasks/${action.oldTaskId}/INDEX.md`],
      physicalEntityId: taskEntityId(action.oldTaskId),
      authoredRoot
    });
  }
  throw new Error(`AUTHORITY_OBSERVED_WRITE_COMMAND_UNSUPPORTED:${action.kind}`);
}

function taskIntent(
  commandName: string,
  payload: TaskDecisionModuleCommandPayloadV2,
  taskId: string,
  action: string,
  taskIds: ReadonlyArray<string>,
  authoredRoot: string,
  extraMutations: CanonicalAttemptIntent["mutations"] = []
): CanonicalAttemptIntent {
  return observedIntent({
    commandName,
    payload,
    mutations: [{ entity: observedWriteRef("task", `task/${taskId}`), action }, ...extraMutations],
    baseRefs: [...taskIds.map((id) => observedWriteRef("task", `task/${id}`)), ...extraMutations.map((mutation) => mutation.entity)],
    portablePaths: taskIds.map((id) => `tasks/${id}/INDEX.md`),
    requiredPathCasPaths: taskIds.map((id) => `tasks/${id}/INDEX.md`),
    physicalEntityId: taskEntityId(taskId),
    authoredRoot
  });
}

function observedIntent(input: {
  readonly commandName: string;
  readonly payload: TaskDecisionModuleCommandPayloadV2;
  readonly mutations: CanonicalAttemptIntent["mutations"];
  readonly baseRefs: CanonicalAttemptIntent["baseRefs"];
  readonly portablePaths: CanonicalAttemptIntent["portablePaths"];
  readonly requiredPathCasPaths: ReadonlyArray<string>;
  readonly physicalEntityId: string;
  readonly authoredRoot: string;
}): CanonicalAttemptIntent {
  const snapshots = input.requiredPathCasPaths.map((portablePath) => {
    const resolved = resolveHostedDocument(input.authoredRoot, portablePath);
    if (!resolved) {
      throw new Error(`AUTHORITY_CANONICAL_HOST_DOCUMENT_REQUIRED:path=${portablePath}`);
    }
    return { path: resolved.portablePath, ...resolved.snapshot.cas };
  });
  return {
    commandName: input.commandName,
    payload: encodeTaskDecisionModuleCommandPayloadV2(input.payload),
    mutations: input.mutations,
    baseRefs: input.baseRefs,
    portablePaths: input.portablePaths,
    declaredPathCas: snapshots,
    physicalEntityId: input.physicalEntityId
  };
}

function decisionWritePayload(operation: WriteOp, kind: WriteOp["kind"], decisionId: string): {
  readonly decision: DecisionPackage;
  readonly body?: string;
  readonly taskWrites?: unknown;
} {
  if (operation.kind !== kind || operation.entityId !== decisionEntityId(decisionId)) throw new Error("AUTHORITY_DECISION_WRITE_OPERATION_MISMATCH");
  const raw = exactObservedRecord(operation.payload, "AUTHORITY_DECISION_WRITE_PAYLOAD_INVALID");
  const decision = raw.decision as DecisionPackage | undefined;
  if (!decision || typeof decision !== "object" || decision.decision_id !== decisionId) throw new Error("AUTHORITY_DECISION_WRITE_PAYLOAD_INVALID");
  if (raw.body !== undefined && typeof raw.body !== "string") throw new Error("AUTHORITY_DECISION_WRITE_BODY_INVALID");
  return { decision, ...(raw.body === undefined ? {} : { body: raw.body }), ...(raw.taskWrites === undefined ? {} : { taskWrites: raw.taskWrites }) };
}

function singleTaskBody(operation: WriteOp, kind: WriteOp["kind"], taskId: string): string {
  if (operation.kind !== kind || operation.entityId !== taskEntityId(taskId)) throw new Error("AUTHORITY_TASK_WRITE_OPERATION_MISMATCH");
  const raw = exactObservedRecord(operation.payload, "AUTHORITY_TASK_WRITE_PAYLOAD_INVALID");
  if (raw.path !== "INDEX.md" || typeof raw.body !== "string") throw new Error("AUTHORITY_TASK_WRITE_PAYLOAD_INVALID");
  return raw.body;
}

function singleArchiveTaskId(action: Extract<ProductionAuthorityCommand["action"], { readonly kind: "task-archive" }>, operation: WriteOp): string {
  const selected = action.taskId ? [action.taskId] : action.ids ? [...new Set(action.ids)] : [];
  if (selected.length !== 1) throw new Error("AUTHORITY_TASK_ARCHIVE_SINGLE_SELECTOR_REQUIRED: production typed archive currently requires exactly one explicit task id");
  if (operation.entityId !== taskEntityId(selected[0]!)) throw new Error("AUTHORITY_TASK_ARCHIVE_OPERATION_MISMATCH");
  return selected[0]!;
}

function taskRelation(action: Extract<ProductionAuthorityCommand["action"], { readonly kind: "task-relate" }>): EntityRelationRecord {
  const base = {
    source: `task/${action.sourceTaskId}`, target: `task/${action.targetTaskId}`, type: action.relationType,
    strength: "strong", direction: "directed", origin: "declared", rationale: action.rationale, state: "active"
  } as const;
  return { relation_id: deriveRelationId(base), ...base };
}

function documentWrites(value: unknown, code: string, allowPackageSlug = false): ReadonlyArray<{ readonly taskId: string; readonly path: string; readonly body: string; readonly packageSlug?: string }> {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new Error(code);
  return value.map((entry) => {
    const row = exactObservedRecord(entry, code);
    if (typeof row.taskId !== "string" || typeof row.path !== "string" || typeof row.body !== "string"
      || (!allowPackageSlug && row.packageSlug !== undefined)
      || (row.packageSlug !== undefined && typeof row.packageSlug !== "string")) throw new Error(code);
    return { taskId: row.taskId, path: row.path, body: row.body, ...(row.packageSlug === undefined ? {} : { packageSlug: row.packageSlug }) };
  });
}

function exactObservedRecord(value: unknown, code: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(code);
  return value as Record<string, unknown>;
}

function observedWriteRef(entityKind: string, canonicalRef: string): RegistryEntityRefV2 {
  return { registryVersion: 1, entityKind, canonicalRef };
}
