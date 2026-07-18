import {
  DecisionPackageSchema,
  decisionEntityId,
  decisionSemanticMutationActions,
  decisionFieldContracts,
  deriveRelationId,
  entityRegistry,
  explainDecisionStateTransition,
  explainStatusTransition,
  formatRelationFlowRecord,
  isDomainStatus,
  isPackageDisposition,
  normalizeRelativeDocumentPath,
  parseDecisionDocument,
  parseRelationFlowRecords,
  readFrontmatter,
  readScalar,
  taskEntityId,
  validateRelationRecordsForHost,
  type DecisionPackage,
  type DomainStatus,
  type EntityRelationRecord,
  type RegistryMutationPlanInput,
  type WriteOp,
  type WriteOpKind
} from "../../../kernel/src/index.ts";
import { Schema } from "effect";
import {
  decodeTaskDecisionModuleCommandPayloadV2,
  type DecisionProposePayloadV2,
  type DecisionRelationPayloadV2,
  type DecisionStatePayloadV2,
  type TaskAppendPayloadV2,
  type TaskAmendPayloadV2,
  type TaskArchivePayloadV2,
  type TaskCreatePayloadV2,
  type TaskDecisionModuleCommandPayloadV2,
  type TaskDocumentPayloadV2,
  type TaskDeletePayloadV2,
  type TaskRelatePayloadV2,
  type TaskReopenPayloadV2,
  type TaskSupersedePayloadV2,
  type TaskTransitionPayloadV2
} from "./task-decision-module-command-v2.ts";
import {
  type AuthoritySemanticCompilerV2,
  type RegistryEntityRefV2
} from "./semantic-mutation-envelope-v2.ts";
import {
  semanticAdmissionV2 as admission,
  semanticMutationPlanV2 as taskDecisionModulePlan,
  verifySemanticBaseCasV2,
  verifySemanticPathCasV2
} from "./semantic-authority-helpers-v2.ts";
import type {
  HostedDocumentSnapshotV2,
  SemanticEntityBaseV2
} from "./fact-relation-semantic-compiler-v2.ts";
import {
  compileDecisionAmendV2,
  compileDecisionRelationReplaceV2,
  compileDecisionRelationRetireV2,
  decisionRelationPriorityCompanionV2
} from "./task-decision-module-decision-mutations-v2.ts";
import {
  compileModuleRegisterV2,
  compileModuleStepV2,
  compileModuleUnregisterV2
} from "./task-decision-module-module-mutations-v2.ts";

export {
  encodeTaskDecisionModuleCommandPayloadV2,
  taskDecisionModuleTypedCommandsV2,
  type DecisionAmendPayloadV2,
  type DecisionProposePayloadV2,
  type DecisionRelationPayloadV2,
  type DecisionRelationReplacePayloadV2,
  type DecisionRelationRetirePayloadV2,
  type DecisionStatePayloadV2,
  type DecisionStateTransitionV2,
  type ModuleRecordV2,
  type ModuleRegisterPayloadV2,
  type ModuleStepPayloadV2,
  type ModuleUnregisterPayloadV2,
  type TaskAppendPayloadV2,
  type TaskAmendPayloadV2,
  type TaskArchivePayloadV2,
  type TaskCreatePayloadV2,
  type TaskDecisionModuleCommandPayloadV2,
  type TaskDecisionModuleTypedCommandV2,
  type TaskDocumentPayloadV2,
  type TaskDeletePayloadV2,
  type TaskRelatePayloadV2,
  type TaskReopenPayloadV2,
  type TaskSupersedePayloadV2,
  type TaskTransitionPayloadV2
} from "./task-decision-module-command-v2.ts";

export interface TaskDecisionModuleAuthorityStateV2 {
  readonly readEntityBase: (entityRef: RegistryEntityRefV2) => Promise<SemanticEntityBaseV2 | null>;
  readonly readHostedDocument: (path: string) => Promise<HostedDocumentSnapshotV2 | null>;
}

export interface TaskDecisionModuleSemanticCompilerV2Options {
  readonly state: TaskDecisionModuleAuthorityStateV2;
}

export interface CompiledTaskDecisionModuleCommandV2 {
  readonly mutationPlan: RegistryMutationPlanInput;
  readonly operation: WriteOp;
  readonly requiredBaseRefs: ReadonlyArray<RegistryEntityRefV2>;
  readonly requiredPathSnapshots: ReadonlyArray<{ readonly path: string; readonly snapshot: HostedDocumentSnapshotV2 }>;
}

const registryVersion = 1;

export function makeTaskDecisionModuleSemanticCompilerV2(
  options: TaskDecisionModuleSemanticCompilerV2Options
): AuthoritySemanticCompilerV2 {
  return {
    compile: async (envelope) => {
      const { payload, decodedBytes } = decodeTaskDecisionModuleCommandPayloadV2(envelope);
      const compiled = await compileTaskDecisionModulePayload(options.state, payload);
      await verifySemanticBaseCasV2(options.state, envelope.intent.kind === "typed" ? envelope.intent.baseCas : [], compiled.requiredBaseRefs);
      verifySemanticPathCasV2(envelope.intent.kind === "typed" ? envelope.intent.declaredPathCas : [], compiled.requiredPathSnapshots);
      return { mutationPlan: compiled.mutationPlan, operation: compiled.operation, decodedBytes };
    }
  };
}

async function compileTaskDecisionModulePayload(
  state: TaskDecisionModuleAuthorityStateV2,
  payload: TaskDecisionModuleCommandPayloadV2
): Promise<CompiledTaskDecisionModuleCommandV2> {
  switch (payload.schema) {
    case "task.create/v1": return compileTaskCreate(payload);
    case "task.transition/v1": return compileTaskTransition(state, payload);
    case "task.append/v1": return compileTaskAppend(payload);
    case "task.document/v1": return compileTaskDocument(state, payload);
    case "task.amend/v1": return compileTaskAmend(state, payload);
    case "task.archive/v1": return compileTaskDisposition(state, payload, "archived", "package_archive");
    case "task.supersede/v1": return compileTaskSupersede(state, payload);
    case "task.delete/v1": return compileTaskDisposition(state, payload, "tombstoned", "package_tombstone");
    case "task.reopen/v1": return compileTaskDisposition(state, payload, "active", "package_reopen");
    case "task.relate/v1": return compileTaskRelate(state, payload);
    case "decision.propose/v1": return compileDecisionPropose(payload);
    case "decision.state/v1": return compileDecisionState(state, payload);
    case "decision.amend/v1": return compileDecisionAmendV2(state, payload);
    case "decision.relation/v1": return compileDecisionRelation(state, payload);
    case "decision.relation-retire/v1": return compileDecisionRelationRetireV2(state, payload);
    case "decision.relation-replace/v1": return compileDecisionRelationReplaceV2(state, payload);
    case "module.register/v1": return compileModuleRegisterV2(state, payload);
    case "module.unregister/v1": return compileModuleUnregisterV2(state, payload);
    case "module.step/v1": return compileModuleStepV2(state, payload);
  }
}

function compileTaskCreate(payload: TaskCreatePayloadV2): CompiledTaskDecisionModuleCommandV2 {
  const task = parseTaskIndex(payload.indexBody);
  if (task.taskId !== payload.taskId) throw admission("TASK_ID_MISMATCH");
  if (task.status !== "planned") throw admission("TASK_CREATE_REQUIRES_PLANNED_STATUS");
  const operationPayload = payload.writes ? { writes: payload.writes.map((write) => ({ taskId: payload.taskId, ...write })) } : {
    path: "INDEX.md",
    body: payload.indexBody,
    ...(payload.packageSlug ? { packageSlug: payload.packageSlug } : {})
  };
  if (payload.writes) {
    const indexWrite = payload.writes.find((write) => write.path === "INDEX.md");
    if (!indexWrite || indexWrite.body !== payload.indexBody) throw admission("TASK_CREATE_INDEX_WRITE_MISMATCH");
  }
  return taskCompilation(payload.taskId, "create", "package_create", operationPayload, [taskDecisionModuleEntityRef("task", `task/${payload.taskId}`)]);
}

async function compileTaskTransition(
  state: TaskDecisionModuleAuthorityStateV2,
  payload: TaskTransitionPayloadV2
): Promise<CompiledTaskDecisionModuleCommandV2> {
  if (!isDomainStatus(payload.to)) throw admission("TASK_TRANSITION_STATUS_INVALID");
  const to = payload.to as DomainStatus;
  const path = taskPath(payload.taskId, "INDEX.md");
  const snapshot = await requiredTaskDecisionModuleDocument(state, path, "TASK_INDEX_NOT_FOUND");
  const current = parseTaskIndex(snapshot.body);
  if (current.taskId !== payload.taskId) throw admission("TASK_ID_MISMATCH");
  if (!explainStatusTransition(current.status as DomainStatus, to).allowed) throw admission("TASK_TRANSITION_INVALID");
  const body = replaceTaskStatus(snapshot.body, to);
  if (payload.auditText !== undefined && (to !== "cancelled" || !payload.auditText.startsWith("FORCE_STATUS_SET_AUDIT:"))) {
    throw admission("TASK_TRANSITION_FORCE_AUDIT_INVALID");
  }
  return taskCompilation(payload.taskId, "transition", "transition_local", {
    path: "INDEX.md",
    body,
    to,
    ...(payload.auditText === undefined ? {} : { auditText: payload.auditText })
  }, [taskDecisionModuleEntityRef("task", `task/${payload.taskId}`)], [{ path, snapshot }]);
}

function compileTaskAppend(payload: TaskAppendPayloadV2): CompiledTaskDecisionModuleCommandV2 {
  return taskCompilation(payload.taskId, "append", "progress_append", {
    path: "progress.md",
    append: payload.text
  }, [taskDecisionModuleEntityRef("task", `task/${payload.taskId}`)]);
}

async function compileTaskDocument(
  state: TaskDecisionModuleAuthorityStateV2,
  payload: TaskDocumentPayloadV2
): Promise<CompiledTaskDecisionModuleCommandV2> {
  const documentPath = normalizeRelativeDocumentPath(payload.path);
  assertTaskDocumentSurface(documentPath);
  const path = taskPath(payload.taskId, documentPath);
  const snapshot = await state.readHostedDocument(path);
  return taskCompilation(payload.taskId, "document", documentPath === "code-doc-anchors.json" ? "code_doc_reconcile" : "doc_write", {
    path: documentPath,
    body: payload.body
  }, [taskDecisionModuleEntityRef("task", `task/${payload.taskId}`)], snapshot ? [{ path, snapshot }] : []);
}

async function compileTaskAmend(
  state: TaskDecisionModuleAuthorityStateV2,
  payload: TaskAmendPayloadV2
): Promise<CompiledTaskDecisionModuleCommandV2> {
  const path = taskPath(payload.taskId, "INDEX.md");
  const snapshot = await requiredTaskDecisionModuleDocument(state, path, "TASK_INDEX_NOT_FOUND");
  const current = parseTaskIndex(snapshot.body);
  const next = parseTaskIndex(payload.body);
  if (current.taskId !== payload.taskId || next.taskId !== payload.taskId) throw admission("TASK_ID_MISMATCH");
  const coreFields = new Set(["schema", "task_id", "title", "parent", "lifecycle", "packageDisposition", "workKind", "riskTier", "urgency", "vertical", "preset", "provenance", "profile"]);
  if (payload.fields.some((field) => coreFields.has(field) || !/^[A-Za-z][A-Za-z0-9_]*$/u.test(field))) {
    throw admission("TASK_AMEND_FIELD_INVALID");
  }
  if (stripTaskAmendFields(snapshot.body, payload.fields) !== stripTaskAmendFields(payload.body, payload.fields)
    || payload.fields.some((field) => !new RegExp(`^${escapeRegExp(field)}:`, "mu").test(readFrontmatter(payload.body) ?? ""))) {
    throw admission("TASK_AMEND_BODY_MISMATCH");
  }
  return taskCompilation(payload.taskId, "document", "doc_write", { path: "INDEX.md", body: payload.body }, [
    taskDecisionModuleEntityRef("task", `task/${payload.taskId}`)
  ], [{ path, snapshot }]);
}

async function compileTaskDisposition(
  state: TaskDecisionModuleAuthorityStateV2,
  payload: TaskArchivePayloadV2 | TaskDeletePayloadV2 | TaskReopenPayloadV2,
  disposition: "active" | "archived" | "tombstoned",
  kind: "package_archive" | "package_tombstone" | "package_reopen"
): Promise<CompiledTaskDecisionModuleCommandV2> {
  const path = taskPath(payload.taskId, "INDEX.md");
  const snapshot = await requiredTaskDecisionModuleDocument(state, path, "TASK_INDEX_NOT_FOUND");
  const current = parseTaskIndex(snapshot.body);
  const next = parseTaskIndex(payload.body);
  if (current.taskId !== payload.taskId || next.taskId !== payload.taskId) throw admission("TASK_ID_MISMATCH");
  if (next.packageDisposition !== disposition || !sameTaskLifecycleCore(current, next)) {
    throw admission("TASK_DISPOSITION_BODY_INVALID");
  }
  if (!payload.body.includes(payload.reason)) throw admission("TASK_DISPOSITION_REASON_REQUIRED");
  return taskCompilation(payload.taskId, "document", kind, { path: "INDEX.md", body: payload.body }, [
    taskDecisionModuleEntityRef("task", `task/${payload.taskId}`)
  ], [{ path, snapshot }]);
}

async function compileTaskSupersede(
  state: TaskDecisionModuleAuthorityStateV2,
  payload: TaskSupersedePayloadV2
): Promise<CompiledTaskDecisionModuleCommandV2> {
  if (payload.body !== undefined) {
    if (!payload.replacementTaskId || payload.writes) throw admission("TASK_SUPERSEDE_PAYLOAD_INVALID");
    const compiled = await compileTaskDisposition(state, {
      schema: "task.archive/v1", taskId: payload.taskId, reason: `supersededBy=${payload.replacementTaskId}`, body: payload.body
    }, "archived", "package_archive");
    const replacementPath = taskPath(payload.replacementTaskId, "INDEX.md");
    const replacementSnapshot = await requiredTaskDecisionModuleDocument(state, replacementPath, "TASK_SUPERSEDE_TARGET_NOT_FOUND");
    return {
      ...compiled,
      requiredBaseRefs: [...compiled.requiredBaseRefs, taskDecisionModuleEntityRef("task", `task/${payload.replacementTaskId}`)],
      requiredPathSnapshots: [...compiled.requiredPathSnapshots, { path: replacementPath, snapshot: replacementSnapshot }]
    };
  }
  if (!payload.replacementTaskId || !payload.writes) throw admission("TASK_SUPERSEDE_PAYLOAD_INVALID");
  const oldPath = taskPath(payload.taskId, "INDEX.md");
  const oldSnapshot = await requiredTaskDecisionModuleDocument(state, oldPath, "TASK_INDEX_NOT_FOUND");
  const oldWrite = payload.writes.find((write) => write.taskId === payload.taskId && write.path === "INDEX.md");
  const newWrite = payload.writes.find((write) => write.taskId === payload.replacementTaskId && write.path === "INDEX.md");
  const relationWrite = payload.writes.find((write) => write.taskId === payload.replacementTaskId && write.path === "relations.md");
  if (!oldWrite || !newWrite || !relationWrite || parseTaskIndex(oldWrite.body).packageDisposition !== "archived"
    || parseTaskIndex(newWrite.body).status !== "planned"
    || !relationWrite.body.includes(`task/${payload.replacementTaskId} supersedes task/${payload.taskId}`)) {
    throw admission("TASK_SUPERSEDE_WRITES_INVALID");
  }
  return {
    mutationPlan: taskDecisionModulePlan([
      { entityKind: "task", identity: { taskId: payload.taskId }, action: "document", storageContext: { documentPath: "INDEX.md" } },
      { entityKind: "task", identity: { taskId: payload.replacementTaskId }, action: "create" }
    ]),
    operation: { opId: "authority-overrides-this", entityId: taskEntityId(payload.taskId), kind: "package_supersede", payload: { writes: payload.writes } },
    requiredBaseRefs: [taskDecisionModuleEntityRef("task", `task/${payload.taskId}`), taskDecisionModuleEntityRef("task", `task/${payload.replacementTaskId}`)],
    requiredPathSnapshots: [{ path: oldPath, snapshot: oldSnapshot }]
  };
}

async function compileTaskRelate(
  state: TaskDecisionModuleAuthorityStateV2,
  payload: TaskRelatePayloadV2
): Promise<CompiledTaskDecisionModuleCommandV2> {
  const relation = payload.relation;
  if (relation.source !== `task/${payload.taskId}` || relation.target !== `task/${payload.targetTaskId}`
    || relation.type !== "depends-on" || relation.state !== "active" || deriveRelationId(relation) !== relation.relation_id) {
    throw admission("TASK_RELATION_INVALID");
  }
  const issues = validateRelationRecordsForHost(`task/${payload.taskId}`, [relation]);
  if (issues.length > 0) throw admission(`TASK_RELATION_INVALID:${issues[0]!.code}`);
  const path = taskPath(payload.taskId, "INDEX.md");
  const targetPath = taskPath(payload.targetTaskId, "INDEX.md");
  const snapshot = await requiredTaskDecisionModuleDocument(state, path, "TASK_INDEX_NOT_FOUND");
  const targetSnapshot = await requiredTaskDecisionModuleDocument(state, targetPath, "TASK_RELATION_TARGET_NOT_FOUND");
  if (appendTaskRelation(snapshot.body, relation) !== payload.body) throw admission("TASK_RELATION_BODY_MISMATCH");
  return {
    mutationPlan: taskDecisionModulePlan([
      { entityKind: "task", identity: { taskId: payload.taskId }, action: "document", storageContext: { documentPath: "INDEX.md" } },
      relationCreateIntent(relation)
    ]),
    operation: { opId: "authority-overrides-this", entityId: taskEntityId(payload.taskId), kind: "doc_write", payload: { path: "INDEX.md", body: payload.body } },
    requiredBaseRefs: [
      taskDecisionModuleEntityRef("task", `task/${payload.taskId}`),
      taskDecisionModuleEntityRef("task", `task/${payload.targetTaskId}`),
      taskDecisionModuleEntityRef("relation", `relation/${relation.relation_id}`)
    ],
    requiredPathSnapshots: [{ path, snapshot }, { path: targetPath, snapshot: targetSnapshot }]
  };
}

function taskCompilation(
  taskId: string,
  action: "create" | "transition" | "append" | "document",
  kind: WriteOpKind,
  payload: unknown,
  requiredBaseRefs: ReadonlyArray<RegistryEntityRefV2>,
  requiredPathSnapshots: ReadonlyArray<{ readonly path: string; readonly snapshot: HostedDocumentSnapshotV2 }> = []
): CompiledTaskDecisionModuleCommandV2 {
  const documentPath = "path" in (payload as object)
    ? (payload as { readonly path: string }).path
    : "INDEX.md";
  return {
    mutationPlan: taskDecisionModulePlan([{ entityKind: "task", identity: { taskId }, action, storageContext: { documentPath } }]),
    operation: { opId: "authority-overrides-this", entityId: taskEntityId(taskId), kind, payload },
    requiredBaseRefs,
    requiredPathSnapshots
  };
}

function compileDecisionPropose(payload: DecisionProposePayloadV2): CompiledTaskDecisionModuleCommandV2 {
  const decision = decodeTaskDecisionModuleDecision(payload.decision);
  if (decision.state !== "proposed") throw admission("DECISION_PROPOSE_REQUIRES_PROPOSED_STATE");
  assertDecisionRelations(decision.decision_id, decision.relations);
  const decisionRef = taskDecisionModuleEntityRef("decision", `decision/${decision.decision_id}`);
  const relationMutations = decision.relations.map(relationCreateIntent);
  return {
    mutationPlan: taskDecisionModulePlan([
      { entityKind: "decision", identity: { decisionId: decision.decision_id }, action: decisionSemanticMutationActions.propose },
      ...relationMutations
    ]),
    operation: decisionOperation("decision_propose", decision, payload.body),
    requiredBaseRefs: [decisionRef, ...decision.relations.map((relation) => taskDecisionModuleEntityRef("relation", `relation/${relation.relation_id}`))],
    requiredPathSnapshots: []
  };
}

async function compileDecisionState(
  state: TaskDecisionModuleAuthorityStateV2,
  payload: DecisionStatePayloadV2
): Promise<CompiledTaskDecisionModuleCommandV2> {
  const next = decodeTaskDecisionModuleDecision(payload.decision);
  const path = decisionPath(next.decision_id);
  const snapshot = await requiredTaskDecisionModuleDocument(state, path, "DECISION_DOCUMENT_NOT_FOUND");
  const current = decodeTaskDecisionModuleDecision(parseDecisionDocument(snapshot.body).decision);
  assertSameDecision(current, next);
  const expectedState = {
    accept: "active",
    reject: "rejected",
    defer: "deferred",
    supersede: "retired",
    retire: "retired"
  }[payload.transition];
  if (next.state !== expectedState || !explainDecisionStateTransition(current.state, next.state).allowed) {
    throw admission("DECISION_STATE_TRANSITION_INVALID");
  }
  const allowedStateFields: Array<keyof DecisionPackage> = ["state", "decidedAt", "contentPins"];
  if (payload.transition === "accept") allowedStateFields.push("claims", "decisionClass");
  assertOnlyDecisionFieldsChanged(current, next, new Set(allowedStateFields));
  return {
    mutationPlan: taskDecisionModulePlan([{ entityKind: "decision", identity: { decisionId: next.decision_id }, action: decisionSemanticMutationActions.state }]),
    operation: decisionOperation(`decision_${payload.transition}` as WriteOpKind, next, payload.body, current),
    requiredBaseRefs: [taskDecisionModuleEntityRef("decision", `decision/${next.decision_id}`)],
    requiredPathSnapshots: [{ path, snapshot }]
  };
}

 async function compileDecisionRelation(
  state: TaskDecisionModuleAuthorityStateV2,
  payload: DecisionRelationPayloadV2
): Promise<CompiledTaskDecisionModuleCommandV2> {
  const relation = payload.relation;
  if (relation.state !== "active" || deriveRelationId(relation) !== relation.relation_id) throw admission("RELATION_PAYLOAD_INVALID");
  assertDecisionRelations(payload.decisionId, [relation]);
  const path = decisionPath(payload.decisionId);
  const snapshot = await requiredTaskDecisionModuleDocument(state, path, "DECISION_DOCUMENT_NOT_FOUND");
  const current = decodeTaskDecisionModuleDecision(parseDecisionDocument(snapshot.body).decision);
  if (current.decision_id !== payload.decisionId) throw admission("DECISION_ID_MISMATCH");
  if (current.relations.some((entry) => entry.relation_id === relation.relation_id)) throw admission("RELATION_ALREADY_EXISTS");
  const next = { ...current, relations: [...current.relations, relation] };
  const companion = await decisionRelationPriorityCompanionV2(state, current, relation, payload.taskWrites ?? []);
  return {
    mutationPlan: taskDecisionModulePlan([
      { entityKind: "decision", identity: { decisionId: payload.decisionId }, action: "relation" },
      relationCreateIntent(relation),
      ...companion.mutations
    ]),
    operation: {
      ...decisionOperation("decision_relate", next, undefined, current),
      payload: {
        decision: next,
        writeMode: { kind: "append_relation", relation },
        ...(payload.taskWrites?.length ? { taskWrites: payload.taskWrites } : {})
      }
    },
    requiredBaseRefs: [
      taskDecisionModuleEntityRef("decision", `decision/${payload.decisionId}`),
      taskDecisionModuleEntityRef("relation", `relation/${relation.relation_id}`),
      ...companion.baseRefs
    ],
    requiredPathSnapshots: [{ path, snapshot }, ...companion.pathSnapshots]
  };
}

 function decisionOperation(
  kind: WriteOpKind,
  decision: DecisionPackage,
  body?: string,
  current?: DecisionPackage
): WriteOp {
  return {
    opId: "authority-overrides-this",
    entityId: decisionEntityId(decision.decision_id),
    kind,
    payload: {
      decision,
      ...(body === undefined ? {} : { body }),
      writeMode: { kind: "snapshot", expectedWatermark: current?._coordinatorWatermark ?? null }
    }
  };
}

 interface ParsedTaskIndexV2 {
  readonly taskId: string;
  readonly status: DomainStatus;
  readonly packageDisposition: "active" | "archived" | "tombstoned";
  readonly core: Readonly<Record<string, string>>;
}

function parseTaskIndex(body: string): ParsedTaskIndexV2 {
  const frontmatter = readFrontmatter(body);
  if (!frontmatter || readScalar(frontmatter, "schema", { required: true }) !== "task-package/v2") {
    throw admission("TASK_INDEX_INVALID");
  }
  const taskId = readScalar(frontmatter, "task_id", { required: true });
  const status = readScalar(frontmatter, "  status", { required: true });
  if (!isDomainStatus(status)) throw admission("TASK_INDEX_INVALID");
  const packageDisposition = readScalar(frontmatter, "packageDisposition", { required: true });
  if (!isPackageDisposition(packageDisposition)) throw admission("TASK_INDEX_INVALID");
  const keys = [
    "schema", "task_id", "title", "parent", "  bindingSchema", "  engine", "  status", "  ref",
    "  titleSnapshot", "  url", "  bindingCreatedAt", "  bindingFingerprint", "packageDisposition",
    "workKind", "riskTier", "urgency", "vertical", "preset", "profile"
  ];
  return {
    taskId,
    status,
    packageDisposition,
    core: Object.fromEntries(keys.map((key) => [key, readScalar(frontmatter, key)]))
  };
}

function sameTaskLifecycleCore(current: ParsedTaskIndexV2, next: ParsedTaskIndexV2): boolean {
  return Object.entries(current.core).every(([key, value]) => key === "packageDisposition" || next.core[key] === value);
}

function stripTaskAmendFields(body: string, fields: ReadonlyArray<string>): string {
  const frontmatter = readFrontmatter(body);
  if (!frontmatter) throw admission("TASK_INDEX_INVALID");
  const stripped = fields.reduce((current, field) => current.replace(new RegExp(`^${escapeRegExp(field)}:[^\\r\\n]*(?:\\r?\\n|$)`, "gmu"), ""), frontmatter);
  return body.replace(frontmatter, stripped);
}

function appendTaskRelation(body: string, relation: EntityRelationRecord): string {
  if (body.includes(`relation_id: ${relation.relation_id}`)) return body;
  const frontmatter = readFrontmatter(body);
  if (!frontmatter) throw admission("TASK_INDEX_INVALID");
  const line = formatRelationFlowRecord(relation);
  const nextFrontmatter = parseRelationFlowRecords(frontmatter).length > 0 || /^relations:\s*$/mu.test(frontmatter)
    ? frontmatter.replace(/^(relations:\s*\n(?:\s*-\s*\{[^\n]*\}\n?)*)/mu, (block) => `${block.endsWith("\n") ? block : `${block}\n`}${line}\n`)
    : `${frontmatter}\nrelations:\n${line}`;
  return body.replace(`---\n${frontmatter}\n---`, `---\n${nextFrontmatter}\n---`);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

function replaceTaskStatus(body: string, status: string): string {
  const matches = [...body.matchAll(/^  status:[ \t]*(.*)$/gmu)];
  if (matches.length !== 1) throw admission("TASK_INDEX_INVALID");
  return body.replace(/^  status:[ \t]*(.*)$/mu, `  status: ${status}`);
}

function assertTaskDocumentSurface(path: string): void {
  if (path === "INDEX.md" || path === "progress.md" || path === "facts.md"
    || path.startsWith("executions/") || path.startsWith("reviews/")) {
    throw admission("TASK_DOCUMENT_SURFACE_OWNED_BY_TYPED_ACTION");
  }
}

function decodeTaskDecisionModuleDecision(value: unknown): DecisionPackage {
  try {
    return Schema.decodeUnknownSync(DecisionPackageSchema)(value);
  } catch {
    throw admission("DECISION_PAYLOAD_INVALID");
  }
}

function assertSameDecision(current: DecisionPackage, next: DecisionPackage): void {
  if (current.decision_id !== next.decision_id) throw admission("DECISION_ID_MISMATCH");
}

function changedDecisionFields(current: DecisionPackage, next: DecisionPackage): ReadonlyArray<keyof DecisionPackage> {
  return (Object.keys(decisionFieldContracts) as ReadonlyArray<keyof DecisionPackage>)
    .filter((field) => JSON.stringify(current[field]) !== JSON.stringify(next[field]));
}

function assertOnlyDecisionFieldsChanged(
  current: DecisionPackage,
  next: DecisionPackage,
  allowed: ReadonlySet<keyof DecisionPackage>
): void {
  const rejected = changedDecisionFields(current, next).find((field) => !allowed.has(field));
  if (rejected) throw admission(`DECISION_STATE_FIELD_INVALID:${String(rejected)}`);
}

function assertDecisionRelations(decisionId: string, relations: ReadonlyArray<EntityRelationRecord>): void {
  for (const relation of relations) {
    if (deriveRelationId(relation) !== relation.relation_id) throw admission("RELATION_ID_MISMATCH");
  }
  const issues = validateRelationRecordsForHost(`decision/${decisionId}`, relations);
  if (issues.length > 0) throw admission(`RELATION_DOMAIN_INVALID:${issues[0]!.code}`);
}

function relationCreateIntent(relation: EntityRelationRecord): RegistryMutationPlanInput["mutations"][number] {
  return {
    entityKind: "relation",
    identity: { relationId: relation.relation_id },
    action: "create",
    storageContext: { sourceRef: relation.source }
  };
}

async function requiredTaskDecisionModuleDocument(
  state: TaskDecisionModuleAuthorityStateV2,
  path: string,
  code: string
): Promise<HostedDocumentSnapshotV2> {
  const snapshot = await state.readHostedDocument(path);
  if (!snapshot) throw admission(code);
  return snapshot;
}

function decisionPath(decisionId: string): string {
  const locator = entityRegistry.decision.storageLocator;
  if (locator.status !== "ready") throw admission("REGISTRY_FACET_NOT_WRITABLE");
  const target = locator.locator.locate({ decisionId }, {}).targets[0];
  if (!target?.path) throw admission("DECISION_STORAGE_TARGET_REQUIRED");
  return target.path;
}

function taskPath(taskId: string, documentPath: string): string {
  return `tasks/${taskId}/${documentPath}`;
}

function taskDecisionModuleEntityRef(entityKind: string, canonicalRef: string): RegistryEntityRefV2 {
  return { registryVersion, entityKind, canonicalRef };
}
