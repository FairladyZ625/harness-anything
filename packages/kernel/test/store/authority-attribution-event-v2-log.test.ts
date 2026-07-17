// harness-test-tier: integration
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
  actorAxesBindingCoreDigestV2,
  canonicalAttributionEventDigestV2,
  encodeCanonicalCbor,
  makeLocalAuthorityAttributionEventV2Log,
  physicalChangeSetDigestV2,
  readUnionAttributionEvents,
  resolveHarnessLayout,
  semanticMutationSetDigestV2,
  semanticMutationWireV2,
  type ActorAxesBindingCoreV2,
  type AttributionEventV2,
  type PhysicalChangeV2,
  type SemanticMutationSetV2,
  type SemanticMutationV2
} from "../../src/index.ts";
import {
  AuthorityAttributionEventV2ProtocolDamageError,
  encodeAuthorityAttributionEventV2Bytes
} from "../../src/integrity/authority-attribution-event-v2-log.ts";
import { readAttributionEvents } from "../../src/local/attribution-event-source.ts";
import { authorityAttributionEventV2FilePath } from "../../src/store/authority-attribution-event-v2-log.ts";
import { recoverAuthorityAttributionEventV2FromOperationRecord } from "../../src/store/authority-attribution-event-v2-recovery.ts";
import { withTempStore, withTempStoreAsync } from "./helpers.ts";

const digestA = "11".repeat(32);
const digestB = "22".repeat(32);

test("durable V2 append reads back exact canonical bytes and only accepts byte-identical replay", () => {
  withTempStore((rootDir) => {
    const layout = resolveHarnessLayout(rootDir);
    mkdirSync(layout.attributionEventsRoot, { recursive: true });
    const legacyPath = path.join(layout.attributionEventsRoot, "legacy-shadow.jsonl");
    const legacyBytes = Buffer.from(`${JSON.stringify(v1Event("op-v2-log"))}\n`, "utf8");
    writeFileSync(legacyPath, legacyBytes);

    const event = v2Event({ opId: "op-v2-log" });
    const log = makeLocalAuthorityAttributionEventV2Log(rootDir);
    const first = log.ensure(event);
    assert.equal(first.replayed, false);
    assert.deepEqual(first.bytes, encodeAuthorityAttributionEventV2Bytes(event));
    assert.deepEqual(log.read(event.workspaceId, event.opId), event);
    assert.deepEqual(log.readBytes(event.workspaceId, event.opId), first.bytes);

    const replay = makeLocalAuthorityAttributionEventV2Log(rootDir).ensure(event);
    assert.equal(replay.replayed, true);
    assert.deepEqual(replay.bytes, first.bytes);
    assert.deepEqual(readFileSync(legacyPath), legacyBytes, "V1 immutable shard bytes must remain untouched");
    assert.deepEqual(log.scanIntegrity(), {
      schema: "authority-attribution-event-v2-integrity-report/v1",
      eventCount: 1,
      logDigest: log.scanIntegrity().logDigest
    });
  });
});

test("immutable V2 shard converges after SIGKILL at every publication boundary", { skip: process.platform === "win32" }, () => {
  for (const killpoint of [
    "post-create",
    "partial-write",
    "post-file-fsync",
    "pre-directory-fsync",
    "post-directory-fsync"
  ]) {
    const rootDir = mkdtempSync(path.join(tmpdir(), `ha-v2-killpoint-${killpoint}-`));
    try {
      const event = v2Event({ opId: `op-${killpoint}` });
      const eventPath = authorityAttributionEventV2FilePath(rootDir, event.workspaceId, event.opId);
      const bytes = encodeAuthorityAttributionEventV2Bytes(event);
      const child = spawnSync(process.execPath, [
        "--experimental-strip-types", "--eval",
        "import { appendImmutableBytesDurably } from './packages/kernel/src/store/write-journal-durable.ts'; appendImmutableBytesDurably(process.env.EVENT_PATH, Buffer.from(process.env.EVENT_BYTES, 'base64'));"
      ], {
        cwd: process.cwd(),
        env: {
          ...process.env,
          EVENT_PATH: eventPath,
          EVENT_BYTES: Buffer.from(bytes).toString("base64"),
          HARNESS_TEST_IMMUTABLE_WRITE_KILLPOINT: killpoint
        },
        encoding: "utf8"
      });
      assert.equal(child.signal, "SIGKILL", `${killpoint}: ${child.stderr}`);
      const recovered = makeLocalAuthorityAttributionEventV2Log(rootDir).ensure(event);
      assert.deepEqual(recovered.bytes, bytes, killpoint);
      assert.deepEqual(makeLocalAuthorityAttributionEventV2Log(rootDir).read(event.workspaceId, event.opId), event);
    } finally {
      rmSync(rootDir, { recursive: true, force: true });
    }
  }
});

test("same durable key with different valid canonical bytes is protocol damage", () => {
  withTempStore((rootDir) => {
    const original = v2Event({ opId: "op-collision" });
    const different = v2Event({
      opId: "op-collision",
      recordedAt: "2026-07-16T12:00:00.999Z"
    });
    const log = makeLocalAuthorityAttributionEventV2Log(rootDir);
    const first = log.ensure(original);

    assert.throws(
      () => log.ensure(different),
      (error: unknown) => error instanceof AuthorityAttributionEventV2ProtocolDamageError
        && error.code === "AUTHORITY_ATTRIBUTION_EVENT_V2_PROTOCOL_DAMAGE"
    );
    assert.deepEqual(log.readBytes(original.workspaceId, original.opId), first.bytes);
    assert.deepEqual(log.read(original.workspaceId, original.opId), original);
  });
});

test("union reader returns one V2 event for a same-op V1 compatibility shadow", () => {
  withTempStore((rootDir) => {
    const event = v2Event({ opId: "op-precedence" });
    const layout = resolveHarnessLayout(rootDir);
    mkdirSync(layout.attributionEventsRoot, { recursive: true });
    writeFileSync(
      path.join(layout.attributionEventsRoot, "legacy-shadow.jsonl"),
      `${JSON.stringify(v1Event(event.opId))}\n`,
      "utf8"
    );
    makeLocalAuthorityAttributionEventV2Log(rootDir).ensure(event);

    assert.deepEqual(readAttributionEvents(rootDir).map(({ opId }) => opId), [event.opId]);
    const union = readUnionAttributionEvents(rootDir);
    assert.equal(union.length, 1);
    assert.equal(union[0]?.schema, "attribution-event/v2");
    assert.equal(union[0]?.opId, event.opId);
  });
});

test("recovery re-ensures exact V2 from a durable operation-record boundary after restart", async () => {
  await withTempStoreAsync(async (rootDir) => {
    const event = v2Event({ opId: "op-recovery" });
    const durableRecord = {
      workspaceId: event.workspaceId,
      opId: event.opId,
      state: "INDETERMINATE",
      commitSha: event.commitSha
    };
    const operationRecords = {
      get: async (workspaceId: string, opId: string) =>
        workspaceId === durableRecord.workspaceId && opId === durableRecord.opId
          ? structuredClone(durableRecord)
          : undefined
    };
    const recover = () => recoverAuthorityAttributionEventV2FromOperationRecord({
      workspaceId: event.workspaceId,
      opId: event.opId,
      operationRecords,
      materializeExactEvent: async (record) => {
        assert.deepEqual(record, durableRecord);
        return structuredClone(event);
      },
      log: makeLocalAuthorityAttributionEventV2Log(rootDir)
    });

    const first = await recover();
    assert.equal(first.replayed, false);
    const restarted = await recover();
    assert.equal(restarted.replayed, true);
    assert.deepEqual(restarted.bytes, first.bytes);
    assert.equal(makeLocalAuthorityAttributionEventV2Log(rootDir).readAll().length, 1);
  });
});

test("recovery refuses an event outside the durable operation commit boundary", async () => {
  await withTempStoreAsync(async (rootDir) => {
    const event = v2Event({ opId: "op-recovery-mismatch" });
    const operationRecords = {
      get: async () => ({
        workspaceId: event.workspaceId,
        opId: event.opId,
        state: "INDETERMINATE",
        commitSha: "different-commit"
      })
    };
    const log = makeLocalAuthorityAttributionEventV2Log(rootDir);
    await assert.rejects(
      recoverAuthorityAttributionEventV2FromOperationRecord({
        workspaceId: event.workspaceId,
        opId: event.opId,
        operationRecords,
        materializeExactEvent: async () => event,
        log
      }),
      /AUTHORITY_OPERATION_EVENT_COMMIT_MISMATCH/u
    );
    assert.equal(log.read(event.workspaceId, event.opId), undefined);
  });
});

test("integrity read rejects non-canonical durable bytes at the registered path", () => {
  withTempStore((rootDir) => {
    const event = v2Event({ opId: "op-integrity" });
    const log = makeLocalAuthorityAttributionEventV2Log(rootDir);
    log.ensure(event);
    writeFileSync(
      authorityAttributionEventV2FilePath(rootDir, event.workspaceId, event.opId),
      `${JSON.stringify(event, null, 2)}\n`,
      "utf8"
    );
    assert.throws(
      () => log.scanIntegrity(),
      (error: unknown) => error instanceof AuthorityAttributionEventV2ProtocolDamageError
    );
  });
});

function v1Event(opId: string): Record<string, unknown> {
  return {
    schema: "attribution-event/v1",
    eventId: `attribution:${opId}`,
    opId,
    journalRecordSchema: "write-journal/v2",
    entityId: "task/task_T",
    kind: "doc_write",
    actor: {
      principal: { kind: "person", personId: "person_zeyu" },
      executor: null
    },
    principalSource: { kind: "migration", evidenceRef: "legacy-fixture" },
    executorSource: "none",
    at: "2026-07-16T11:59:59.000Z",
    recordedAt: "2026-07-16T11:59:59.100Z",
    payloadHash: digestA,
    payloadRef: { path: `payloads/${opId}.json`, sha256: digestA }
  };
}

function v2Event(overrides: {
  readonly opId: string;
  readonly recordedAt?: string;
}): AttributionEventV2 {
  const mutationSet: SemanticMutationSetV2 = {
    registryVersion: 1,
    mutations: [mutation("fact", "fact/task_T/F-1", "create")].sort((left, right) => Buffer.compare(
      Buffer.from(encodeCanonicalCbor(semanticMutationWireV2(left))),
      Buffer.from(encodeCanonicalCbor(semanticMutationWireV2(right)))
    ))
  };
  const actorAxesBinding: ActorAxesBindingCoreV2 = {
    bindingId: "binding-1",
    principalPersonId: "person_zeyu",
    executorAgentId: "agent-codex",
    workspaceId: "workspace-1",
    deviceId: "device-1",
    viewId: "view-1",
    sessionId: "session-1",
    schemaTuple: {
      wire: 2,
      event: 2,
      receipt: 2,
      digest: 2,
      policy: 1,
      commandRegistry: 1,
      entityRegistry: 1,
      mutationRegistry: 1,
      localState: 1,
      applyJournal: 1
    }
  };
  const physicalChanges: ReadonlyArray<PhysicalChangeV2> = [{
    path: "tasks/task_T/facts.md",
    beforeDigest: digestA,
    afterDigest: digestB
  }];
  const withoutEventDigest: Omit<AttributionEventV2, "canonicalEventDigest"> = {
    schema: "attribution-event/v2",
    eventId: `attribution:${overrides.opId}`,
    workspaceId: "workspace-1",
    opId: overrides.opId,
    revision: 1,
    commitSha: "commit-v2",
    previousCommit: "commit-v1",
    outcome: "COMMITTED",
    occurredAt: "2026-07-16T12:00:00.000Z",
    recordedAt: overrides.recordedAt ?? "2026-07-16T12:00:00.100Z",
    actorAxesBinding,
    semanticRequestDigest: "33".repeat(32),
    mutationSet,
    semanticMutationSetDigest: hex(semanticMutationSetDigestV2(mutationSet)),
    actorAxesBindingDigest: hex(actorAxesBindingCoreDigestV2(actorAxesBinding)),
    physicalChanges,
    changeSetDigest: hex(physicalChangeSetDigestV2(physicalChanges))
  };
  return {
    ...withoutEventDigest,
    canonicalEventDigest: hex(canonicalAttributionEventDigestV2(withoutEventDigest))
  };
}

function mutation(entityKind: string, canonicalRef: string, action: string): SemanticMutationV2 {
  return {
    entity: { registryVersion: 1, entityKind, canonicalRef },
    action: { registryVersion: 1, action }
  };
}

function hex(value: Uint8Array): string {
  return Buffer.from(value).toString("hex");
}
