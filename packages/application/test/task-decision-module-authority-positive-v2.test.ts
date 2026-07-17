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
  createAuthoritySubmissionService,
  createInMemoryAuthorityOperationRegistry,
  createInMemoryReplicaChangeLog,
  encodeSemanticMutationEnvelopeV2,
  encodeTaskDecisionModuleCommandPayloadV2,
  issueActorAxesBindingV2,
  makeTaskDecisionModuleSemanticCompilerV2,
  materializeCommittedAttributionEventV2,
  semanticMutationEnvelopeV2Schema,
  semanticMutationSetDigestV2,
  semanticRequestDigestV2,
  type ActorAxesBindingClaimsV2,
  type ReplicaChangeLog,
  type SemanticBaseCasV2,
  type SemanticMutationEnvelopeV2,
  type SemanticMutationSetV2,
  type TaskDecisionModuleCommandPayloadV2
} from "../src/index.ts";
import {
  entityRegistry,
  makeJournaledWriteCoordinator,
  readUnionAttributionEvents,
  type DaemonAdmissionBudget,
  type DecisionPackage,
  type RegistryEntityRefV2
} from "../../kernel/src/index.ts";

test("authority returns retryable overload when the shared admission byte budget is unavailable", async () => {
  await withHermeticGit(async ({ rootDir, env }) => {
    const claims = actorClaims();
    const secret = Buffer.alloc(32, 0x5a);
    const token = issueActorAxesBindingV2(claims, {
      algorithm: "HMAC-SHA-256", issuer: "authority.test", keyId: "key-w3", secret
    });
    const tokenDigest = actorAxesBindingTokenDigestV2(token);
    let authorityRejections = 0;
    const admissionBudget: DaemonAdmissionBudget = {
      reserve: () => {
        authorityRejections += 1;
        return {
          ok: false,
          error: {
            _tag: "WriteRejected",
            code: "admission_overloaded",
            reason: "Shared daemon admission budget is full. Run 'ha daemon status --json', wait for current writes to settle, then retry the exact command.",
            retryable: true
          }
        };
      },
      snapshot: () => ({
        limits: { maxOperations: 2, maxBytes: 1, reservedOperationsPerPlane: 0, reservedBytesPerPlane: 0 },
        used: { operations: 0, bytes: 0, authorityOperations: 0, authorityBytes: 0, jsonRpcOperations: 0, jsonRpcBytes: 0 },
        rejected: { authority: authorityRejections, "json-rpc": 0 }
      })
    };
    const service = authority(rootDir, env, claims, secret, tokenDigest, createInMemoryReplicaChangeLog(), admissionBudget);
    const payload = { schema: "task.create/v1" as const, taskId: "task_W3", indexBody: taskIndex() };
    const mutationSet = set("task", "task/task_W3", "create");
    const envelope = bindEnvelope(requestEnvelope(9, payload, [absent(ref("task", "task/task_W3"))], mutationSet), claims, tokenDigest);

    const receipt = await service.submitV2!({
      requestId: "authority-overload",
      presentationToken: token,
      envelope: encodeSemanticMutationEnvelopeV2(envelope)
    });

    assert.equal(receipt.tag, "RETRYABLE_NOT_COMMITTED");
    assert.equal(receipt.reason, "Shared daemon admission budget is full. Run 'ha daemon status --json', wait for current writes to settle, then retry the exact command.");
    assert.equal(admissionBudget.snapshot().rejected.authority, 1);
  });
});

test("task, decision, and module typed writes publish through their existing physical stores with one digest", async () => {
  await withHermeticGit(async ({ rootDir, env }) => {
    const claims = actorClaims();
    const secret = Buffer.alloc(32, 0x5a);
    const token = issueActorAxesBindingV2(claims, {
      algorithm: "HMAC-SHA-256", issuer: "authority.test", keyId: "key-w3", secret
    });
    const tokenDigest = actorAxesBindingTokenDigestV2(token);
    const changeLog = createInMemoryReplicaChangeLog();
    const service = authority(rootDir, env, claims, secret, tokenDigest, changeLog);
    const fixtures: ReadonlyArray<{
      readonly payload: TaskDecisionModuleCommandPayloadV2;
      readonly mutationSet: SemanticMutationSetV2;
      readonly baseCas: ReadonlyArray<SemanticBaseCasV2>;
      readonly assertPhysical: () => void;
    }> = [
      {
        payload: { schema: "task.create/v1", taskId: "task_W3", indexBody: taskIndex() },
        mutationSet: set("task", "task/task_W3", "create"),
        baseCas: [absent(ref("task", "task/task_W3"))],
        assertPhysical: () => assert.match(readFileSync(path.join(rootDir, "harness/tasks/task_W3/INDEX.md"), "utf8"), /task_id: task_W3/u)
      },
      {
        payload: { schema: "decision.propose/v1", decision: decisionPackage() },
        mutationSet: set("decision", "decision/dec_W3_POS", "propose"),
        baseCas: [absent(ref("decision", "decision/dec_W3_POS"))],
        assertPhysical: () => assert.match(readFileSync(path.join(rootDir, "harness/decisions/decision-dec_W3_POS/decision.md"), "utf8"), /decision_id: dec_W3_POS/u)
      },
      {
        payload: {
          schema: "module.register/v1",
          module: { key: "kernel", title: "Kernel", status: "active", scopes: ["packages/kernel/**"], steps: [] }
        },
        mutationSet: set("module", "module/kernel", "register"),
        baseCas: [absent(ref("module", "module/kernel"))],
        assertPhysical: () => {
          const registry = JSON.parse(readFileSync(path.join(rootDir, "harness/modules.json"), "utf8")) as { readonly modules: ReadonlyArray<{ readonly key: string }> };
          assert.deepEqual(registry.modules.map((entry) => entry.key), ["kernel"]);
        }
      }
    ];

    const receipts = [];
    for (const [index, fixture] of fixtures.entries()) {
      const envelope = bindEnvelope(requestEnvelope(index + 1, fixture.payload, fixture.baseCas, fixture.mutationSet), claims, tokenDigest);
      const receipt = await service.submitV2!({
        requestId: `w3-positive-${index}`,
        presentationToken: token,
        envelope: encodeSemanticMutationEnvelopeV2(envelope)
      });
      assert.equal(receipt.tag, "COMMITTED", JSON.stringify(receipt));
      if (receipt.tag !== "COMMITTED") continue;
      fixture.assertPhysical();
      receipts.push({ receipt, mutationSet: fixture.mutationSet });
    }
    assert.equal(receipts.length, 3);

    const events = readUnionAttributionEvents(rootDir);
    const changes = await changeLog.changesAfter(claims.workspaceId, 0);
    for (const { receipt, mutationSet } of receipts) {
      const digest = Buffer.from(semanticMutationSetDigestV2(mutationSet)).toString("hex");
      assert.equal(receipt.authorityIntegrity?.semanticMutationSetDigest, digest);
      assert.equal(receipt.integrityTuple?.semanticMutationSetDigest, digest);
      assert.equal(receipt.integrityTuple?.actorAxesBindingDigest, receipt.authorityIntegrity?.actorAxesBindingDigest);
      assert.match(receipt.integrityTuple?.changeSetDigest ?? "", /^[a-f0-9]{64}$/u);
      assert.match(receipt.integrityTuple?.canonicalEventDigest ?? "", /^[a-f0-9]{64}$/u);
      assert.equal(events.find((event) => event.opId === receipt.opId)?.authorityIntegrity?.semanticMutationSetDigest, digest);
      assert.equal(changes.find((change) => change.opId === receipt.opId)?.authorityIntegrity?.semanticMutationSetDigest, digest);
      assert.deepEqual(readBatchTrailer(git(rootDir, env, "log", "-1", "--format=%B", receipt.commitSha)), [{
        opId: receipt.opId,
        semanticMutationSetDigest: digest
      }]);
    }
    assert.equal(existsSync(path.join(rootDir, "harness/modules/kernel.json")), false);
  });
});

function authority(
  rootDir: string,
  env: NodeJS.ProcessEnv,
  claims: ActorAxesBindingClaimsV2,
  secret: Uint8Array,
  tokenDigest: Uint8Array,
  changeLog: ReplicaChangeLog,
  admissionBudget?: DaemonAdmissionBudget
) {
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
    ...(admissionBudget ? { admissionBudget } : {}),
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
      entityRegistrations: [entityRegistry.task, entityRegistry.decision, entityRegistry.module],
      semanticCompiler: makeTaskDecisionModuleSemanticCompilerV2({
        state: { readEntityBase: async () => null, readHostedDocument: async () => null }
      }),
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
  payloadValue: TaskDecisionModuleCommandPayloadV2,
  baseCas: ReadonlyArray<SemanticBaseCasV2>,
  mutationSet: SemanticMutationSetV2
): SemanticMutationEnvelopeV2 {
  const payload = encodeTaskDecisionModuleCommandPayloadV2(payloadValue);
  return finalize({
    schema: semanticMutationEnvelopeV2Schema,
    workspaceId: "workspace-w3-positive",
    operationId: {
      namespace: {
        schema: "operation-namespace/v1", workspaceId: "workspace-w3-positive", deviceId: "device-w3",
        authorityGeneration: 1n, namespaceId: "namespace-w3", expiresAt: 8_000n,
        issuer: "authority.test", keyId: "namespace-key", proof: Buffer.alloc(32, 3)
      },
      clientRandom128: Buffer.alloc(16, randomByte)
    },
    binding: {
      bindingId: "binding-w3", actorAxesBindingDigest: Buffer.alloc(32), deviceId: "device-w3",
      viewId: "view-w3", sessionId: "session-w3",
      admissionTokenRef: { tokenId: "token-w3", tokenDigest: Buffer.alloc(32) }
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

function actorClaims(): ActorAxesBindingClaimsV2 {
  return {
    tokenId: "token-w3", bindingId: "binding-w3", principalPersonId: "person_zeyu", executorAgentId: "agent_w3",
    workspaceId: "workspace-w3-positive", deviceId: "device-w3", viewId: "view-w3", sessionId: "session-w3",
    allowedEntityKinds: ["task", "module", "decision"],
    allowedActions: ["create", "propose", "register"],
    resourceScopes: [{ kind: "workspace" }], pathFootprint: null,
    maxBytes: 128n * 1024n, maxMutations: 8, maxOperations: 8,
    authorityGeneration: 1n, channelNonceDigest, schemaTuple,
    issuedAt: 1_000n, notBefore: 1_000n, expiresAt: 9_000n,
    revocationEpochs: { global: 1n, workspace: 1n, device: 1n, view: 1n, principal: 1n, executor: 1n }
  };
}

async function withHermeticGit(body: (input: { readonly rootDir: string; readonly env: NodeJS.ProcessEnv }) => Promise<void>) {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-w3-positive-"));
  const env = {
    ...process.env,
    GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null",
    GIT_AUTHOR_NAME: "ZeyuLi", GIT_AUTHOR_EMAIL: "zeyuli@example.test",
    GIT_COMMITTER_NAME: "Harness Authority", GIT_COMMITTER_EMAIL: "authority@example.test"
  };
  try {
    execFileSync("git", ["-C", rootDir, "init", "-q"], { env });
    writeFileSync(path.join(rootDir, ".gitignore"), "/harness/\n/.harness/\n", "utf8");
    mkdirSync(path.join(rootDir, "harness"), { recursive: true });
    execFileSync("git", ["-C", path.join(rootDir, "harness"), "init", "-q"], { env });
    execFileSync("git", ["-C", path.join(rootDir, "harness"), "commit", "--allow-empty", "-m", "test: initialize W3 positive control"], { env });
    await body({ rootDir, env });
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
}

function set(entityKind: string, canonicalRef: string, action: string): SemanticMutationSetV2 {
  return { registryVersion: 1, mutations: [{ entity: ref(entityKind, canonicalRef), action: { registryVersion: 1, action } }] };
}

function ref(entityKind: string, canonicalRef: string): RegistryEntityRefV2 {
  return { registryVersion: 1, entityKind, canonicalRef };
}

function absent(entityRef: RegistryEntityRefV2): SemanticBaseCasV2 {
  return { entityRef, expectedSemanticVersion: null, expectedStateDigest: null };
}

function taskIndex(): string {
  return [
    "---", "schema: task-package/v2", "task_id: task_W3", "title: W3 positive",
    "lifecycle:", "  bindingSchema: lifecycle-binding/v1", "  engine: local", "  status: planned",
    "  ref: ", "  titleSnapshot: W3 positive", "  url: ",
    "  bindingCreatedAt: 2026-07-14T00:00:00.000Z", `  bindingFingerprint: sha256:${"b".repeat(64)}`,
    "packageDisposition: active", "vertical: default", "preset: default",
    "provenance:", "  - {runtime: codex, sessionId: session-w3, boundAt: 2026-07-14T00:00:00.000Z}",
    "---", "", "# W3 positive", ""
  ].join("\n");
}

function decisionPackage(): DecisionPackage {
  return {
    schema: "decision-package/v1", decision_id: "dec_W3_POS", title: "W3 positive", state: "proposed",
    riskTier: "medium", urgency: "medium", vertical: "software/coding", preset: "architecture-decision",
    applies_to: { modules: [], productLines: [] }, proposedAt: "2026-07-14T00:00:00.000Z",
    provenance: [{ runtime: "codex", sessionId: "session-w3", boundAt: "2026-07-14T00:00:00.000Z" }],
    question: "Should W3 publish a decision?", chosen: [{ id: "CH1", text: "Yes." }],
    rejected: [{ id: "RJ1", text: "No.", why_not: "Positive control requires a write." }],
    claims: [{ id: "C1", text: "The write is typed." }], relations: []
  };
}

function git(rootDir: string, env: NodeJS.ProcessEnv, ...args: ReadonlyArray<string>): string {
  return execFileSync("git", ["-C", path.join(rootDir, "harness"), ...args], { encoding: "utf8", env }).trim();
}

function gitOptional(rootDir: string, env: NodeJS.ProcessEnv, ...args: ReadonlyArray<string>): string | null {
  try { return git(rootDir, env, ...args); } catch { return null; }
}

function readBatchTrailer(commitBody: string): ReadonlyArray<{ readonly opId: string; readonly semanticMutationSetDigest: string }> {
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

function bytesEqual(left: Uint8Array, right: Uint8Array): boolean {
  return Buffer.from(left).equals(Buffer.from(right));
}

const channelNonceDigest = Buffer.alloc(32, 0x22);
const schemaTuple = {
  wire: 2, event: 2, receipt: 2, digest: 2, policy: 1,
  commandRegistry: 1, entityRegistry: 1, mutationRegistry: 1, localState: 1, applyJournal: 1
} as const;
