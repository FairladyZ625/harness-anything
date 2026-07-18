// harness-test-tier: contract
import assert from "node:assert/strict";
import test from "node:test";
import {
  canonicalPayloadDigestV2,
  classifyStaticZones,
  classifyTouchedZones,
  encodeSessionExecutionReviewCommandPayloadV2,
  makeSessionExecutionReviewSemanticCompilerV2,
  semanticMutationEnvelopeV2Schema,
  semanticMutationSetDigestV2,
  semanticRequestDigestV2,
  type ExecutionActionPayloadV2,
  type HostedDocumentSnapshotV2,
  type PathCasV2,
  type RegistryEntityRefV2,
  type ReviewActionPayloadV2,
  type SemanticBaseCasV2,
  type SemanticEntityBaseV2,
  type SemanticMutationEnvelopeV2,
  type SemanticMutationSetV2,
  type SessionActionPayloadV2,
  type SessionExecutionReviewCommandPayloadV2
} from "../src/index.ts";
import {
  compileRegistryMutationPlan,
  createWritableEntityRegistry,
  entityRegistry,
  sha256Text,
  type EntityRegistration,
  type ExecutionRecord,
  type ReviewRecord,
  type SessionManifest
} from "../../kernel/src/index.ts";

const taskId = "task_01KXD8H2QFMMA4T203PJZ77AQ5";
const executionId = "exe_01KXD8H2QFMMA4T203PJZ77AQ6";
const reviewId = "rev_01KXD8H2QFMMA4T203PJZ77AQ7";
const sessionId = "session-w4";
const stateDigest = Buffer.alloc(32, 0x11);
const registry = createWritableEntityRegistry([
  entityRegistry.session,
  entityRegistry.execution,
  entityRegistry.review,
  entityRegistry.task
]);

test("session/execution/review register only OQ-3 actions and remain DEFER-TYPED-ONLY", () => {
  assert.deepEqual(entityRegistry.session.mutationContract, { status: "ready", actions: ["export", "sync", "archive"] });
  assert.deepEqual(entityRegistry.execution.mutationContract, { status: "ready", actions: ["claim", "submit", "close"] });
  assert.deepEqual(entityRegistry.review.mutationContract, { status: "ready", actions: ["create", "dismiss", "record"] });
  for (const kind of ["session", "execution", "review"] as const) {
    assert.equal(entityRegistry[kind].semanticDiff.status, "typed-only");
    assert.equal(entityRegistry[kind].projectionFacet.status, "ready");
  }
});

test("all session actions compile one composite manifest plus immutable CAS body StoragePlan", async () => {
  const body = "# Session W4\n\nTyped composite body.\n";
  const sealed = sessionManifest(body, "sealed");
  const archived = sessionManifest(body, "archived");
  const sessionRef = ref("session", `session/${sessionId}`);
  const path = `sessions/${sessionId}.md`;
  const current = snapshot(JSON.stringify(sealed));
  const cases: ReadonlyArray<{
    readonly payload: SessionActionPayloadV2;
    readonly state: ReturnType<typeof authorityState>;
    readonly baseCas: ReadonlyArray<SemanticBaseCasV2>;
    readonly pathCas?: ReadonlyArray<PathCasV2>;
    readonly action: string;
  }> = [
    {
      payload: { schema: "session.export/v1", manifest: sealed, body },
      state: authorityState(), baseCas: [absent(sessionRef)], action: "export"
    },
    {
      payload: { schema: "session.sync/v1", manifest: sealed, body },
      state: authorityState(new Map([[key(sessionRef), base("session-v1")]]), new Map([[path, current]])),
      baseCas: [present(sessionRef, "session-v1")], pathCas: [cas(path, current)], action: "sync"
    },
    {
      payload: { schema: "session.archive/v1", manifest: archived, body },
      state: authorityState(new Map([[key(sessionRef), base("session-v2")]]), new Map([[path, current]])),
      baseCas: [present(sessionRef, "session-v2")], pathCas: [cas(path, current)], action: "archive"
    }
  ];
  for (const fixture of cases) {
    const compiled = await makeSessionExecutionReviewSemanticCompilerV2({ state: fixture.state })
      .compile(envelope(fixture.payload, fixture.baseCas, fixture.pathCas));
    const planned = compileRegistryMutationPlan(registry, compiled.mutationPlan);
    assert.deepEqual(planned.mutationSet.mutations.map(pair), [`session/${sessionId}:${fixture.action}`]);
    assert.deepEqual(planned.storagePlan.targets, [
      { kind: "content-addressed-blob", access: "exact", referenceField: "bodyRef" },
      { kind: "document", path, access: "exact" }
    ]);
    assert.deepEqual(planned.storagePlan.touchedPaths, [path]);
    assert.deepEqual(planned.storagePlan.consistencyScopes, [`entity:session/${sessionId}`]);
    const document = operationDocument(compiled.operation.payload);
    assert.equal(document.blobBody, body);
    assert.deepEqual(document.blobRef, fixture.payload.manifest.bodyRef);
    assert.equal(compiled.operation.kind, "doc_write");
  }
});

test("execution claim/submit/close compile exact hosted execution document plans", async () => {
  const executionRef = ref("execution", `execution/${taskId}/${executionId}`);
  const path = `tasks/${taskId}/executions/${executionId}.md`;
  const active = executionRecord("active");
  const submitted = executionRecord("submitted");
  const accepted = executionRecord("accepted");
  const activeSnapshot = snapshot(JSON.stringify(active));
  const submittedSnapshot = snapshot(JSON.stringify(submitted));
  const cases: ReadonlyArray<{
    readonly payload: ExecutionActionPayloadV2;
    readonly state: ReturnType<typeof authorityState>;
    readonly baseCas: ReadonlyArray<SemanticBaseCasV2>;
    readonly pathCas?: ReadonlyArray<PathCasV2>;
    readonly action: string;
  }> = [
    {
      payload: { schema: "execution.claim/v1", taskId, execution: active },
      state: authorityState(), baseCas: [absent(executionRef)], action: "claim"
    },
    {
      payload: { schema: "execution.submit/v1", taskId, execution: submitted },
      state: authorityState(new Map([[key(executionRef), base("execution-v1")]]), new Map([[path, activeSnapshot]])),
      baseCas: [present(executionRef, "execution-v1")], pathCas: [cas(path, activeSnapshot)], action: "submit"
    },
    {
      payload: { schema: "execution.close/v1", taskId, execution: accepted },
      state: authorityState(new Map([[key(executionRef), base("execution-v2")]]), new Map([[path, submittedSnapshot]])),
      baseCas: [present(executionRef, "execution-v2")], pathCas: [cas(path, submittedSnapshot)], action: "close"
    }
  ];
  for (const fixture of cases) {
    const compiled = await makeSessionExecutionReviewSemanticCompilerV2({ state: fixture.state })
      .compile(envelope(fixture.payload, fixture.baseCas, fixture.pathCas));
    const planned = compileRegistryMutationPlan(registry, compiled.mutationPlan);
    assert.deepEqual(planned.mutationSet.mutations.map(pair), [`execution/${taskId}/${executionId}:${fixture.action}`]);
    assert.deepEqual(planned.storagePlan.targets, [{ kind: "document", path, access: "exact" }]);
    assert.deepEqual(planned.storagePlan.consistencyScopes, [`path:${path}`]);
    assert.equal(operationDocument(compiled.operation.payload).identity.executionId, executionId);
  }
});

test("execution submit atomically transitions the task index to in_review", async () => {
  const executionRef = ref("execution", `execution/${taskId}/${executionId}`);
  const taskRef = ref("task", `task/${taskId}`);
  const executionPath = `tasks/${taskId}/executions/${executionId}.md`;
  const taskPath = `tasks/${taskId}/INDEX.md`;
  const active = snapshot(JSON.stringify(executionRecord("active")));
  const activeIndex = snapshot("---\n  status: active\n---\n");
  const inReviewIndex = activeIndex.body.replace("status: active", "status: in_review");
  const compiled = await makeSessionExecutionReviewSemanticCompilerV2({
    state: authorityState(
      new Map([[key(executionRef), base("execution-v1")], [key(taskRef), base("task-v1")]]),
      new Map([[executionPath, active], [taskPath, activeIndex]])
    )
  }).compile(envelope({
    schema: "execution.submit/v1",
    taskId,
    execution: executionRecord("submitted"),
    taskIndexBody: inReviewIndex
  }, [present(executionRef, "execution-v1"), present(taskRef, "task-v1")], [
    cas(executionPath, active), cas(taskPath, activeIndex)
  ]));

  const planned = compileRegistryMutationPlan(registry, compiled.mutationPlan);
  assert.deepEqual(planned.mutationSet.mutations.map(pair).sort(), [
    `execution/${taskId}/${executionId}:submit`, `task/${taskId}:transition`
  ].sort());
  assert.deepEqual((compiled.operation.payload as { readonly companionWrites?: unknown }).companionWrites, [
    { taskId, path: "INDEX.md", body: inReviewIndex }
  ]);
});

test("review create/dismiss/record compile immutable hosted review documents without task-host attribution", async () => {
  const cases: ReadonlyArray<{ readonly schema: ReviewActionPayloadV2["schema"]; readonly verdict: ReviewRecord["verdict"]; readonly action: string }> = [
    { schema: "review.create/v1", verdict: "changes_requested", action: "create" },
    { schema: "review.dismiss/v1", verdict: "dismissed", action: "dismiss" },
    { schema: "review.record/v1", verdict: "changes_requested", action: "record" }
  ];
  for (const fixture of cases) {
    const review = reviewRecord(fixture.verdict);
    const reviewRef = ref("review", `review/${taskId}/${reviewId}`);
    const compiled = await makeSessionExecutionReviewSemanticCompilerV2({ state: authorityState() }).compile(envelope({
      schema: fixture.schema, taskId, review
    }, [absent(reviewRef)]));
    const planned = compileRegistryMutationPlan(registry, compiled.mutationPlan);
    assert.deepEqual(planned.mutationSet.mutations.map(pair), [`review/${taskId}/${reviewId}:${fixture.action}`]);
    assert.equal(planned.mutationSet.mutations.some((mutation) => mutation.entity.entityKind === "task"), false);
    assert.deepEqual(planned.storagePlan.touchedPaths, [`tasks/${taskId}/reviews/${reviewId}.md`]);
    assert.equal(operationDocument(compiled.operation.payload).identity.reviewId, reviewId);
  }
});

test("authority review writes cannot bypass the consent-aware approved Review transaction", async () => {
  const reviewRef = ref("review", `review/${taskId}/${reviewId}`);
  const compiler = makeSessionExecutionReviewSemanticCompilerV2({ state: authorityState() });
  await assert.rejects(
    compiler.compile(envelope({
      schema: "review.record/v1", taskId, review: reviewRecord("approved")
    }, [absent(reviewRef)])),
    /REVIEW_APPROVAL_REQUIRES_CONSENT_TRANSACTION/u
  );
});

test("every W4 action is independently disabled at the named registry boundary", () => {
  for (const registration of [entityRegistry.session, entityRegistry.execution, entityRegistry.review] as const) {
    if (registration.mutationContract.status !== "ready") throw new Error("fixture requires ready mutation contract");
    for (const action of registration.mutationContract.actions) {
      const disabled = {
        ...registration,
        mutationContract: { status: "ready" as const, actions: registration.mutationContract.actions.filter((candidate) => candidate !== action) }
      } as EntityRegistration<string, typeof registration.kind>;
      assert.throws(() => compileRegistryMutationPlan(createWritableEntityRegistry([disabled]), {
        registryVersion: 1,
        mutations: [{ entityKind: registration.kind, identity: identityFor(registration.kind), action }]
      }), new RegExp(`UNKNOWN_SEMANTIC_ACTION:${registration.kind}:${action}`, "u"));
    }
  }
});

test("transparent save and generic doc-sync reject all W4 machine-owned surfaces without host fallback", async () => {
  const compiler = makeSessionExecutionReviewSemanticCompilerV2({ state: authorityState() });
  const typed = envelope({ schema: "review.record/v1", taskId, review: reviewRecord("approved") }, [
    absent(ref("review", `review/${taskId}/${reviewId}`))
  ]);
  await assert.rejects(compiler.compile(finalize({
    ...typed,
    intent: { kind: "transparent-file", interpretation: "full-semantic", files: [] }
  })), /SEMANTIC_DIFF_REQUIRED/u);
  const paths = [
    `sessions/${sessionId}.md`,
    `tasks/${taskId}/executions/${executionId}.md`,
    `tasks/${taskId}/reviews/${reviewId}.md`
  ];
  for (const path of paths) {
    for (const zones of [classifyStaticZones(path, []), classifyTouchedZones(path, "modified", "before", "after", [])]) {
      assert.deepEqual(zones.map((zone) => zone.ok), [false]);
      assert.match(zones[0]!.ok ? "" : zones[0]!.reason, /machine-owned.*typed/u);
    }
  }
});

test("canonical payload and registry mutation digests are deterministic", async () => {
  const payload: ReviewActionPayloadV2 = { schema: "review.record/v1", taskId, review: reviewRecord("changes_requested") };
  const reordered = { review: payload.review, taskId: payload.taskId, schema: payload.schema } as ReviewActionPayloadV2;
  assert.deepEqual(encodeSessionExecutionReviewCommandPayloadV2(payload), encodeSessionExecutionReviewCommandPayloadV2(reordered));
  const compiler = makeSessionExecutionReviewSemanticCompilerV2({ state: authorityState() });
  const compiled = await compiler.compile(envelope(payload, [absent(ref("review", `review/${taskId}/${reviewId}`))]));
  const left = compileRegistryMutationPlan(registry, compiled.mutationPlan).mutationSet;
  const right = compileRegistryMutationPlan(registry, { ...compiled.mutationPlan, mutations: [...compiled.mutationPlan.mutations].reverse() }).mutationSet;
  assert.deepEqual(semanticMutationSetDigestV2(left), semanticMutationSetDigestV2(right));
});

function envelope(
  payloadValue: SessionExecutionReviewCommandPayloadV2,
  baseCas: ReadonlyArray<SemanticBaseCasV2>,
  declaredPathCas: ReadonlyArray<PathCasV2> = []
): SemanticMutationEnvelopeV2 {
  const payload = encodeSessionExecutionReviewCommandPayloadV2(payloadValue);
  const mutationSet: SemanticMutationSetV2 = { registryVersion: 1, mutations: [] };
  return finalize({
    schema: semanticMutationEnvelopeV2Schema,
    workspaceId: "workspace-w4",
    operationId: {
      namespace: {
        schema: "operation-namespace/v1", workspaceId: "workspace-w4", deviceId: "device-w4",
        authorityGeneration: 1n, namespaceId: "namespace-w4", expiresAt: 9_000n,
        issuer: "authority.test", keyId: "namespace-key", proof: Buffer.alloc(32, 3)
      },
      clientRandom128: Buffer.alloc(16, 7)
    },
    binding: {
      bindingId: "binding-w4", actorAxesBindingDigest: Buffer.alloc(32, 4), deviceId: "device-w4",
      viewId: "view-w4", sessionId: "session-w4",
      admissionTokenRef: { tokenId: "token-w4", tokenDigest: Buffer.alloc(32, 5) }
    },
    schemaTuple,
    intent: {
      kind: "typed",
      command: { registryVersion: 1, name: payloadValue.schema.replace("/v1", ""), version: 1 },
      canonicalPayload: { kind: "inline", size: BigInt(payload.length), bytes: payload },
      canonicalPayloadDigest: canonicalPayloadDigestV2(payload), baseCas, declaredPathCas
    },
    claimedMutationSet: mutationSet,
    claimedSemanticMutationSetDigest: semanticMutationSetDigestV2(mutationSet),
    claimedSemanticRequestDigest: Buffer.alloc(32)
  });
}

function finalize(value: SemanticMutationEnvelopeV2): SemanticMutationEnvelopeV2 {
  return { ...value, claimedSemanticRequestDigest: semanticRequestDigestV2(value) };
}

function authorityState(
  bases: ReadonlyMap<string, SemanticEntityBaseV2> = new Map(),
  documents: ReadonlyMap<string, HostedDocumentSnapshotV2> = new Map()
) {
  return {
    readEntityBase: async (entityRef: RegistryEntityRefV2) => bases.get(key(entityRef)) ?? null,
    readHostedDocument: async (path: string) => documents.get(path) ?? null
  };
}

function sessionManifest(body: string, lifecycle: SessionManifest["lifecycle"]): SessionManifest {
  const sha = sha256Text(body);
  return {
    schema: "session-entity/v1", sessionId, lifecycle,
    archiveStatus: "complete", runtime: "codex", source: "runtime",
    detectedAt: "2026-07-14T00:00:00.000Z", exportedAt: "2026-07-14T00:01:00.000Z",
    bodyRef: {
      store: "authored-cas/v1", ref: `harness/objects/sha256/${sha.slice(0, 2)}/${sha.slice(2)}`,
      sha256: sha, size: Buffer.byteLength(body), mediaType: "text/markdown; charset=utf-8"
    },
    snapshot: {
      capturedAt: "2026-07-14T00:01:00.000Z", completeness: "complete",
      captureRange: { messageCount: 1 },
      privacyScan: { scannerVersion: "w4-test", passed: true, findings: [] }
    }
  };
}

function executionRecord(state: ExecutionRecord["state"]): ExecutionRecord {
  const submitted = state !== "active";
  return {
    schema: "execution/v2", execution_id: executionId, task_ref: `task/${taskId}`, state,
    primary_actor: {
      principal: { personId: "person_zeyu" }, executor: { kind: "agent", id: "agent_w4" }, responsibleHuman: "person_zeyu"
    },
    claimed_at: "2026-07-14T00:00:00.000Z",
    submitted_at: submitted ? "2026-07-14T00:10:00.000Z" : null,
    closed_at: state === "accepted" ? "2026-07-14T00:20:00.000Z" : null,
    session_bindings: [],
    outputs: submitted ? [{ evidence_id: "evidence:w4", execution_ref: `execution/${taskId}/${executionId}`, locator: { substrate: "inline", text: "passed" } }] : [],
    submission: submitted ? {
      completion_claim: "W4 complete", deliverables: ["typed compiler"], evidence_refs: ["evidence:w4"],
      verification_notes: ["tested"], known_gaps: [], residual_risks: []
    } : null
  };
}

function reviewRecord(verdict: ReviewRecord["verdict"]): ReviewRecord {
  return {
    schema: "review/v3", review_id: reviewId, task_ref: `task/${taskId}`,
    execution_ref: `execution/${taskId}/${executionId}`,
    reviewer_actor: {
      principal: { personId: "person_reviewer" }, executor: { kind: "agent", id: "agent_reviewer" }, responsibleHuman: "person_reviewer"
    },
    reviewer_session_ref: "session/reviewer-w4", findings: "Typed review findings.",
    evidence_checked: ["evidence:w4"], rationale: "The exact evidence supports this verdict.", verdict,
    archive_warnings_acknowledged: true, reviewed_at: "2026-07-14T00:15:00.000Z", approval_basis: null
  };
}

function operationDocument(payload: unknown): {
  readonly identity: Record<string, string>;
  readonly blobRef?: unknown;
  readonly blobBody?: string;
} {
  return (payload as { readonly entityDocument: ReturnType<typeof operationDocument> }).entityDocument;
}

function snapshot(body: string): HostedDocumentSnapshotV2 {
  return { body, epoch: "epoch-w4", revision: 7n, blobDigest: Buffer.alloc(32, 0x77) };
}

function base(semanticVersion: string): SemanticEntityBaseV2 {
  return { semanticVersion, stateDigest };
}

function ref(entityKind: string, canonicalRef: string): RegistryEntityRefV2 {
  return { registryVersion: 1, entityKind, canonicalRef };
}

function key(entityRef: RegistryEntityRefV2): string {
  return `${entityRef.registryVersion}\0${entityRef.entityKind}\0${entityRef.canonicalRef}`;
}

function absent(entityRef: RegistryEntityRefV2): SemanticBaseCasV2 {
  return { entityRef, expectedSemanticVersion: null, expectedStateDigest: null };
}

function present(entityRef: RegistryEntityRefV2, semanticVersion: string): SemanticBaseCasV2 {
  return { entityRef, expectedSemanticVersion: semanticVersion, expectedStateDigest: stateDigest };
}

function cas(path: string, value: HostedDocumentSnapshotV2): PathCasV2 {
  return { path, expectedEpoch: value.epoch, expectedRevision: value.revision, expectedBlobDigest: value.blobDigest };
}

function pair(mutation: SemanticMutationSetV2["mutations"][number]): string {
  return `${mutation.entity.canonicalRef}:${mutation.action.action}`;
}

function identityFor(kind: "session" | "execution" | "review"): Record<string, string> {
  if (kind === "session") return { sessionId };
  if (kind === "execution") return { taskId, executionId };
  return { taskId, reviewId };
}

const schemaTuple = {
  wire: 2, event: 2, receipt: 2, digest: 2, policy: 1,
  commandRegistry: 1, entityRegistry: 1, mutationRegistry: 1, localState: 1, applyJournal: 1
} as const;
