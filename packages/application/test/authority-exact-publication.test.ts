// harness-test-tier: fast
import assert from "node:assert/strict";
import test from "node:test";
import { Effect } from "effect";
import {
  authorityProtocolTuple,
  canonicalAuthorityRequestDigest,
  createAuthoritySubmissionService,
  createInMemoryAuthorityOperationRegistry,
  createInMemoryReplicaChangeLog,
  type AuthorityOperationEnvelope,
  type DelegationTokenVerifier
} from "../src/index.ts";
import {
  withExactCommit,
  type ExactWriteScope,
  type FlushReport,
  type WriteAttribution
} from "../../kernel/src/index.ts";
import { classifyAuthorityPublicationOutcome } from "../src/authority/publication-outcome.ts";

const workspaceId = "workspace-exact-publication";

test("concurrent cross-session admissions publish in separate exact routes", async () => {
  const fixture = authorityFixture(({ acknowledgements, reason }) => ({
    reason,
    opCount: acknowledgements.length,
    committed: true
  }), (opId) => opId.endsWith("alpha") ? "session-alpha" : "session-beta");

  const receipts = await Promise.all([
    fixture.service.submit(envelope("op-alpha")),
    fixture.service.submit(envelope("op-beta"))
  ]);

  assert.equal(receipts.every((receipt) => receipt.tag === "COMMITTED"), true, JSON.stringify(receipts));
  assert.deepEqual(fixture.commits.map(({ sessionId, opIds }) => ({ sessionId, opIds })), [
    { sessionId: "session-alpha", opIds: ["op-alpha"] },
    { sessionId: "session-beta", opIds: ["op-beta"] }
  ]);
  assert.notEqual(fixture.commits[0]!.exactWriteScope, fixture.commits[1]!.exactWriteScope);
  assert.deepEqual(fixture.broadFlushVisibleAtCommit, [false, false]);
});

test("committed partial exact report makes every candidate indeterminate", async () => {
  const fixture = authorityFixture(({ reason }) => ({
    reason,
    opCount: 1,
    committed: true
  }), () => "session-partial");

  const receipts = await Promise.all([
    fixture.service.submit(envelope("op-partial-one")),
    fixture.service.submit(envelope("op-partial-two"))
  ]);

  assert.deepEqual(receipts.map((receipt) => receipt.tag), ["INDETERMINATE", "INDETERMINATE"]);
  for (const receipt of receipts) {
    assert.match(receipt.reason, /PUBLICATION_PARTIAL_COMMIT_OUTCOME_UNKNOWN:expected=2;actual=1/u);
  }
  assert.equal(fixture.commits.length, 1, "same-session coordinators share one exact scope and batch");
  assert.equal(fixture.inspections(), 0, "partial publication cannot proceed to canonical proof");
});

test("deterministic exact batch rejection remains rejected instead of indeterminate", () => {
  assert.deepEqual(classifyAuthorityPublicationOutcome({
    kind: "error",
    error: {
      _tag: "WriteRejected",
      code: "authority_exact_batch_owner_mismatch",
      reason: "scope mismatch",
      retryable: false
    }
  }), { kind: "rejected", reason: "scope mismatch" });
});

test("publication outcome preserves structured journal failure causes", () => {
  const outcome = classifyAuthorityPublicationOutcome({
    kind: "error",
    error: {
      _tag: "JournalUnavailable",
      cause: { name: "Error", message: "durable write may have committed", code: "EIO" }
    }
  });

  assert.deepEqual(outcome, {
    kind: "indeterminate",
    reason: "PUBLICATION_OUTCOME_UNKNOWN:durable write may have committed"
  });
});

test("publication outcome does not trust object-valued WriteRejected.reason", () => {
  const outcome = classifyAuthorityPublicationOutcome({
    kind: "error",
    error: { _tag: "WriteRejected", reason: { message: "structured rejection" }, retryable: false }
  });

  assert.deepEqual(outcome, {
    kind: "indeterminate",
    reason: "PUBLICATION_OUTCOME_UNKNOWN:structured rejection"
  });
});

test("publication outcome formatting is total for circular and null-prototype values", () => {
  const circular: Record<string, unknown> = { code: "CIRCULAR_FAILURE" };
  circular.self = circular;
  const nullPrototype = Object.create(null) as Record<string, unknown>;
  nullPrototype.message = "null-prototype failure";

  for (const error of [circular, nullPrototype]) {
    const outcome = classifyAuthorityPublicationOutcome({ kind: "error", error });
    assert.equal(outcome.kind, "indeterminate");
    assert.doesNotMatch(outcome.reason, /\[object Object\]/u);
  }
  assert.match(classifyAuthorityPublicationOutcome({ kind: "error", error: circular }).reason, /CIRCULAR_FAILURE/u);
  assert.match(classifyAuthorityPublicationOutcome({ kind: "error", error: nullPrototype }).reason, /null-prototype failure/u);
});

function authorityFixture(
  report: (input: {
    readonly reason: FlushReport["reason"];
    readonly acknowledgements: ReadonlyArray<{ readonly opId: string }>;
  }) => FlushReport,
  sessionForOperation: (opId: string) => string
) {
  const commits: Array<{
    readonly sessionId: string;
    readonly opIds: ReadonlyArray<string>;
    readonly exactWriteScope: ExactWriteScope;
  }> = [];
  const broadFlushVisibleAtCommit: boolean[] = [];
  let lastHead: string | null = null;
  let inspections = 0;
  const verifier: DelegationTokenVerifier = {
    verify: async ({ envelope: unsigned }) => ({
      attribution: attribution(unsigned.opId),
      claims: {
        tokenId: `token-${unsigned.opId}`,
        issuer: "fixture",
        keyId: "key-fixture",
        workspaceId,
        deviceId: "device-fixture",
        viewId: "view-fixture",
        actorId: `person-${unsigned.opId}`,
        executorId: `agent-${unsigned.opId}`,
        sessionId: sessionForOperation(unsigned.opId),
        authorityGeneration: 1,
        channelNonceDigest: "channel-fixture",
        protocol: authorityProtocolTuple,
        commandScopes: ["repo.document.write"],
        pathScopes: ["harness/tasks/**"],
        maxBytes: 4096,
        maxOps: 1,
        issuedAt: "2026-08-05T00:00:00.000Z",
        notBefore: "2026-08-05T00:00:00.000Z",
        expiresAt: "2026-08-05T01:00:00.000Z",
        revocationEpoch: 1
      }
    })
  };
  const service = createAuthoritySubmissionService({
    workspaceId,
    coordinatorFactory: {
      create: ({ sessionId, exactWriteScope }) => {
        const exact = withExactCommit({
        enqueue: (operation) => Effect.succeed({
          opId: operation.opId,
          entityId: operation.entityId,
          accepted: true as const
        }),
        recover: Effect.succeed({ replayedOps: 0 })
      }, (reason, acknowledgements) => Effect.sync(() => {
        commits.push({
          sessionId,
          opIds: acknowledgements.map((acknowledgement) => acknowledgement.opId),
          exactWriteScope
        });
        lastHead = `${commits.length}`.padStart(40, "a");
        return report({ reason, acknowledgements });
        }), exactWriteScope);
        return {
          ...exact,
          flush: () => Effect.die("authority service facade must hide broad flush"),
          commitExact(
            this: object,
            ...args: Parameters<typeof exact.commitExact>
          ): ReturnType<typeof exact.commitExact> {
            broadFlushVisibleAtCommit.push("flush" in this);
            return exact.commitExact(...args);
          }
        };
      }
    },
    tokenVerifier: verifier,
    operationRegistry: createInMemoryAuthorityOperationRegistry(),
    replicaChangeLog: createInMemoryReplicaChangeLog(),
    publicationInspector: {
      currentHead: async () => lastHead,
      inspectPublishedHead: async () => {
        inspections += 1;
        return { commitSha: lastHead!, parentCommits: [] };
      }
    },
    fenceWitness: { assertHeld: async () => undefined },
    now: () => "2026-08-05T00:00:00.000Z"
  });
  return { service, commits, broadFlushVisibleAtCommit, inspections: () => inspections };
}

function envelope(opId: string): AuthorityOperationEnvelope {
  const draft: AuthorityOperationEnvelope = {
    workspaceId,
    opId,
    claimedDigest: "pending",
    command: "repo.document.write",
    operation: {
      opId,
      entityId: `task/task-${opId}`,
      kind: "doc_write",
      payload: { path: "notes.md", body: `${opId}\n` }
    },
    delegationToken: "opaque-fixture-token",
    channelNonceDigest: "channel-fixture",
    protocol: authorityProtocolTuple
  };
  return { ...draft, claimedDigest: canonicalAuthorityRequestDigest(draft) };
}

function attribution(opId: string): WriteAttribution {
  return {
    actor: {
      principal: { kind: "person", personId: `person-${opId}` },
      executor: { kind: "agent", id: `agent-${opId}` }
    },
    principalSource: {
      kind: "daemon-authenticated",
      providerId: "fixture",
      credentialFingerprint: "sha256:fixture"
    },
    executorSource: "client-asserted"
  };
}
