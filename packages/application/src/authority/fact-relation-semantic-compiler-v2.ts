import { Schema } from "effect";
import {
  DecisionPackageSchema,
  deriveRelationId,
  entityRegistry,
  formatRelationFlowRecord,
  parseDecisionDocument,
  parseRelationFlowRecords,
  sha256Text,
  taskEntityId,
  validateRelationRecordsForHost,
  type DecisionPackage,
  type EntityId,
  type EntityRelationRecord,
  type RegistryMutationPlanInput,
  type WriteOp
} from "../../../kernel/src/index.ts";
import {
  decodeFactRecordV2,
  decodeFactRelationCommandPayloadV2,
  decodeRelationV2,
  type FactCreatePayloadV2,
  type FactInvalidatePayloadV2,
  type FactRelationCommandPayloadV2,
  type RelationCreatePayloadV2,
  type RelationReplacePayloadV2,
  type RelationRetirePayloadV2
} from "./fact-relation-command-v2.ts";
import {
  SemanticAdmissionErrorV2,
  type AuthoritySemanticCompilerV2,
  type PathCasV2,
  type RegistryEntityRefV2,
  type SemanticBaseCasV2
} from "./semantic-mutation-envelope-v2.ts";

export {
  canonicalPayloadDigestV2,
  encodeFactRelationCommandPayloadV2,
  factRelationTypedCommandsV2,
  type FactCreatePayloadV2,
  type FactInvalidatePayloadV2,
  type FactRelationCommandPayloadV2,
  type FactRelationTypedCommandV2,
  type RelationCreatePayloadV2,
  type RelationReplacePayloadV2,
  type RelationRetirePayloadV2
} from "./fact-relation-command-v2.ts";

export interface SemanticEntityBaseV2 {
  readonly semanticVersion: string | null;
  readonly stateDigest: Uint8Array | null;
}

export interface HostedDocumentSnapshotV2 {
  readonly body: string;
  readonly epoch: string;
  readonly revision: bigint;
  readonly blobDigest: Uint8Array;
}

export interface FactRelationAuthorityStateV2 {
  readonly readEntityBase: (entityRef: RegistryEntityRefV2) => Promise<SemanticEntityBaseV2 | null>;
  readonly readHostedDocument: (path: string) => Promise<HostedDocumentSnapshotV2 | null>;
}

export interface FactRelationSemanticCompilerV2Options {
  readonly state: FactRelationAuthorityStateV2;
}

interface CompiledFactRelationCommandV2 {
  readonly mutationPlan: RegistryMutationPlanInput;
  readonly operation: WriteOp;
  readonly requiredBaseRefs: ReadonlyArray<RegistryEntityRefV2>;
  readonly requiredPathSnapshots: ReadonlyArray<{ readonly path: string; readonly snapshot: HostedDocumentSnapshotV2 }>;
}

const registryVersion = 1;

export function makeFactRelationSemanticCompilerV2(
  options: FactRelationSemanticCompilerV2Options
): AuthoritySemanticCompilerV2 {
  return {
    compile: async (envelope) => {
      const { payload, decodedBytes } = decodeFactRelationCommandPayloadV2(envelope);
      const compiled = await compilePayload(options.state, payload);
      await verifyBaseCas(options.state, envelope.intent.kind === "typed" ? envelope.intent.baseCas : [], compiled.requiredBaseRefs);
      verifyPathCas(envelope.intent.kind === "typed" ? envelope.intent.declaredPathCas : [], compiled.requiredPathSnapshots);
      return {
        mutationPlan: compiled.mutationPlan,
        operation: compiled.operation,
        decodedBytes
      };
    }
  };
}

async function compilePayload(
  state: FactRelationAuthorityStateV2,
  payload: FactRelationCommandPayloadV2
): Promise<CompiledFactRelationCommandV2> {
  switch (payload.schema) {
    case "fact.create/v1":
      return compileFactCreate(payload);
    case "fact.invalidate/v1":
      return compileFactInvalidate(payload);
    case "relation.create/v1":
      return compileRelationCreate(state, payload);
    case "relation.retire/v1":
      return compileRelationLifecycle(state, payload);
    case "relation.replace/v1":
      return compileRelationLifecycle(state, payload);
  }
}

function compileFactCreate(payload: FactCreatePayloadV2): CompiledFactRelationCommandV2 {
  const record = decodeFactRecordV2({
    fact_id: payload.factId,
    statement: payload.statement,
    source: payload.source,
    observedAt: payload.observedAt,
    confidence: payload.confidence,
    memoryClass: payload.memoryClass,
    memoryTags: payload.memoryTags,
    provenance: payload.provenance
  });
  const factRef = entityRef("fact", `fact/${payload.ownerTaskId}/${payload.factId}`);
  return {
    mutationPlan: plan([{ entityKind: "fact", identity: { taskId: payload.ownerTaskId, factId: payload.factId }, action: "create" }]),
    operation: {
      opId: "authority-overrides-this",
      entityId: taskEntityId(payload.ownerTaskId),
      kind: "doc_write",
      payload: { path: "facts.md", appendRecord: { kind: "fact-record/v1", record } }
    },
    requiredBaseRefs: [factRef],
    requiredPathSnapshots: []
  };
}

function compileFactInvalidate(payload: FactInvalidatePayloadV2): CompiledFactRelationCommandV2 {
  if (payload.factId === payload.invalidatedByFactId) throw compilerAdmission("FACT_SELF_INVALIDATION");
  if (!payload.rationale.trim()) throw compilerAdmission("FACT_INVALIDATION_RATIONALE_REQUIRED");
  const relation = decodeRelationV2({
    relation_id: deriveRelationId({
      source: `fact/${payload.ownerTaskId}/${payload.invalidatedByFactId}`,
      target: `fact/${payload.ownerTaskId}/${payload.factId}`,
      type: "supersedes-fact",
      direction: "directed"
    }),
    source: `fact/${payload.ownerTaskId}/${payload.invalidatedByFactId}`,
    target: `fact/${payload.ownerTaskId}/${payload.factId}`,
    type: "supersedes-fact",
    strength: "strong",
    direction: "directed",
    origin: "declared",
    rationale: payload.rationale.trim(),
    state: "active"
  });
  const invalidated = entityRef("fact", `fact/${payload.ownerTaskId}/${payload.factId}`);
  const invalidator = entityRef("fact", `fact/${payload.ownerTaskId}/${payload.invalidatedByFactId}`);
  const relationRef = entityRef("relation", `relation/${relation.relation_id}`);
  return {
    mutationPlan: plan([
      { entityKind: "fact", identity: { taskId: payload.ownerTaskId, factId: payload.factId }, action: "invalidate" },
      {
        entityKind: "relation",
        identity: { relationId: relation.relation_id },
        action: "create",
        storageContext: { sourceRef: relation.source }
      }
    ]),
    operation: {
      opId: "authority-overrides-this",
      entityId: taskEntityId(payload.ownerTaskId),
      kind: "fact_invalidate",
      payload: {
        path: "facts.md",
        appendRecord: {
          kind: "fact-relation/v1",
          relation,
          requiresFacts: [payload.factId, payload.invalidatedByFactId]
        }
      }
    },
    requiredBaseRefs: [invalidated, invalidator, relationRef],
    requiredPathSnapshots: []
  };
}

async function compileRelationCreate(
  state: FactRelationAuthorityStateV2,
  payload: RelationCreatePayloadV2
): Promise<CompiledFactRelationCommandV2> {
  const relation = decodeRelationV2(payload.relation);
  if (relation.state !== "active") throw compilerAdmission("RELATION_CREATE_REQUIRES_ACTIVE_STATE");
  assertRelationIdentity(relation);
  const host = relationHost(relation.source);
  assertRelationHost(relation, host.hostRef);
  const relationRef = entityRef("relation", `relation/${relation.relation_id}`);
  const hostRef = entityRef(host.kind, host.hostRef);
  const mutationPlan = plan([{
    entityKind: "relation",
    identity: { relationId: relation.relation_id },
    action: "create",
    storageContext: { sourceRef: relation.source }
  }]);
  if (host.kind === "fact") {
    const targetFacts = targetFactInSameHost(relation.target, host.taskId);
    const requiredFacts = [host.factId, ...targetFacts];
    return {
      mutationPlan,
      operation: {
        opId: "authority-overrides-this",
        entityId: taskEntityId(host.taskId),
        kind: "doc_write",
        payload: {
          path: "facts.md",
          appendRecord: { kind: "fact-relation/v1", relation, requiresFacts: requiredFacts }
        }
      },
      requiredBaseRefs: [
        relationRef,
        hostRef,
        ...targetFacts.map((factId) => entityRef("fact", `fact/${host.taskId}/${factId}`))
      ],
      requiredPathSnapshots: []
    };
  }
  const path = relationStoragePath(relation.relation_id, relation.source);
  const snapshot = await requiredDocument(state, path);
  if (host.kind === "decision") {
    const current = decodeDecision(parseDecisionDocument(snapshot.body).decision);
    if (current.decision_id !== host.id) throw compilerAdmission("RELATION_HOST_ID_MISMATCH");
    return {
      mutationPlan,
      operation: {
        opId: "authority-overrides-this",
        entityId: `decision/${host.id}` as EntityId,
        kind: "decision_relate",
        payload: {
          decision: { ...current, relations: [...current.relations, relation] },
          writeMode: { kind: "append_relation", relation }
        }
      },
      requiredBaseRefs: [relationRef, hostRef],
      requiredPathSnapshots: []
    };
  }
  return {
    mutationPlan,
    operation: {
      opId: "authority-overrides-this",
      entityId: taskEntityId(host.id),
      kind: "doc_sync_submit",
      payload: {
        writes: [{
          path,
          body: rewriteHostedRelation(snapshot.body, null, relation),
          baseBlobSha256: sha256Text(snapshot.body)
        }]
      }
    },
    requiredBaseRefs: [relationRef, hostRef],
    requiredPathSnapshots: [{ path, snapshot }]
  };
}

async function compileRelationLifecycle(
  state: FactRelationAuthorityStateV2,
  payload: RelationRetirePayloadV2 | RelationReplacePayloadV2
): Promise<CompiledFactRelationCommandV2> {
  const host = relationHost(payload.sourceRef);
  const path = relationStoragePath(payload.relationId, payload.sourceRef);
  const snapshot = await requiredDocument(state, path);
  const current = currentHostedRelations(snapshot.body, host.kind);
  const existing = current.relations.find((relation) => relation.relation_id === payload.relationId);
  if (!existing) throw compilerAdmission("RELATION_NOT_FOUND");
  if (existing.source !== payload.sourceRef) throw compilerAdmission("RELATION_SOURCE_MISMATCH");
  if (existing.state !== "active") throw compilerAdmission("RELATION_NOT_ACTIVE");
  const retired = { ...existing, state: "retired" as const };
  const replacement = payload.schema === "relation.replace/v1" ? decodeRelationV2(payload.replacement) : null;
  if (replacement) {
    if (replacement.state !== "active") throw compilerAdmission("RELATION_REPLACEMENT_REQUIRES_ACTIVE_STATE");
    assertRelationIdentity(replacement);
    const replacementHost = relationHost(replacement.source);
    if (replacementHost.hostRef !== host.hostRef) throw compilerAdmission("RELATION_REPLACEMENT_HOST_MISMATCH");
    if (replacement.relation_id === existing.relation_id) throw compilerAdmission("RELATION_REPLACEMENT_ID_UNCHANGED");
    assertRelationHost(replacement, host.hostRef);
  }
  const mutations: RegistryMutationPlanInput["mutations"] = [
    {
      entityKind: "relation",
      identity: { relationId: existing.relation_id },
      action: "retire",
      storageContext: { sourceRef: existing.source }
    },
    ...(replacement ? [{
      entityKind: "relation",
      identity: { relationId: replacement.relation_id },
      action: "create",
      storageContext: { sourceRef: replacement.source }
    }] : [])
  ];
  const requiredBaseRefs = [
    entityRef("relation", `relation/${existing.relation_id}`),
    entityRef(host.kind, host.hostRef),
    ...(replacement ? [entityRef("relation", `relation/${replacement.relation_id}`)] : [])
  ];
  if (host.kind === "decision") {
    const decision = decodeDecision(current.decision);
    const relations = decision.relations
      .map((relation) => relation.relation_id === existing.relation_id ? retired : relation)
      .concat(replacement ? [replacement] : []);
    return {
      mutationPlan: plan(mutations),
      operation: {
        opId: "authority-overrides-this",
        entityId: `decision/${host.id}` as EntityId,
        kind: replacement ? "relation_replace" : "relation_retire",
        payload: {
          decision: { ...decision, relations },
          writeMode: { kind: "snapshot", expectedWatermark: decision._coordinatorWatermark ?? null }
        }
      },
      requiredBaseRefs,
      requiredPathSnapshots: [{ path, snapshot }]
    };
  }
  return {
    mutationPlan: plan(mutations),
    operation: {
      opId: "authority-overrides-this",
      entityId: taskEntityId(host.kind === "fact" ? host.taskId : host.id),
      kind: "doc_sync_submit",
      payload: {
        writes: [{
          path,
          body: rewriteHostedRelation(snapshot.body, existing, replacement),
          baseBlobSha256: sha256Text(snapshot.body)
        }]
      }
    },
    requiredBaseRefs,
    requiredPathSnapshots: [{ path, snapshot }]
  };
}

async function verifyBaseCas(
  state: FactRelationAuthorityStateV2,
  claimed: ReadonlyArray<SemanticBaseCasV2>,
  requiredRefs: ReadonlyArray<RegistryEntityRefV2>
): Promise<void> {
  const required = uniqueRefs(requiredRefs);
  if (claimed.length !== required.length) throw compilerAdmission("BASE_CAS_CONFLICT");
  const byRef = new Map(claimed.map((entry) => [entityRefKey(entry.entityRef), entry]));
  if (byRef.size !== claimed.length) throw compilerAdmission("BASE_CAS_CONFLICT");
  for (const ref of required) {
    const row = byRef.get(entityRefKey(ref));
    if (!row) throw compilerAdmission("BASE_CAS_CONFLICT");
    const actual = await state.readEntityBase(ref);
    if (!actual) {
      if (row.expectedSemanticVersion !== null || row.expectedStateDigest !== null) throw compilerAdmission("BASE_CAS_CONFLICT");
      continue;
    }
    if (row.expectedSemanticVersion !== actual.semanticVersion
      || !nullableBytesEqual(row.expectedStateDigest, actual.stateDigest)) throw compilerAdmission("BASE_CAS_CONFLICT");
  }
}

function verifyPathCas(
  claimed: ReadonlyArray<PathCasV2>,
  required: ReadonlyArray<{ readonly path: string; readonly snapshot: HostedDocumentSnapshotV2 }>
): void {
  if (claimed.length !== required.length) throw compilerAdmission("BASE_CAS_CONFLICT");
  const byPath = new Map(claimed.map((entry) => [entry.path, entry]));
  if (byPath.size !== claimed.length) throw compilerAdmission("BASE_CAS_CONFLICT");
  for (const { path, snapshot } of required) {
    const row = byPath.get(path);
    if (!row || row.expectedEpoch !== snapshot.epoch || row.expectedRevision !== snapshot.revision
      || !compilerBytesEqual(row.expectedBlobDigest, snapshot.blobDigest)) throw compilerAdmission("BASE_CAS_CONFLICT");
  }
}

function decodeDecision(value: unknown): DecisionPackage {
  try {
    return Schema.decodeUnknownSync(DecisionPackageSchema)(value);
  } catch {
    throw compilerAdmission("RELATION_HOST_DOCUMENT_INVALID");
  }
}

function assertRelationIdentity(relation: EntityRelationRecord): void {
  if (deriveRelationId(relation) !== relation.relation_id) throw compilerAdmission("RELATION_ID_MISMATCH");
}

function assertRelationHost(relation: EntityRelationRecord, hostRef: string): void {
  const issues = validateRelationRecordsForHost(hostRef, [relation]);
  if (issues.length > 0) throw compilerAdmission(`RELATION_DOMAIN_INVALID:${issues[0]!.code}`);
}

function relationHost(sourceRef: string):
  | { readonly kind: "task"; readonly id: string; readonly hostRef: string }
  | { readonly kind: "decision"; readonly id: string; readonly hostRef: string }
  | { readonly kind: "fact"; readonly id: string; readonly taskId: string; readonly factId: string; readonly hostRef: string } {
  const segments = sourceRef.split("/");
  if (segments[0] === "task" && segments[1]) return { kind: "task", id: segments[1], hostRef: `task/${segments[1]}` };
  if (segments[0] === "decision" && segments[1]) return { kind: "decision", id: segments[1], hostRef: `decision/${segments[1]}` };
  if (segments[0] === "fact" && segments[1] && segments[2]) {
    return { kind: "fact", id: segments[2], taskId: segments[1], factId: segments[2], hostRef: `fact/${segments[1]}/${segments[2]}` };
  }
  throw compilerAdmission("RELATION_STORAGE_SOURCE_UNSUPPORTED");
}

function relationStoragePath(relationId: string, sourceRef: string): string {
  const locator = entityRegistry.relation.storageLocator;
  if (locator.status !== "ready") throw compilerAdmission("REGISTRY_FACET_NOT_WRITABLE");
  const target = locator.locator.locate({ relationId }, { sourceRef }).targets[0];
  if (!target?.path) throw compilerAdmission("RELATION_STORAGE_TARGET_REQUIRED");
  return target.path;
}

async function requiredDocument(state: FactRelationAuthorityStateV2, path: string): Promise<HostedDocumentSnapshotV2> {
  const snapshot = await state.readHostedDocument(path);
  if (!snapshot) throw compilerAdmission("RELATION_HOST_DOCUMENT_NOT_FOUND");
  return snapshot;
}

function currentHostedRelations(body: string, kind: "task" | "decision" | "fact"):
  { readonly relations: ReadonlyArray<EntityRelationRecord>; readonly decision?: DecisionPackage } {
  if (kind === "decision") {
    const decision = decodeDecision(parseDecisionDocument(body).decision);
    return { relations: decision.relations, decision };
  }
  return { relations: parseRelationFlowRecords(body) };
}

function rewriteHostedRelation(
  body: string,
  existing: EntityRelationRecord | null,
  replacement: EntityRelationRecord | null
): string {
  let next = body;
  if (existing) {
    const before = formatRelationFlowRecord(existing);
    if (!next.includes(before)) throw compilerAdmission("RELATION_HOST_CODEC_MISMATCH");
    next = next.replace(before, formatRelationFlowRecord({ ...existing, state: "retired" }));
  }
  if (!replacement) return next;
  if (next.includes(`relation_id: ${replacement.relation_id}`)) throw compilerAdmission("RELATION_ALREADY_EXISTS");
  const line = formatRelationFlowRecord(replacement);
  if (/^relations:\s*$/mu.test(next)) return next.replace(/^relations:\s*$/mu, (heading) => `${heading}\n${line}`);
  const frontmatter = /^---\r?\n([\s\S]*?)\r?\n---/u.exec(next);
  if (frontmatter) return next.replace(frontmatter[0], `${frontmatter[0].slice(0, -3)}relations:\n${line}\n---`);
  const base = next.endsWith("\n") ? next : `${next}\n`;
  return `${base}\nrelations:\n${line}\n`;
}

function targetFactInSameHost(target: string, taskId: string): ReadonlyArray<string> {
  const segments = target.split("/");
  return segments[0] === "fact" && segments[1] === taskId && segments[2] ? [segments[2]] : [];
}

function plan(mutations: RegistryMutationPlanInput["mutations"]): RegistryMutationPlanInput {
  return { registryVersion, mutations };
}

function entityRef(entityKind: string, canonicalRef: string): RegistryEntityRefV2 {
  return { registryVersion, entityKind, canonicalRef };
}

function entityRefKey(ref: RegistryEntityRefV2): string {
  return `${ref.registryVersion}\0${ref.entityKind}\0${ref.canonicalRef}`;
}

function uniqueRefs(refs: ReadonlyArray<RegistryEntityRefV2>): ReadonlyArray<RegistryEntityRefV2> {
  return [...new Map(refs.map((ref) => [entityRefKey(ref), ref])).values()];
}

function compilerAdmission(code: string, message = code): SemanticAdmissionErrorV2 {
  return new SemanticAdmissionErrorV2(code, message);
}

function compilerBytesEqual(left: Uint8Array, right: Uint8Array): boolean {
  return Buffer.from(left).equals(Buffer.from(right));
}

function nullableBytesEqual(left: Uint8Array | null, right: Uint8Array | null): boolean {
  return left === null || right === null ? left === right : compilerBytesEqual(left, right);
}
