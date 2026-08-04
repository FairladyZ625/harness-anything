// harness-test-tier: contract
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
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
  type PathCasV2,
  type SemanticBaseCasV2,
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
  withExactCommit,
  type ConsentRecord,
  type ExecutionRecord,
  type ReviewRecord,
  type WriteOp
} from "../../kernel/src/index.ts";
import {
  absent,
  authorityState,
  base,
  bytesEqual,
  cas,
  channelNonceDigest,
  consentId,
  consentPath,
  consentRef,
  executionId,
  executionPath,
  executionRef,
  key,
  mutationPair,
  present,
  reviewId,
  reviewRef,
  schemaTuple,
  snapshot,
  taskId,
  taskIndexPath
} from "./consent-semantic-compiler-v2-fixtures.ts";
const registry = createWritableEntityRegistry([
  entityRegistry.execution,
  entityRegistry.consent,
  entityRegistry.review
]);

test("consent grant derives principal and time only from authenticated authority context", async () => {
  const execution = submittedExecution();
  const executionSnapshot = snapshot(executionDeclaration.documentCodec.encode(execution));
  const state = authorityState(
    new Map([[key(executionRef()), base("execution-v1")]]),
    new Map([[executionPath, executionSnapshot]])
  );
  const compiler = makeConsentSemanticCompilerV2({ state, rootInput: ".", ttlMs: 60_000 });
  const payload: ConsentCommandPayloadV2 = {
    schema: "consent.grant/v1",
    taskId,
    executionId,
    consentId,
    utterance: null,
    standingPolicyDecisionId: null,
    assertedRationale: "Approval was received through an external channel.",
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
  assert.equal(consent.source.strength, "asserted");
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

test("authority verifies the current reviewer session when the Execution is bound to a different worker session", async () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-consent-authority-transcript-"));
  try {
    const logRoot = path.join(rootDir, "logs");
    mkdirSync(logRoot, { recursive: true });
    writeFileSync(path.join(logRoot, "rollout-2024-07-15T00-00-00-session-w6-consent.jsonl"), [
      JSON.stringify({ timestamp: "2024-07-15T00:11:00.000Z", type: "event_msg", payload: { type: "user_message", message: "Approved in the current reviewer session." } }),
      JSON.stringify({ timestamp: "2024-07-15T00:11:01.000Z", type: "response_item", payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "Assistant approval is not evidence." }] } })
    ].join("\n"));
    const execution = {
      ...submittedExecution(),
      session_bindings: [{
        binding_id: "binding-primary",
        session_ref: "session/session-w6-worker",
        role: "primary" as const,
        archive_status: "complete" as const,
        attached_at: "2024-07-15T00:00:00.000Z",
        session: { runtime: "codex", sessionId: "session-w6-worker", source: "runtime", detectedAt: "2024-07-15T00:00:00.000Z" },
        capture_range: null
      }]
    };
    const executionSnapshot = snapshot(executionDeclaration.documentCodec.encode(execution));
    const state = authorityState(new Map([[key(executionRef()), base("execution-v1")]]), new Map([[executionPath, executionSnapshot]]));
    const compiler = makeConsentSemanticCompilerV2({
      state,
      rootInput: rootDir,
      runtimeLogOptions: { runtimeLogRoots: { codex: [logRoot] } }
    });
    const reviewerSession = {
      runtime: "codex" as const,
      sessionId: "session-w6-consent",
      source: "runtime" as const,
      detectedAt: "2024-07-15T00:12:00.000Z"
    };
    const compile = (utterance: string) => compiler.compile(envelope({
      schema: "consent.grant/v1", taskId, executionId, consentId,
      utterance, standingPolicyDecisionId: null, assertedRationale: null,
      actions: ["approve_execution", "complete_task"]
    }, [present(executionRef(), "execution-v1"), absent(consentRef())], [cas(executionPath, executionSnapshot)]), {
      ...context(BigInt(Date.parse("2024-07-15T00:12:00.000Z"))),
      currentSession: reviewerSession
    });

    const verified = decodePrimaryConsent((await compile("Approved in the current reviewer session.")).operation.payload);
    assert.equal(verified.source.strength, "transcript-verified");
    assert.equal(verified.source.transcript_anchor?.session_ref, `session/${reviewerSession.sessionId}`);
    await assert.rejects(compile("Assistant approval is not evidence."), /not found in any bound session transcript user turn/u);
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test("authority inline review keeps the Consent anchor equal to the Review session", async () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-consent-authority-review-session-"));
  try {
    const logRoot = path.join(rootDir, "logs");
    mkdirSync(logRoot, { recursive: true });
    writeFileSync(path.join(logRoot, "rollout-2024-07-15T00-00-00-session-w6-consent.jsonl"), `${JSON.stringify({
      timestamp: "2024-07-15T00:11:00.000Z",
      type: "event_msg",
      payload: { type: "user_message", message: "Approved for the authority inline review." }
    })}\n`);
    const execution: ExecutionRecord = {
      ...submittedExecution(),
      session_bindings: [{
        binding_id: "binding-primary-worker",
        session_ref: "session/session-w6-worker",
        role: "primary",
        archive_status: "complete",
        attached_at: "2024-07-15T00:00:00.000Z",
        session: { runtime: "codex", sessionId: "session-w6-worker", source: "runtime", detectedAt: "2024-07-15T00:00:00.000Z" },
        capture_range: null
      }]
    };
    const executionSnapshot = snapshot(executionDeclaration.documentCodec.encode(execution));
    const taskIndexSnapshot = snapshot("  status: in_review\n");
    const state = authorityState(
      new Map([[key(executionRef()), base("execution-v1")]]),
      new Map([[executionPath, executionSnapshot], [taskIndexPath, taskIndexSnapshot]])
    );
    const payload: ConsentCommandPayloadV2 = {
      schema: "consent.consume/v1",
      taskId,
      executionId,
      consentId,
      utterance: "Approved for the authority inline review.",
      standingPolicyDecisionId: null,
      assertedRationale: null,
      actions: ["approve_execution", "complete_task"],
      review: {
        reviewId,
        findings: "The submitted evidence is complete.",
        evidenceChecked: ["evidence:w6-consent"],
        rationale: "The exact submitted execution is approved.",
        archiveWarningsAcknowledged: true
      }
    };
    const reviewedAt = "2024-07-15T00:12:00.000Z";
    const compiled = await makeConsentSemanticCompilerV2({
      state,
      rootInput: rootDir,
      runtimeLogOptions: { runtimeLogRoots: { codex: [logRoot] } }
    }).compile(envelope(payload, [
      present(executionRef(), "execution-v1"), absent(consentRef()), absent(reviewRef())
    ], [
      cas(executionPath, executionSnapshot), cas(taskIndexPath, taskIndexSnapshot)
    ]), {
      ...context(BigInt(Date.parse(reviewedAt))),
      currentSession: {
        runtime: "codex",
        sessionId: "session-w6-consent",
        source: "runtime",
        detectedAt: reviewedAt
      }
    });

    const transaction = operationTransaction(compiled.operation.payload);
    const review = reviewDeclaration.documentCodec.decode(transaction.body) as ReviewRecord;
    const consent = consentDeclaration.documentCodec.decode(transaction.companionWrites[0]!.body) as ConsentRecord;
    assert.equal(consent.source.strength, "transcript-verified");
    assert.equal(consent.source.transcript_anchor?.session_ref, review.reviewer_session_ref);
    assert.equal(review.reviewer_session_ref, "session/session-w6-consent");
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test("consent consume atomically records the review and terminal consent for the same principal", async () => {
  const fixture = await openConsentFixture();
  const payload: ConsentCommandPayloadV2 = {
    schema: "consent.consume/v1",
    taskId,
    executionId,
    consentId,
    utterance: null,
    standingPolicyDecisionId: null,
    assertedRationale: null,
    actions: [],
    review: {
      reviewId,
      findings: "The submitted evidence is complete.",
      evidenceChecked: ["evidence:w6-consent"],
      rationale: "The exact submitted execution is approved.",
      archiveWarningsAcknowledged: true
    }
  };
  const compiler = makeConsentSemanticCompilerV2({ state: fixture.state, rootInput: "." });
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
    `execution/${taskId}/${executionId}:close`,
    `review/${taskId}/${reviewId}:record`,
    `consent/${taskId}/${consentId}:consume`
  ]);
  const transaction = operationTransaction(compiled.operation.payload);
  const review = reviewDeclaration.documentCodec.decode(transaction.body) as ReviewRecord;
  const consent = consentDeclaration.documentCodec.decode(transaction.companionWrites[0]!.body) as ConsentRecord;
  const execution = executionDeclaration.documentCodec.decode(transaction.companionWrites[1]!.body) as ExecutionRecord;
  assert.equal(review.reviewer_actor.principal.personId, "person_zeyu");
  assert.equal(review.approval_basis?.kind, "human-consent");
  assert.equal(consent.state, "consumed");
  assert.equal(consent.consumed_by, `review/${taskId}/${reviewId}`);
  assert.equal(execution.state, "accepted");
  assert.equal(execution.closed_at, "2024-07-14T23:33:50.000Z");

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
    standingPolicyDecisionId: null,
    assertedRationale: null,
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
  ) => makeConsentSemanticCompilerV2({ state: fixture.state, rootInput: "." }).compile(envelope(command, [
    present(executionRef(), "execution-v1"), present(consentRef(), "consent-v1"), absent(reviewRef())
  ], [
    cas(executionPath, fixture.executionSnapshot),
    cas(consentPath, fixture.consentSnapshot),
    cas(taskIndexPath, fixture.taskIndexSnapshot)
  ]), context(1_721_000_030_000n));

  const ordinary = await openConsentFixture();
  await assert.rejects(attempt(ordinary, payload(["evidence:client-reported"], true)), /REVIEW_EVIDENCE_NOT_IN_EXECUTION/u);

  const activeTask = await openConsentFixture(60_000, { taskIndexBody: "  status: active\n" });
  await attempt(activeTask, payload(["evidence:w6-consent"], true));

  for (const status of ["planned", "blocked", "done", "cancelled"] as const) {
    const nonReviewableTask = await openConsentFixture(60_000, {
      taskIndexBody: `  status: ${status}\n`
    });
    await assert.rejects(
      attempt(nonReviewableTask, payload(["evidence:w6-consent"], true)),
      /REVIEW_TASK_NOT_IN_REVIEW/u
    );
  }

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
  const compiler = makeConsentSemanticCompilerV2({ state: fixture.state, rootInput: "." });
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
  const semanticCompiler = makeConsentSemanticCompilerV2({ state, rootInput: ".", ttlMs: 60_000 });
  const payload: ConsentCommandPayloadV2 = {
    schema: "consent.grant/v1", taskId, executionId, consentId,
    utterance: null, standingPolicyDecisionId: null,
    assertedRationale: "Approval was received through an external channel.", actions: ["approve_execution", "complete_task"]
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
  let admittedContext: AuthoritySemanticCompilerContextV2 | undefined;
  const service = createAuthoritySubmissionService({
    workspaceId: claims.workspaceId,
    coordinatorFactory: {
      create: () => withExactCommit({
        enqueue: (operation) => Effect.sync(() => {
          enqueued += 1;
          captured = operation;
          documents.set(consentPath, snapshot(operationTransaction(operation.payload).body));
          return { opId: operation.opId, entityId: operation.entityId, accepted: true as const };
        }),
        recover: Effect.succeed({ replayedOps: 0 })
      }, (reason) => Effect.succeed({ reason, opCount: 1, committed: true }))
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
        consumeOperation: async () => { consumed += 1; return "consumed"; },
        validateAdmissionTokenRef: async (input) => input.tokenId === claims.tokenId
          && bytesEqual(input.tokenDigest, tokenDigest)
      },
      entityRegistrations: [entityRegistry.consent],
      semanticCompiler: {
        compile: async (candidate, authorityContext) => {
          admittedContext = authorityContext;
          return semanticCompiler.compile(candidate, authorityContext);
        }
      },
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
  assert.deepEqual(admittedContext?.currentSession, {
    runtime: "codex",
    sessionId: claims.sessionId,
    source: "runtime",
    detectedAt: new Date(Number(claims.issuedAt)).toISOString()
  });
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
    utterance: null, standingPolicyDecisionId: null,
    assertedRationale: "Approval was received through an external channel.", actions: ["approve_execution", "complete_task"]
  };
  const grant = await makeConsentSemanticCompilerV2({ state: grantState, rootInput: ".", ttlMs }).compile(envelope(grantPayload, [
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
    sessionRuntime: "codex",
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
