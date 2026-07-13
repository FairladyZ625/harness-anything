// harness-test-tier: integration
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { PassThrough, Writable } from "node:stream";
import test from "node:test";
import {
  authorityProtocolTuple,
  actorAxesBindingTokenDigestV2,
  canonicalAuthorityRequestDigest,
  compareCanonicalPathBytes,
  createAuthoritySubmissionService,
  createInMemoryAuthorityOperationRegistry,
  createInMemoryReplicaChangeLog,
  createInMemoryShadowPublicationLog,
  createNamespaceAdmissionService,
  encodeSemanticMutationEnvelopeV2,
  issueActorAxesBindingV2,
  reconcileShadowPublications,
  semanticMutationSetDigestV2,
  semanticRequestDigestV2,
  SemanticAdmissionErrorV2,
  NamespaceAdmissionError,
  validatePortableManagedPath,
  type AuthorityOperationEnvelope,
  type CanonicalPublicationInspector,
  type DelegationTokenVerifier,
  type ReplicaChangeLog,
  type ProtocolSchemaTupleV2,
  type ShadowPublicationLog
} from "../../application/src/index.ts";
import {
  entityRegistry,
  makeJournaledWriteCoordinator,
  readUnionAttributionEvents,
  taskEntityId,
  type WriteAttribution
} from "../../kernel/src/index.ts";
import {
  PersistentSshAuthorityClient,
  AuthorityTransportDisconnectedError,
  buildAuthoritySshArgs,
  createLengthPrefixedFrameReader,
  encodeLengthPrefixedFrame,
  serveAuthorityForcedCommand,
  type SshAuthorityChild,
  type SshAuthorityChildFactory
} from "../src/index.ts";
import { v2Claims, v2Envelope, v2MutationSet } from "./authority-v2-fixtures.ts";

const workspaceId = "workspace-tw01";
const channelNonceDigest = "sha256:channel-generation";
const opaqueToken = "opaque-token-must-not-leak";
const authorityBatchTrailerName = "Harness-Authority-Batch";
const v2SchemaTuple: ProtocolSchemaTupleV2 = {
  wire: 2, event: 2, receipt: 2, digest: 2, policy: 2,
  commandRegistry: 1, entityRegistry: 1, mutationRegistry: 1,
  localState: 1, applyJournal: 1
};
const v2Attribution: WriteAttribution = {
  actor: {
    principal: { kind: "person", personId: "person_v2" },
    executor: { kind: "agent", id: "agent_v2" }
  },
  principalSource: { kind: "daemon-authenticated", providerId: "v2-test", credentialFingerprint: "sha256:redacted" },
  executorSource: "client-asserted"
};
const v2EntityRegistrations = [{
  ...entityRegistry.task,
  mutationContract: { status: "ready", actions: ["update"] },
  semanticDiff: { status: "ready", compile: () => [] },
  projectionFacet: { status: "ready", project: () => undefined, resolveCanonicalRef: () => ({}) }
}] as const;

test("portable-ascii-v2 rejects reserved, non-ASCII, overlong, and Windows-budget paths", () => {
  for (const candidate of ["tasks/CON.md", "tasks/naïve.md", `tasks/${"a".repeat(113)}.md`, `${"a".repeat(181)}`]) {
    assert.throws(() => validatePortableManagedPath(candidate), NamespaceAdmissionError, candidate);
  }
  assert.throws(
    () => validatePortableManagedPath("tasks/ok.md", { windowsVisibleRootUnits: 60 }),
    (error: unknown) => error instanceof NamespaceAdmissionError && error.code === "WINDOWS_ROOT_TOO_LONG"
  );
  assert.equal(validatePortableManagedPath("tasks/task_01ABC/INDEX.md", { windowsVisibleRootUnits: 59 }).policy, "portable-ascii-v2");
  assert.deepEqual(["a", "A", "a-"].sort(compareCanonicalPathBytes), ["A", "a", "a-"]);
});

test("folded component trie rejects aliases and file ancestors while grandfathering exact legacy paths", () => {
  const legacy = `tasks/${"legacy-".repeat(30)}.md`;
  const admission = createNamespaceAdmissionService(["A/x.md", legacy]);

  assert.equal(admission.admitNewPath(legacy), undefined, "an exact legacy update is not a new-path admission");
  assert.throws(
    () => admission.admitNewPath("a/y.md"),
    (error: unknown) => error instanceof NamespaceAdmissionError && error.code === "CASE_COLLISION"
  );
  admission.admitNewPath("docs/file");
  assert.throws(
    () => admission.admitNewPath("docs/file/child.md"),
    (error: unknown) => error instanceof NamespaceAdmissionError && error.code === "FILE_ANCESTOR"
  );
});

test("shadow reconciliation reports exact matches and names commit divergence", () => {
  const canonical = [{ commitSha: "a".repeat(40), previousCommit: "b".repeat(40), opIds: ["op-1"] }];
  const matching = [{
    schema: "shadow-publication/v1" as const,
    workspaceId,
    sequence: 1,
    ...canonical[0]!,
    observedAt: "2026-07-13T00:00:00.000Z"
  }];
  assert.equal(reconcileShadowPublications({ workspaceId, canonical, shadow: matching }).status, "MATCH");

  const divergent = [{ ...matching[0]!, commitSha: "c".repeat(40) }];
  const report = reconcileShadowPublications({ workspaceId, canonical, shadow: divergent });
  assert.equal(report.status, "DIFFERENT");
  assert.deepEqual(report.differences.map((entry) => entry.code), ["CANONICAL_COMMIT_MISMATCH"]);
});

test("authority microbatches concurrent admissions into one linear publication with per-operation attribution", async () => {
  await withHermeticGit(async ({ rootDir, env }) => {
    const changeLog = createInMemoryReplicaChangeLog();
    const shadowLog = createInMemoryShadowPublicationLog();
    const service = makeAuthority(rootDir, env, changeLog, shadowLog, tokenVerifier({ delayedOpId: "op-0", delayMs: 25 }));
    const envelopes = Array.from({ length: 8 }, (_, index) => operationEnvelope(`op-${index}`, `task-tw01-${index}`, `body-${index}\n`));
    const seedHead = git(rootDir, env, "rev-parse", "HEAD");

    const receipts = await Promise.all(envelopes.map((envelope) => service.submit(envelope)));
    const shadow = await shadowLog.list(workspaceId);
    assert.equal(shadow.length, 1);
    assert.deepEqual(shadow[0]?.opIds, envelopes.map((envelope) => envelope.opId));

    assert.equal(receipts.every((receipt) => receipt.tag === "COMMITTED"), true, JSON.stringify(receipts));
    assert.deepEqual(receipts.map((receipt) => receipt.tag === "COMMITTED" ? receipt.revision : -1), [1, 2, 3, 4, 5, 6, 7, 8]);
    assert.equal(new Set(receipts.map((receipt) => receipt.tag === "COMMITTED" ? receipt.commitSha : "")).size, 1);
    assert.equal(receipts.every((receipt) => receipt.tag === "COMMITTED" && receipt.previousCommit === seedHead), true);
    assert.equal(git(rootDir, env, "rev-list", "--count", "HEAD~1..HEAD"), "1");
    assert.equal(git(rootDir, env, "rev-list", "--min-parents=2", "HEAD"), "");
    for (let index = 0; index < envelopes.length; index += 1) {
      assert.equal(readFileSync(path.join(rootDir, `harness/tasks/task-tw01-${index}/notes.md`), "utf8"), `body-${index}\n`);
    }
    const changes = await changeLog.changesAfter(workspaceId, 0);
    assert.deepEqual(changes.map((change) => change.revision), [1, 2, 3, 4, 5, 6, 7, 8]);
    assert.equal(changes.every((change) => change.commitSha === receipts[0]?.commitSha), true);
    assert.equal(changes.every((change) => change.previousCommit === seedHead), true);
    const attributionEvents = readUnionAttributionEvents(rootDir);
    assert.deepEqual(attributionEvents.map((event) => event.opId), envelopes.map((envelope) => envelope.opId));
    assert.deepEqual(
      attributionEvents.map((event) => event.actor.principal.personId),
      envelopes.map((envelope) => `person_${envelope.opId}`),
      "a slow first admission stays first and every operation retains its own principal"
    );
    assert.deepEqual(
      attributionEvents.map((event) => event.actor.executor?.id),
      envelopes.map((envelope) => `agent_${envelope.opId}`)
    );
  });
});

test("persistent forced-command SSH reconnect replays the same opId without another canonical effect", async () => {
  await withHermeticGit(async ({ rootDir, env }) => {
    const changeLog = createInMemoryReplicaChangeLog();
    const service = makeAuthority(rootDir, env, changeLog);
    const capturedArgs: ReadonlyArray<string>[] = [];
    const notifications: string[] = [];
    const childFactory = loopbackChildFactory(service, changeLog, capturedArgs, { dropFirstSubmitResponse: true });
    const client = new PersistentSshAuthorityClient({
      target: { destination: "authority.internal", fixedCommand: "ha-authority-connect" },
      workspaceId,
      channelNonceDigest: () => channelNonceDigest,
      protocol: authorityProtocolTuple,
      childFactory,
      onNotification: (change) => notifications.push(JSON.stringify(change))
    });
    const envelope = operationEnvelope("op-replay", "task-tw01-replay", "once\n");

    await client.connect();
    await assert.rejects(
      client.submit(envelope),
      (error: unknown) => error instanceof AuthorityTransportDisconnectedError && error.opId === envelope.opId
    );
    const firstHead = git(rootDir, env, "rev-parse", "HEAD");
    await client.connect();
    const replay = await client.submit(envelope);
    const queried = await client.getOperation(envelope.opId);

    assert.equal(replay.tag, "COMMITTED");
    assert.equal(queried?.state, "COMMITTED", JSON.stringify(queried));
    assert.equal(git(rootDir, env, "rev-parse", "HEAD"), firstHead);
    assert.equal(git(rootDir, env, "rev-list", "--count", "HEAD~1..HEAD"), "1");
    assert.equal((await changeLog.changesAfter(workspaceId, 0)).length, 1);
    assert.equal(capturedArgs.length, 2);
    assert.deepEqual(capturedArgs[0], buildAuthoritySshArgs({ destination: "authority.internal", fixedCommand: "ha-authority-connect" }));
    assert.deepEqual(capturedArgs[0], [
      "-T",
      "-o", "ForwardAgent=no",
      "-o", "ForwardX11=no",
      "-o", "ClearAllForwardings=yes",
      "-o", "ExitOnForwardFailure=yes",
      "authority.internal",
      "ha-authority-connect"
    ]);
    assert.equal(notifications.some((notification) => notification.includes(opaqueToken)), false);
    await client.close();
  });
});

test("V2 forced-command admission recomputes mutations and anchors one exact ordered batch trailer", async () => {
  await withHermeticGit(async ({ rootDir, env }) => {
    const changeLog = createInMemoryReplicaChangeLog();
    const operationRegistry = createInMemoryAuthorityOperationRegistry();
    const secret = Buffer.from("authority-v2-integration-secret");
    const nonce = Buffer.alloc(32, 12);
    const claims = v2Claims(workspaceId, nonce, v2SchemaTuple);
    const token = issueActorAxesBindingV2(claims, {
      algorithm: "HMAC-SHA-256", issuer: "authority.test", keyId: "key-1", secret
    });
    const tokenDigest = actorAxesBindingTokenDigestV2(token);
    let consumed = 0;
    const service = createAuthoritySubmissionService({
      workspaceId,
      coordinatorFactory: {
        create: ({ attribution }) => makeJournaledWriteCoordinator({
          rootDir,
          attribution,
          commitAuthor: { name: "Authenticated Person", email: "person@example.test" },
          autoMaterialize: false
        })
      },
      tokenVerifier: { verify: async () => { throw new Error("legacy token path disabled"); } },
      operationRegistry,
      replicaChangeLog: changeLog,
      publicationInspector: gitPublicationInspector(rootDir, env),
      fenceWitness: { assertHeld: async () => undefined },
      v2: {
        schemaTuple: v2SchemaTuple,
        channelNonceDigest: nonce,
        bindingRuntime: {
          proofKeys: { resolve: () => ({ algorithm: "HMAC-SHA-256", secret }) },
          validatePresentationToken: async (input) => input.tokenId === claims.tokenId
            && Buffer.from(input.tokenDigest).equals(Buffer.from(tokenDigest)),
          getBinding: async () => ({
            bindingId: claims.bindingId,
            principalPersonId: claims.principalPersonId,
            executorAgentId: claims.executorAgentId,
            workspaceId: claims.workspaceId,
            deviceId: claims.deviceId,
            viewId: claims.viewId,
            sessionId: claims.sessionId,
            active: true,
            attribution: v2Attribution
          }),
          currentAuthorityGeneration: () => claims.authorityGeneration,
          currentRevocationEpochs: async () => claims.revocationEpochs,
          nowMs: () => 2_000n,
          consumeOperation: async (_tokenId, maximum) => ++consumed <= maximum,
          validateAdmissionTokenRef: async (input) => input.tokenId === claims.tokenId
            && Buffer.from(input.tokenDigest).equals(Buffer.from(tokenDigest))
        },
        entityRegistrations: v2EntityRegistrations,
        operationNamespaceVerifier: { verify: async () => undefined },
        semanticCompiler: {
          compile: async (envelope) => {
            assert.equal(envelope.intent.kind, "typed");
            if (envelope.intent.kind !== "typed" || envelope.intent.canonicalPayload.kind !== "inline") {
              throw new Error("typed inline payload required");
            }
            const payload = JSON.parse(Buffer.from(envelope.intent.canonicalPayload.bytes).toString("utf8")) as { taskId: string; body: string };
            if (payload.body === "SEMANTIC_DIFF_REQUIRED") throw new SemanticAdmissionErrorV2("SEMANTIC_DIFF_REQUIRED");
            if (payload.body === "SEMANTIC_DIFF_AMBIGUOUS") throw new SemanticAdmissionErrorV2("SEMANTIC_DIFF_AMBIGUOUS");
            return {
              mutationPlan: {
                registryVersion: 1,
                mutations: [{ entityKind: "task", identity: { taskId: payload.taskId }, action: "update" }]
              },
              operation: {
                opId: "authority-overrides-this",
                entityId: taskEntityId(payload.taskId),
                kind: "doc_write",
                payload: { path: "notes.md", body: payload.body }
              },
              decodedBytes: BigInt(envelope.intent.canonicalPayload.bytes.length)
            };
          }
        }
      }
    });
    const envelopes = [
      v2Envelope(claims, tokenDigest, "task-v2-one", "one\n", 1),
      v2Envelope(claims, tokenDigest, "task-v2-two", "two\n", 2)
    ];

    const receipts = await Promise.all(envelopes.map((envelope, index) => service.submitV2!({
      requestId: `attempt-${index}`,
      presentationToken: token,
      envelope: encodeSemanticMutationEnvelopeV2(envelope)
    })));

    assert.equal(receipts.every((receipt) => receipt.tag === "COMMITTED"), true, JSON.stringify(receipts));
    assert.equal(new Set(receipts.map((receipt) => receipt.tag === "COMMITTED" ? receipt.commitSha : "")).size, 1);
    assert.equal(consumed, 2);
    const commitMessage = git(rootDir, env, "log", "-1", "--format=%B");
    const trailerLines = commitMessage.split("\n").filter((line) => line.startsWith(`${authorityBatchTrailerName}: `));
    assert.equal(trailerLines.length, 1);
    const trailerEntries = readBatchTrailerEntries(trailerLines[0]!.slice(authorityBatchTrailerName.length + 2));
    assert.deepEqual(trailerEntries, receipts.map((receipt) => ({
      opId: receipt.opId,
      semanticMutationSetDigest: receipt.tag === "COMMITTED" ? receipt.authorityIntegrity!.semanticMutationSetDigest : ""
    })));
    const events = readUnionAttributionEvents(rootDir);
    assert.deepEqual(events.map((event) => event.authorityIntegrity?.semanticMutationSetDigest), trailerEntries.map((entry) => entry.semanticMutationSetDigest));
    assert.deepEqual(events.map((event) => event.authorityIntegrity?.canonicalMutationSet), envelopes.map((envelope) => envelope.claimedMutationSet));
    assert.equal((await changeLog.changesAfter(workspaceId, 0)).every((change) => Boolean(change.authorityIntegrity)), true);
    const stored = await operationRegistry.get(workspaceId, receipts[0]!.opId);
    assert.equal(stored?.canonicalRequestEnvelope, Buffer.from(encodeSemanticMutationEnvelopeV2(envelopes[0]!)).toString("base64url"));
    assert.equal("canonicalRequestEnvelope" in (await service.getOperation(workspaceId, receipts[0]!.opId))!, false);

    const headAfterBatch = git(rootDir, env, "rev-parse", "HEAD");
    const mismatchDraft = v2Envelope(claims, tokenDigest, "task-v2-mismatch", "mismatch\n", 3);
    const falseClaim = v2MutationSet("task-v2-not-the-payload-subject");
    const mismatchCore = {
      ...mismatchDraft,
      claimedMutationSet: falseClaim,
      claimedSemanticMutationSetDigest: semanticMutationSetDigestV2(falseClaim),
      claimedSemanticRequestDigest: Buffer.alloc(32)
    };
    const mismatch = {
      ...mismatchCore,
      claimedSemanticRequestDigest: semanticRequestDigestV2(mismatchCore)
    };
    const rejectedAttempts = [
      mismatch,
      v2Envelope(claims, tokenDigest, "task-v2-required", "SEMANTIC_DIFF_REQUIRED", 4),
      v2Envelope(claims, tokenDigest, "task-v2-ambiguous", "SEMANTIC_DIFF_AMBIGUOUS", 5)
    ];
    const rejectedReceipts = await Promise.all(rejectedAttempts.map((envelope, index) => service.submitV2!({
      requestId: `rejected-${index}`,
      presentationToken: token,
      envelope: encodeSemanticMutationEnvelopeV2(envelope)
    })));
    assert.deepEqual(rejectedReceipts.map((receipt) => receipt.tag === "REJECTED" ? receipt.reason : receipt.tag), [
      "SEMANTIC_MUTATION_MISMATCH",
      "SEMANTIC_DIFF_REQUIRED",
      "SEMANTIC_DIFF_AMBIGUOUS"
    ]);
    assert.equal(git(rootDir, env, "rev-parse", "HEAD"), headAfterBatch, "semantic failures reject before PREPARED/publication");
    assert.equal(consumed, 2, "semantic failures do not consume token operation slots");

    const childFactory = loopbackV2ChildFactory(service, changeLog, v2SchemaTuple);
    const client = new PersistentSshAuthorityClient({
      target: { destination: "authority.internal", fixedCommand: "ha-authority-connect" },
      workspaceId,
      channelNonceDigest: () => Buffer.from(nonce).toString("hex"),
      protocol: v2SchemaTuple,
      childFactory
    });
    await client.connect();
    await assert.rejects(client.submit(operationEnvelope("legacy-under-v2", "task-legacy-under-v2", "denied\n")), /Legacy submit is not valid/u);
    await assert.rejects(client.getOperation(receipts[0]!.opId), /current coarse-authority presentation/u);
    const retry = await client.submitV2({
      requestId: "transport-retry",
      presentationToken: token,
      envelope: encodeSemanticMutationEnvelopeV2(envelopes[0]!)
    });
    assert.deepEqual(retry, receipts[0], "V2 daemon route replays without consuming or publishing again");
    assert.equal(consumed, 2);
    await client.close();
  });
});

test("length-prefixed decoder rejects an oversized frame from its header before body allocation", () => {
  const reader = createLengthPrefixedFrameReader(8);
  const header = Buffer.alloc(4);
  header.writeUInt32BE(9, 0);

  const batch = reader.push(header);

  assert.match(batch.error?.message ?? "", /exceeds limit 8/u);
  assert.deepEqual(batch.frames, []);
});

function makeAuthority(
  rootDir: string,
  env: NodeJS.ProcessEnv,
  replicaChangeLog: ReplicaChangeLog,
  shadowPublicationLog?: ShadowPublicationLog,
  verifier: DelegationTokenVerifier = tokenVerifier()
) {
  return createAuthoritySubmissionService({
    workspaceId,
    coordinatorFactory: {
      create: ({ attribution }) => makeJournaledWriteCoordinator({
        rootDir,
        attribution,
        commitAuthor: { name: "Authenticated Person", email: "person@example.test" },
        autoMaterialize: false
      })
    },
    tokenVerifier: verifier,
    operationRegistry: createInMemoryAuthorityOperationRegistry(),
    replicaChangeLog,
    ...(shadowPublicationLog ? { shadowPublicationLog } : {}),
    publicationInspector: gitPublicationInspector(rootDir, env),
    fenceWitness: { assertHeld: async () => undefined },
    now: () => "2026-07-13T00:00:00.000Z"
  });
}

function operationEnvelope(opId: string, taskId: string, body: string): AuthorityOperationEnvelope {
  const envelope: AuthorityOperationEnvelope = {
    workspaceId,
    opId,
    claimedDigest: "pending",
    command: "repo.document.write",
    operation: {
      opId,
      entityId: taskEntityId(taskId),
      kind: "doc_write",
      payload: { path: "notes.md", body }
    },
    delegationToken: opaqueToken,
    channelNonceDigest,
    protocol: authorityProtocolTuple
  };
  return { ...envelope, claimedDigest: canonicalAuthorityRequestDigest(envelope) };
}

function tokenVerifier(options: { readonly delayedOpId?: string; readonly delayMs?: number } = {}): DelegationTokenVerifier {
  return {
    verify: async ({ token, envelope }) => {
      if (token !== opaqueToken) throw new Error("invalid token");
      if (envelope.opId === options.delayedOpId) {
        await new Promise((resolve) => setTimeout(resolve, options.delayMs ?? 0));
      }
      const actorId = `person_${envelope.opId}`;
      const executorId = `agent_${envelope.opId}`;
      const attribution: WriteAttribution = {
        actor: {
          principal: { kind: "person", personId: actorId },
          executor: { kind: "agent", id: executorId }
        },
        principalSource: {
          kind: "daemon-authenticated",
          providerId: "test-token-verifier",
          credentialFingerprint: "sha256:redacted-credential"
        },
        executorSource: "client-asserted"
      };
      return {
        attribution,
        claims: {
          tokenId: "token-redacted-id",
          issuer: "test-issuer",
          keyId: "key-1",
          workspaceId,
          deviceId: "device-1",
          viewId: "view-1",
          actorId,
          executorId,
          sessionId: "session-tw01",
          authorityGeneration: 1,
          channelNonceDigest,
          protocol: authorityProtocolTuple,
          commandScopes: ["repo.document.write"],
          pathScopes: ["harness/tasks/**"],
          maxBytes: 64 * 1024,
          maxOps: 1,
          issuedAt: "2026-07-13T00:00:00.000Z",
          notBefore: "2026-07-13T00:00:00.000Z",
          expiresAt: "2026-07-13T00:05:00.000Z",
          revocationEpoch: 1
        }
      };
    }
  };
}

function gitPublicationInspector(rootDir: string, env: NodeJS.ProcessEnv): CanonicalPublicationInspector {
  return {
    currentHead: async () => gitOptional(rootDir, env, "rev-parse", "--verify", "HEAD"),
    inspectPublishedHead: async () => {
      const row = git(rootDir, env, "rev-list", "--parents", "-n", "1", "HEAD").split(" ");
      return { commitSha: row[0]!, parentCommits: row.slice(1) };
    }
  };
}

function loopbackChildFactory(
  submissionService: ReturnType<typeof makeAuthority>,
  replicaChangeLog: ReplicaChangeLog,
  capturedArgs: ReadonlyArray<string>[],
  options: { readonly dropFirstSubmitResponse?: boolean } = {}
): SshAuthorityChildFactory {
  let connectionCount = 0;
  return {
    spawn: (_command, args) => {
      connectionCount += 1;
      capturedArgs.push([...args]);
      const clientToServer = new PassThrough();
      const serverToClient = new PassThrough();
      const stderr = new PassThrough();
      const events = new EventEmitter();
      const serverOutput = connectionCount === 1 && options.dropFirstSubmitResponse
        ? dropAfterHelloResponse(serverToClient, events)
        : serverToClient;
      const session = serveAuthorityForcedCommand({
        input: clientToServer,
        output: serverOutput,
        workspaceId,
        protocol: authorityProtocolTuple,
        submissionService,
        replicaChangeLog
      });
      return {
        stdin: clientToServer,
        stdout: serverToClient,
        stderr,
        on: (event, listener) => events.on(event, listener),
        kill: () => {
          void session.close();
          queueMicrotask(() => events.emit("exit", 0, null));
          return true;
        }
      } satisfies SshAuthorityChild;
    }
  };
}

function loopbackV2ChildFactory(
  submissionService: ReturnType<typeof createAuthoritySubmissionService>,
  replicaChangeLog: ReplicaChangeLog,
  protocol: ProtocolSchemaTupleV2
): SshAuthorityChildFactory {
  return {
    spawn: () => {
      const clientToServer = new PassThrough();
      const serverToClient = new PassThrough();
      const stderr = new PassThrough();
      const events = new EventEmitter();
      const session = serveAuthorityForcedCommand({
        input: clientToServer,
        output: serverToClient,
        workspaceId,
        protocol,
        submissionService,
        replicaChangeLog
      });
      return {
        stdin: clientToServer,
        stdout: serverToClient,
        stderr,
        on: (event, listener) => events.on(event, listener),
        kill: () => {
          void session.close();
          queueMicrotask(() => events.emit("exit", 0, null));
          return true;
        }
      } satisfies SshAuthorityChild;
    }
  };
}

function dropAfterHelloResponse(output: PassThrough, events: EventEmitter): Writable {
  const reader = createLengthPrefixedFrameReader();
  let responseCount = 0;
  let disconnected = false;
  return new Writable({
    write(chunk: Buffer, _encoding, callback) {
      const batch = reader.push(chunk);
      for (const frame of batch.frames) {
        if (isResponseFrame(frame)) {
          responseCount += 1;
          if (responseCount > 1) {
            if (!disconnected) {
              disconnected = true;
              queueMicrotask(() => {
                output.destroy();
                events.emit("exit", 255, null);
              });
            }
            continue;
          }
        }
        if (!disconnected) output.write(encodeLengthPrefixedFrame(frame));
      }
      callback(batch.error);
    }
  });
}

function isResponseFrame(value: unknown): value is { readonly kind: "response" } {
  return typeof value === "object" && value !== null && "kind" in value && value.kind === "response";
}

function readBatchTrailerEntries(value: string): ReadonlyArray<{ readonly opId: string; readonly semanticMutationSetDigest: string }> {
  const match = /^v1:[0-9a-f]{64}:([A-Za-z0-9_-]+)$/u.exec(value);
  assert.ok(match);
  const bytes = Buffer.from(match[1]!, "base64url");
  let offset = 0;
  const count = bytes.readUInt32BE(offset);
  offset += 4;
  const entries = Array.from({ length: count }, () => {
    const length = bytes.readUInt32BE(offset);
    offset += 4;
    const opId = bytes.subarray(offset, offset + length).toString("utf8");
    offset += length;
    const semanticMutationSetDigest = bytes.subarray(offset, offset + 32).toString("hex");
    offset += 32;
    return { opId, semanticMutationSetDigest };
  });
  assert.equal(offset, bytes.length);
  return entries;
}

async function withHermeticGit(
  body: (input: { readonly rootDir: string; readonly env: NodeJS.ProcessEnv }) => Promise<void>
): Promise<void> {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-tw01-authority-"));
  const home = path.join(rootDir, "empty-home");
  mkdirSync(home, { recursive: true });
  const env = {
    ...process.env,
    HOME: home,
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_SYSTEM: "/dev/null",
    GIT_AUTHOR_NAME: "Harness Test",
    GIT_AUTHOR_EMAIL: "harness@example.test",
    GIT_COMMITTER_NAME: "Harness Test",
    GIT_COMMITTER_EMAIL: "harness@example.test"
  };
  const previous = {
    HOME: process.env.HOME,
    GIT_CONFIG_GLOBAL: process.env.GIT_CONFIG_GLOBAL,
    GIT_CONFIG_SYSTEM: process.env.GIT_CONFIG_SYSTEM,
    GIT_AUTHOR_NAME: process.env.GIT_AUTHOR_NAME,
    GIT_AUTHOR_EMAIL: process.env.GIT_AUTHOR_EMAIL,
    GIT_COMMITTER_NAME: process.env.GIT_COMMITTER_NAME,
    GIT_COMMITTER_EMAIL: process.env.GIT_COMMITTER_EMAIL
  };
  Object.assign(process.env, env);
  try {
    execFileSync("git", ["-C", rootDir, "init", "-q"], { env });
    writeFileSync(path.join(rootDir, ".gitignore"), "/harness/\n/.harness/\n", "utf8");
    const harnessRoot = path.join(rootDir, "harness");
    mkdirSync(harnessRoot, { recursive: true });
    execFileSync("git", ["-C", harnessRoot, "init", "-q"], { env });
    git(rootDir, env, "commit", "--allow-empty", "-m", "test: initialize canonical authority repo");
    await body({ rootDir, env });
  } finally {
    restoreEnvironment(previous);
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

function restoreEnvironment(previous: Record<string, string | undefined>): void {
  for (const [key, value] of Object.entries(previous)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}
