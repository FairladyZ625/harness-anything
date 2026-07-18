import { Schema } from "effect";
import {
  DecisionPackageSchema,
  computeDecisionContentDigest,
  decisionContentCanonicalization,
  decisionEntityId,
  decisionFieldContracts,
  deriveRelationId,
  entityRegistry,
  parseDecisionDocument,
  readFrontmatter,
  readScalar,
  validateRelationRecordsForHost,
  type DecisionPackage,
  type EntityRelationRecord,
  type RegistryMutationPlanInput,
  type WriteOp
} from "../../../kernel/src/index.ts";
import type {
  DecisionAmendPayloadV2,
  DecisionRelationPayloadV2,
  DecisionRelationReplacePayloadV2,
  DecisionRelationRetirePayloadV2
} from "./task-decision-module-command-v2.ts";
import type {
  CompiledTaskDecisionModuleCommandV2,
  TaskDecisionModuleAuthorityStateV2
} from "./task-decision-module-semantic-compiler-v2.ts";
import type { HostedDocumentSnapshotV2 } from "./fact-relation-semantic-compiler-v2.ts";
import type { RegistryEntityRefV2 } from "./semantic-mutation-envelope-v2.ts";
import { semanticAdmissionV2 as admission, semanticMutationPlanV2 as plan } from "./semantic-authority-helpers-v2.ts";

const registryVersion = 1;

export async function compileDecisionAmendV2(
  state: TaskDecisionModuleAuthorityStateV2,
  payload: DecisionAmendPayloadV2
): Promise<CompiledTaskDecisionModuleCommandV2> {
  const next = decodeIngressDecision(payload.decision);
  const path = ingressDecisionPath(next.decision_id);
  const snapshot = await requiredIngressDecisionDocument(state, path, "DECISION_DOCUMENT_NOT_FOUND");
  const current = decodeIngressDecision(parseDecisionDocument(snapshot.body).decision);
  if (current.decision_id !== next.decision_id) throw admission("DECISION_ID_MISMATCH");
  const changed = changedFields(current, next);
  if (changed.length === 0 || changed.some((field) => field !== "contentPins" && decisionFieldContracts[field].mutability !== "amendable")
    || (changed.includes("contentPins") && !validContentPinAppend(current, next))) {
    throw admission("DECISION_AMEND_FIELD_INVALID");
  }
  return {
    mutationPlan: plan([{ entityKind: "decision", identity: { decisionId: next.decision_id }, action: "amend" }]),
    operation: ingressDecisionOperation("decision_amend", next, payload.body, current),
    requiredBaseRefs: [ingressDecisionRef("decision", `decision/${next.decision_id}`)],
    requiredPathSnapshots: [{ path, snapshot }]
  };
}

export async function compileDecisionRelationRetireV2(
  state: TaskDecisionModuleAuthorityStateV2,
  payload: DecisionRelationRetirePayloadV2
): Promise<CompiledTaskDecisionModuleCommandV2> {
  const next = decodeIngressDecision(payload.decision);
  const path = ingressDecisionPath(payload.decisionId);
  const snapshot = await requiredIngressDecisionDocument(state, path, "DECISION_DOCUMENT_NOT_FOUND");
  const current = decodeIngressDecision(parseDecisionDocument(snapshot.body).decision);
  if (current.decision_id !== payload.decisionId || next.decision_id !== payload.decisionId) throw admission("DECISION_ID_MISMATCH");
  const active = current.relations.find((relation) => relation.relation_id === payload.relationId);
  if (!active || active.state !== "active") throw admission("RELATION_NOT_ACTIVE");
  const relations = current.relations.map((relation) => relation.relation_id === payload.relationId ? { ...relation, state: "retired" as const } : relation);
  if (JSON.stringify(next) !== JSON.stringify({ ...current, relations })) throw admission("RELATION_RETIRE_DECISION_MISMATCH");
  return {
    mutationPlan: plan([
      { entityKind: "decision", identity: { decisionId: payload.decisionId }, action: "relation" },
      { entityKind: "relation", identity: { relationId: payload.relationId }, action: "retire", storageContext: { sourceRef: active.source } }
    ]),
    operation: ingressDecisionOperation("relation_retire", next, payload.body, current),
    requiredBaseRefs: [ingressDecisionRef("decision", `decision/${payload.decisionId}`), ingressDecisionRef("relation", `relation/${payload.relationId}`)],
    requiredPathSnapshots: [{ path, snapshot }]
  };
}

export async function compileDecisionRelationReplaceV2(
  state: TaskDecisionModuleAuthorityStateV2,
  payload: DecisionRelationReplacePayloadV2
): Promise<CompiledTaskDecisionModuleCommandV2> {
  const next = decodeIngressDecision(payload.decision);
  const path = ingressDecisionPath(payload.decisionId);
  const snapshot = await requiredIngressDecisionDocument(state, path, "DECISION_DOCUMENT_NOT_FOUND");
  const current = decodeIngressDecision(parseDecisionDocument(snapshot.body).decision);
  if (current.decision_id !== payload.decisionId || next.decision_id !== payload.decisionId) throw admission("DECISION_ID_MISMATCH");
  const active = current.relations.find((relation) => relation.relation_id === payload.relationId);
  if (!active || active.state !== "active") throw admission("RELATION_NOT_ACTIVE");
  const replacement = payload.replacement;
  assertRelations(payload.decisionId, [replacement]);
  const relations = [...current.relations.map((relation) => relation.relation_id === payload.relationId ? { ...relation, state: "retired" as const } : relation), replacement];
  if (replacement.state !== "active" || JSON.stringify(next) !== JSON.stringify({ ...current, relations })) throw admission("RELATION_REPLACE_DECISION_MISMATCH");
  const companion = await decisionRelationPriorityCompanionV2(state, current, replacement, payload.taskWrites ?? []);
  return {
    mutationPlan: plan([
      { entityKind: "decision", identity: { decisionId: payload.decisionId }, action: "relation" },
      { entityKind: "relation", identity: { relationId: payload.relationId }, action: "retire", storageContext: { sourceRef: active.source } },
      relationCreate(replacement), ...companion.mutations
    ]),
    operation: {
      ...ingressDecisionOperation("relation_replace", next, payload.body, current),
      payload: { decision: next, writeMode: { kind: "snapshot", expectedWatermark: current._coordinatorWatermark ?? null }, ...(payload.body === undefined ? {} : { body: payload.body }), ...(payload.taskWrites?.length ? { taskWrites: payload.taskWrites } : {}) }
    },
    requiredBaseRefs: [ingressDecisionRef("decision", `decision/${payload.decisionId}`), ingressDecisionRef("relation", `relation/${payload.relationId}`), ingressDecisionRef("relation", `relation/${replacement.relation_id}`), ...companion.baseRefs],
    requiredPathSnapshots: [{ path, snapshot }, ...companion.pathSnapshots]
  };
}

export async function decisionRelationPriorityCompanionV2(
  state: TaskDecisionModuleAuthorityStateV2,
  decision: DecisionPackage,
  relation: EntityRelationRecord,
  taskWrites: NonNullable<DecisionRelationPayloadV2["taskWrites"]>
): Promise<{
  readonly mutations: RegistryMutationPlanInput["mutations"];
  readonly baseRefs: ReadonlyArray<RegistryEntityRefV2>;
  readonly pathSnapshots: ReadonlyArray<{ readonly path: string; readonly snapshot: HostedDocumentSnapshotV2 }>;
}> {
  const match = relation.state === "active" && relation.type === "derives" ? /^task\/([^/]+)$/u.exec(relation.target) : null;
  if (!match) {
    if (taskWrites.length > 0) throw admission("DECISION_RELATION_TASK_WRITES_FORBIDDEN");
    return { mutations: [], baseRefs: [], pathSnapshots: [] };
  }
  const taskId = match[1]!;
  const path = `tasks/${taskId}/INDEX.md`;
  const snapshot = await requiredIngressDecisionDocument(state, path, "DECISION_RELATION_TASK_NOT_FOUND");
  const expectedBody = seedTaskPriority(snapshot.body, decision);
  if (expectedBody === null) {
    if (taskWrites.length > 0) throw admission("DECISION_RELATION_TASK_WRITES_REDUNDANT");
    return { mutations: [], baseRefs: [], pathSnapshots: [] };
  }
  if (taskWrites.length !== 1 || taskWrites[0]!.taskId !== taskId || taskWrites[0]!.path !== "INDEX.md" || taskWrites[0]!.body !== expectedBody) {
    throw admission("DECISION_RELATION_TASK_WRITE_MISMATCH");
  }
  return {
    mutations: [{ entityKind: "task", identity: { taskId }, action: "document", storageContext: { documentPath: "INDEX.md" } }],
    baseRefs: [ingressDecisionRef("task", `task/${taskId}`)],
    pathSnapshots: [{ path, snapshot }]
  };
}

function decodeIngressDecision(value: unknown): DecisionPackage {
  try { return Schema.decodeUnknownSync(DecisionPackageSchema)(value); } catch { throw admission("DECISION_PAYLOAD_INVALID"); }
}

function changedFields(current: DecisionPackage, next: DecisionPackage): ReadonlyArray<keyof DecisionPackage> {
  return (Object.keys(decisionFieldContracts) as ReadonlyArray<keyof DecisionPackage>).filter((field) => JSON.stringify(current[field]) !== JSON.stringify(next[field]));
}

function validContentPinAppend(current: DecisionPackage, next: DecisionPackage): boolean {
  const previous = current.contentPins ?? [];
  const pins = next.contentPins ?? [];
  const pin = pins.at(-1);
  return pins.length === previous.length + 1 && JSON.stringify(pins.slice(0, -1)) === JSON.stringify(previous) && Boolean(pin
    && pin.action === "amend" && pin.state === next.state && pin.canonicalization === decisionContentCanonicalization
    && pin.digest === computeDecisionContentDigest(next));
}

function assertRelations(decisionId: string, relations: ReadonlyArray<EntityRelationRecord>): void {
  for (const relation of relations) if (deriveRelationId(relation) !== relation.relation_id) throw admission("RELATION_ID_MISMATCH");
  const issues = validateRelationRecordsForHost(`decision/${decisionId}`, relations);
  if (issues.length > 0) throw admission(`RELATION_DOMAIN_INVALID:${issues[0]!.code}`);
}

function relationCreate(relation: EntityRelationRecord): RegistryMutationPlanInput["mutations"][number] {
  return { entityKind: "relation", identity: { relationId: relation.relation_id }, action: "create", storageContext: { sourceRef: relation.source } };
}

function seedTaskPriority(body: string, decision: DecisionPackage): string | null {
  const frontmatter = readFrontmatter(body);
  if (!frontmatter) throw admission("DECISION_RELATION_TASK_FRONTMATTER_INVALID");
  const additions = [...(readScalar(frontmatter, "riskTier") ? [] : [`riskTier: ${decision.riskTier}`]), ...(readScalar(frontmatter, "urgency") ? [] : [`urgency: ${decision.urgency}`])];
  if (additions.length === 0) return null;
  const next = frontmatter.replace(/^packageDisposition:[^\n]*(?:\n|$)/mu, (line) => `${line.endsWith("\n") ? line : `${line}\n`}${additions.join("\n")}\n`);
  if (next === frontmatter) throw admission("DECISION_RELATION_TASK_FRONTMATTER_INVALID");
  return body.replace(`---\n${frontmatter}\n---`, `---\n${next}\n---`);
}

function ingressDecisionOperation(kind: WriteOp["kind"], decision: DecisionPackage, body?: string, current?: DecisionPackage): WriteOp {
  return { opId: "authority-overrides-this", entityId: decisionEntityId(decision.decision_id), kind, payload: { decision, ...(body === undefined ? {} : { body }), writeMode: { kind: "snapshot", expectedWatermark: current?._coordinatorWatermark ?? null } } };
}

async function requiredIngressDecisionDocument(state: TaskDecisionModuleAuthorityStateV2, path: string, code: string): Promise<HostedDocumentSnapshotV2> {
  const snapshot = await state.readHostedDocument(path);
  if (!snapshot) throw admission(code);
  return snapshot;
}

function ingressDecisionPath(decisionId: string): string {
  const locator = entityRegistry.decision.storageLocator;
  if (locator.status !== "ready") throw admission("REGISTRY_FACET_NOT_WRITABLE");
  const target = locator.locator.locate({ decisionId }, {}).targets[0];
  if (!target?.path) throw admission("DECISION_STORAGE_TARGET_REQUIRED");
  return target.path;
}

function ingressDecisionRef(entityKind: string, canonicalRef: string): RegistryEntityRefV2 {
  return { registryVersion, entityKind, canonicalRef };
}
