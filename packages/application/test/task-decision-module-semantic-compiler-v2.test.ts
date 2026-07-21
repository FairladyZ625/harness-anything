// harness-test-tier: contract
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
  assertMutationClaimMatchesV2,
  canonicalPayloadDigestV2,
  compileManagedCandidateTreeV2,
  encodeFactRelationCommandPayloadV2,
  encodeTaskDecisionModuleCommandPayloadV2,
  makeFactRelationSemanticCompilerV2,
  makeTaskDecisionModuleSemanticCompilerV2,
  materializeCommittedAttributionEventV2,
  materializeCommittedAttributionProjectionV2,
  readModuleAttributionProjection,
  semanticMutationEnvelopeV2Schema,
  semanticMutationSetDigestV2,
  semanticRequestDigestV2,
  type FactRelationCommandPayloadV2,
  type HostedDocumentSnapshotV2,
  type ModuleRecordV2,
  type PathCasV2,
  type RegistryEntityRefV2,
  type SemanticBaseCasV2,
  type SemanticEntityBaseV2,
  type SemanticMutationEnvelopeV2,
  type SemanticMutationSetV2,
  type TaskDecisionModuleCommandPayloadV2
} from "../src/index.ts";
import {
  actorAxesBindingCoreDigestV2,
  compileRegistryMutationPlan,
  createWritableEntityRegistry,
  deriveRelationId,
  entityRegistry,
  ManagedSemanticDiffError,
  type DecisionPackage,
  type EntityRegistration,
  type EntityRelationRecord
} from "../../kernel/src/index.ts";

const registry = createWritableEntityRegistry([
  entityRegistry.task,
  entityRegistry.decision,
  entityRegistry.module,
  entityRegistry.relation
]);
const stateDigest = Buffer.alloc(32, 0x11);

test("task/decision register W5 semanticDiff while non-markdown module stays typed-only", () => {
  assert.deepEqual(entityRegistry.task.mutationContract, { status: "ready", actions: ["create", "transition", "append", "document"] });
  assert.deepEqual(entityRegistry.decision.mutationContract, { status: "ready", actions: ["propose", "state", "amend", "relation"] });
  assert.deepEqual(entityRegistry.module.mutationContract, { status: "ready", actions: ["register", "unregister", "step"] });
  assert.equal(entityRegistry.task.semanticDiff.status, "ready");
  assert.equal(entityRegistry.decision.semanticDiff.status, "ready");
  assert.equal(entityRegistry.module.semanticDiff.status, "typed-only");
  assert.equal(entityRegistry.module.projectionFacet.status, "ready");
  assert.deepEqual(entityRegistry.module.projectionFacet.status === "ready"
    ? entityRegistry.module.projectionFacet.attributionTarget
    : null, {
    table: "module_attribution_projection",
    idColumn: "module_key",
    identityField: "moduleKey",
    materialization: "mutation-index"
  });
});

test("managed heading regions merge multi-file task prose without guessing the subject from its path", () => {
  const taskId = "task_T";
  const indexPath = `tasks/${taskId}-folder/INDEX.md`;
  const planPath = `tasks/${taskId}-folder/task_plan.md`;
  const briefPath = `tasks/${taskId}-folder/brief.md`;
  const base = {
    documents: [
      { path: indexPath, body: taskIndex(taskId, "active") },
      { path: planPath, body: managedBody("Plan", "## Goal", "Old goal") },
      { path: briefPath, body: managedBody("Brief", "## Summary", "Old summary") }
    ]
  };
  const candidate = {
    documents: [
      { path: indexPath, body: taskIndex(taskId, "active") },
      { path: planPath, body: managedBody("Plan", "## Goal", "New goal") },
      { path: briefPath, body: managedBody("Brief", "## Summary", "New summary") }
    ]
  };
  const mutationPlan = compileManagedCandidateTreeV2(base, candidate, [
    freeProsePolicy(planPath, "## Goal"),
    freeProsePolicy(briefPath, "## Summary")
  ], [{ kind: "task", semanticDiff: entityRegistry.task.semanticDiff }]);
  assert.equal(mutationPlan.mutations.length, 1);
  assert.deepEqual(mutationPlan.mutations[0]?.identity, { taskId });
  assert.equal(mutationPlan.mutations[0]?.action, "document");
  const compiled = compileRegistryMutationPlan(createWritableEntityRegistry([entityRegistry.task]), mutationPlan);
  assert.deepEqual(compiled.storagePlan.touchedPaths, [briefPath, planPath]);

  assert.throws(() => compileManagedCandidateTreeV2({
    documents: [{ path: planPath, body: managedBody("Plan", "## Goal", "Old goal") }]
  }, {
    documents: [{ path: planPath, body: managedBody("Plan", "## Goal", "New goal") }]
  }, [freeProsePolicy(planPath, "## Goal")], [{ kind: "task", semanticDiff: entityRegistry.task.semanticDiff }]), /SEMANTIC_DIFF_REQUIRED:task identity must come from INDEX\.md/u);
});

test("managed heading regions fail closed on undeclared, duplicate, machine-written, and forbidden edits", () => {
  const documentPath = "tasks/task_T-folder/task_plan.md";
  const index = { path: "tasks/task_T-folder/INDEX.md", body: taskIndex("task_T", "active") };
  const compile = (baseBody: string, candidateBody: string, writeMode: "free-prose" | "machine-written" | "forbidden") =>
    compileManagedCandidateTreeV2({ documents: [index, { path: documentPath, body: baseBody }] }, {
      documents: [index, { path: documentPath, body: candidateBody }]
    }, [{
      path: documentPath,
      sections: [{
        anchor: "## Goal",
        writeMode,
        ...(writeMode === "free-prose" ? { semanticClass: "host-prose-only" as const } : {})
      }]
    }], [{ kind: "task", semanticDiff: entityRegistry.task.semanticDiff }]);

  assert.throws(() => compile(
    managedBody("Plan", "## Goal", "Old"),
    `${managedBody("Plan", "## Goal", "New")}\n## Surprise\n\nUndeclared.\n`,
    "free-prose"
  ), (error: unknown) => error instanceof ManagedSemanticDiffError
    && error.code === "SEMANTIC_DIFF_REQUIRED"
    && /undeclared section/u.test(error.message));
  assert.throws(() => compile(
    managedBody("Plan", "## Goal", "Old"),
    `${managedBody("Plan", "## Goal", "New")}\n## Goal\n\nDuplicate.\n`,
    "free-prose"
  ), (error: unknown) => error instanceof ManagedSemanticDiffError
    && error.code === "SEMANTIC_DIFF_AMBIGUOUS"
    && /duplicate heading/u.test(error.message));
  assert.throws(() => compile(
    managedBody("Plan", "## Goal", "Old"), managedBody("Plan", "## Goal", "New"), "machine-written"
  ), /SEMANTIC_DIFF_REQUIRED:machine-written section requires typed command/u);
  assert.throws(() => compile(
    managedBody("Plan", "## Goal", "Old"), managedBody("Plan", "## Goal", "New"), "forbidden"
  ), /SEMANTIC_DIFF_REQUIRED:forbidden section changed/u);
});

test("host-prose policies allow undeclared sections without weakening their declared skeleton", () => {
  const taskId = "task_T";
  const documentPath = `tasks/${taskId}-folder/task_plan.md`;
  const index = { path: `tasks/${taskId}-folder/INDEX.md`, body: taskIndex(taskId, "active") };
  const policy = {
    ...freeProsePolicy(documentPath, "## Goal"),
    undeclaredSections: "allow" as const
  };

  assert.doesNotThrow(() => compileManagedCandidateTreeV2({
    documents: [index, { path: documentPath, body: managedBody("Plan", "## Goal", "Old") }]
  }, {
    documents: [index, {
      path: documentPath,
      body: `${managedBody("Plan", "## Goal", "Old")}\n## Review Addendum\n\nNew context.\n`
    }]
  }, [policy], [{ kind: "task", semanticDiff: entityRegistry.task.semanticDiff }]));

  assert.throws(() => compileManagedCandidateTreeV2({
    documents: [index, { path: documentPath, body: managedBody("Plan", "## Goal", "Old") }]
  }, {
    documents: [index, { path: documentPath, body: managedBody("Plan", "## Purpose", "Old") }]
  }, [policy], [{ kind: "task", semanticDiff: entityRegistry.task.semanticDiff }]),
  /SEMANTIC_DIFF_AMBIGUOUS:section identity changed/u);
});

test("all task actions compile to one exact package-hosted StoragePlan", async () => {
  const taskId = "task_T";
  const taskRef = ref("task", `task/${taskId}`);
  const index = taskIndex(taskId, "planned");
  const indexSnapshot = snapshot(index);
  const bases = new Map([[key(taskRef), base("task-v1")]]);
  const documents = new Map([[`tasks/${taskId}/INDEX.md`, indexSnapshot]]);
  const compiler = makeTaskDecisionModuleSemanticCompilerV2({ state: authorityState(bases, documents) });

  const fixtures: ReadonlyArray<{
    readonly payload: TaskDecisionModuleCommandPayloadV2;
    readonly baseCas: ReadonlyArray<SemanticBaseCasV2>;
    readonly pathCas?: ReadonlyArray<PathCasV2>;
    readonly pair: string;
    readonly target: string;
    readonly opKind: string;
  }> = [
    {
      payload: { schema: "task.create/v1", taskId: "task_NEW", packageSlug: "new", indexBody: taskIndex("task_NEW", "planned") },
      baseCas: [absent(ref("task", "task/task_NEW"))],
      pair: "task/task_NEW:create", target: "tasks/task_NEW/INDEX.md", opKind: "package_create"
    },
    {
      payload: { schema: "task.transition/v1", taskId, to: "active" },
      baseCas: [present(taskRef, "task-v1")], pathCas: [cas(`tasks/${taskId}/INDEX.md`, indexSnapshot)],
      pair: `task/${taskId}:transition`, target: `tasks/${taskId}/INDEX.md`, opKind: "transition_local"
    },
    {
      payload: { schema: "task.append/v1", taskId, text: "2026-07-14 W3 typed progress" },
      baseCas: [present(taskRef, "task-v1")],
      pair: `task/${taskId}:append`, target: `tasks/${taskId}/progress.md`, opKind: "progress_append"
    },
    {
      payload: { schema: "task.document/v1", taskId, path: "notes/design.md", body: "# Design\n" },
      baseCas: [present(taskRef, "task-v1")],
      pair: `task/${taskId}:document`, target: `tasks/${taskId}/notes/design.md`, opKind: "doc_write"
    }
  ];

  for (const fixture of fixtures) {
    const compiled = await compiler.compile(envelope(fixture.payload, fixture.baseCas, fixture.pathCas));
    const plan = compileRegistryMutationPlan(registry, compiled.mutationPlan);
    assert.deepEqual(plan.mutationSet.mutations.map(pair), [fixture.pair]);
    assert.deepEqual(plan.storagePlan.touchedPaths, [fixture.target]);
    assert.deepEqual(plan.storagePlan.consistencyScopes, [`entity:task/${fixture.payload.taskId}`]);
    assert.equal(compiled.operation.kind, fixture.opKind);
  }
});

test("all decision actions compile exact decision mutations; relation also creates its first-class relation", async () => {
  const proposed = decisionPackage();
  const active = decisionPackage({
    state: "active",
    decidedAt: "2026-07-14T00:00:00.000Z",
    contentPins: [contentPin()]
  });
  const proposedSnapshot = snapshot(decisionDocument(proposed));
  const activeSnapshot = snapshot(decisionDocument(active));
  const decisionRef = ref("decision", "decision/dec_W3");
  const relation = relationRecord("decision/dec_W3/C1", "task/task_T", "relates");
  const relationRef = ref("relation", `relation/${relation.relation_id}`);

  const cases = [
    {
      payload: { schema: "decision.propose/v1", decision: proposed } as const,
      state: authorityState(), baseCas: [absent(decisionRef)], pathCas: [],
      expected: ["decision/dec_W3:propose"], opKind: "decision_propose"
    },
    {
      payload: { schema: "decision.state/v1", transition: "accept", decision: active } as const,
      state: authorityState(new Map([[key(decisionRef), base("decision-v1")]]), new Map([[decisionPath(), proposedSnapshot]])),
      baseCas: [present(decisionRef, "decision-v1")], pathCas: [cas(decisionPath(), proposedSnapshot)],
      expected: ["decision/dec_W3:state"], opKind: "decision_accept"
    },
    {
      payload: { schema: "decision.amend/v1", decision: { ...active, title: "Amended decision" } } as const,
      state: authorityState(new Map([[key(decisionRef), base("decision-v2")]]), new Map([[decisionPath(), activeSnapshot]])),
      baseCas: [present(decisionRef, "decision-v2")], pathCas: [cas(decisionPath(), activeSnapshot)],
      expected: ["decision/dec_W3:amend"], opKind: "decision_amend"
    },
    {
      payload: { schema: "decision.relation/v1", decisionId: "dec_W3", relation } as const,
      state: authorityState(new Map([[key(decisionRef), base("decision-v2")]]), new Map([[decisionPath(), activeSnapshot]])),
      baseCas: [present(decisionRef, "decision-v2"), absent(relationRef)], pathCas: [cas(decisionPath(), activeSnapshot)],
      expected: [`decision/dec_W3:relation`, `relation/${relation.relation_id}:create`], opKind: "decision_relate"
    }
  ];

  for (const fixture of cases) {
    const compiler = makeTaskDecisionModuleSemanticCompilerV2({ state: fixture.state });
    const compiled = await compiler.compile(envelope(fixture.payload, fixture.baseCas, fixture.pathCas));
    const plan = compileRegistryMutationPlan(registry, compiled.mutationPlan);
    assert.deepEqual(new Set(plan.mutationSet.mutations.map(pair)), new Set(fixture.expected));
    assert.deepEqual(plan.storagePlan.touchedPaths, [decisionPath()]);
    assert.equal(compiled.operation.kind, fixture.opKind);
  }
});

test("module register/unregister/step compile canonical modules.json snapshots", async () => {
  const module = moduleRecord();
  const moduleRef = ref("module", "module/kernel");
  const registryBody = `${JSON.stringify({ schema: "module-registry/v1", modules: [module] }, null, 2)}\n`;
  const registrySnapshot = snapshot(registryBody);
  const presentState = authorityState(
    new Map([[key(moduleRef), base("module-v1")]]),
    new Map([["modules.json", registrySnapshot]])
  );
  const fixtures = [
    {
      payload: { schema: "module.register/v1", module } as const,
      state: authorityState(), baseCas: [absent(moduleRef)], pathCas: [], action: "register"
    },
    {
      payload: { schema: "module.unregister/v1", moduleKey: "kernel" } as const,
      state: presentState, baseCas: [present(moduleRef, "module-v1")], pathCas: [cas("modules.json", registrySnapshot)], action: "unregister"
    },
    {
      payload: { schema: "module.step/v1", moduleKey: "kernel", stepId: "W3", state: "done" } as const,
      state: presentState, baseCas: [present(moduleRef, "module-v1")], pathCas: [cas("modules.json", registrySnapshot)], action: "step"
    }
  ];

  for (const fixture of fixtures) {
    const compiler = makeTaskDecisionModuleSemanticCompilerV2({ state: fixture.state });
    const compiled = await compiler.compile(envelope(fixture.payload, fixture.baseCas, fixture.pathCas));
    const plan = compileRegistryMutationPlan(registry, compiled.mutationPlan);
    assert.deepEqual(plan.mutationSet.mutations.map(pair), [`module/kernel:${fixture.action}`]);
    assert.deepEqual(plan.storagePlan.touchedPaths, ["modules.json"]);
    assert.equal(compiled.operation.entityId, "module/kernel");
    assert.equal(compiled.operation.kind, "module_registry_write");
    assert.equal((compiled.operation.payload as { readonly operation: string }).operation, fixture.action);
  }
});

test("every W3 action is independently disabled at the named registry boundary", async () => {
  for (const registration of [entityRegistry.task, entityRegistry.decision, entityRegistry.module] as const) {
    if (registration.mutationContract.status !== "ready") throw new Error("fixture requires ready mutation contract");
    for (const action of registration.mutationContract.actions) {
      const disabled = {
        ...registration,
        mutationContract: {
          status: "ready" as const,
          actions: registration.mutationContract.actions.filter((candidate) => candidate !== action)
        }
      } as EntityRegistration<string, typeof registration.kind>;
      const gated = createWritableEntityRegistry([disabled]);
      assert.throws(() => compileRegistryMutationPlan(gated, {
        registryVersion: 1,
        mutations: [{
          entityKind: registration.kind,
          identity: identityFor(registration.kind),
          action,
          ...(registration.kind === "task" ? { storageContext: { documentPath: "INDEX.md" } } : {})
        }]
      }), new RegExp(`UNKNOWN_SEMANTIC_ACTION:${registration.kind}:${action}`, "u"));
    }
  }
});

test("storage-only hosted fact bytes never upgrade into a task mutation", async () => {
  const factRef = ref("fact", "fact/task_T/F-DEADBEEF");
  const factPayload: FactRelationCommandPayloadV2 = {
    schema: "fact.create/v1",
    ownerTaskId: "task_T",
    factId: "F-DEADBEEF",
    statement: "Hosted storage is not a task semantic mutation.",
    source: "W3 boundary control",
    observedAt: "2026-07-14T00:00:00.000Z",
    confidence: "high",
    memoryClass: "episodic",
    memoryTags: [],
    provenance: [{ runtime: "codex", sessionId: "w3", boundAt: "2026-07-14T00:00:00.000Z" }]
  };
  const compiler = makeFactRelationSemanticCompilerV2({ state: authorityState() });
  const compiled = await compiler.compile(factEnvelope(factPayload, [absent(factRef)]));
  const plan = compileRegistryMutationPlan(createWritableEntityRegistry([entityRegistry.fact]), compiled.mutationPlan);
  assert.deepEqual(plan.storagePlan.touchedPaths, ["tasks/task_T/facts.md"]);
  assert.deepEqual(plan.mutationSet.mutations.map(pair), ["fact/task_T/F-DEADBEEF:create"]);
  assert.equal(plan.mutationSet.mutations.some((mutation) => mutation.entity.entityKind === "task"), false);

  const taskCompiler = makeTaskDecisionModuleSemanticCompilerV2({ state: authorityState() });
  await assert.rejects(taskCompiler.compile(envelope({
    schema: "task.document/v1", taskId: "task_T", path: "facts.md", body: "# Facts\n"
  }, [absent(ref("task", "task/task_T"))])), /TASK_DOCUMENT_SURFACE_OWNED_BY_TYPED_ACTION/u);
});

test("unknown command, transparent fallback, base-CAS, and mutation claim mismatch fail closed", async () => {
  const moduleRef = ref("module", "module/kernel");
  const payload = { schema: "module.register/v1", module: moduleRecord() } as const;
  const compiler = makeTaskDecisionModuleSemanticCompilerV2({ state: authorityState() });
  const draft = envelope(payload, [absent(moduleRef)]);
  const compiled = await compiler.compile(draft);
  const exact = compileRegistryMutationPlan(registry, compiled.mutationPlan).mutationSet;
  const omission: SemanticMutationSetV2 = { registryVersion: 1, mutations: [] };
  assert.throws(() => assertMutationClaimMatchesV2(withClaim(draft, omission), exact), /SEMANTIC_MUTATION_MISMATCH/u);

  if (draft.intent.kind !== "typed") throw new Error("fixture must be typed");
  await assert.rejects(compiler.compile(finalize({
    ...draft,
    intent: { ...draft.intent, command: { ...draft.intent.command, name: "module.unknown" } }
  })), /TYPED_COMMAND_UNREGISTERED/u);
  await assert.rejects(compiler.compile(finalize({
    ...draft,
    intent: { kind: "transparent-file", interpretation: "full-semantic", files: [] }
  })), /TYPED_COMMAND_REQUIRED/u);
  await assert.rejects(compiler.compile(envelope(payload, [present(moduleRef, "wrong-version")])), /ENTITY_BASE_CAS_CONFLICT/u);
});

test("module journal mutation appears in registry-derived attribution read surface with cross-layer digests", () => {
  const mutationSet: SemanticMutationSetV2 = {
    registryVersion: 1,
    mutations: [{
      entity: ref("module", "module/kernel"),
      action: { registryVersion: 1, action: "step" }
    }]
  };
  const actorAxesBinding = {
    bindingId: "binding-w3",
    principalPersonId: "person_zeyu",
    executorAgentId: "agent_w3",
    workspaceId: "workspace-w3",
    deviceId: "device-w3",
    viewId: "view-w3",
    sessionId: "session-w3",
    schemaTuple
  };
  const mutationDigest = Buffer.from(semanticMutationSetDigestV2(mutationSet)).toString("hex");
  const actorDigest = Buffer.from(actorAxesBindingCoreDigestV2(actorAxesBinding)).toString("hex");
  const event = materializeCommittedAttributionEventV2({
    receipt: {
      tag: "COMMITTED",
      workspaceId: "workspace-w3",
      opId: "op-module-step",
      semanticDigest: "33".repeat(32),
      revision: 9,
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
    physicalChanges: [{ path: "modules.json", beforeDigest: "44".repeat(32), afterDigest: "55".repeat(32) }],
    occurredAt: "2026-07-14T00:00:00.000Z",
    recordedAt: "2026-07-14T00:00:00.001Z"
  });
  const root = mkdtempSync(path.join(tmpdir(), "ha-w3-module-attribution-"));
  try {
    const projectionPath = path.join(root, "projection.sqlite");
    writeFileSync(projectionPath, "", "utf8");
    const rows = materializeCommittedAttributionProjectionV2(projectionPath, [event]);
    const modules = readModuleAttributionProjection(projectionPath, "kernel");
    assert.deepEqual(rows.map((row) => [row.subjectRef, row.operation]), [["module/kernel", "step"]]);
    assert.equal(event.semanticMutationSetDigest, mutationDigest);
    assert.equal(event.actorAxesBindingDigest, actorDigest);
    assert.equal(modules.length, 1);
    assert.equal(modules[0]?.moduleKey, "kernel");
    assert.equal(modules[0]?.attribution.completeness, "complete");
    assert.equal(modules[0]?.attribution.trailCount, 1);
    assert.equal(modules[0]?.attribution.latestActor?.principal.personId, "person_zeyu");
    assert.equal(modules[0]?.attribution.latestActor?.executor?.id, "agent_w3");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

function envelope(
  payloadValue: TaskDecisionModuleCommandPayloadV2,
  baseCas: ReadonlyArray<SemanticBaseCasV2>,
  declaredPathCas: ReadonlyArray<PathCasV2> = []
): SemanticMutationEnvelopeV2 {
  const payload = encodeTaskDecisionModuleCommandPayloadV2(payloadValue);
  return typedEnvelope(payloadValue.schema.replace("/v1", ""), payload, baseCas, declaredPathCas);
}

function factEnvelope(
  payloadValue: FactRelationCommandPayloadV2,
  baseCas: ReadonlyArray<SemanticBaseCasV2>
): SemanticMutationEnvelopeV2 {
  const payload = encodeFactRelationCommandPayloadV2(payloadValue);
  return typedEnvelope(payloadValue.schema.replace("/v1", ""), payload, baseCas, []);
}

function typedEnvelope(
  command: string,
  payload: Uint8Array,
  baseCas: ReadonlyArray<SemanticBaseCasV2>,
  declaredPathCas: ReadonlyArray<PathCasV2>
): SemanticMutationEnvelopeV2 {
  const mutationSet: SemanticMutationSetV2 = { registryVersion: 1, mutations: [] };
  return finalize({
    schema: semanticMutationEnvelopeV2Schema,
    workspaceId: "workspace-w3",
    operationId: {
      namespace: {
        schema: "operation-namespace/v1", workspaceId: "workspace-w3", deviceId: "device-w3",
        authorityGeneration: 1n, namespaceId: "namespace-w3", expiresAt: 9_000n,
        issuer: "authority.test", keyId: "namespace-key", proof: Buffer.alloc(32, 3)
      },
      clientRandom128: Buffer.alloc(16, 7)
    },
    binding: {
      bindingId: "binding-w3", actorAxesBindingDigest: Buffer.alloc(32, 4), deviceId: "device-w3",
      viewId: "view-w3", sessionId: "session-w3",
      admissionTokenRef: { tokenId: "token-w3", tokenDigest: Buffer.alloc(32, 5) }
    },
    schemaTuple,
    intent: {
      kind: "typed",
      command: { registryVersion: 1, name: command, version: 1 },
      canonicalPayload: { kind: "inline", size: BigInt(payload.length), bytes: payload },
      canonicalPayloadDigest: canonicalPayloadDigestV2(payload),
      baseCas,
      declaredPathCas
    },
    claimedMutationSet: mutationSet,
    claimedSemanticMutationSetDigest: semanticMutationSetDigestV2(mutationSet),
    claimedSemanticRequestDigest: Buffer.alloc(32)
  });
}

function finalize(envelopeValue: SemanticMutationEnvelopeV2): SemanticMutationEnvelopeV2 {
  return { ...envelopeValue, claimedSemanticRequestDigest: semanticRequestDigestV2(envelopeValue) };
}

function withClaim(envelopeValue: SemanticMutationEnvelopeV2, claim: SemanticMutationSetV2): SemanticMutationEnvelopeV2 {
  return finalize({
    ...envelopeValue,
    claimedMutationSet: claim,
    claimedSemanticMutationSetDigest: semanticMutationSetDigestV2(claim)
  });
}

function authorityState(
  bases: ReadonlyMap<string, SemanticEntityBaseV2> = new Map(),
  documents: ReadonlyMap<string, HostedDocumentSnapshotV2> = new Map()
) {
  return {
    readEntityBase: async (entityRef: RegistryEntityRefV2) => bases.get(key(entityRef)) ?? null,
    readHostedDocument: async (documentPath: string) => documents.get(documentPath) ?? null
  };
}

function decisionPackage(overrides: Partial<DecisionPackage> = {}): DecisionPackage {
  return {
    schema: "decision-package/v1",
    decision_id: "dec_W3",
    _coordinatorWatermark: "watermark-w3",
    title: "W3 decision",
    state: "proposed",
    riskTier: "medium",
    urgency: "medium",
    vertical: "software/coding",
    preset: "architecture-decision",
    applies_to: { modules: ["kernel"], productLines: [] },
    proposedAt: "2026-07-14T00:00:00.000Z",
    provenance: [{ runtime: "codex", sessionId: "session-w3", boundAt: "2026-07-14T00:00:00.000Z" }],
    question: "Should W3 compile typed mutations?",
    chosen: [{ id: "CH1", text: "Compile at the authority." }],
    rejected: [{ id: "RJ1", text: "Trust the client.", why_not: "Claims are completeness assertions only." }],
    claims: [{ id: "C1", text: "Authority recomputes the canonical set." }],
    relations: [],
    ...overrides
  };
}

function contentPin() {
  return {
    action: "accept" as const,
    state: "active" as const,
    decidedAt: "2026-07-14T00:00:00.000Z",
    arbiter: { kind: "human" as const, id: "person_zeyu" },
    canonicalization: "decision-content/v1" as const,
    digest: `sha256:${"a".repeat(64)}`
  };
}

function decisionDocument(decision: DecisionPackage): string {
  return [
    "---", `schema: ${decision.schema}`, `decision_id: ${decision.decision_id}`,
    `_coordinatorWatermark: ${decision._coordinatorWatermark ?? "watermark-w3"}`,
    `title: ${JSON.stringify(decision.title)}`, `state: ${decision.state}`,
    `riskTier: ${decision.riskTier}`, `urgency: ${decision.urgency}`,
    `vertical: ${JSON.stringify(decision.vertical)}`, `preset: ${JSON.stringify(decision.preset)}`,
    "applies_to:", `  modules: ${flowArray(decision.applies_to.modules)}`, `  productLines: ${flowArray(decision.applies_to.productLines)}`,
    `proposedAt: ${JSON.stringify(decision.proposedAt)}`,
    ...(decision.decidedAt ? [`decidedAt: ${JSON.stringify(decision.decidedAt)}`] : []),
    ...(decision.contentPins ? ["contentPins:", ...decision.contentPins.map((entry) => `  - ${flowObject(entry)}`)] : []),
    "provenance:", ...decision.provenance.map((entry) => `  - ${flowObject(entry)}`),
    `question: ${JSON.stringify(decision.question)}`,
    "chosen:", ...decision.chosen.map((entry) => `  - ${flowObject(entry)}`),
    "rejected:", ...decision.rejected.map((entry) => `  - ${flowObject(entry)}`),
    "claims:", ...decision.claims.map((entry) => `  - ${flowObject(entry)}`),
    "relations:", ...decision.relations.map((entry) => `  - ${flowObject(entry)}`),
    "---", "", `# ${decision.title}`, ""
  ].join("\n");
}

function flowArray(values: ReadonlyArray<string>): string {
  return `[${values.map((value) => JSON.stringify(value)).join(", ")}]`;
}

function flowObject(value: Record<string, unknown>): string {
  return `{ ${Object.entries(value).map(([key, entry]) => `${key}: ${flowValue(entry)}`).join(", ")} }`;
}

function flowValue(value: unknown): string {
  if (typeof value === "string") return JSON.stringify(value);
  if (Array.isArray(value)) return flowArray(value.map(String));
  if (value && typeof value === "object") return flowObject(value as Record<string, unknown>);
  return JSON.stringify(value);
}

function relationRecord(source: string, target: string, type: EntityRelationRecord["type"]): EntityRelationRecord {
  const row = {
    source, target, type, strength: "strong" as const, direction: "directed" as const,
    origin: "declared" as const, rationale: "W3 relation mutation.", state: "active" as const
  };
  return { relation_id: deriveRelationId(row), ...row };
}

function moduleRecord(): ModuleRecordV2 {
  return {
    key: "kernel", title: "Kernel", status: "active", scopes: ["packages/kernel/**"],
    shared: [], dependsOn: [], steps: []
  };
}

function taskIndex(taskId: string, status: string): string {
  return [
    "---", "schema: task-package/v2", `task_id: ${taskId}`, `title: ${taskId}`,
    "lifecycle:", "  bindingSchema: lifecycle-binding/v1", "  engine: local", `  status: ${status}`,
    "  ref: ", `  titleSnapshot: ${taskId}`, "  url: ",
    "  bindingCreatedAt: 2026-07-14T00:00:00.000Z", `  bindingFingerprint: sha256:${"b".repeat(64)}`,
    "packageDisposition: active", "vertical: default", "preset: default",
    "provenance:", "  - {runtime: codex, sessionId: session-w3, boundAt: 2026-07-14T00:00:00.000Z}",
    "---", "", `# ${taskId}`, ""
  ].join("\n");
}

function managedBody(title: string, anchor: string, body: string): string {
  return [`# ${title}`, "", anchor, "", body, ""].join("\n");
}

function freeProsePolicy(pathValue: string, anchor: string) {
  return {
    path: pathValue,
    sections: [{ anchor, writeMode: "free-prose" as const, semanticClass: "host-prose-only" as const }]
  };
}

function snapshot(body: string): HostedDocumentSnapshotV2 {
  return { body, epoch: "epoch-w3", revision: 7n, blobDigest: Buffer.alloc(32, 0x22) };
}

function cas(documentPath: string, value: HostedDocumentSnapshotV2): PathCasV2 {
  return { path: documentPath, expectedEpoch: value.epoch, expectedRevision: value.revision, expectedBlobDigest: value.blobDigest };
}

function ref(entityKind: string, canonicalRef: string): RegistryEntityRefV2 {
  return { registryVersion: 1, entityKind, canonicalRef };
}

function key(entityRef: RegistryEntityRefV2): string {
  return `${entityRef.registryVersion}\0${entityRef.entityKind}\0${entityRef.canonicalRef}`;
}

function base(semanticVersion: string): SemanticEntityBaseV2 {
  return { semanticVersion, stateDigest };
}

function present(entityRef: RegistryEntityRefV2, semanticVersion: string): SemanticBaseCasV2 {
  return { entityRef, expectedSemanticVersion: semanticVersion, expectedStateDigest: stateDigest };
}

function absent(entityRef: RegistryEntityRefV2): SemanticBaseCasV2 {
  return { entityRef, expectedSemanticVersion: null, expectedStateDigest: null };
}

function pair(mutation: SemanticMutationSetV2["mutations"][number]): string {
  return `${mutation.entity.canonicalRef}:${mutation.action.action}`;
}

function identityFor(kind: "task" | "decision" | "module") {
  if (kind === "task") return { taskId: "task_T" };
  if (kind === "decision") return { decisionId: "dec_W3" };
  return { moduleKey: "kernel" };
}

function decisionPath(): string {
  return "decisions/decision-dec_W3/decision.md";
}

const schemaTuple = {
  wire: 2, event: 2, receipt: 2, digest: 2, policy: 1,
  commandRegistry: 1, entityRegistry: 1, mutationRegistry: 1, localState: 1, applyJournal: 1
} as const;
