// harness-test-tier: contract
import assert from "node:assert/strict";
import test from "node:test";
import { Effect } from "effect";
import {
  actorAxesBindingDigestV2,
  actorAxesBindingTokenDigestV2,
  canonicalPayloadDigestV2,
  createAuthoritySubmissionService,
  createInMemoryAuthorityOperationRegistry,
  createInMemoryReplicaChangeLog,
  encodeSemanticMutationEnvelopeV2,
  encodeConsentCommandPayloadV2,
  issueActorAxesBindingV2,
  makeConsentSemanticCompilerV2,
  materializeCommittedAttributionEventV2,
  semanticMutationEnvelopeV2Schema,
  semanticMutationSetDigestV2,
  semanticRequestDigestV2,
  type AuthoritySemanticCompilerContextV2,
  type ActorAxesBindingClaimsV2,
  type ConsentCommandPayloadV2,
  type HostedDocumentSnapshotV2,
  type PathCasV2,
  type RegistryEntityRefV2,
  type SemanticBaseCasV2,
  type SemanticEntityBaseV2,
  type SemanticMutationEnvelopeV2,
  type SemanticMutationSetV2
} from "../src/index.ts";
import {
  compileRegistryMutationPlan,
  consentDeclaration,
  createWritableEntityRegistry,
  entityRegistry,
  executionDeclaration,
  reviewDeclaration,
  type ConsentRecord,
  type ExecutionRecord,
  type ReviewRecord,
  type WriteOp
} from "../../kernel/src/index.ts";

const taskId = "task_01KXPP248WACVWSM7F4K855RWH";
const executionId = "exe_01KXPP248WACVWSM7F4K855RWJ";
const consentId = "cns_01KXPP248WACVWSM7F4K855RWK";
const reviewId = "rev_01KXPP248WACVWSM7F4K855RWM";
const executionPath = `tasks/${taskId}/executions/${executionId}.md`;
const consentPath = `tasks/${taskId}/consents/${consentId}.md`;
const taskIndexPath = `tasks/${taskId}/INDEX.md`;
const stateDigest = Buffer.alloc(32, 0x41);
const registry = createWritableEntityRegistry([
  entityRegistry.execution,
  entityRegistry.consent,
  entityRegistry.review
]);

test("consent grant derives principal session and time only from authenticated authority context", async () => {
  const execution = submittedExecution();
  const executionSnapshot = snapshot(executionDeclaration.documentCodec.encode(execution));
  const state = authorityState(
    new Map([[key(executionRef()), base("execution-v1")]]),
    new Map([[executionPath, executionSnapshot]])
  );
  const compiler = makeConsentSemanticCompilerV2({ state, ttlMs: 60_000 });
  const payload: ConsentCommandPayloadV2 = {
    schema: "consent.grant/v1",
    taskId,
    executionId,
    consentId,
    utterance: "Approved for this exact submission.",
    actions: ["approve_execution", "complete_task"]
  };
  const compiled = await compiler.compile(envelope(payload, [
    present(executionRef(), "execution-v1"), absent(consentRef())
  ], [cas(executionPath, executionSnapshot)]), context(1_721_000_000_000n));
  const planned = compileRegistryMutationPlan(registry, compiled.mutationPlan);
  assert.deepEqual(planned.mutationSet.mutations.map(mutationPair), [
    `consent/${taskId}/${consentId}:grant`
  ]);
  const consent = decodePrimaryConsent(compiled.operation.payload);
  assert.deepEqual(consent.principal, { personId: "person_zeyu" });
  assert.deepEqual(consent.recorded_by, context(1_721_000_000_000n).actor);
  assert.equal(consent.response.session_ref, "session/session-w6-consent");
  assert.equal(consent.granted_at, new Date(1_721_000_000_000).toISOString());

  const clientAttributed = Buffer.from(JSON.stringify({
    ...payload,
    principal: { personId: "client-reported" }
  }), "utf8");
  await assert.rejects(
    compiler.compile(envelopeBytes("consent.grant", clientAttributed, [
      present(executionRef(), "execution-v1"), absent(consentRef())
    ], [cas(executionPath, executionSnapshot)]), context(1_721_000_000_000n)),
    /TYPED_PAYLOAD_UNKNOWN_OR_MISSING_FIELD/u
  );
});

test("consent consume atomically records the review and terminal consent for the same principal", async () => {
  const fixture = await openConsentFixture();
  const payload: ConsentCommandPayloadV2 = {
    schema: "consent.consume/v1",
    taskId,
    executionId,
    consentId,
    utterance: null,
    actions: [],
    review: {
      reviewId,
      findings: "The submitted evidence is complete.",
      evidenceChecked: ["evidence:w6-consent"],
      rationale: "The exact submitted execution is approved.",
      archiveWarningsAcknowledged: true
    }
  };
  const compiler = makeConsentSemanticCompilerV2({ state: fixture.state });
  const compiled = await compiler.compile(envelope(payload, [
    present(executionRef(), "execution-v1"),
    present(consentRef(), "consent-v1"),
    absent(reviewRef())
  ], [
    cas(executionPath, fixture.executionSnapshot),
    cas(consentPath, fixture.consentSnapshot),
    cas(taskIndexPath, fixture.taskIndexSnapshot)
  ]), context(1_721_000_030_000n));
  const planned = compileRegistryMutationPlan(registry, compiled.mutationPlan);
  assert.deepEqual(planned.mutationSet.mutations.map(mutationPair), [
    `review/${taskId}/${reviewId}:record`,
    `consent/${taskId}/${consentId}:consume`
  ]);
  const transaction = operationTransaction(compiled.operation.payload);
  const review = reviewDeclaration.documentCodec.decode(transaction.body) as ReviewRecord;
  const consent = consentDeclaration.documentCodec.decode(transaction.companionWrites[0]!.body) as ConsentRecord;
  assert.equal(review.reviewer_actor.principal.personId, "person_zeyu");
  assert.equal(review.approval_basis?.kind, "human-consent");
  assert.equal(consent.state, "consumed");
  assert.equal(consent.consumed_by, `review/${taskId}/${reviewId}`);

  await assert.rejects(
    compiler.compile(envelope(payload, [
      present(executionRef(), "execution-v1"), present(consentRef(), "consent-v1"), absent(reviewRef())
    ], [
      cas(executionPath, fixture.executionSnapshot),
      cas(consentPath, fixture.consentSnapshot),
      cas(taskIndexPath, fixture.taskIndexSnapshot)
    ]), {
      ...context(1_721_000_030_000n),
      actor: { ...context(1_721_000_030_000n).actor, principal: { personId: "person_other" }, responsibleHuman: "person_other" }
    }),
    /CONSENT_PRINCIPAL_MISMATCH/u
  );
});

test("consent consume preserves review task evidence and archive-warning invariants", async () => {
  const payload = (evidenceChecked: ReadonlyArray<string>, archiveWarningsAcknowledged: boolean): ConsentCommandPayloadV2 => ({
    schema: "consent.consume/v1",
    taskId,
    executionId,
    consentId,
    utterance: null,
    actions: [],
    review: {
      reviewId,
      findings: "Reviewed.",
      evidenceChecked,
      rationale: "Exact submitted execution reviewed.",
      archiveWarningsAcknowledged
    }
  });
  const attempt = async (
    fixture: Awaited<ReturnType<typeof openConsentFixture>>,
    command: ConsentCommandPayloadV2
  ) => makeConsentSemanticCompilerV2({ state: fixture.state }).compile(envelope(command, [
    present(executionRef(), "execution-v1"), present(consentRef(), "consent-v1"), absent(reviewRef())
  ], [
    cas(executionPath, fixture.executionSnapshot),
    cas(consentPath, fixture.consentSnapshot),
    cas(taskIndexPath, fixture.taskIndexSnapshot)
  ]), context(1_721_000_030_000n));

  const ordinary = await openConsentFixture();
  await assert.rejects(attempt(ordinary, payload(["evidence:client-reported"], true)), /REVIEW_EVIDENCE_NOT_IN_EXECUTION/u);

  const activeTask = await openConsentFixture(60_000, { taskIndexBody: "  status: active\n" });
  await assert.rejects(attempt(activeTask, payload(["evidence:w6-consent"], true)), /REVIEW_TASK_NOT_IN_REVIEW/u);

  const warningExecution: ExecutionRecord = {
    ...submittedExecution(),
    session_bindings: [{
      binding_id: "primary:w6",
      session_ref: "session/w6",
      role: "primary",
      archive_status: "partial",
      attached_at: "2024-07-15T00:00:00.000Z",
      session: null,
      capture_range: null
    }]
  };
  const warning = await openConsentFixture(60_000, { execution: warningExecution });
  await assert.rejects(attempt(warning, payload(["evidence:w6-consent"], false)), /REVIEW_ARCHIVE_WARNING_ACK_REQUIRED/u);
});

test("consent expire compiles only after the server clock crosses the recorded expiry", async () => {
  const fixture = await openConsentFixture(1_000);
  const payload: ConsentCommandPayloadV2 = { schema: "consent.expire/v1", taskId, consentId };
  const compiler = makeConsentSemanticCompilerV2({ state: fixture.state });
  const before = envelope(payload, [present(consentRef(), "consent-v1")], [cas(consentPath, fixture.consentSnapshot)]);
  await assert.rejects(compiler.compile(before, context(1_721_000_000_999n)), /CONSENT_NOT_EXPIRED/u);
  const compiled = await compiler.compile(before, context(1_721_000_001_000n));
  const planned = compileRegistryMutationPlan(registry, compiled.mutationPlan);
  assert.deepEqual(planned.mutationSet.mutations.map(mutationPair), [
    `consent/${taskId}/${consentId}:expire`
  ]);
  assert.equal(decodePrimaryConsent(compiled.operation.payload).state, "expired");
});

test("an exact consent grant attempt replays one committed receipt after authored state changes", async () => {
  const execution = submittedExecution();
  const executionSnapshot = snapshot(executionDeclaration.documentCodec.encode(execution));
  const documents = new Map([[executionPath, executionSnapshot]]);
  const state = authorityState(
    new Map([[key(executionRef()), base("execution-v1")]]),
    documents
  );
  const semanticCompiler = makeConsentSemanticCompilerV2({ state, ttlMs: 60_000 });
  const payload: ConsentCommandPayloadV2 = {
    schema: "consent.grant/v1", taskId, executionId, consentId,
    utterance: "Approved for this exact submission.", actions: ["approve_execution", "complete_task"]
  };
  const claims = authorityClaims();
  const secret = Buffer.alloc(32, 0x5a);
  const token = issueActorAxesBindingV2(claims, {
    algorithm: "HMAC-SHA-256", issuer: "authority.test", keyId: "key-w6-consent", secret
  });
  const tokenDigest = actorAxesBindingTokenDigestV2(token);
  const draft = bindEnvelope(envelope(payload, [
    present(executionRef(), "execution-v1"), absent(consentRef())
  ], [cas(executionPath, executionSnapshot)]), claims, tokenDigest);
  const compiled = await semanticCompiler.compile(draft, {
    actor: context(1_721_000_000_000n).actor,
    sessionId: claims.sessionId,
    nowMs: 1_721_000_000_000n
  });
  const exact = compileRegistryMutationPlan(registry, compiled.mutationPlan).mutationSet;
  const request = finalize({
    ...draft,
    claimedMutationSet: exact,
    claimedSemanticMutationSetDigest: semanticMutationSetDigestV2(exact),
    claimedSemanticRequestDigest: Buffer.alloc(32)
  });
  let enqueued = 0;
  let consumed = 0;
  let captured: WriteOp | undefined;
  const service = createAuthoritySubmissionService({
    workspaceId: claims.workspaceId,
    coordinatorFactory: {
      create: () => ({
        enqueue: (operation) => Effect.sync(() => {
          enqueued += 1;
          captured = operation;
          documents.set(consentPath, snapshot(operationTransaction(operation.payload).body));
          return { opId: operation.opId, entityId: operation.entityId, accepted: true as const };
        }),
        flush: () => Effect.succeed({ reason: "explicit" as const, opCount: 1, committed: true }),
        recover: Effect.succeed({ replayedOps: 0 })
      })
    },
    tokenVerifier: { verify: async () => { throw new Error("legacy verifier must not run"); } },
    operationRegistry: createInMemoryAuthorityOperationRegistry(),
    replicaChangeLog: createInMemoryReplicaChangeLog(),
    publicationInspector: {
      currentHead: async () => null,
      inspectPublishedHead: async () => ({ commitSha: "a".repeat(40), parentCommits: [] })
    },
    fenceWitness: { assertHeld: async () => undefined },
    now: () => "2024-07-15T00:00:00.000Z",
    v2: {
      schemaTuple,
      channelNonceDigest,
      bindingRuntime: {
        proofKeys: { resolve: () => ({ algorithm: "HMAC-SHA-256", secret }) },
        validatePresentationToken: async (input) => bytesEqual(input.tokenDigest, tokenDigest),
        getBinding: async () => ({
          bindingId: claims.bindingId,
          principalPersonId: claims.principalPersonId,
          executorAgentId: claims.executorAgentId,
          workspaceId: claims.workspaceId,
          deviceId: claims.deviceId,
          viewId: claims.viewId,
          sessionId: claims.sessionId,
          active: true,
          attribution: {
            actor: {
              principal: { kind: "person", personId: claims.principalPersonId },
              executor: { kind: "agent", id: claims.executorAgentId! }
            },
            principalSource: { kind: "daemon-authenticated", providerId: "authority.test", credentialFingerprint: "sha256:redacted" },
            executorSource: "client-asserted"
          }
        }),
        currentAuthorityGeneration: () => claims.authorityGeneration,
        currentRevocationEpochs: async () => claims.revocationEpochs,
        nowMs: () => 1_721_000_000_000n,
        consumeOperation: async () => { consumed += 1; return true; },
        validateAdmissionTokenRef: async (input) => input.tokenId === claims.tokenId
          && bytesEqual(input.tokenDigest, tokenDigest)
      },
      entityRegistrations: [entityRegistry.consent],
      semanticCompiler,
      operationNamespaceVerifier: { verify: async () => undefined },
      committedEventPublisher: {
        publish: async (input) => materializeCommittedAttributionEventV2({
          ...input,
          physicalChanges: [{ path: consentPath, beforeDigest: null, afterDigest: "55".repeat(32) }],
          recordedAt: input.occurredAt
        })
      }
    }
  });
  const attempt = {
    requestId: "w6-consent-grant",
    presentationToken: token,
    envelope: encodeSemanticMutationEnvelopeV2(request)
  };
  const first = await service.submitV2!(attempt);
  const replay = await service.submitV2!({ ...attempt, requestId: "w6-consent-grant-replay" });
  assert.equal(first.tag, "COMMITTED");
  assert.deepEqual(replay, first);
  assert.equal(enqueued, 1);
  assert.equal(consumed, 1);
  assert.equal(decodePrimaryConsent(captured?.payload).principal.personId, "person_zeyu");
  if (first.tag !== "COMMITTED") return;
  assert.match(first.integrityTuple?.canonicalEventDigest ?? "", /^[a-f0-9]{64}$/u);
  assert.match(first.integrityTuple?.changeSetDigest ?? "", /^[a-f0-9]{64}$/u);
  assert.match(first.integrityTuple?.semanticMutationSetDigest ?? "", /^[a-f0-9]{64}$/u);
  assert.match(first.integrityTuple?.actorAxesBindingDigest ?? "", /^[a-f0-9]{64}$/u);
});

async function openConsentFixture(ttlMs = 60_000, input?: {
  readonly execution?: ExecutionRecord;
  readonly taskIndexBody?: string;
}) {
  const execution = input?.execution ?? submittedExecution();
  const executionSnapshot = snapshot(executionDeclaration.documentCodec.encode(execution));
  const taskIndexSnapshot = snapshot(input?.taskIndexBody ?? "  status: in_review\n");
  const grantState = authorityState(
    new Map([[key(executionRef()), base("execution-v1")]]),
    new Map([[executionPath, executionSnapshot]])
  );
  const grantPayload: ConsentCommandPayloadV2 = {
    schema: "consent.grant/v1", taskId, executionId, consentId,
    utterance: "Approved for this exact submission.", actions: ["approve_execution", "complete_task"]
  };
  const grant = await makeConsentSemanticCompilerV2({ state: grantState, ttlMs }).compile(envelope(grantPayload, [
    present(executionRef(), "execution-v1"), absent(consentRef())
  ], [cas(executionPath, executionSnapshot)]), context(1_721_000_000_000n));
  const consentBody = operationTransaction(grant.operation.payload).body;
  const consentSnapshot = snapshot(consentBody);
  return {
    executionSnapshot,
    consentSnapshot,
    taskIndexSnapshot,
    state: authorityState(
      new Map([
        [key(executionRef()), base("execution-v1")],
        [key(consentRef()), base("consent-v1")]
      ]),
      new Map([
        [executionPath, executionSnapshot],
        [consentPath, consentSnapshot],
        [taskIndexPath, taskIndexSnapshot]
      ])
    )
  };
}

function envelope(
  payload: ConsentCommandPayloadV2,
  baseCas: ReadonlyArray<SemanticBaseCasV2>,
  declaredPathCas: ReadonlyArray<PathCasV2>
): SemanticMutationEnvelopeV2 {
  return envelopeBytes(payload.schema.replace("/v1", ""), encodeConsentCommandPayloadV2(payload), baseCas, declaredPathCas);
}

function envelopeBytes(
  commandName: string,
  payload: Uint8Array,
  baseCas: ReadonlyArray<SemanticBaseCasV2>,
  declaredPathCas: ReadonlyArray<PathCasV2>
): SemanticMutationEnvelopeV2 {
  const mutationSet: SemanticMutationSetV2 = { registryVersion: 1, mutations: [] };
  return finalize({
    schema: semanticMutationEnvelopeV2Schema,
    workspaceId: "workspace-w6-consent",
    operationId: {
      namespace: {
        schema: "operation-namespace/v1", workspaceId: "workspace-w6-consent", deviceId: "device-w6",
        authorityGeneration: 1n, namespaceId: "namespace-w6", expiresAt: 9_000n,
        issuer: "authority.test", keyId: "namespace-key", proof: Buffer.alloc(32, 3)
      },
      clientRandom128: Buffer.alloc(16, 7)
    },
    binding: {
      bindingId: "binding-w6", actorAxesBindingDigest: Buffer.alloc(32, 4), deviceId: "device-w6",
      viewId: "view-w6", sessionId: "session-w6-consent",
      admissionTokenRef: { tokenId: "token-w6", tokenDigest: Buffer.alloc(32, 5) }
    },
    schemaTuple,
    intent: {
      kind: "typed",
      command: { registryVersion: 1, name: commandName, version: 1 },
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

function bindEnvelope(
  envelope: SemanticMutationEnvelopeV2,
  claims: ActorAxesBindingClaimsV2,
  tokenDigest: Uint8Array
): SemanticMutationEnvelopeV2 {
  return finalize({
    ...envelope,
    binding: {
      bindingId: claims.bindingId,
      actorAxesBindingDigest: actorAxesBindingDigestV2(claims),
      deviceId: claims.deviceId,
      viewId: claims.viewId,
      sessionId: claims.sessionId,
      admissionTokenRef: { tokenId: claims.tokenId, tokenDigest }
    }
  });
}

function context(nowMs: bigint): AuthoritySemanticCompilerContextV2 {
  return {
    actor: {
      principal: { personId: "person_zeyu" },
      executor: { kind: "agent", id: "agent_w6" },
      responsibleHuman: "person_zeyu"
    },
    sessionId: "session-w6-consent",
    nowMs
  };
}

function authorityClaims(): ActorAxesBindingClaimsV2 {
  return {
    tokenId: "token-w6-consent",
    bindingId: "binding-w6-consent",
    principalPersonId: "person_zeyu",
    executorAgentId: "agent_w6",
    workspaceId: "workspace-w6-consent",
    deviceId: "device-w6",
    viewId: "view-w6",
    sessionId: "session-w6-consent",
    allowedEntityKinds: ["consent"],
    allowedActions: ["grant"],
    resourceScopes: [{ kind: "workspace" }],
    pathFootprint: null,
    maxBytes: 64n * 1024n,
    maxMutations: 4,
    maxOperations: 4,
    authorityGeneration: 1n,
    channelNonceDigest,
    schemaTuple,
    issuedAt: 1_720_999_999_000n,
    notBefore: 1_720_999_999_000n,
    expiresAt: 1_721_000_060_000n,
    revocationEpochs: { global: 1n, workspace: 1n, device: 1n, view: 1n, principal: 1n, executor: 1n }
  };
}

function submittedExecution(): ExecutionRecord {
  return {
    schema: "execution/v2", execution_id: executionId, task_ref: `task/${taskId}`, state: "submitted",
    primary_actor: context(1_721_000_000_000n).actor,
    claimed_at: "2024-07-15T00:00:00.000Z", submitted_at: "2024-07-15T00:10:00.000Z", closed_at: null,
    session_bindings: [],
    outputs: [{ evidence_id: "evidence:w6-consent", execution_ref: `execution/${taskId}/${executionId}`, locator: { substrate: "inline", text: "passed" } }],
    submission: {
      completion_claim: "W6 consent path is qualified", deliverables: ["consent authority compiler"],
      evidence_refs: ["evidence:w6-consent"], verification_notes: ["contract test"], known_gaps: [], residual_risks: []
    }
  };
}

function authorityState(
  bases: ReadonlyMap<string, SemanticEntityBaseV2>,
  documents: ReadonlyMap<string, HostedDocumentSnapshotV2>
) {
  return {
    readEntityBase: async (entityRef: RegistryEntityRefV2) => bases.get(key(entityRef)) ?? null,
    readHostedDocument: async (path: string) => documents.get(path) ?? null
  };
}

function operationTransaction(payload: unknown): {
  readonly body: string;
  readonly companionWrites: ReadonlyArray<{ readonly body: string }>;
} {
  const transaction = payload as {
    readonly entityDocument: { readonly body: string };
    readonly companionWrites: ReadonlyArray<{ readonly body: string }>;
  };
  return { body: transaction.entityDocument.body, companionWrites: transaction.companionWrites };
}

function decodePrimaryConsent(payload: unknown): ConsentRecord {
  return consentDeclaration.documentCodec.decode(operationTransaction(payload).body) as ConsentRecord;
}

function snapshot(body: string): HostedDocumentSnapshotV2 {
  return { body, epoch: "epoch-w6", revision: 7n, blobDigest: Buffer.alloc(32, 0x77) };
}

function base(semanticVersion: string): SemanticEntityBaseV2 {
  return { semanticVersion, stateDigest };
}

function ref(entityKind: string, canonicalRef: string): RegistryEntityRefV2 {
  return { registryVersion: 1, entityKind, canonicalRef };
}

function executionRef(): RegistryEntityRefV2 {
  return ref("execution", `execution/${taskId}/${executionId}`);
}

function consentRef(): RegistryEntityRefV2 {
  return ref("consent", `consent/${taskId}/${consentId}`);
}

function reviewRef(): RegistryEntityRefV2 {
  return ref("review", `review/${taskId}/${reviewId}`);
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

function mutationPair(mutation: SemanticMutationSetV2["mutations"][number]): string {
  return `${mutation.entity.canonicalRef}:${mutation.action.action}`;
}

const schemaTuple = {
  wire: 2, event: 2, receipt: 2, digest: 2, policy: 1,
  commandRegistry: 1, entityRegistry: 1, mutationRegistry: 1, localState: 1, applyJournal: 1
} as const;

const channelNonceDigest = Buffer.alloc(32, 0x22);

function bytesEqual(left: Uint8Array, right: Uint8Array): boolean {
  return Buffer.from(left).equals(Buffer.from(right));
}
