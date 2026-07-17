// harness-test-tier: integration
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
  actorAxesBindingDigestV2,
  actorAxesBindingTokenDigestV2,
  canonicalPayloadDigestV2,
  completeAuthorityCommittedReceiptV2,
  createAuthoritySubmissionService,
  createInMemoryAuthorityOperationRegistry,
  createInMemoryReplicaChangeLog,
  encodeFactRelationCommandPayloadV2,
  encodeSemanticMutationEnvelopeV2,
  issueActorAxesBindingV2,
  makeFactRelationSemanticCompilerV2,
  materializeCommittedAttributionEventV2,
  materializeCommittedAttributionProjectionV2,
  semanticMutationEnvelopeV2Schema,
  semanticMutationSetDigestV2,
  semanticRequestDigestV2,
  type ActorAxesBindingClaimsV2,
  type FactRelationCommandPayloadV2,
  type ReplicaChangeLog,
  type SemanticBaseCasV2,
  type SemanticMutationEnvelopeV2,
  type SemanticMutationSetV2
} from "../src/index.ts";
import {
  deriveRelationId,
  entityRegistry,
  makeJournaledWriteCoordinator,
  readUnionAttributionEvents,
  type EntityRelationRecord,
  type RegistryEntityRefV2
} from "../../kernel/src/index.ts";

test("typed fact-create and relation-create publish hosted bytes with one cross-layer digest", async () => {
  await withHermeticGit(async ({ rootDir, env }) => {
    const claims = actorClaims();
    const secret = Buffer.alloc(32, 0x5a);
    const token = issueActorAxesBindingV2(claims, {
      algorithm: "HMAC-SHA-256",
      issuer: "authority.test",
      keyId: "key-w2",
      secret
    });
    const tokenDigest = actorAxesBindingTokenDigestV2(token);
    const bases = new Map<string, { readonly semanticVersion: string | null; readonly stateDigest: Uint8Array | null }>();
    const changeLog = createInMemoryReplicaChangeLog();
    let failEventPublication = false;
    const service = authority(rootDir, env, claims, secret, tokenDigest, changeLog, bases, () => failEventPublication);
    const factRef = ref("fact", "fact/task_T/F-DEADBEEF");
    const factSet: SemanticMutationSetV2 = {
      registryVersion: 1,
      mutations: [{
        entity: factRef,
        action: { registryVersion: 1, action: "create" }
      }]
    };
    const factEnvelope = bindEnvelope(
      requestEnvelope(1, factCreatePayload(), [absent(factRef)], factSet),
      claims,
      tokenDigest
    );
    const factReceipt = await service.submitV2!({
      requestId: "positive-fact",
      presentationToken: token,
      envelope: encodeSemanticMutationEnvelopeV2(factEnvelope)
    });
    assert.equal(factReceipt.tag, "COMMITTED", JSON.stringify(factReceipt));
    if (factReceipt.tag !== "COMMITTED") return;
    const factsPath = path.join(rootDir, "harness/tasks/task_T/facts.md");
    assert.equal(existsSync(factsPath), true);
    assert.match(readFileSync(factsPath, "utf8"), /fact_id: F-DEADBEEF/u);
    assert.equal(existsSync(path.join(rootDir, "harness/facts/F-DEADBEEF.md")), false);
    bases.set(key(factRef), { semanticVersion: "fact-v1", stateDigest: stateDigest });

    const relation = evidenceRelation();
    const relationRef = ref("relation", `relation/${relation.relation_id}`);
    const relationSet: SemanticMutationSetV2 = {
      registryVersion: 1,
      mutations: [{
        entity: relationRef,
        action: { registryVersion: 1, action: "create" }
      }]
    };
    const relationEnvelope = bindEnvelope(
      requestEnvelope(2, { schema: "relation.create/v1", relation }, [absent(relationRef), present(factRef, "fact-v1")], relationSet),
      claims,
      tokenDigest
    );
    const relationReceipt = await service.submitV2!({
      requestId: "positive-relation",
      presentationToken: token,
      envelope: encodeSemanticMutationEnvelopeV2(relationEnvelope)
    });
    assert.equal(relationReceipt.tag, "COMMITTED", JSON.stringify(relationReceipt));
    if (relationReceipt.tag !== "COMMITTED") return;
    assert.match(readFileSync(factsPath, "utf8"), new RegExp(`relation_id: ${relation.relation_id}`, "u"));
    assert.equal(existsSync(path.join(rootDir, `harness/relations/${relation.relation_id}.md`)), false);

    const events = readUnionAttributionEvents(rootDir);
    const changes = await changeLog.changesAfter(claims.workspaceId, 0);
    for (const [receipt, mutationSet] of [[factReceipt, factSet], [relationReceipt, relationSet]] as const) {
      const digest = Buffer.from(semanticMutationSetDigestV2(mutationSet)).toString("hex");
      assert.equal(receipt.authorityIntegrity?.semanticMutationSetDigest, digest);
      assert.equal(receipt.integrityTuple?.semanticMutationSetDigest, digest);
      assert.equal(receipt.integrityTuple?.actorAxesBindingDigest, receipt.authorityIntegrity?.actorAxesBindingDigest);
      assert.match(receipt.integrityTuple?.changeSetDigest ?? "", /^[a-f0-9]{64}$/u);
      assert.match(receipt.integrityTuple?.canonicalEventDigest ?? "", /^[a-f0-9]{64}$/u);
      assert.equal(events.find((event) => event.opId === receipt.opId)?.schema, "attribution-event/v1");
      assert.equal(events.find((event) => event.opId === receipt.opId)?.authorityIntegrity?.semanticMutationSetDigest, digest);
      assert.equal(changes.find((change) => change.opId === receipt.opId)?.authorityIntegrity?.semanticMutationSetDigest, digest);
      const commitBody = git(rootDir, env, "log", "-1", "--format=%B", receipt.commitSha);
      assert.deepEqual(readBatchTrailer(commitBody), [{ opId: receipt.opId, semanticMutationSetDigest: digest }]);
    }

    const completeEvent = materializeCommittedAttributionEventV2({
      receipt: relationReceipt,
      actorAxesBinding: actorAxesBindingCore(claims),
      physicalChanges: [{ path: "tasks/task_T/facts.md", beforeDigest: "33".repeat(32), afterDigest: "44".repeat(32) }],
      occurredAt: "2026-07-13T00:00:00.000Z",
      recordedAt: "2026-07-13T00:00:00.001Z"
    });
    const projectionPath = path.join(rootDir, "w2-projection.sqlite");
    writeFileSync(projectionPath, "", "utf8");
    const rows = materializeCommittedAttributionProjectionV2(projectionPath, [completeEvent]);
    assert.deepEqual(rows.map((row) => [row.subjectRef, row.operation]), [[`relation/${relation.relation_id}`, "create"]]);
    assert.equal(rows[0]?.actor.principal.personId, claims.principalPersonId);
    assert.equal(rows[0]?.actor.executor?.id, claims.executorAgentId);
    assert.equal(rows[0]?.digestStatus.semanticMutationSet, "verified");
    assert.equal(rows[0]?.digestStatus.actorAxesBinding, "verified");

    failEventPublication = true;
    const unpublishedFactRef = ref("fact", "fact/task_T/F-ABCD1234");
    const unpublishedSet: SemanticMutationSetV2 = {
      registryVersion: 1,
      mutations: [{ entity: unpublishedFactRef, action: { registryVersion: 1, action: "create" } }]
    };
    const unpublishedEnvelope = bindEnvelope(
      requestEnvelope(3, factCreatePayload("F-ABCD1234"), [absent(unpublishedFactRef)], unpublishedSet),
      claims,
      tokenDigest
    );
    const unpublishedReceipt = await service.submitV2!({
      requestId: "event-store-unavailable",
      presentationToken: token,
      envelope: encodeSemanticMutationEnvelopeV2(unpublishedEnvelope)
    });
    assert.equal(unpublishedReceipt.tag, "INDETERMINATE", JSON.stringify(unpublishedReceipt));
    assert.match(unpublishedReceipt.tag === "INDETERMINATE" ? unpublishedReceipt.reason : "", /V2_EVENT_PUBLICATION_FAILED/u);
    assert.equal(unpublishedReceipt.tag === "INDETERMINATE" && typeof unpublishedReceipt.commitSha === "string", true);
    assert.equal("integrityTuple" in unpublishedReceipt, false);
    failEventPublication = false;
    const recoveredReceipt = await service.submitV2!({
      requestId: "event-store-recovered-after-restart",
      presentationToken: token,
      envelope: encodeSemanticMutationEnvelopeV2(unpublishedEnvelope)
    });
    assert.equal(recoveredReceipt.tag, "COMMITTED", JSON.stringify(recoveredReceipt));
    if (recoveredReceipt.tag === "COMMITTED") {
      assert.equal(recoveredReceipt.commitSha, unpublishedReceipt.tag === "INDETERMINATE" ? unpublishedReceipt.commitSha : undefined);
      assert.match(recoveredReceipt.integrityTuple?.canonicalEventDigest ?? "", /^[a-f0-9]{64}$/u);
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
  bases: Map<string, { readonly semanticVersion: string | null; readonly stateDigest: Uint8Array | null }>,
  failEventPublication: () => boolean
) {
  const operationRegistry = createInMemoryAuthorityOperationRegistry();
  return createAuthoritySubmissionService({
    workspaceId: claims.workspaceId,
    coordinatorFactory: {
      create: ({ attribution }) => makeJournaledWriteCoordinator({
        rootDir,
        attribution,
        commitAuthor: { name: "ZeyuLi", email: "zeyuli@example.test" },
        autoMaterialize: false
      })
    },
    tokenVerifier: { verify: async () => { throw new Error("v1 verifier must not run"); } },
    operationRegistry,
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
        nowMs: () => 2_000n,
        consumeOperation: async () => true,
        validateAdmissionTokenRef: async (input) => input.tokenId === claims.tokenId && bytesEqual(input.tokenDigest, tokenDigest)
      },
      entityRegistrations: [entityRegistry.fact, entityRegistry.relation],
      semanticCompiler: makeFactRelationSemanticCompilerV2({
        state: {
          readEntityBase: async (entityRef) => bases.get(key(entityRef)) ?? null,
          readHostedDocument: async () => null
        }
      }),
      operationNamespaceVerifier: { verify: async () => undefined },
      committedEventPublisher: {
        publish: async (input) => {
          if (failEventPublication()) throw new Error("durable V2 event store unavailable");
          return materializeCommittedAttributionEventV2({
            ...input,
            physicalChanges: [{ path: `authority/${input.receipt.opId}`, beforeDigest: null, afterDigest: "55".repeat(32) }],
            recordedAt: input.occurredAt
          });
        }
      },
      recoverCommittedReceipt: async (record) => {
        const change = await changeLog.getByOperation(record.workspaceId, record.opId);
        if (!change || !record.authorityIntegrity || !record.commitSha) throw new Error("incomplete recovery fixture");
        return completeAuthorityCommittedReceiptV2({
          publisher: {
            publish: async (input) => materializeCommittedAttributionEventV2({
              ...input,
              physicalChanges: [{ path: `authority/${input.receipt.opId}`, beforeDigest: null, afterDigest: "55".repeat(32) }],
              recordedAt: input.occurredAt
            })
          },
          receipt: {
            tag: "COMMITTED",
            workspaceId: record.workspaceId,
            opId: record.opId,
            semanticDigest: record.semanticDigest,
            revision: change.revision,
            commitSha: change.commitSha,
            previousCommit: change.previousCommit,
            authorityIntegrity: record.authorityIntegrity
          },
          actorAxesBinding: actorAxesBindingCore(claims),
          occurredAt: change.changedAt
        });
      }
    }
  });
}

function requestEnvelope(
  randomByte: number,
  payloadValue: FactRelationCommandPayloadV2,
  baseCas: ReadonlyArray<SemanticBaseCasV2>,
  mutationSet: SemanticMutationSetV2
): SemanticMutationEnvelopeV2 {
  const payload = encodeFactRelationCommandPayloadV2(payloadValue);
  const draft: SemanticMutationEnvelopeV2 = {
    schema: semanticMutationEnvelopeV2Schema,
    workspaceId: "workspace-w2",
    operationId: {
      namespace: {
        schema: "operation-namespace/v1", workspaceId: "workspace-w2", deviceId: "device-w2",
        authorityGeneration: 1n, namespaceId: "namespace-w2", expiresAt: 8_000n,
        issuer: "authority.test", keyId: "namespace-key", proof: Buffer.alloc(32, 3)
      },
      clientRandom128: Buffer.alloc(16, randomByte)
    },
    binding: {
      bindingId: "binding-w2", actorAxesBindingDigest: Buffer.alloc(32), deviceId: "device-w2",
      viewId: "view-w2", sessionId: "session-w2",
      admissionTokenRef: { tokenId: "token-w2", tokenDigest: Buffer.alloc(32) }
    },
    schemaTuple,
    intent: {
      kind: "typed",
      command: { registryVersion: 1, name: payloadValue.schema.replace("/v1", ""), version: 1 },
      canonicalPayload: { kind: "inline", size: BigInt(payload.length), bytes: payload },
      canonicalPayloadDigest: canonicalPayloadDigestV2(payload),
      baseCas,
      declaredPathCas: []
    },
    claimedMutationSet: mutationSet,
    claimedSemanticMutationSetDigest: semanticMutationSetDigestV2(mutationSet),
    claimedSemanticRequestDigest: Buffer.alloc(32)
  };
  return finalize(draft);
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

function finalize(envelope: SemanticMutationEnvelopeV2): SemanticMutationEnvelopeV2 {
  return { ...envelope, claimedSemanticRequestDigest: semanticRequestDigestV2(envelope) };
}

function factCreatePayload(factId = "F-DEADBEEF"): FactRelationCommandPayloadV2 {
  return {
    schema: "fact.create/v1",
    ownerTaskId: "task_T",
    factId,
    statement: "Authority writes a hosted fact.",
    source: "W2 positive control",
    observedAt: "2026-07-13T00:00:00.000Z",
    confidence: "high",
    memoryClass: "episodic",
    memoryTags: [],
    provenance: [{ runtime: "codex", sessionId: "session-w2", boundAt: "2026-07-13T00:00:00.000Z" }]
  };
}

function evidenceRelation(): EntityRelationRecord {
  const identity = {
    source: "fact/task_T/F-DEADBEEF",
    target: "decision/dec_D",
    type: "supports" as const,
    direction: "directed" as const
  };
  return {
    relation_id: deriveRelationId(identity),
    ...identity,
    strength: "strong",
    origin: "declared",
    rationale: "Fact supports the decision.",
    state: "active"
  };
}

function actorClaims(): ActorAxesBindingClaimsV2 {
  return {
    tokenId: "token-w2", bindingId: "binding-w2", principalPersonId: "person_zeyu", executorAgentId: "agent_w2",
    workspaceId: "workspace-w2", deviceId: "device-w2", viewId: "view-w2", sessionId: "session-w2",
    allowedEntityKinds: ["fact", "relation"], allowedActions: ["create"], resourceScopes: [{ kind: "workspace" }],
    pathFootprint: null, maxBytes: 64n * 1024n, maxMutations: 8, maxOperations: 8,
    authorityGeneration: 1n, channelNonceDigest, schemaTuple,
    issuedAt: 1_000n, notBefore: 1_000n, expiresAt: 9_000n,
    revocationEpochs: { global: 1n, workspace: 1n, device: 1n, view: 1n, principal: 1n, executor: 1n }
  };
}

function actorAxesBindingCore(claims: ActorAxesBindingClaimsV2) {
  return {
    bindingId: claims.bindingId,
    principalPersonId: claims.principalPersonId,
    executorAgentId: claims.executorAgentId,
    workspaceId: claims.workspaceId,
    deviceId: claims.deviceId,
    viewId: claims.viewId,
    sessionId: claims.sessionId,
    schemaTuple: claims.schemaTuple
  };
}

async function withHermeticGit(body: (input: { readonly rootDir: string; readonly env: NodeJS.ProcessEnv }) => Promise<void>) {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-w2-positive-"));
  const env = {
    ...process.env,
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_SYSTEM: "/dev/null",
    GIT_AUTHOR_NAME: "ZeyuLi",
    GIT_AUTHOR_EMAIL: "zeyuli@example.test",
    GIT_COMMITTER_NAME: "Harness Authority",
    GIT_COMMITTER_EMAIL: "authority@example.test"
  };
  try {
    execFileSync("git", ["-C", rootDir, "init", "-q"], { env });
    writeFileSync(path.join(rootDir, ".gitignore"), "/harness/\n/.harness/\n", "utf8");
    mkdirSync(path.join(rootDir, "harness"), { recursive: true });
    execFileSync("git", ["-C", path.join(rootDir, "harness"), "init", "-q"], { env });
    execFileSync("git", ["-C", path.join(rootDir, "harness"), "commit", "--allow-empty", "-m", "test: initialize W2 positive control"], { env });
    await body({ rootDir, env });
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
}

function git(rootDir: string, env: NodeJS.ProcessEnv, ...args: ReadonlyArray<string>): string {
  return execFileSync("git", ["-C", path.join(rootDir, "harness"), ...args], { encoding: "utf8", env }).trim();
}

function gitOptional(rootDir: string, env: NodeJS.ProcessEnv, ...args: ReadonlyArray<string>): string | null {
  try {
    return git(rootDir, env, ...args);
  } catch {
    return null;
  }
}

function ref(entityKind: string, canonicalRef: string): RegistryEntityRefV2 {
  return { registryVersion: 1, entityKind, canonicalRef };
}

function key(entityRef: RegistryEntityRefV2): string {
  return `${entityRef.registryVersion}\0${entityRef.entityKind}\0${entityRef.canonicalRef}`;
}

function present(entityRef: RegistryEntityRefV2, semanticVersion: string): SemanticBaseCasV2 {
  return { entityRef, expectedSemanticVersion: semanticVersion, expectedStateDigest: stateDigest };
}

function absent(entityRef: RegistryEntityRefV2): SemanticBaseCasV2 {
  return { entityRef, expectedSemanticVersion: null, expectedStateDigest: null };
}

function bytesEqual(left: Uint8Array, right: Uint8Array): boolean {
  return Buffer.from(left).equals(Buffer.from(right));
}

function readBatchTrailer(commitBody: string): ReadonlyArray<{
  readonly opId: string;
  readonly semanticMutationSetDigest: string;
}> {
  const value = commitBody.split("\n")
    .find((line) => line.startsWith("Harness-Authority-Batch: "))
    ?.slice("Harness-Authority-Batch: ".length);
  if (!value) throw new Error("authority batch trailer missing");
  const encoded = value.split(":").at(-1);
  if (!encoded) throw new Error("authority batch trailer vector missing");
  const bytes = Buffer.from(encoded, "base64url");
  const count = bytes.readUInt32BE(0);
  let offset = 4;
  const entries: Array<{ readonly opId: string; readonly semanticMutationSetDigest: string }> = [];
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

const stateDigest = Buffer.alloc(32, 0x11);
const channelNonceDigest = Buffer.alloc(32, 0x22);
const schemaTuple = {
  wire: 2, event: 2, receipt: 2, digest: 2, policy: 1,
  commandRegistry: 1, entityRegistry: 1, mutationRegistry: 1, localState: 1, applyJournal: 1
} as const;
