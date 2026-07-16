// harness-test-tier: contract
import assert from "node:assert/strict";
import test from "node:test";
import {
  canonicalAuthorityAttributionEventStorageBytesV2,
  createDurableAuthorityCommittedEventPublisherV2,
  type AuthorityAttributionEventLogPrimitiveV2,
  type AuthorityAttributionEventLogRecordV2,
  type AuthorityCommittedReceipt
} from "../src/index.ts";
import {
  actorAxesBindingCoreDigestV2,
  semanticMutationSetDigestV2,
  type ActorAxesBindingCoreV2,
  type SemanticMutationSetV2
} from "../../kernel/src/index.ts";

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

test("publisher adapter appends then exact-reads X event-log port before returning", async () => {
  const eventLog = memoryExactEventLog();
  const publisher = createDurableAuthorityCommittedEventPublisherV2({
    eventLog,
    observation: {
      observe: async () => ({
        physicalChanges: [{ path: "task.md", beforeDigest: null, afterDigest: "55".repeat(32) }],
        recordedAt: "2026-07-16T00:00:01.000Z"
      })
    }
  });
  const input = {
    receipt: committedReceipt(),
    actorAxesBinding,
    occurredAt: "2026-07-16T00:00:00.000Z"
  };
  const first = await publisher.publish(input);
  const replay = await publisher.publish(input);
  assert.equal(replay.canonicalEventDigest, first.canonicalEventDigest);
  assert.equal(eventLog.records.size, 1, "byte-identical replay keeps one durable key");
  assert.equal(Buffer.from(eventLog.records.get("workspace-v2\0op-v2")!.canonicalBytes).equals(
    Buffer.from(canonicalAuthorityAttributionEventStorageBytesV2(first))
  ), true);
});

test("publisher adapter rejects a non-exact durable read", async () => {
  const eventLog = memoryExactEventLog();
  const publisher = createDurableAuthorityCommittedEventPublisherV2({
    eventLog: {
      appendExact: eventLog.appendExact,
      readExact: async (workspaceId, opId) => {
        const stored = await eventLog.readExact(workspaceId, opId);
        return stored && { ...stored, canonicalBytes: Buffer.from([0]) };
      }
    },
    observation: {
      observe: async () => ({ physicalChanges: [], recordedAt: "2026-07-16T00:00:01.000Z" })
    }
  });
  await assert.rejects(publisher.publish({
    receipt: committedReceipt(),
    actorAxesBinding,
    occurredAt: "2026-07-16T00:00:00.000Z"
  }), /DURABLE_REPLAY_MISMATCH/u);
});

test("publisher port classifies a differing replay for the same workspace/op key as protocol damage", async () => {
  const eventLog = memoryExactEventLog();
  let afterDigest = "55".repeat(32);
  const publisher = createDurableAuthorityCommittedEventPublisherV2({
    eventLog,
    observation: {
      observe: async () => ({
        physicalChanges: [{ path: "task.md", beforeDigest: null, afterDigest }],
        recordedAt: "2026-07-16T00:00:01.000Z"
      })
    }
  });
  const input = {
    receipt: committedReceipt(),
    actorAxesBinding,
    occurredAt: "2026-07-16T00:00:00.000Z"
  };
  await publisher.publish(input);
  afterDigest = "66".repeat(32);
  await assert.rejects(publisher.publish(input), /PROTOCOL_DAMAGED/u);
});

function memoryExactEventLog(): AuthorityAttributionEventLogPrimitiveV2 & {
  readonly records: Map<string, AuthorityAttributionEventLogRecordV2>;
} {
  const records = new Map<string, AuthorityAttributionEventLogRecordV2>();
  const key = (workspaceId: string, opId: string) => `${workspaceId}\0${opId}`;
  return {
    records,
    appendExact: async (record) => {
      const current = records.get(key(record.workspaceId, record.opId));
      if (current && !Buffer.from(current.canonicalBytes).equals(Buffer.from(record.canonicalBytes))) {
        throw new Error("AUTHORITY_EVENT_V2_PROTOCOL_DAMAGED");
      }
      if (!current) records.set(key(record.workspaceId, record.opId), structuredClone(record));
    },
    readExact: async (workspaceId, opId) => records.get(key(workspaceId, opId))
  };
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
