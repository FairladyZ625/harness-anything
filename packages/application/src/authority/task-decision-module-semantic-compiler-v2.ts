import {
  DecisionPackageSchema,
  decisionEntityId,
  decisionSemanticMutationActions,
  decisionFieldContracts,
  deriveRelationId,
  entityRegistry,
  explainDecisionStateTransition,
  explainStatusTransition,
  isDomainStatus,
  moduleEntityId,
  normalizeRelativeDocumentPath,
  parseDecisionDocument,
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
  type DecisionAmendPayloadV2,
  type DecisionProposePayloadV2,
  type DecisionRelationPayloadV2,
  type DecisionStatePayloadV2,
  type ModuleRecordV2,
  type ModuleRegisterPayloadV2,
  type ModuleStepPayloadV2,
  type ModuleUnregisterPayloadV2,
  type TaskAppendPayloadV2,
  type TaskCreatePayloadV2,
  type TaskDecisionModuleCommandPayloadV2,
  type TaskDocumentPayloadV2,
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

export {
  encodeTaskDecisionModuleCommandPayloadV2,
  taskDecisionModuleTypedCommandsV2,
  type DecisionAmendPayloadV2,
  type DecisionProposePayloadV2,
  type DecisionRelationPayloadV2,
  type DecisionStatePayloadV2,
  type DecisionStateTransitionV2,
  type ModuleRecordV2,
  type ModuleRegisterPayloadV2,
  type ModuleStepPayloadV2,
  type ModuleUnregisterPayloadV2,
  type TaskAppendPayloadV2,
  type TaskCreatePayloadV2,
  type TaskDecisionModuleCommandPayloadV2,
  type TaskDecisionModuleTypedCommandV2,
  type TaskDocumentPayloadV2,
  type TaskTransitionPayloadV2
} from "./task-decision-module-command-v2.ts";

export interface TaskDecisionModuleAuthorityStateV2 {
  readonly readEntityBase: (entityRef: RegistryEntityRefV2) => Promise<SemanticEntityBaseV2 | null>;
  readonly readHostedDocument: (path: string) => Promise<HostedDocumentSnapshotV2 | null>;
}

export interface TaskDecisionModuleSemanticCompilerV2Options {
  readonly state: TaskDecisionModuleAuthorityStateV2;
}

interface CompiledTaskDecisionModuleCommandV2 {
  readonly mutationPlan: RegistryMutationPlanInput;
  readonly operation: WriteOp;
  readonly requiredBaseRefs: ReadonlyArray<RegistryEntityRefV2>;
  readonly requiredPathSnapshots: ReadonlyArray<{ readonly path: string; readonly snapshot: HostedDocumentSnapshotV2 }>;
}

interface ModuleRegistryV2 {
  readonly schema: "module-registry/v1";
  readonly modules: ReadonlyArray<ModuleRecordV2>;
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
    case "decision.propose/v1": return compileDecisionPropose(payload);
    case "decision.state/v1": return compileDecisionState(state, payload);
    case "decision.amend/v1": return compileDecisionAmend(state, payload);
    case "decision.relation/v1": return compileDecisionRelation(state, payload);
    case "module.register/v1": return compileModuleRegister(state, payload);
    case "module.unregister/v1": return compileModuleUnregister(state, payload);
    case "module.step/v1": return compileModuleStep(state, payload);
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
  return taskCompilation(payload.taskId, "transition", "transition_local", {
    path: "INDEX.md",
    body,
    to
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

async function compileDecisionAmend(
  state: TaskDecisionModuleAuthorityStateV2,
  payload: DecisionAmendPayloadV2
): Promise<CompiledTaskDecisionModuleCommandV2> {
  const next = decodeTaskDecisionModuleDecision(payload.decision);
  const path = decisionPath(next.decision_id);
  const snapshot = await requiredTaskDecisionModuleDocument(state, path, "DECISION_DOCUMENT_NOT_FOUND");
  const current = decodeTaskDecisionModuleDecision(parseDecisionDocument(snapshot.body).decision);
  assertSameDecision(current, next);
  const changed = changedDecisionFields(current, next);
  if (changed.length === 0 || changed.some((field) => decisionFieldContracts[field].mutability !== "amendable")) {
    throw admission("DECISION_AMEND_FIELD_INVALID");
  }
  return {
    mutationPlan: taskDecisionModulePlan([{ entityKind: "decision", identity: { decisionId: next.decision_id }, action: decisionSemanticMutationActions.amend }]),
    operation: decisionOperation("decision_amend", next, payload.body, current),
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
  return {
    mutationPlan: taskDecisionModulePlan([
      { entityKind: "decision", identity: { decisionId: payload.decisionId }, action: "relation" },
      relationCreateIntent(relation)
    ]),
    operation: {
      ...decisionOperation("decision_relate", next, undefined, current),
      payload: {
        decision: next,
        writeMode: { kind: "append_relation", relation }
      }
    },
    requiredBaseRefs: [
      taskDecisionModuleEntityRef("decision", `decision/${payload.decisionId}`),
      taskDecisionModuleEntityRef("relation", `relation/${relation.relation_id}`)
    ],
    requiredPathSnapshots: [{ path, snapshot }]
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

async function compileModuleRegister(
  state: TaskDecisionModuleAuthorityStateV2,
  payload: ModuleRegisterPayloadV2
): Promise<CompiledTaskDecisionModuleCommandV2> {
  const { registry, snapshot } = await moduleRegistry(state);
  const modules = registry.modules.some((entry) => entry.key === payload.module.key)
    ? registry.modules.map((entry) => entry.key === payload.module.key ? payload.module : entry)
    : [...registry.modules, payload.module];
  return moduleCompilation(payload.module.key, "register", { schema: "module-registry/v1", modules }, snapshot);
}

async function compileModuleUnregister(
  state: TaskDecisionModuleAuthorityStateV2,
  payload: ModuleUnregisterPayloadV2
): Promise<CompiledTaskDecisionModuleCommandV2> {
  const { registry, snapshot } = await moduleRegistry(state);
  if (!snapshot) throw admission("MODULE_REGISTRY_NOT_FOUND");
  const current = registry.modules.find((entry) => entry.key === payload.moduleKey);
  if (!current || current.status === "unregistered") throw admission("MODULE_NOT_FOUND");
  return moduleCompilation(payload.moduleKey, "unregister", {
    schema: "module-registry/v1",
    modules: registry.modules.map((entry) => entry.key === payload.moduleKey ? { ...entry, status: "unregistered" } : entry)
  }, snapshot);
}

async function compileModuleStep(
  state: TaskDecisionModuleAuthorityStateV2,
  payload: ModuleStepPayloadV2
): Promise<CompiledTaskDecisionModuleCommandV2> {
  const { registry, snapshot } = await moduleRegistry(state);
  if (!snapshot) throw admission("MODULE_REGISTRY_NOT_FOUND");
  const current = registry.modules.find((entry) => entry.key === payload.moduleKey);
  if (!current || current.status === "unregistered") throw admission("MODULE_NOT_FOUND");
  const step = { id: payload.stepId, state: payload.state };
  const steps = current.steps.some((entry) => entry.id === payload.stepId)
    ? current.steps.map((entry) => entry.id === payload.stepId ? step : entry)
    : [...current.steps, step];
  return moduleCompilation(payload.moduleKey, "step", {
    schema: "module-registry/v1",
    modules: registry.modules.map((entry) => entry.key === payload.moduleKey ? { ...entry, steps } : entry)
  }, snapshot);
}

function moduleCompilation(
  moduleKey: string,
  action: "register" | "unregister" | "step",
  registry: ModuleRegistryV2,
  snapshot: HostedDocumentSnapshotV2 | null
): CompiledTaskDecisionModuleCommandV2 {
  return {
    mutationPlan: taskDecisionModulePlan([{ entityKind: "module", identity: { moduleKey }, action }]),
    operation: {
      opId: "authority-overrides-this",
      entityId: moduleEntityId(moduleKey),
      kind: "module_registry_write",
      payload: { operation: action, registry }
    },
    requiredBaseRefs: [taskDecisionModuleEntityRef("module", `module/${encodeURIComponent(moduleKey)}`)],
    requiredPathSnapshots: snapshot ? [{ path: "modules.json", snapshot }] : []
  };
}

async function moduleRegistry(state: TaskDecisionModuleAuthorityStateV2): Promise<{
  readonly registry: ModuleRegistryV2;
  readonly snapshot: HostedDocumentSnapshotV2 | null;
}> {
  const snapshot = await state.readHostedDocument("modules.json");
  if (!snapshot) return { registry: { schema: "module-registry/v1", modules: [] }, snapshot: null };
  let value: unknown;
  try {
    value = JSON.parse(snapshot.body);
  } catch {
    throw admission("MODULE_REGISTRY_INVALID");
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw admission("MODULE_REGISTRY_INVALID");
  const row = value as { readonly schema?: unknown; readonly modules?: unknown };
  if (row.schema !== "module-registry/v1" || !Array.isArray(row.modules)) throw admission("MODULE_REGISTRY_INVALID");
  const modules = row.modules.map(decodeModuleRecord);
  if (new Set(modules.map((entry) => entry.key)).size !== modules.length) throw admission("MODULE_REGISTRY_DUPLICATE_KEY");
  return { registry: { schema: "module-registry/v1", modules }, snapshot };
}

function decodeModuleRecord(value: unknown): ModuleRecordV2 {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw admission("MODULE_REGISTRY_INVALID");
  const row = value as Record<string, unknown>;
  if (typeof row.key !== "string" || typeof row.title !== "string" || typeof row.status !== "string"
    || !Array.isArray(row.scopes) || !Array.isArray(row.steps)) throw admission("MODULE_REGISTRY_INVALID");
  const optional = (key: string): string | undefined => row[key] === undefined
    ? undefined
    : typeof row[key] === "string" ? row[key] : (() => { throw admission("MODULE_REGISTRY_INVALID"); })();
  const stringArray = (key: string): ReadonlyArray<string> | undefined => row[key] === undefined
    ? undefined
    : Array.isArray(row[key]) && row[key].every((entry) => typeof entry === "string")
      ? row[key] as ReadonlyArray<string>
      : (() => { throw admission("MODULE_REGISTRY_INVALID"); })();
  const steps = row.steps.map((entry) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) throw admission("MODULE_REGISTRY_INVALID");
    const step = entry as Record<string, unknown>;
    if (typeof step.id !== "string" || typeof step.state !== "string") throw admission("MODULE_REGISTRY_INVALID");
    return { id: step.id, state: step.state };
  });
  return {
    key: row.key,
    title: row.title,
    ...(optional("prefix") === undefined ? {} : { prefix: optional("prefix")! }),
    status: row.status,
    ...(optional("branch") === undefined ? {} : { branch: optional("branch")! }),
    ...(optional("owner") === undefined ? {} : { owner: optional("owner")! }),
    ...(optional("currentStep") === undefined ? {} : { currentStep: optional("currentStep")! }),
    scopes: row.scopes as ReadonlyArray<string>,
    ...(stringArray("shared") === undefined ? {} : { shared: stringArray("shared")! }),
    ...(stringArray("dependsOn") === undefined ? {} : { dependsOn: stringArray("dependsOn")! }),
    steps
  };
}

function parseTaskIndex(body: string): { readonly taskId: string; readonly status: string } {
  const frontmatter = readFrontmatter(body);
  if (!frontmatter || readScalar(frontmatter, "schema", { required: true }) !== "task-package/v2") {
    throw admission("TASK_INDEX_INVALID");
  }
  const taskId = readScalar(frontmatter, "task_id", { required: true });
  const status = readScalar(frontmatter, "  status", { required: true });
  if (!isDomainStatus(status)) throw admission("TASK_INDEX_INVALID");
  return { taskId, status };
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
