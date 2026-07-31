// harness-test-tier: integration
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
  type CanonicalPublicationInspector,
  type HostedDocumentSnapshotV2,
  type PathCasV2,
  type SemanticMutationEnvelopeV2
} from "../src/index.ts";
import {
  entityRegistry,
  makeJournaledWriteCoordinator,
  sha256Text,
  type RegistryEntityRefV2
} from "../../kernel/src/index.ts";

test("same-state task transition is proven by a terminal reread and returns already-satisfied without publication", async () => {
  await withHermeticGit(async ({ rootDir, env }) => {
    const fixture = installTask(rootDir, env, "task_ALREADY_ACTIVE", "active");
    let reads = 0;
    const readHostedDocument = diskReader(rootDir, fixture.taskId, () => { reads += 1; });
    const initial = (await readHostedDocument(fixture.path))!;
    reads = 0;

    const receipt = await submitTransition({
      rootDir,
      env,
      taskId: fixture.taskId,
      to: "active",
      initial,
      readHostedDocument,
      randomByte: 8
    });

    assert.equal(receipt.tag, "ALREADY_SATISFIED", JSON.stringify(receipt));
    assert.equal(reads, 2, "terminal success must be based on a fresh state reread");
    assert.equal(git(rootDir, env, "rev-parse", "HEAD"), fixture.head);
  });
});

test("same-state candidate fails closed when the terminal reread no longer equals the request", async () => {
  await withHermeticGit(async ({ rootDir, env }) => {
    const taskId = "task_REREAD_CHANGED";
    const active = taskIndex(taskId, "active");
    const blocked = taskIndex(taskId, "blocked");
    let reads = 0;
    const readHostedDocument = async (): Promise<HostedDocumentSnapshotV2> => {
      reads += 1;
      return snapshot(reads === 1 ? active : blocked, BigInt(reads));
    };
    const initial = snapshot(active, 1n);

    const receipt = await submitTransition({
      rootDir,
      env,
      taskId,
      to: "active",
      initial,
      readHostedDocument,
      randomByte: 6
    });

    assert.equal(receipt.tag, "INDETERMINATE", JSON.stringify(receipt));
    assert.equal(receipt.reason, "ALREADY_SATISFIED_STATE_RECHECK_MISMATCH");
    assert.equal(reads, 2);
  });
});

test("real task transition remains indeterminate when canonical publication proof is non-linear", async () => {
  await withHermeticGit(async ({ rootDir, env }) => {
    const fixture = installTask(rootDir, env, "task_REAL_TRANSITION", "active");
    let reads = 0;
    const readHostedDocument = diskReader(rootDir, fixture.taskId, () => { reads += 1; });
    const initial = (await readHostedDocument(fixture.path))!;
    reads = 0;
    const publicationInspector: CanonicalPublicationInspector = {
      currentHead: async () => fixture.head,
      inspectPublishedHead: async () => {
        throw new Error(
          `AUTHORITY_CANONICAL_PUBLICATION_NON_LINEAR;expectedPreviousHead=${fixture.head}`
        );
      }
    };

    const receipt = await submitTransition({
      rootDir,
      env,
      taskId: fixture.taskId,
      to: "blocked",
      initial,
      readHostedDocument,
      publicationInspector,
      randomByte: 7
    });

    assert.equal(receipt.tag, "INDETERMINATE", JSON.stringify(receipt));
    assert.match(receipt.reason, /PUBLICATION_PROOF_FAILED:AUTHORITY_CANONICAL_PUBLICATION_NON_LINEAR/u);
    assert.equal(reads, 1, "a differing target state must not enter no-op terminal reread");
    assert.match(readFileSync(path.join(rootDir, "harness", fixture.path), "utf8"), /status: blocked/u);
  });
});

async function submitTransition(input: {
  readonly rootDir: string;
  readonly env: NodeJS.ProcessEnv;
  readonly taskId: string;
  readonly to: "active" | "blocked";
  readonly initial: HostedDocumentSnapshotV2;
  readonly readHostedDocument: (path: string) => Promise<HostedDocumentSnapshotV2 | null>;
  readonly publicationInspector?: CanonicalPublicationInspector;
  readonly randomByte: number;
}) {
  const claims = actorClaims();
  const secret = Buffer.alloc(32, 0x5a);
  const token = issueActorAxesBindingV2(claims, {
    algorithm: "HMAC-SHA-256", issuer: "authority.test", keyId: "key-noop", secret
  });
  const tokenDigest = actorAxesBindingTokenDigestV2(token);
  const payload = { schema: "task.transition/v1" as const, taskId: input.taskId, to: input.to };
  const payloadBytes = encodeTaskDecisionModuleCommandPayloadV2(payload);
  const entityRef = ref("task", `task/${input.taskId}`);
  const mutationSet = {
    registryVersion: 1,
    mutations: [{ entity: entityRef, action: { registryVersion: 1, action: "transition" } }]
  } as const;
  const envelope = finalize({
    schema: semanticMutationEnvelopeV2Schema,
    workspaceId: claims.workspaceId,
    operationId: {
      namespace: {
        schema: "operation-namespace/v1", workspaceId: claims.workspaceId,
        deviceId: claims.deviceId, authorityGeneration: 1n, namespaceId: "namespace-noop",
        expiresAt: 8_000n, issuer: "authority.test", keyId: "namespace-key",
        proof: Buffer.alloc(32, 3)
      },
      clientRandom128: Buffer.alloc(16, input.randomByte)
    },
    binding: {
      bindingId: claims.bindingId,
      actorAxesBindingDigest: actorAxesBindingDigestV2(claims),
      deviceId: claims.deviceId,
      viewId: claims.viewId,
      sessionId: claims.sessionId,
      admissionTokenRef: { tokenId: claims.tokenId, tokenDigest }
    },
    schemaTuple,
    intent: {
      kind: "typed",
      command: { registryVersion: 1, name: "task.transition", version: 1 },
      canonicalPayload: { kind: "inline", size: BigInt(payloadBytes.length), bytes: payloadBytes },
      canonicalPayloadDigest: canonicalPayloadDigestV2(payloadBytes),
      baseCas: [{ entityRef, expectedSemanticVersion: null, expectedStateDigest: null }],
      declaredPathCas: [pathCas(`tasks/${input.taskId}/INDEX.md`, input.initial)]
    },
    claimedMutationSet: mutationSet,
    claimedSemanticMutationSetDigest: semanticMutationSetDigestV2(mutationSet),
    claimedSemanticRequestDigest: Buffer.alloc(32)
  });
  const service = createAuthoritySubmissionService({
    workspaceId: claims.workspaceId,
    coordinatorFactory: {
      create: ({ attribution }) => makeJournaledWriteCoordinator({
        rootDir: input.rootDir,
        attribution,
        commitAuthor: { name: "ZeyuLi", email: "zeyuli@example.test" },
        autoMaterialize: false
      })
    },
    tokenVerifier: { verify: async () => { throw new Error("v1 verifier must not run"); } },
    operationRegistry: createInMemoryAuthorityOperationRegistry(),
    replicaChangeLog: createInMemoryReplicaChangeLog(),
    publicationInspector: input.publicationInspector ?? gitPublicationInspector(input.rootDir, input.env),
    fenceWitness: { assertHeld: async () => undefined },
    v2: {
      schemaTuple,
      channelNonceDigest,
      bindingRuntime: bindingRuntime(claims, secret, tokenDigest),
      entityRegistrations: [entityRegistry.task],
      semanticCompiler: makeTaskDecisionModuleSemanticCompilerV2({
        state: { readEntityBase: async () => null, readHostedDocument: input.readHostedDocument }
      }),
      operationNamespaceVerifier: { verify: async () => undefined },
      committedEventPublisher: {
        publish: async (eventInput) => materializeCommittedAttributionEventV2({
          ...eventInput,
          physicalChanges: [{ path: `authority/${eventInput.receipt.opId}`, beforeDigest: null, afterDigest: "55".repeat(32) }],
          recordedAt: eventInput.occurredAt
        })
      }
    }
  });
  return service.submitV2!({
    requestId: `transition-${input.randomByte}`,
    presentationToken: token,
    envelope: encodeSemanticMutationEnvelopeV2(envelope)
  });
}

function bindingRuntime(claims: ActorAxesBindingClaimsV2, secret: Uint8Array, tokenDigest: Uint8Array) {
  return {
    proofKeys: { resolve: () => ({ algorithm: "HMAC-SHA-256" as const, secret }) },
    validatePresentationToken: async (input: { readonly tokenDigest: Uint8Array }) => bytesEqual(input.tokenDigest, tokenDigest),
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
          principal: { kind: "person" as const, personId: claims.principalPersonId },
          executor: { kind: "agent" as const, id: claims.executorAgentId! }
        },
        principalSource: { kind: "daemon-authenticated" as const, providerId: "authority.test", credentialFingerprint: "sha256:redacted" },
        executorSource: "client-asserted" as const
      }
    }),
    currentAuthorityGeneration: () => claims.authorityGeneration,
    currentRevocationEpochs: async () => claims.revocationEpochs,
    nowMs: () => 2_000n,
    consumeOperation: async () => "consumed" as const,
    validateAdmissionTokenRef: async (input: { readonly tokenId: string; readonly tokenDigest: Uint8Array }) =>
      input.tokenId === claims.tokenId && bytesEqual(input.tokenDigest, tokenDigest)
  };
}

function actorClaims(): ActorAxesBindingClaimsV2 {
  return {
    tokenId: "token-noop", bindingId: "binding-noop", principalPersonId: "person_zeyu",
    executorAgentId: "agent_noop", workspaceId: "workspace-noop", deviceId: "device-noop",
    viewId: "view-noop", sessionId: "session-noop", allowedEntityKinds: ["task"],
    allowedActions: ["transition"], resourceScopes: [{ kind: "workspace" }], pathFootprint: null,
    maxBytes: 128n * 1024n, maxMutations: 8, maxOperations: 8,
    authorityGeneration: 1n, channelNonceDigest, schemaTuple,
    issuedAt: 1_000n, notBefore: 1_000n, expiresAt: 9_000n,
    revocationEpochs: { global: 1n, workspace: 1n, device: 1n, view: 1n, principal: 1n, executor: 1n }
  };
}

function installTask(rootDir: string, env: NodeJS.ProcessEnv, taskId: string, status: string) {
  const relativePath = `tasks/${taskId}/INDEX.md`;
  mkdirSync(path.dirname(path.join(rootDir, "harness", relativePath)), { recursive: true });
  writeFileSync(path.join(rootDir, "harness", relativePath), taskIndex(taskId, status), "utf8");
  git(rootDir, env, "add", ".");
  git(rootDir, env, "commit", "-m", `test: install ${status} task`);
  return { taskId, path: relativePath, head: git(rootDir, env, "rev-parse", "HEAD") };
}

function diskReader(rootDir: string, taskId: string, observed: () => void) {
  return async (documentPath: string): Promise<HostedDocumentSnapshotV2 | null> => {
    if (documentPath !== `tasks/${taskId}/INDEX.md`) return null;
    observed();
    return snapshot(readFileSync(path.join(rootDir, "harness", documentPath), "utf8"), 0n);
  };
}

function snapshot(body: string, revision: bigint): HostedDocumentSnapshotV2 {
  const digest = sha256Text(body);
  return { body, epoch: digest, revision, blobDigest: Buffer.from(digest, "hex") };
}

function pathCas(documentPath: string, value: HostedDocumentSnapshotV2): PathCasV2 {
  return {
    path: documentPath,
    expectedEpoch: value.epoch,
    expectedRevision: value.revision,
    expectedBlobDigest: value.blobDigest
  };
}

function taskIndex(taskId: string, status: string): string {
  return [
    "---", "schema: task-package/v2", `task_id: ${taskId}`, "title: Exact no-op",
    "lifecycle:", "  bindingSchema: lifecycle-binding/v1", "  engine: local", `  status: ${status}`,
    "  ref: ", "  titleSnapshot: Exact no-op", "  url: ",
    "  bindingCreatedAt: 2026-07-31T00:00:00.000Z", `  bindingFingerprint: sha256:${"b".repeat(64)}`,
    "packageDisposition: active", "vertical: default", "preset: default",
    "provenance:", "  - {runtime: codex, sessionId: session-noop, boundAt: 2026-07-31T00:00:00.000Z}",
    "---", "", "# Exact no-op", ""
  ].join("\n");
}

async function withHermeticGit(body: (input: { readonly rootDir: string; readonly env: NodeJS.ProcessEnv }) => Promise<void>) {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-noop-transition-"));
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
    execFileSync("git", ["-C", path.join(rootDir, "harness"), "commit", "--allow-empty", "-m", "test: initialize no-op transition"], { env });
    await body({ rootDir, env });
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
}

function gitPublicationInspector(rootDir: string, env: NodeJS.ProcessEnv): CanonicalPublicationInspector {
  return {
    currentHead: async () => git(rootDir, env, "rev-parse", "--verify", "HEAD"),
    inspectPublishedHead: async () => {
      const row = git(rootDir, env, "rev-list", "--parents", "-n", "1", "HEAD").split(" ");
      return { commitSha: row[0]!, parentCommits: row.slice(1) };
    }
  };
}

function finalize(envelope: SemanticMutationEnvelopeV2): SemanticMutationEnvelopeV2 {
  return { ...envelope, claimedSemanticRequestDigest: semanticRequestDigestV2(envelope) };
}

function ref(entityKind: string, canonicalRef: string): RegistryEntityRefV2 {
  return { registryVersion: 1, entityKind, canonicalRef };
}

function git(rootDir: string, env: NodeJS.ProcessEnv, ...args: ReadonlyArray<string>): string {
  return execFileSync("git", ["-C", path.join(rootDir, "harness"), ...args], { encoding: "utf8", env }).trim();
}

function bytesEqual(left: Uint8Array, right: Uint8Array): boolean {
  return Buffer.from(left).equals(Buffer.from(right));
}

const channelNonceDigest = Buffer.alloc(32, 0x22);
const schemaTuple = {
  wire: 2, event: 2, receipt: 2, digest: 2, policy: 1,
  commandRegistry: 1, entityRegistry: 1, mutationRegistry: 1, localState: 1, applyJournal: 1
} as const;
