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

test("publisher adapter ensures and exact-reads the production V2 log with byte-identical replay", async () => {
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
        opId: "op-v2",
        commitSha: "commit-8",
        previousCommit: "commit-7"
      },
      {
        workspaceId: "workspace-v2",
        opId: "op-v2",
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
          commitSha: input.commitSha,
          previousCommit: input.previousCommit,
          physicalChanges: [
            { path: "task.md", beforeDigest: null, afterDigest: "55".repeat(32) }
          ],
          // Legacy/parallel observers may still carry their own wall clock.
          // It is observation metadata, not a publish-once byte input.
          recordedAt: recordedAtByDerivation[derivation++]!
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

test("publisher adapter fails closed when the durable event or exact bytes cannot be read", async (t) => {
  for (const missing of ["event", "bytes"] as const) {
    await t.test(missing, async () => {
      await withTempEventLog(async (productionLog) => {
        const eventLog: AuthorityAttributionEventV2Log = {
          ...productionLog,
          ...(missing === "event"
            ? { read: () => undefined }
            : { readBytes: () => undefined })
        };
        const publisher = createDurableAuthorityCommittedEventPublisherV2({
          eventLog,
          observation: physicalObservation()
        });

        await assert.rejects(
          publisher.publish(publicationInput()),
          /AUTHORITY_EVENT_V2_DURABLE_READ_MISSING/u
        );
      });
    });
  }
});

function publicationInput() {
  return {
    receipt: committedReceipt(),
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
      readonly opId: string;
      readonly commitSha: string;
      readonly previousCommit: string | null;
    }) => ({
      commitSha: boundary?.commitSha ?? input.commitSha,
      previousCommit: boundary?.previousCommit ?? input.previousCommit,
      physicalChanges: changes()
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

function committedReceipt(): AuthorityCommittedReceipt {
  return {
    tag: "COMMITTED",
    workspaceId: "workspace-v2",
    opId: "op-v2",
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
