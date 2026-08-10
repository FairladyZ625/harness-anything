// harness-test-tier: contract
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
  createDurableAuthorityCommittedEventPublisherV2,
  type AuthorityCommittedReceipt
} from "../src/index.ts";
import {
  actorAxesBindingCoreDigestV2,
  makeLocalAuthorityAttributionEventV2Log,
  semanticMutationSetDigestV2,
  type ActorAxesBindingCoreV2,
  type PhysicalChangeV2,
  type SemanticMutationSetV2
} from "../../kernel/src/index.ts";

type AuthorityAttributionEventV2Log = ReturnType<typeof makeLocalAuthorityAttributionEventV2Log>;

const actorAxesBinding: ActorAxesBindingCoreV2 = {
  bindingId: "binding-v2",
  principalPersonId: "person-v2",
  executorAgentId: "agent-v2",
  workspaceId: "workspace-v2",
  deviceId: "device-v2",
  viewId: "view-v2",
  sessionId: "session-v2",
  schemaTuple: {
    wire: 2, event: 2, receipt: 2, digest: 2, policy: 1,
    commandRegistry: 1, entityRegistry: 1, mutationRegistry: 1, localState: 1, applyJournal: 1
  }
};
const mutationSet: SemanticMutationSetV2 = { registryVersion: 1, mutations: [] };

test("publisher adapter uses ensure as the single authoritative readback with byte-identical replay", async () => {
  await withTempEventLog(async (eventLog) => {
    const observedInputs: Array<Parameters<ReturnType<typeof physicalObservation>["observe"]>[0]> = [];
    const observation = physicalObservation();
    const publisher = createDurableAuthorityCommittedEventPublisherV2({
      eventLog,
      observation: {
        observe: async (input) => {
          observedInputs.push(input);
          return observation.observe(input);
        }
      }
    });
    const input = publicationInput();

    const first = await publisher.publish(input);
    const firstBytes = eventLog.readBytes(first.workspaceId, first.opId);
    const replay = await publisher.publish(input);
    const replayBytes = eventLog.readBytes(replay.workspaceId, replay.opId);

    assert.deepEqual(replay, first);
    assert.deepEqual(replayBytes, firstBytes);
    assert.equal(eventLog.readAll().length, 1, "byte-identical replay keeps one durable key");
    assert.equal(eventLog.ensure(replay).replayed, true);
    assert.deepEqual(observedInputs, [
      {
        workspaceId: "workspace-v2",
        opIds: ["op-v2"],
        commitSha: "commit-8",
        previousCommit: "commit-7"
      },
      {
        workspaceId: "workspace-v2",
        opIds: ["op-v2"],
        commitSha: "commit-8",
        previousCommit: "commit-7"
      }
    ]);
  });
});

test("same operation derives byte-identical publication bytes after observation time advances", async () => {
  await withTempEventLog(async (eventLog) => {
    const recordedAtByDerivation = [
      "2026-07-16T00:00:01.000Z",
      "2026-07-16T00:00:02.000Z"
    ];
    let derivation = 0;
    const publisher = createDurableAuthorityCommittedEventPublisherV2({
      eventLog,
      observation: {
        observe: async (input) => ({
          opIds: input.opIds,
          commitSha: input.commitSha,
          previousCommit: input.previousCommit,
          physicalChanges: [
            { path: "task.md", beforeDigest: null, afterDigest: "55".repeat(32) }
          ],
          // Legacy/parallel observers may still carry their own wall clock.
          // It is observation metadata, not a publish-once byte input.
          recordedAt: recordedAtByDerivation[derivation++]!,
          pipelineGeneratedPaths: [],
          contentAddressedPaths: []
        })
      }
    });
    const input = publicationInput();

    const first = await publisher.publish(input);
    const firstBytes = eventLog.readBytes(first.workspaceId, first.opId);
    const rederived = await publisher.publish(input);
    const rederivedBytes = eventLog.readBytes(rederived.workspaceId, rederived.opId);

    assert.deepEqual(rederivedBytes, firstBytes);
    assert.equal(rederived.recordedAt, input.occurredAt);
  });
});

test("publisher adapter preserves protocol damage when the same durable key receives different bytes", async () => {
  await withTempEventLog(async (eventLog) => {
    let afterDigest = "55".repeat(32);
    const publisher = createDurableAuthorityCommittedEventPublisherV2({
      eventLog,
      observation: physicalObservation(() => [
        { path: "task.md", beforeDigest: null, afterDigest }
      ])
    });
    const input = publicationInput();

    await publisher.publish(input);
    afterDigest = "66".repeat(32);

    await assert.rejects(
      publisher.publish(input),
      (error: unknown) => error instanceof Error
        && error.name === "AuthorityAttributionEventV2ProtocolDamageError"
        && "code" in error
        && error.code === "AUTHORITY_ATTRIBUTION_EVENT_V2_PROTOCOL_DAMAGE"
    );
    assert.equal(eventLog.readAll().length, 1);
  });
});

test("publisher adapter rejects observation commit and previous-commit mismatches before durable write", async (t) => {
  for (const mismatch of [
    { name: "commit", commitSha: "different-commit", previousCommit: "commit-7" },
    { name: "previous commit", commitSha: "commit-8", previousCommit: "different-previous-commit" }
  ] as const) {
    await t.test(mismatch.name, async () => {
      await withTempEventLog(async (eventLog) => {
        const publisher = createDurableAuthorityCommittedEventPublisherV2({
          eventLog,
          observation: physicalObservation(undefined, mismatch)
        });

        await assert.rejects(
          publisher.publish(publicationInput()),
          /AUTHORITY_EVENT_V2_PUBLICATION_OBSERVATION_MISMATCH/u
        );
        assert.equal(eventLog.readAll().length, 0);
      });
    });
  }
});

test("publisher does not repeat read or readBytes after ensure already verified stored bytes", async () => {
  await withTempEventLog(async (productionLog) => {
    const eventLog: AuthorityAttributionEventV2Log = {
      ...productionLog,
      read: () => { throw new Error("redundant read"); },
      readBytes: () => { throw new Error("redundant readBytes"); }
    };
    const publisher = createDurableAuthorityCommittedEventPublisherV2({
      eventLog,
      observation: physicalObservation()
    });

    const event = await publisher.publish(publicationInput());
    assert.equal(event.opId, "op-v2");
  });
});

test("publisher batches one physical observation and one evidence commit for a canonical group", async () => {
  await withTempEventLog(async (eventLog) => {
    let observationCount = 0;
    let evidenceCommitCount = 0;
    const observation = physicalObservation();
    const publisher = createDurableAuthorityCommittedEventPublisherV2({
      eventLog,
      observation: {
        observe: async (input) => {
          observationCount += 1;
          return observation.observe(input);
        }
      },
      commitEvidence: async () => { evidenceCommitCount += 1; }
    });
    const events = await publisher.publishBatch!({
      events: [publicationInput("op-v2"), publicationInput("op-v2-peer")]
    });

    assert.equal(events.length, 2);
    assert.equal(observationCount, 1);
    assert.equal(evidenceCommitCount, 1);
    assert.equal(eventLog.readAll().length, 2);
  });
});

test("partial batch append is replayable and does not commit incomplete evidence", async () => {
  await withTempEventLog(async (productionLog) => {
    let ensureCount = 0;
    let evidenceCommitCount = 0;
    const failingLog: AuthorityAttributionEventV2Log = {
      ...productionLog,
      ensure: (event) => {
        ensureCount += 1;
        if (ensureCount === 2) throw new Error("simulated crash between immutable appends");
        return productionLog.ensure(event);
      }
    };
    const failedPublisher = createDurableAuthorityCommittedEventPublisherV2({
      eventLog: failingLog,
      observation: physicalObservation(),
      commitEvidence: async () => { evidenceCommitCount += 1; }
    });
    const events = [publicationInput("op-v2"), publicationInput("op-v2-peer")];
    await assert.rejects(failedPublisher.publishBatch!({ events }), /simulated crash/u);
    assert.equal(productionLog.readAll().length, 1);
    assert.equal(evidenceCommitCount, 0);

    const replayPublisher = createDurableAuthorityCommittedEventPublisherV2({
      eventLog: productionLog,
      observation: physicalObservation(),
      commitEvidence: async () => { evidenceCommitCount += 1; }
    });
    assert.equal((await replayPublisher.publishBatch!({ events })).length, 2);
    assert.equal(productionLog.readAll().length, 2);
    assert.equal(evidenceCommitCount, 1);
  });
});

function publicationInput(opId = "op-v2") {
  return {
    receipt: committedReceipt(opId),
    actorAxesBinding,
    occurredAt: "2026-07-16T00:00:00.000Z"
  };
}

function physicalObservation(
  changes: () => ReadonlyArray<PhysicalChangeV2> = () => [
    { path: "task.md", beforeDigest: null, afterDigest: "55".repeat(32) }
  ],
  boundary?: { readonly commitSha: string; readonly previousCommit: string | null }
) {
  return {
    observe: async (input: {
      readonly workspaceId: string;
      readonly opIds: ReadonlyArray<string>;
      readonly commitSha: string;
      readonly previousCommit: string | null;
    }) => ({
      opIds: input.opIds,
      commitSha: boundary?.commitSha ?? input.commitSha,
      previousCommit: boundary?.previousCommit ?? input.previousCommit,
      physicalChanges: changes(),
      pipelineGeneratedPaths: [],
      contentAddressedPaths: []
    })
  };
}

async function withTempEventLog(
  run: (eventLog: AuthorityAttributionEventV2Log) => Promise<void>
): Promise<void> {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-authority-event-v2-publisher-"));
  try {
    await run(makeLocalAuthorityAttributionEventV2Log(rootDir));
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
}

function committedReceipt(opId = "op-v2"): AuthorityCommittedReceipt {
  return {
    tag: "COMMITTED",
    workspaceId: "workspace-v2",
    opId,
    semanticDigest: "11".repeat(32),
    revision: 8,
    commitSha: "commit-8",
    previousCommit: "commit-7",
    authorityIntegrity: {
      schema: "authority-operation-integrity/v2",
      semanticRequestDigest: "11".repeat(32),
      semanticMutationSetDigest: hex(semanticMutationSetDigestV2(mutationSet)),
      mutationRegistryVersion: 1,
      actorAxesBindingDigest: hex(actorAxesBindingCoreDigestV2(actorAxesBinding)),
      canonicalMutationSet: mutationSet
    }
  };
}

function hex(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("hex");
}
