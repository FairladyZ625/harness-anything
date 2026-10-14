// harness-test-tier: integration
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import * as tar from "tar";
import {
  activateEmptyCanonicalGeneration,
  makeTaskProjection,
  makeTaskProjectionReader,
  openSqliteEventStore,
  openReplicaStore,
} from "@harness-anything/kernel";
import { eventAt, initRepo } from "../../kernel/test/store/task-event-store.fixtures.ts";
import { backup, DatabaseSync } from "node:sqlite";
import { ReadableStream, type ReadableStreamDefaultController } from "node:stream/web";
import { runWalSender } from "../src/fleet/walsender.ts";
import { runWalReceiver, openWalReceiverGeneration } from "../src/fleet/walreceiver.ts";
import { startBaseBackup } from "../src/fleet/basebackup.ts";
import { installReplicaGeneration, readReplicaGeneration } from "../src/fleet/replica-generation.ts";
import { createReplicationRetention, openReplicationSlots } from "../src/fleet/replication-slot.ts";
import {
  parseReplicationFrame,
  ReplicationDecoder,
  REPLICATION_FRAME_BYTES,
  type ReplicationFrame,
  type ReplicationPeer,
} from "../src/fleet/protocol.ts";

test("real backup worker installs a generation readable by the common projection reader", async (t) => {
  const root = mkdtempSync(path.join(tmpdir(), "ha-basebackup-core-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  initRepo(root);
  activateEmptyCanonicalGeneration({ repoId: "backup-core", rootInput: root });
  const ledger = openSqliteEventStore({ repoId: "backup-core", rootInput: root });
  const projection = makeTaskProjection({
    rootDir: root,
    eventStore: {
      readHead: () => null,
      readBatch: () => ({ sourceRevision: 0, events: [], cursor: null, done: true, accessedItems: 0 }),
      readContentBlob: () => null,
    },
  });
  try {
    projection.catchUp();
    ledger.claimWriter({ repoId: "backup-core", holder: "primary", epoch: 1 });
    const initial = ledger.replicationPosition();
    const transfer = await startBaseBackup({
      ledgerPath: ledger.databasePath,
      projectionPath: projection.path,
      directory: path.join(root, "transfer"),
    });
    ledger.appendCommand({
      fence: { repoId: "backup-core", holder: "primary", epoch: 1 },
      events: [],
      rejectionCode: "test",
      intent: { opId: "later", intentDigest: `sha256:${"a".repeat(64)}`, summary: "after pinned" },
    });
    const archive = await transfer.complete;
    assert.deepEqual(archive.metadata.position, initial);
    const replicaRoot = path.join(root, "replica");
    const installed = await installReplicaGeneration({
      root: replicaRoot,
      archive: archive.file,
      metadata: archive.metadata,
      sha256: archive.sha256,
      size: archive.size,
      quotaBytes: 16 * 1024 * 1024,
    });
    assert.deepEqual(readReplicaGeneration(replicaRoot), installed);
    await assert.rejects(
      installReplicaGeneration({
        root: replicaRoot,
        archive: archive.file,
        metadata: archive.metadata,
        sha256: archive.sha256,
        size: archive.size,
        quotaBytes: 1,
      }),
      /disk quota/u,
    );
    assert.deepEqual(readReplicaGeneration(replicaRoot), installed);
    assert.deepEqual(readdirSync(path.join(replicaRoot, "generations")), [installed.id]);
    writeFileSync(path.join(root, "unexpected"), "not a backup member");
    symlinkSync("unexpected", path.join(root, "backup.json"));
    for (const [member, message] of [
      ["unexpected", /unexpected base backup archive member/u],
      ["backup.json", /invalid base backup archive member/u],
    ] as const) {
      const file = path.join(root, "invalid.tar.gz");
      await tar.create({ file, cwd: root, gzip: true }, [member]);
      const bytes = readFileSync(file);
      await assert.rejects(
        installReplicaGeneration({
          root: replicaRoot,
          archive: file,
          metadata: archive.metadata,
          sha256: createHash("sha256").update(bytes).digest("hex"),
          size: bytes.length,
          quotaBytes: 16 * 1024 * 1024,
        }),
        message,
      );
      assert.deepEqual(readReplicaGeneration(replicaRoot), installed);
      assert.deepEqual(readdirSync(path.join(replicaRoot, "generations")), [installed.id]);
    }
    const receiving = openWalReceiverGeneration(installed);
    try {
      ledger.appendCommand({
        fence: { repoId: "backup-core", holder: "primary", epoch: 1 },
        events: [eventAt(1)],
        intent: { opId: "task-created", intentDigest: `sha256:${"b".repeat(64)}`, summary: "task after backup" },
      });
      for (const commit of ledger.replicationCommits(initial, 10).commits) receiving.apply(commit, []);
      await receiving.project();
      assert.deepEqual(receiving.position(), ledger.replicationPosition());
    } finally {
      await receiving.close();
    }
    const reader = makeTaskProjectionReader({ rootDir: installed.rootDir });
    try {
      assert.equal(
        reader.withSession((queries) => queries.readCut().watermark),
        1,
      );
    } finally {
      reader.close();
    }
    await assert.rejects(
      installReplicaGeneration({
        root: replicaRoot,
        archive: archive.file,
        metadata: archive.metadata,
        sha256: "0".repeat(64),
        size: archive.size,
        quotaBytes: 16 * 1024 * 1024,
      }),
      /corrupt/u,
    );
    assert.deepEqual(readReplicaGeneration(replicaRoot), installed);
  } finally {
    projection.close();
    ledger.close();
  }
});

test("slots persist ACKs and fence an older connection", (t) => {
  const root = mkdtempSync(path.join(tmpdir(), "ha-slot-core-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, "slots.sqlite"),
    key = { repoId: "repo", nodeId: "node" };
  let slots = openReplicationSlots(file);
  try {
    const old = slots.claim(key, "history"),
      sent = { history: "history", sequence: 5, revision: 3 };
    slots.acknowledge(old, { durable: sent, applied: sent }, sent);
    const next = slots.claim(key, "history");
    assert.equal(slots.current(old), false);
    assert.throws(() => slots.acknowledge(old, { durable: sent, applied: sent }, sent), /fenced/u);
    assert.throws(
      () => slots.acknowledge(next, { durable: { ...sent, sequence: 6 }, applied: sent }, sent),
      /exceeds/u,
    );
    slots.close();
    slots = openReplicationSlots(file);
    assert.deepEqual(slots.cursor(key), { durable: sent, applied: sent });
    slots.claim(key, "new-history");
    assert.equal(slots.cursor(key), null);
  } finally {
    slots.close();
  }
});

test("retention keeps the slowest slot's suffix within the cap and each active backup pins its start", async () => {
  const pruned: number[] = [];
  let slowest: number | null = 90;
  const retention = createReplicationRetention({
    windowCommits: 63,
    slotFloor: () => slowest,
    prune: (before) => {
      pruned.push(before);
    },
  });
  const head = { history: "history", sequence: 100, revision: 80 };
  await retention.advance(head); // the slowest slot (90) is inside the cap: keep its suffix
  slowest = 10;
  await retention.advance(head); // a slot beyond the cap does not hold the log: prune to the cap
  slowest = null;
  await retention.advance(head); // no slot: only the head anchor stays
  const position = { history: "history", sequence: 1, revision: 1 };
  const releaseFirst = retention.pin(position),
    releaseSecond = retention.pin(position),
    releaseOtherHistory = retention.pin({ history: "other", sequence: 0, revision: 0 });
  await retention.advance(head);
  releaseFirst();
  await retention.advance(head);
  releaseSecond();
  await retention.advance(head);
  releaseOtherHistory();
  assert.deepEqual(pruned, [90, 37, 100, 1, 1, 100]);
});

test("the slot floor is the slowest durable ACK on the current history", (t) => {
  const root = mkdtempSync(path.join(tmpdir(), "ha-slot-floor-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const slots = openReplicationSlots(path.join(root, "slots.sqlite"));
  try {
    assert.equal(slots.minimumAck("repo", "h1"), null);
    const at = (history: string, sequence: number) => ({ history, sequence, revision: sequence });
    const fast = slots.claim({ repoId: "repo", nodeId: "fast" }, "h1"),
      slow = slots.claim({ repoId: "repo", nodeId: "slow" }, "h1"),
      other = slots.claim({ repoId: "repo", nodeId: "other" }, "h0");
    slots.acknowledge(fast, { durable: at("h1", 9), applied: at("h1", 9) }, at("h1", 9));
    slots.acknowledge(slow, { durable: at("h1", 4), applied: at("h1", 4) }, at("h1", 4));
    slots.acknowledge(other, { durable: at("h0", 1), applied: at("h0", 1) }, at("h0", 1));
    assert.equal(slots.minimumAck("repo", "h1"), 4);
    assert.equal(slots.minimumAck("another-repo", "h1"), null);
  } finally {
    slots.close();
  }
});

test("decoder accepts many complete frames per chunk and rejects oversized remainder and inherited names", () => {
  const decoder = new ReplicationDecoder();
  const line = JSON.stringify({ type: "replica.backup.end" }) + "\n";
  assert.equal(decoder.push(Buffer.from(line.repeat(5000))).length, 5000);
  decoder.finish();
  assert.throws(() => new ReplicationDecoder().push(Buffer.alloc(REPLICATION_FRAME_BYTES + 1, 32)), /capacity/u);
  assert.throws(() => parseReplicationFrame('{"type":"constructor"}'), /invalid/u);
  const partial = new ReplicationDecoder();
  partial.push(Buffer.from('{"type":'));
  assert.throws(() => partial.finish(), /mid-frame/u);
});

test("sender streams eventless commits to the real replica and records an applied ACK", async (t) => {
  const root = mkdtempSync(path.join(tmpdir(), "ha-stream-core-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const center = openSqliteEventStore({ repoId: "stream", databasePath: path.join(root, "center.sqlite") });
  const sourceDb = new DatabaseSync(center.databasePath, { readOnly: true });
  const replicaPath = path.join(root, "replica.sqlite");
  try {
    await backup(sourceDb, replicaPath);
  } finally {
    sourceDb.close();
  }
  const replica = openReplicaStore({ repoId: "stream", databasePath: replicaPath });
  const slots = openReplicationSlots(path.join(root, "slots.sqlite"));
  const abort = new AbortController();
  const stop = new Error("test stream complete");
  const channel = () => {
    let controller!: ReadableStreamDefaultController<ReplicationFrame>;
    const stream = new ReadableStream<ReplicationFrame>({
      start(value) {
        controller = value;
      },
    });
    const reader = stream.getReader();
    abort.signal.addEventListener("abort", () => controller.error(abort.signal.reason), { once: true });
    return {
      send: async (frame: ReplicationFrame) => {
        controller.enqueue(frame);
      },
      receive: async () => {
        const result = await reader.read();
        if (result.done) throw new Error("closed channel");
        return result.value;
      },
    };
  };
  const incoming = channel(),
    outgoing = channel();
  const primaryPeer: ReplicationPeer = { send: outgoing.send, receive: incoming.receive };
  const replicaPeer: ReplicationPeer = { send: incoming.send, receive: outgoing.receive };
  try {
    const fence = { repoId: "stream", holder: "primary", epoch: 1 };
    center.claimWriter(fence);
    center.appendCommand({
      fence,
      events: [],
      rejectionCode: "test",
      intent: {
        opId: "eventless",
        intentDigest: `sha256:${"a".repeat(64)}`,
        summary: "eventless command",
      },
    });
    const key = { repoId: "stream", nodeId: "replica" };
    let projected = 0;
    const sender = runWalSender({
      peer: primaryPeer,
      slots,
      lease: slots.claim(key, center.replicationPosition().history),
      signal: abort.signal,
      source: {
        read: (after) => center.replicationCommits(after, 1),
        wait: async () => {
          abort.abort(stop);
          throw stop;
        },
        acknowledged: async () => undefined,
        backup: async () => {
          throw new Error("unexpected backup");
        },
        object: () => {
          throw new Error("unexpected object");
        },
      },
    });
    const receiver = runWalReceiver({
      peer: replicaPeer,
      directory: root,
      quotaBytes: 1024 * 1024,
      maxBufferedBytes: 1024 * 1024,
      signal: abort.signal,
      target: {
        position: replica.position,
        apply: replica.apply,
        install: async () => {
          throw new Error("unexpected install");
        },
        project: async (position) => {
          projected = position.sequence;
        },
      },
    });
    const results = await Promise.allSettled([sender, receiver]);
    assert.ok(results.every((result) => result.status === "rejected" && result.reason === stop));
    assert.equal(projected, center.replicationPosition().sequence);
    assert.deepEqual(replica.position(), center.replicationPosition());
    assert.deepEqual(slots.cursor(key), { durable: replica.position(), applied: replica.position() });
    const read = openSqliteEventStore({ databasePath: replicaPath, readOnly: true });
    try {
      assert.deepEqual(read.outcome("eventless"), center.outcome("eventless"));
    } finally {
      read.close();
    }
  } finally {
    abort.abort(stop);
    slots.close();
    replica.close();
    center.close();
  }
});
