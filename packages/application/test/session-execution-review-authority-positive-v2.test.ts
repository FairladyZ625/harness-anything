// harness-test-tier: integration
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
  actorAxesBindingDigestV2,
  actorAxesBindingTokenDigestV2,
  canonicalPayloadDigestV2,
  createAuthoritySubmissionService,
  createInMemoryAuthorityOperationRegistry,
  createInMemoryReplicaChangeLog,
  encodeSemanticMutationEnvelopeV2,
  encodeSessionExecutionReviewCommandPayloadV2,
  issueActorAxesBindingV2,
  makeSessionExecutionReviewSemanticCompilerV2,
  materializeCommittedAttributionEventV2,
  materializeCommittedAttributionProjectionV2,
  semanticMutationEnvelopeV2Schema,
  semanticMutationSetDigestV2,
  semanticRequestDigestV2,
  type ActorAxesBindingClaimsV2,
  type HostedDocumentSnapshotV2,
  type RegistryEntityRefV2,
  type ReplicaChangeLog,
  type SemanticBaseCasV2,
  type SemanticEntityBaseV2,
  type SemanticMutationEnvelopeV2,
  type SemanticMutationSetV2,
  type SessionExecutionReviewCommandPayloadV2
} from "../src/index.ts";
import {
  entityRegistry,
  makeJournaledWriteCoordinator,
  readUnionAttributionEvents,
  sha256Text,
  type ExecutionRecord,
  type ReviewRecord,
  type SessionManifest
} from "../../kernel/src/index.ts";

const taskId = "task_01KXD8H2QFMMA4T203PJZ77AQ5";
const executionId = "exe_01KXD8H2QFMMA4T203PJZ77AQ6";
const sessionId = "session-w4-positive";

test("all W4 actions publish exact refs through one composite/hosted op with cross-layer digests", async () => {
  await withHermeticGit(async ({ rootDir, env, harnessRoot }) => {
    const claims = actorClaims();
    const secret = Buffer.alloc(32, 0x5a);
    const token = issueActorAxesBindingV2(claims, {
      algorithm: "HMAC-SHA-256", issuer: "authority.test", keyId: "key-w4", secret
    });
    const tokenDigest = actorAxesBindingTokenDigestV2(token);
    const changeLog = createInMemoryReplicaChangeLog();
    const bases = new Map<string, SemanticEntityBaseV2>();
    const compiler = makeSessionExecutionReviewSemanticCompilerV2({
      state: {
        readEntityBase: async (entityRef) => bases.get(key(entityRef)) ?? null,
        readHostedDocument: async (documentPath) => documentSnapshot(harnessRoot, documentPath)
      }
    });
    const service = authority(rootDir, env, claims, secret, tokenDigest, changeLog, compiler);
    const sessionBody = "# W4 positive session\n\nComposite CAS body.\n";
    const syncedSessionBody = `${sessionBody}\nSynced snapshot.\n`;
    const active = executionRecord("active");
    const submitted = executionRecord("submitted");
    const accepted = executionRecord("accepted");
    const fixtures: ReadonlyArray<{
      readonly payload: SessionExecutionReviewCommandPayloadV2;
      readonly ref: RegistryEntityRefV2;
      readonly action: string;
      readonly path: string;
    }> = [
      { payload: { schema: "session.export/v1", manifest: sessionManifest(sessionBody, "sealed"), body: sessionBody }, ref: ref("session", `session/${sessionId}`), action: "export", path: `sessions/${sessionId}.md` },
      { payload: { schema: "session.sync/v1", manifest: sessionManifest(syncedSessionBody, "sealed"), body: syncedSessionBody }, ref: ref("session", `session/${sessionId}`), action: "sync", path: `sessions/${sessionId}.md` },
      { payload: { schema: "session.archive/v1", manifest: sessionManifest(syncedSessionBody, "archived"), body: syncedSessionBody }, ref: ref("session", `session/${sessionId}`), action: "archive", path: `sessions/${sessionId}.md` },
      { payload: { schema: "execution.claim/v1", taskId, execution: active }, ref: ref("execution", `execution/${taskId}/${executionId}`), action: "claim", path: `tasks/${taskId}/executions/${executionId}.md` },
      { payload: { schema: "execution.submit/v1", taskId, execution: submitted }, ref: ref("execution", `execution/${taskId}/${executionId}`), action: "submit", path: `tasks/${taskId}/executions/${executionId}.md` },
      { payload: { schema: "execution.close/v1", taskId, execution: accepted }, ref: ref("execution", `execution/${taskId}/${executionId}`), action: "close", path: `tasks/${taskId}/executions/${executionId}.md` },
      ...(["create", "dismiss", "record"] as const).map((action, index) => {
        const id = reviewId(index);
        const verdict = action === "dismiss" ? "dismissed" : "changes_requested";
        return {
          payload: { schema: `review.${action}/v1`, taskId, review: reviewRecord(id, verdict) } as SessionExecutionReviewCommandPayloadV2,
          ref: ref("review", `review/${taskId}/${id}`), action,
          path: `tasks/${taskId}/reviews/${id}.md`
        };
      })
    ];

    const receipts = [];
    for (const [index, fixture] of fixtures.entries()) {
      const snapshot = documentSnapshot(harnessRoot, fixture.path);
      const baseCas = [baseCasFor(fixture.ref, bases.get(key(fixture.ref)) ?? null)];
      const pathCas = snapshot ? [pathCasFor(fixture.path, snapshot)] : [];
      const mutationSet = set(fixture.ref, fixture.action);
      const envelope = bindEnvelope(requestEnvelope(index + 1, fixture.payload, baseCas, pathCas, mutationSet), claims, tokenDigest);
      const receipt = await service.submitV2!({
        requestId: `w4-positive-${index}`,
        presentationToken: token,
        envelope: encodeSemanticMutationEnvelopeV2(envelope)
      });
      assert.equal(receipt.tag, "COMMITTED", `${fixture.action}:${JSON.stringify(receipt)}`);
      if (receipt.tag !== "COMMITTED") continue;
      assert.equal(existsSync(path.join(harnessRoot, fixture.path)), true, fixture.path);
      const body = readFileSync(path.join(harnessRoot, fixture.path), "utf8");
      bases.set(key(fixture.ref), { semanticVersion: `w4-v${index + 1}`, stateDigest: Buffer.from(sha256Text(body), "hex") });
      receipts.push({ receipt, mutationSet, action: fixture.action, path: fixture.path });
    }
    assert.equal(receipts.length, 9);

    const session = sessionManifest(syncedSessionBody, "archived");
    assert.equal(readFileSync(path.join(rootDir, session.bodyRef.ref), "utf8"), syncedSessionBody);
    assert.match(readFileSync(path.join(harnessRoot, `sessions/${sessionId}.md`), "utf8"), /"lifecycle": "archived"/u);
    assert.match(readFileSync(path.join(harnessRoot, `tasks/${taskId}/executions/${executionId}.md`), "utf8"), /"state": "accepted"/u);
    const journalPayloads = readdirSync(path.join(rootDir, ".harness", "write-journal", "payloads"))
      .map((entry) => readFileSync(path.join(rootDir, ".harness", "write-journal", "payloads", entry), "utf8"));
    assert.equal(journalPayloads.some((body) => body.includes("Composite CAS body")), true);
    assert.equal(journalPayloads.some((body) => body.includes("\"blobRef\"") && body.includes("\"blobBody\"")), true);

    const events = readUnionAttributionEvents(rootDir);
    const changes = await changeLog.changesAfter(claims.workspaceId, 0);
    const projectionPath = path.join(rootDir, "w4-attribution.sqlite");
    writeFileSync(projectionPath, "", "utf8");
    const actorAxesBinding = {
      bindingId: claims.bindingId, principalPersonId: claims.principalPersonId,
      executorAgentId: claims.executorAgentId, workspaceId: claims.workspaceId,
      deviceId: claims.deviceId, viewId: claims.viewId, sessionId: claims.sessionId, schemaTuple
    };
    const projection = materializeCommittedAttributionProjectionV2(
      projectionPath,
      receipts.map(({ receipt, path: changedPath }, index) => materializeCommittedAttributionEventV2({
        receipt,
        actorAxesBinding,
        physicalChanges: [{ path: changedPath, beforeDigest: "44".repeat(32), afterDigest: "55".repeat(32) }],
        occurredAt: `2026-07-14T00:30:${String(index).padStart(2, "0")}.000Z`,
        recordedAt: `2026-07-14T00:31:${String(index).padStart(2, "0")}.000Z`
      }))
    );
    for (const { receipt, mutationSet, action } of receipts) {
      const digest = Buffer.from(semanticMutationSetDigestV2(mutationSet)).toString("hex");
      assert.equal(receipt.authorityIntegrity?.semanticMutationSetDigest, digest);
      assert.equal(receipt.integrityTuple?.semanticMutationSetDigest, digest);
      assert.equal(receipt.integrityTuple?.actorAxesBindingDigest, receipt.authorityIntegrity?.actorAxesBindingDigest);
      assert.match(receipt.integrityTuple?.changeSetDigest ?? "", /^[a-f0-9]{64}$/u);
      assert.match(receipt.integrityTuple?.canonicalEventDigest ?? "", /^[a-f0-9]{64}$/u);
      assert.equal(events.find((event) => event.opId === receipt.opId)?.authorityIntegrity?.semanticMutationSetDigest, digest);
      assert.equal(changes.find((change) => change.opId === receipt.opId)?.authorityIntegrity?.semanticMutationSetDigest, digest);
      const projected = projection.find((row) => row.opId === receipt.opId);
      assert.ok(projected, JSON.stringify({ expected: receipt.opId, projected: projection.map((row) => row.opId) }));
      assert.equal(projected.digestStatus.semanticMutationSet, "verified");
      assert.equal(projected.operation, action);
      assert.deepEqual(readBatchTrailer(git(rootDir, env, "log", "-1", "--format=%B", receipt.commitSha)), [{
        opId: receipt.opId,
        semanticMutationSetDigest: digest
      }]);
    }
  });
});

function authority(
  rootDir: string,
  env: NodeJS.ProcessEnv,
  claims: ActorAxesBindingClaimsV2,
  secret: Uint8Array,
  tokenDigest: Uint8Array,
  changeLog: ReplicaChangeLog,
  semanticCompiler: ReturnType<typeof makeSessionExecutionReviewSemanticCompilerV2>
) {
  return createAuthoritySubmissionService({
    workspaceId: claims.workspaceId,
    coordinatorFactory: {
      create: ({ attribution }) => makeJournaledWriteCoordinator({
        rootDir, attribution, commitAuthor: { name: "ZeyuLi", email: "zeyuli@example.test" }, autoMaterialize: false
      })
    },
    tokenVerifier: { verify: async () => { throw new Error("v1 verifier must not run"); } },
    operationRegistry: createInMemoryAuthorityOperationRegistry(),
    replicaChangeLog: changeLog,
    publicationInspector: {
      currentHead: async () => gitOptional(rootDir, env, "rev-parse", "--verify", "HEAD"),
      inspectPublishedHead: async () => {
        const row = git(rootDir, env, "rev-list", "--parents", "-n", "1", "HEAD").split(" ");
        return { commitSha: row[0]!, parentCommits: row.slice(1) };
      }
    },
    fenceWitness: { assertHeld: async () => undefined },
    v2: {
      schemaTuple,
      channelNonceDigest,
      bindingRuntime: {
        proofKeys: { resolve: () => ({ algorithm: "HMAC-SHA-256", secret }) },
        validatePresentationToken: async (input) => bytesEqual(input.tokenDigest, tokenDigest),
        getBinding: async () => ({
          bindingId: claims.bindingId, principalPersonId: claims.principalPersonId,
          executorAgentId: claims.executorAgentId, workspaceId: claims.workspaceId,
          deviceId: claims.deviceId, viewId: claims.viewId, sessionId: claims.sessionId, active: true,
          attribution: {
            actor: { principal: { kind: "person", personId: claims.principalPersonId }, executor: { kind: "agent", id: claims.executorAgentId! } },
            principalSource: { kind: "daemon-authenticated", providerId: "authority.test", credentialFingerprint: "sha256:redacted" },
            executorSource: "client-asserted"
          }
        }),
        currentAuthorityGeneration: () => claims.authorityGeneration,
        currentRevocationEpochs: async () => claims.revocationEpochs,
        nowMs: () => 2_000n,
        consumeOperation: async () => true,
        validateAdmissionTokenRef: async (input) => input.tokenId === claims.tokenId && bytesEqual(input.tokenDigest, tokenDigest)
      },
      entityRegistrations: [entityRegistry.session, entityRegistry.execution, entityRegistry.review],
      semanticCompiler,
      operationNamespaceVerifier: { verify: async () => undefined },
      committedEventPublisher: {
        publish: async (input) => materializeCommittedAttributionEventV2({
          ...input,
          physicalChanges: [{ path: `authority/${input.receipt.opId}`, beforeDigest: null, afterDigest: "55".repeat(32) }],
          recordedAt: input.occurredAt
        })
      }
    }
  });
}

function requestEnvelope(
  randomByte: number,
  payloadValue: SessionExecutionReviewCommandPayloadV2,
  baseCas: ReadonlyArray<SemanticBaseCasV2>,
  declaredPathCas: ReadonlyArray<ReturnType<typeof pathCasFor>>,
  mutationSet: SemanticMutationSetV2
): SemanticMutationEnvelopeV2 {
  const payload = encodeSessionExecutionReviewCommandPayloadV2(payloadValue);
  return finalize({
    schema: semanticMutationEnvelopeV2Schema,
    workspaceId: "workspace-w4-positive",
    operationId: {
      namespace: {
        schema: "operation-namespace/v1", workspaceId: "workspace-w4-positive", deviceId: "device-w4",
        authorityGeneration: 1n, namespaceId: "namespace-w4", expiresAt: 8_000n,
        issuer: "authority.test", keyId: "namespace-key", proof: Buffer.alloc(32, 3)
      },
      clientRandom128: Buffer.alloc(16, randomByte)
    },
    binding: {
      bindingId: "binding-w4", actorAxesBindingDigest: Buffer.alloc(32), deviceId: "device-w4",
      viewId: "view-w4", sessionId: "session-w4",
      admissionTokenRef: { tokenId: "token-w4", tokenDigest: Buffer.alloc(32) }
    },
    schemaTuple,
    intent: {
      kind: "typed", command: { registryVersion: 1, name: payloadValue.schema.replace("/v1", ""), version: 1 },
      canonicalPayload: { kind: "inline", size: BigInt(payload.length), bytes: payload },
      canonicalPayloadDigest: canonicalPayloadDigestV2(payload), baseCas, declaredPathCas
    },
    claimedMutationSet: mutationSet,
    claimedSemanticMutationSetDigest: semanticMutationSetDigestV2(mutationSet),
    claimedSemanticRequestDigest: Buffer.alloc(32)
  });
}

function bindEnvelope(
  envelope: SemanticMutationEnvelopeV2,
  claims: ActorAxesBindingClaimsV2,
  tokenDigest: Uint8Array
): SemanticMutationEnvelopeV2 {
  return finalize({
    ...envelope,
    binding: {
      bindingId: claims.bindingId, actorAxesBindingDigest: actorAxesBindingDigestV2(claims),
      deviceId: claims.deviceId, viewId: claims.viewId, sessionId: claims.sessionId,
      admissionTokenRef: { tokenId: claims.tokenId, tokenDigest }
    }
  });
}

function finalize(value: SemanticMutationEnvelopeV2): SemanticMutationEnvelopeV2 {
  return { ...value, claimedSemanticRequestDigest: semanticRequestDigestV2(value) };
}

function actorClaims(): ActorAxesBindingClaimsV2 {
  return {
    tokenId: "token-w4", bindingId: "binding-w4", principalPersonId: "person_zeyu", executorAgentId: "agent_w4",
    workspaceId: "workspace-w4-positive", deviceId: "device-w4", viewId: "view-w4", sessionId: "session-w4",
    allowedEntityKinds: ["review", "session", "execution"],
    allowedActions: ["sync", "claim", "close", "create", "export", "record", "submit", "archive", "dismiss"],
    resourceScopes: [{ kind: "workspace" }], pathFootprint: null,
    maxBytes: 256n * 1024n, maxMutations: 16, maxOperations: 16,
    authorityGeneration: 1n, channelNonceDigest, schemaTuple,
    issuedAt: 1_000n, notBefore: 1_000n, expiresAt: 9_000n,
    revocationEpochs: { global: 1n, workspace: 1n, device: 1n, view: 1n, principal: 1n, executor: 1n }
  };
}

async function withHermeticGit(body: (input: {
  readonly rootDir: string;
  readonly harnessRoot: string;
  readonly env: NodeJS.ProcessEnv;
}) => Promise<void>) {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-w4-positive-"));
  const harnessRoot = path.join(rootDir, "harness");
  const env = {
    ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null",
    GIT_AUTHOR_NAME: "ZeyuLi", GIT_AUTHOR_EMAIL: "zeyuli@example.test",
    GIT_COMMITTER_NAME: "Harness Authority", GIT_COMMITTER_EMAIL: "authority@example.test"
  };
  try {
    execFileSync("git", ["-C", rootDir, "init", "-q"], { env });
    writeFileSync(path.join(rootDir, ".gitignore"), "/harness/\n/.harness/\n", "utf8");
    mkdirSync(path.join(harnessRoot, "tasks", taskId), { recursive: true });
    writeFileSync(path.join(harnessRoot, "tasks", taskId, "INDEX.md"), "# W4 host task\n", "utf8");
    execFileSync("git", ["-C", harnessRoot, "init", "-q"], { env });
    execFileSync("git", ["-C", harnessRoot, "add", "."], { env });
    execFileSync("git", ["-C", harnessRoot, "commit", "-m", "test: initialize W4 positive control"], { env });
    await body({ rootDir, harnessRoot, env });
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
}

function documentSnapshot(harnessRoot: string, documentPath: string): HostedDocumentSnapshotV2 | null {
  const absolute = path.join(harnessRoot, documentPath);
  if (!existsSync(absolute)) return null;
  const body = readFileSync(absolute, "utf8");
  return { body, epoch: "epoch-w4", revision: 1n, blobDigest: Buffer.from(sha256Text(body), "hex") };
}

function baseCasFor(entityRef: RegistryEntityRefV2, value: SemanticEntityBaseV2 | null): SemanticBaseCasV2 {
  return value
    ? { entityRef, expectedSemanticVersion: value.semanticVersion, expectedStateDigest: value.stateDigest }
    : { entityRef, expectedSemanticVersion: null, expectedStateDigest: null };
}

function pathCasFor(documentPath: string, value: HostedDocumentSnapshotV2) {
  return { path: documentPath, expectedEpoch: value.epoch, expectedRevision: value.revision, expectedBlobDigest: value.blobDigest };
}

function set(entityRef: RegistryEntityRefV2, action: string): SemanticMutationSetV2 {
  return { registryVersion: 1, mutations: [{ entity: entityRef, action: { registryVersion: 1, action } }] };
}

function ref(entityKind: string, canonicalRef: string): RegistryEntityRefV2 {
  return { registryVersion: 1, entityKind, canonicalRef };
}

function key(entityRef: RegistryEntityRefV2): string {
  return `${entityRef.registryVersion}\0${entityRef.entityKind}\0${entityRef.canonicalRef}`;
}

function sessionManifest(body: string, lifecycle: SessionManifest["lifecycle"]): SessionManifest {
  const sha = sha256Text(body);
  return {
    schema: "session-entity/v1", sessionId, lifecycle, archiveStatus: "complete", runtime: "codex", source: "runtime",
    detectedAt: "2026-07-14T00:00:00.000Z", exportedAt: "2026-07-14T00:01:00.000Z",
    bodyRef: {
      store: "authored-cas/v1", ref: `harness/objects/sha256/${sha.slice(0, 2)}/${sha.slice(2)}`,
      sha256: sha, size: Buffer.byteLength(body), mediaType: "text/markdown; charset=utf-8"
    },
    snapshot: {
      capturedAt: "2026-07-14T00:01:00.000Z", completeness: "complete", captureRange: { messageCount: 1 },
      privacyScan: { scannerVersion: "w4-test", passed: true, findings: [] }
    }
  };
}

function executionRecord(state: ExecutionRecord["state"]): ExecutionRecord {
  const submitted = state !== "active";
  return {
    schema: "execution/v2", execution_id: executionId, task_ref: `task/${taskId}`, state,
    primary_actor: { principal: { personId: "person_zeyu" }, executor: { kind: "agent", id: "agent_w4" }, responsibleHuman: "person_zeyu" },
    claimed_at: "2026-07-14T00:00:00.000Z", submitted_at: submitted ? "2026-07-14T00:10:00.000Z" : null,
    closed_at: state === "accepted" ? "2026-07-14T00:20:00.000Z" : null, session_bindings: [],
    outputs: submitted ? [{ evidence_id: "evidence:w4", execution_ref: `execution/${taskId}/${executionId}`, locator: { substrate: "inline", text: "passed" } }] : [],
    submission: submitted ? {
      completion_claim: "W4 complete", deliverables: ["typed compiler"], evidence_refs: ["evidence:w4"],
      verification_notes: ["tested"], known_gaps: [], residual_risks: []
    } : null
  };
}

function reviewId(index: number): string {
  return `rev_01KXD8H2QFMMA4T203PJZ77AQ${7 + index}`;
}

function reviewRecord(id: string, verdict: ReviewRecord["verdict"]): ReviewRecord {
  return {
    schema: "review/v3", review_id: id, task_ref: `task/${taskId}`, execution_ref: `execution/${taskId}/${executionId}`,
    reviewer_actor: { principal: { personId: "person_reviewer" }, executor: { kind: "agent", id: "agent_reviewer" }, responsibleHuman: "person_reviewer" },
    reviewer_session_ref: "session/reviewer-w4", findings: "Typed review findings.", evidence_checked: ["evidence:w4"],
    rationale: "The exact evidence supports this verdict.", verdict, archive_warnings_acknowledged: true,
    reviewed_at: "2026-07-14T00:15:00.000Z", approval_basis: null
  };
}

function git(rootDir: string, env: NodeJS.ProcessEnv, ...args: ReadonlyArray<string>): string {
  return execFileSync("git", ["-C", path.join(rootDir, "harness"), ...args], { encoding: "utf8", env }).trim();
}

function gitOptional(rootDir: string, env: NodeJS.ProcessEnv, ...args: ReadonlyArray<string>): string | null {
  try { return git(rootDir, env, ...args); } catch { return null; }
}

function readBatchTrailer(commitBody: string): ReadonlyArray<{ readonly opId: string; readonly semanticMutationSetDigest: string }> {
  const value = commitBody.split("\n").find((line) => line.startsWith("Harness-Authority-Batch: "))?.slice("Harness-Authority-Batch: ".length);
  if (!value) throw new Error("authority batch trailer missing");
  const encoded = value.split(":").at(-1);
  if (!encoded) throw new Error("authority batch trailer vector missing");
  const bytes = Buffer.from(encoded, "base64url");
  const count = bytes.readUInt32BE(0);
  let offset = 4;
  const entries = [];
  for (let index = 0; index < count; index += 1) {
    const length = bytes.readUInt32BE(offset);
    offset += 4;
    const opId = bytes.subarray(offset, offset + length).toString("utf8");
    offset += length;
    const semanticMutationSetDigest = bytes.subarray(offset, offset + 32).toString("hex");
    offset += 32;
    entries.push({ opId, semanticMutationSetDigest });
  }
  return entries;
}

function bytesEqual(left: Uint8Array, right: Uint8Array): boolean {
  return Buffer.from(left).equals(Buffer.from(right));
}

const channelNonceDigest = Buffer.alloc(32, 0x22);
const schemaTuple = {
  wire: 2, event: 2, receipt: 2, digest: 2, policy: 1,
  commandRegistry: 1, entityRegistry: 1, mutationRegistry: 1, localState: 1, applyJournal: 1
} as const;
