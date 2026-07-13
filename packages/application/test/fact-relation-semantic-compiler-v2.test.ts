// harness-test-tier: contract
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
  materializeCommittedAttributionEventV2,
  materializeCommittedAttributionProjectionV2,
  assertMutationClaimMatchesV2,
  canonicalPayloadDigestV2,
  encodeFactRelationCommandPayloadV2,
  makeFactRelationSemanticCompilerV2,
  semanticMutationEnvelopeV2Schema,
  semanticMutationSetDigestV2,
  semanticRequestDigestV2,
  type FactRelationAuthorityStateV2,
  type FactRelationCommandPayloadV2,
  type HostedDocumentSnapshotV2,
  type PathCasV2,
  type RegistryEntityRefV2,
  type SemanticBaseCasV2,
  type SemanticEntityBaseV2,
  type SemanticMutationEnvelopeV2,
  type SemanticMutationSetV2,
  type VerifiedActorAxesBindingV2
} from "../src/index.ts";
import { authorizeSemanticCompilationV2 } from "../src/authority/semantic-authorizer-v2.ts";
import {
  compileRegistryMutationPlan,
  createWritableEntityRegistry,
  deriveRelationId,
  actorAxesBindingCoreDigestV2,
  encodeCanonicalCbor,
  entityRegistry,
  formatRelationFlowRecord,
  semanticMutationWireV2,
  type EntityRelationRecord
} from "../../kernel/src/index.ts";

const registry = createWritableEntityRegistry([entityRegistry.fact, entityRegistry.relation]);
const existingDigest = Buffer.alloc(32, 0x11);

test("fact/relation registry enables only the OQ-3 entity-level actions and remains typed-only", () => {
  assert.deepEqual(entityRegistry.fact.mutationContract, { status: "ready", actions: ["create", "invalidate"] });
  assert.deepEqual(entityRegistry.relation.mutationContract, { status: "ready", actions: ["create", "retire"] });
  assert.equal(entityRegistry.fact.semanticDiff.status, "typed-only");
  assert.equal(entityRegistry.relation.semanticDiff.status, "typed-only");
  assert.doesNotThrow(() => createWritableEntityRegistry([entityRegistry.fact, entityRegistry.relation]));
});

test("fact create and invalidate compile exact hosted mutations without standalone entity files", async () => {
  const factCreate = factCreatePayload();
  const factRef = ref("fact", "fact/task_T/F-CREATES1");
  const createCompiler = makeFactRelationSemanticCompilerV2({ state: state() });
  const created = await createCompiler.compile(envelope(factCreate, [absent(factRef)]));
  const createdPlan = compileRegistryMutationPlan(registry, created.mutationPlan);

  assert.deepEqual(createdPlan.mutationSet.mutations.map(pair), ["fact/task_T/F-CREATES1:create"]);
  assert.deepEqual(createdPlan.storagePlan.touchedPaths, ["tasks/task_T/facts.md"]);
  assert.equal(created.operation.entityId, "task/task_T", "WriteOp entityId remains the physical hosted lock owner");
  assert.equal(created.operation.kind, "doc_write");

  const relationId = invalidationRelationId("task_T", "F-DEADBEEF", "F-CAFEBABE");
  const invalidatedRef = ref("fact", "fact/task_T/F-DEADBEEF");
  const invalidatorRef = ref("fact", "fact/task_T/F-CAFEBABE");
  const relationRef = ref("relation", `relation/${relationId}`);
  const invalidateState = state(new Map([
    [key(invalidatedRef), base("fact-v1")],
    [key(invalidatorRef), base("fact-v2")]
  ]));
  const invalidated = await makeFactRelationSemanticCompilerV2({ state: invalidateState }).compile(envelope(
    factInvalidatePayload(),
    [present(invalidatedRef, "fact-v1"), present(invalidatorRef, "fact-v2"), absent(relationRef)]
  ));
  const invalidatedPlan = compileRegistryMutationPlan(registry, invalidated.mutationPlan);

  assert.deepEqual(invalidatedPlan.mutationSet.mutations.map(pair), [
    `relation/${relationId}:create`,
    "fact/task_T/F-DEADBEEF:invalidate"
  ]);
  assert.deepEqual(invalidatedPlan.storagePlan.targets, [
    { kind: "document", path: "tasks/task_T/facts.md", access: "exact" }
  ]);
  assert.deepEqual(invalidatedPlan.storagePlan.consistencyScopes, ["path:tasks/task_T/facts.md"]);
  assert.equal(invalidated.operation.kind, "fact_invalidate");
  assert.equal(Array.isArray(invalidated.operation.payload), false, "one typed operation produces one physical WriteOp");
});

test("relation replace compiles retire old plus create new into one CAS-protected hosted op and plan", async () => {
  const oldRelation = relation("task/task_T", "task/task_U", "depends-on");
  const replacement = relation("task/task_T", "task/task_V", "depends-on");
  const taskRef = ref("task", "task/task_T");
  const oldRef = ref("relation", `relation/${oldRelation.relation_id}`);
  const newRef = ref("relation", `relation/${replacement.relation_id}`);
  const path = "tasks/task_T/INDEX.md";
  const snapshot = documentSnapshot(`---\nschema: task/v1\nrelations:\n${formatRelationFlowRecord(oldRelation)}\n---\n\n# Task\n`);
  const compiler = makeFactRelationSemanticCompilerV2({
    state: state(new Map([
      [key(taskRef), base("task-v3")],
      [key(oldRef), base("relation-v1")]
    ]), new Map([[path, snapshot]]))
  });
  const compiled = await compiler.compile(envelope(
    { schema: "relation.replace/v1", sourceRef: "task/task_T", relationId: oldRelation.relation_id, replacement },
    [present(taskRef, "task-v3"), present(oldRef, "relation-v1"), absent(newRef)],
    [pathCas(path, snapshot)]
  ));
  const plan = compileRegistryMutationPlan(registry, compiled.mutationPlan);

  assert.deepEqual(plan.mutationSet.mutations.map(pair), [
    `relation/${replacement.relation_id}:create`,
    `relation/${oldRelation.relation_id}:retire`
  ].sort());
  assert.deepEqual(plan.storagePlan.touchedPaths, [path]);
  assert.equal(compiled.operation.kind, "doc_sync_submit");
  const writes = (compiled.operation.payload as { readonly writes: ReadonlyArray<{ readonly path: string; readonly body: string }> }).writes;
  assert.equal(writes.length, 1);
  assert.equal(writes[0]!.path, path);
  assert.match(writes[0]!.body, new RegExp(`relation_id: ${oldRelation.relation_id}[^\n]*state: retired`, "u"));
  assert.match(writes[0]!.body, new RegExp(`relation_id: ${replacement.relation_id}[^\n]*state: active`, "u"));
});

test("six admission controls reject omission, addition, relabel, digest, scope, and base-CAS before a WriteOp exists", async () => {
  const relationId = invalidationRelationId("task_T", "F-DEADBEEF", "F-CAFEBABE");
  const invalidatedRef = ref("fact", "fact/task_T/F-DEADBEEF");
  const invalidatorRef = ref("fact", "fact/task_T/F-CAFEBABE");
  const relationRef = ref("relation", `relation/${relationId}`);
  const authoritativeState = state(new Map([
    [key(invalidatedRef), base("fact-v1")],
    [key(invalidatorRef), base("fact-v2")]
  ]));
  const compiler = makeFactRelationSemanticCompilerV2({ state: authoritativeState });
  const baseCas = [present(invalidatedRef, "fact-v1"), present(invalidatorRef, "fact-v2"), absent(relationRef)];
  const draft = envelope(factInvalidatePayload(), baseCas);
  const compilation = await compiler.compile(draft);
  const exact = compileRegistryMutationPlan(registry, compilation.mutationPlan).mutationSet;
  const omission = { ...exact, mutations: exact.mutations.slice(0, 1) };
  const addition = {
    ...exact,
    mutations: canonicalMutations([...exact.mutations, {
      entity: ref("fact", "fact/task_T/F-ABCD1234"),
      action: { registryVersion: 1, action: "create" }
    }])
  };
  const relabel = {
    ...exact,
    mutations: canonicalMutations(exact.mutations.map((mutation) => mutation.entity.entityKind === "fact"
      ? { ...mutation, action: { ...mutation.action, action: "create" } }
      : mutation))
  };

  for (const claim of [omission, addition, relabel]) {
    assert.throws(() => assertMutationClaimMatchesV2(withClaim(draft, claim), exact), /SEMANTIC_MUTATION_MISMATCH/u);
  }
  const badMutationDigest = finalize({
    ...draft,
    claimedMutationSet: exact,
    claimedSemanticMutationSetDigest: Buffer.alloc(32, 0xff)
  });
  assert.throws(() => assertMutationClaimMatchesV2(badMutationDigest, exact), /SEMANTIC_MUTATION_DIGEST_MISMATCH/u);

  const scoped = withClaim(draft, exact);
  assert.throws(() => authorizeSemanticCompilationV2(
    scoped,
    ["tasks/task_T/facts.md"],
    compilation.decodedBytes,
    factOnlyVerifiedBinding() as VerifiedActorAxesBindingV2
  ), /TOKEN_ENTITY_KIND_SCOPE_DENIED/u);

  const wrongBase = baseCas.map((entry, index) => index === 0
    ? { ...entry, expectedStateDigest: Buffer.alloc(32, 0xee) }
    : entry);
  await assert.rejects(compiler.compile(envelope(factInvalidatePayload(), wrongBase)), /BASE_CAS_CONFLICT/u);

  const digestEnvelope = envelope(factInvalidatePayload(), baseCas);
  if (digestEnvelope.intent.kind !== "typed") throw new Error("fixture must be typed");
  const corruptedPayloadDigest = finalize({
    ...digestEnvelope,
    intent: { ...digestEnvelope.intent, canonicalPayloadDigest: Buffer.alloc(32, 0xdd) }
  });
  await assert.rejects(compiler.compile(corruptedPayloadDigest), /CANONICAL_PAYLOAD_DIGEST_MISMATCH/u);
});

test("receipt, complete event, and W1 event-mutation projection preserve one semantic and ActorAxes digest", () => {
  const mutationSet: SemanticMutationSetV2 = {
    registryVersion: 1,
    mutations: canonicalMutations([
      { entity: ref("fact", "fact/task_T/F-DEADBEEF"), action: { registryVersion: 1, action: "invalidate" } },
      { entity: ref("relation", "relation/rel_0123456789abcdef"), action: { registryVersion: 1, action: "create" } }
    ])
  };
  const actorAxesBinding = {
    bindingId: "binding-w2",
    principalPersonId: "person_zeyu",
    executorAgentId: "agent_w2",
    workspaceId: "workspace-w2",
    deviceId: "device-w2",
    viewId: "view-w2",
    sessionId: "session-w2",
    schemaTuple
  };
  const mutationDigest = Buffer.from(semanticMutationSetDigestV2(mutationSet)).toString("hex");
  const actorDigest = Buffer.from(actorAxesBindingCoreDigestV2(actorAxesBinding)).toString("hex");
  const event = materializeCommittedAttributionEventV2({
    receipt: {
      tag: "COMMITTED",
      workspaceId: "workspace-w2",
      opId: "op-w2",
      semanticDigest: "33".repeat(32),
      revision: 8,
      commitSha: "a".repeat(40),
      previousCommit: "b".repeat(40),
      authorityIntegrity: {
        schema: "authority-operation-integrity/v2",
        semanticRequestDigest: "33".repeat(32),
        semanticMutationSetDigest: mutationDigest,
        mutationRegistryVersion: 1,
        actorAxesBindingDigest: actorDigest,
        canonicalMutationSet: mutationSet
      }
    },
    actorAxesBinding,
    physicalChanges: [{ path: "tasks/task_T/facts.md", beforeDigest: "44".repeat(32), afterDigest: "55".repeat(32) }],
    occurredAt: "2026-07-13T00:00:00.000Z",
    recordedAt: "2026-07-13T00:00:00.001Z"
  });
  const root = mkdtempSync(path.join(tmpdir(), "ha-w2-attribution-"));
  try {
    const projectionPath = path.join(root, "projection.sqlite");
    writeFileSync(projectionPath, "", "utf8");
    const rows = materializeCommittedAttributionProjectionV2(projectionPath, [event]);
    assert.equal(event.semanticMutationSetDigest, mutationDigest);
    assert.equal(event.actorAxesBindingDigest, actorDigest);
    assert.deepEqual(rows.map((row) => [row.subjectRef, row.operation]), mutationSet.mutations.map((mutation) => [
      mutation.entity.canonicalRef,
      mutation.action.action
    ]));
    assert.equal(rows.every((row) => row.completeness === "complete"), true);
    assert.equal(rows.every((row) => Object.values(row.digestStatus).every((status) => status === "verified")), true);
    assert.equal(rows.every((row) => row.actor.principal.personId === "person_zeyu" && row.actor.executor?.id === "agent_w2"), true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

function envelope(
  payload: FactRelationCommandPayloadV2,
  baseCas: ReadonlyArray<SemanticBaseCasV2>,
  declaredPathCas: ReadonlyArray<PathCasV2> = []
): SemanticMutationEnvelopeV2 {
  const bytes = encodeFactRelationCommandPayloadV2(payload);
  const mutationSet: SemanticMutationSetV2 = { registryVersion: 1, mutations: [] };
  return finalize({
    schema: semanticMutationEnvelopeV2Schema,
    workspaceId: "workspace-w2",
    operationId: {
      namespace: {
        schema: "operation-namespace/v1",
        workspaceId: "workspace-w2",
        deviceId: "device-w2",
        authorityGeneration: 1n,
        namespaceId: "namespace-w2",
        expiresAt: 9_000n,
        issuer: "authority.test",
        keyId: "namespace-key",
        proof: Buffer.alloc(32, 3)
      },
      clientRandom128: Buffer.alloc(16, 4)
    },
    binding: {
      bindingId: "binding-w2",
      actorAxesBindingDigest: Buffer.alloc(32, 5),
      deviceId: "device-w2",
      viewId: "view-w2",
      sessionId: "session-w2",
      admissionTokenRef: { tokenId: "token-w2", tokenDigest: Buffer.alloc(32, 6) }
    },
    schemaTuple: schemaTuple,
    intent: {
      kind: "typed",
      command: { registryVersion: 1, name: payload.schema.replace("/v1", ""), version: 1 },
      canonicalPayload: { kind: "inline", size: BigInt(bytes.length), bytes },
      canonicalPayloadDigest: canonicalPayloadDigestV2(bytes),
      baseCas,
      declaredPathCas
    },
    claimedMutationSet: mutationSet,
    claimedSemanticMutationSetDigest: semanticMutationSetDigestV2(mutationSet),
    claimedSemanticRequestDigest: Buffer.alloc(32)
  });
}

function finalize(envelope: SemanticMutationEnvelopeV2): SemanticMutationEnvelopeV2 {
  return { ...envelope, claimedSemanticRequestDigest: semanticRequestDigestV2(envelope) };
}

function withClaim(envelope: SemanticMutationEnvelopeV2, claim: SemanticMutationSetV2): SemanticMutationEnvelopeV2 {
  return finalize({
    ...envelope,
    claimedMutationSet: claim,
    claimedSemanticMutationSetDigest: semanticMutationSetDigestV2(claim)
  });
}

function state(
  bases = new Map<string, SemanticEntityBaseV2>(),
  documents = new Map<string, HostedDocumentSnapshotV2>()
): FactRelationAuthorityStateV2 {
  return {
    readEntityBase: async (entityRef) => bases.get(key(entityRef)) ?? null,
    readHostedDocument: async (path) => documents.get(path) ?? null
  };
}

function base(semanticVersion: string): SemanticEntityBaseV2 {
  return { semanticVersion, stateDigest: existingDigest };
}

function present(entityRef: RegistryEntityRefV2, semanticVersion: string): SemanticBaseCasV2 {
  return { entityRef, expectedSemanticVersion: semanticVersion, expectedStateDigest: existingDigest };
}

function absent(entityRef: RegistryEntityRefV2): SemanticBaseCasV2 {
  return { entityRef, expectedSemanticVersion: null, expectedStateDigest: null };
}

function ref(entityKind: string, canonicalRef: string): RegistryEntityRefV2 {
  return { registryVersion: 1, entityKind, canonicalRef };
}

function key(entityRef: RegistryEntityRefV2): string {
  return `${entityRef.registryVersion}\0${entityRef.entityKind}\0${entityRef.canonicalRef}`;
}

function pair(mutation: SemanticMutationSetV2["mutations"][number]): string {
  return `${mutation.entity.canonicalRef}:${mutation.action.action}`;
}

function factCreatePayload(): FactRelationCommandPayloadV2 {
  return {
    schema: "fact.create/v1",
    ownerTaskId: "task_T",
    factId: "F-CREATES1",
    statement: "Authority compiles this fact.",
    source: "test",
    observedAt: "2026-07-13T00:00:00.000Z",
    confidence: "high",
    memoryClass: "episodic",
    memoryTags: [],
    provenance: [{ runtime: "codex", sessionId: "session-w2", boundAt: "2026-07-13T00:00:00.000Z" }]
  };
}

function factInvalidatePayload(): FactRelationCommandPayloadV2 {
  return {
    schema: "fact.invalidate/v1",
    ownerTaskId: "task_T",
    factId: "F-DEADBEEF",
    invalidatedByFactId: "F-CAFEBABE",
    rationale: "New evidence supersedes the old fact."
  };
}

function invalidationRelationId(taskId: string, oldFactId: string, newFactId: string): string {
  return deriveRelationId({
    source: `fact/${taskId}/${newFactId}`,
    target: `fact/${taskId}/${oldFactId}`,
    type: "supersedes-fact",
    direction: "directed"
  });
}

function relation(source: string, target: string, type: EntityRelationRecord["type"]): EntityRelationRecord {
  const identity = { source, target, type, direction: "directed" as const };
  return {
    relation_id: deriveRelationId(identity),
    ...identity,
    strength: "strong",
    origin: "declared",
    rationale: "test relation",
    state: "active"
  };
}

function documentSnapshot(body: string): HostedDocumentSnapshotV2 {
  return { body, epoch: "epoch-w2", revision: 7n, blobDigest: Buffer.alloc(32, 0x22) };
}

function pathCas(path: string, snapshot: HostedDocumentSnapshotV2): PathCasV2 {
  return {
    path,
    expectedEpoch: snapshot.epoch,
    expectedRevision: snapshot.revision,
    expectedBlobDigest: snapshot.blobDigest
  };
}

function factOnlyVerifiedBinding(): unknown {
  return {
    token: {
      claims: {
        schemaTuple,
        maxBytes: 64n * 1024n,
        maxMutations: 8,
        allowedEntityKinds: ["fact"],
        allowedActions: ["create", "invalidate"],
        resourceScopes: [{ kind: "workspace" }],
        pathFootprint: null
      }
    }
  };
}

function canonicalMutations(
  mutations: SemanticMutationSetV2["mutations"]
): SemanticMutationSetV2["mutations"] {
  return [...mutations].sort((left, right) => Buffer.compare(
    Buffer.from(encodeCanonicalCbor(semanticMutationWireV2(left))),
    Buffer.from(encodeCanonicalCbor(semanticMutationWireV2(right)))
  ));
}

const schemaTuple = {
  wire: 2,
  event: 2,
  receipt: 2,
  digest: 2,
  policy: 1,
  commandRegistry: 1,
  entityRegistry: 1,
  mutationRegistry: 1,
  localState: 1,
  applyJournal: 1
} as const;
