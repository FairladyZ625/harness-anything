// harness-test-tier: integration
// harness-test-file-timeout: 180000
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { DatabaseSync, backup } from "node:sqlite";
import { TASK_EVENT_SHAPE_COMPAT_VERSION } from "@harness-anything/kernel";
import {
  openSqliteEventStore,
  openReplicaStore,
  openReplicationSlots,
  openReplicaProjection,
} from "@harness-anything/storage";
import { eventAt, initRepo } from "../../storage/test/store/task-event-store.fixtures.ts";
import { runWalSender } from "../src/fleet/walsender.ts";
import { runWalReceiver } from "../src/fleet/walreceiver.ts";
import type { ReplicationFrame, ReplicationPeer } from "../src/fleet/protocol.ts";

async function streamEnvelope(
  megabytes: number,
  t: import("node:test").TestContext,
  manyEvents = false,
  legacySender = false,
  singleEvent = false,
): Promise<void> {
  const root = mkdtempSync(path.join(tmpdir(), "ha-rss-commit-"));
  initRepo(root);
  const center = openSqliteEventStore({ repoId: "rss-stream", databasePath: path.join(root, "center.sqlite") });
  const source = new DatabaseSync(center.databasePath, { readOnly: true });
  try {
    await backup(source, path.join(root, "replica.sqlite"));
  } finally {
    source.close();
  }
  const replica = openReplicaStore({ repoId: "rss-stream", databasePath: path.join(root, "replica.sqlite") });
  const model = openReplicaProjection({
    repoId: "rss-stream",
    rootDir: root,
    ledgerPath: path.join(root, "replica.sqlite"),
    projectionPath: path.join(root, "projection.sqlite"),
    generation: 3,
  });
  const slots = openReplicationSlots(path.join(root, "slots.sqlite"));
  const abort = new AbortController(),
    stop = new Error("measurement stream complete");
  function channel(): ReplicationPeer {
    const queue: ReplicationFrame[] = [];
    let waiter: { resolve: (frame: ReplicationFrame) => void; reject: (e: unknown) => void } | undefined;
    abort.signal.addEventListener("abort", () => waiter?.reject(abort.signal.reason));
    return {
      send: async (frame) => {
        if (waiter) {
          const pending = waiter;
          waiter = undefined;
          pending.resolve(frame);
        } else queue.push(frame);
      },
      receive: async () => {
        abort.signal.throwIfAborted();
        if (queue.length) return queue.shift()!;
        return new Promise((resolve, reject) => {
          waiter = { resolve, reject };
        });
      },
    };
  }
  const up = channel(),
    down = channel(),
    primary = { send: down.send, receive: up.receive },
    edge = { send: up.send, receive: down.receive };
  let receivedSize = 0,
    projected = 0,
    maximumChunk = 0,
    stagedIterator = false;
  const before = process.memoryUsage();
  let peak = before;
  const sample = () => {
    const current = process.memoryUsage();
    if (current.rss > peak.rss) peak = current;
  };
  try {
    const fence = { repoId: "rss-stream", holder: "primary", epoch: 1 };
    center.claimWriter(fence);
    const events = manyEvents
      ? Array.from({ length: singleEvent ? 1 : 80 }, (_, i) => {
          const event = eventAt(i + 1);
          return {
            ...event,
            payload: {
              task: {
                ...event.payload.task,
                title: singleEvent ? "x".repeat(20 * 1024 * 1024) + '台灣😀\\"' : '台灣😀\\"'.repeat(16384),
              },
            },
          };
        })
      : [];
    center.appendCommand({
      fence,
      events,
      ...(!manyEvents ? { rejectionCode: "test" } : {}),
      intent: {
        opId: "large",
        intentDigest: `sha256:${"a".repeat(64)}`,
        summary: manyEvents ? "many events" : "x".repeat(megabytes * 1024 * 1024),
      },
    });
    await primary.send({
      type: "replica.accept",
      centerBuildCommit: null,
      taskEventShapeVersion: TASK_EVENT_SHAPE_COMPAT_VERSION,
    });
    const receiver = runWalReceiver({
      peer: {
        ...edge,
        receive: async (signal) => {
          const frame = await edge.receive(signal);
          if (frame.type === "replica.commit") receivedSize = frame.size;
          if (frame.type === "replica.data") {
            maximumChunk = Math.max(maximumChunk, Buffer.byteLength(frame.data, "base64"));
            sample();
          }
          return frame;
        },
      },
      repoId: "rss-stream",
      directory: root,
      quotaBytes: 100 * 1024 * 1024,
      maxBufferedBytes: 16 * 1024 * 1024,
      signal: abort.signal,
      target: {
        position: replica.position,
        apply: (commit) => {
          stagedIterator = !Array.isArray(commit.events);
          replica.apply(
            {
              ...commit,
              events: {
                *[Symbol.iterator]() {
                  yield* commit.events;
                  assert.ok(
                    !readdirSync(root).some((name) => name.endsWith(".commit")),
                    "consuming the last event removed staging before SQLite COMMIT",
                  );
                },
              },
            },
            [],
          );
        },
        project: async () => {
          try {
            await model.projection.catchUpAsync!();
          } catch (error) {
            t.diagnostic(`projection failed: ${error instanceof Error ? error.stack : String(error)}`);
            throw error;
          }
          projected = replica.position().revision;
        },
        install: async () => assert.fail("unexpected backup"),
        installObject: async () => assert.fail("unexpected object"),
      },
    });
    const settledReceiver = receiver.catch((error) => {
      abort.abort(error);
      throw error;
    });
    const sendCurrent = () =>
      runWalSender({
        peer: primary,
        slots,
        lease: slots.claim({ repoId: "rss-stream", nodeId: "edge" }, center.replicationPosition().history),
        signal: abort.signal,
        source: {
          read: (after) => center.replicationCommits(after, 1),
          acknowledged: async () => {},
          wait: async () => {
            abort.abort(stop);
            throw stop;
          },
          backup: async () => assert.fail("unexpected backup"),
          object: () => assert.fail("unexpected object"),
        },
      });
    const sendLegacy = async () => {
      const start = await primary.receive(abort.signal);
      assert.equal(start.type, "replica.start");
      if (start.type !== "replica.start" || !start.position) assert.fail("legacy sender requires an anchor");
      let position = start.position;
      for (;;) {
        const page = center.replicationCommits(position, 100);
        for (const commit of page.commits) {
          // Frozen N-1 implementation: one JSON.stringify and one Buffer for the full envelope.
          const bytes = Buffer.from(JSON.stringify(commit));
          await primary.send({ type: "replica.commit", size: bytes.length });
          for (let offset = 0; offset < bytes.length; offset += 64 * 1024)
            await primary.send({
              type: "replica.data",
              offset,
              data: bytes.subarray(offset, offset + 64 * 1024).toString("base64"),
            });
          await primary.send({ type: "replica.commit.end" });
          position = commit.position;
        }
        await primary.send({ type: "replica.progress", head: position });
        const ack = await primary.receive(abort.signal);
        assert.equal(ack.type, "replica.ack");
        if (page.done) break;
      }
      abort.abort(stop);
      throw stop;
    };
    const sender = (legacySender ? sendLegacy() : sendCurrent()).catch((error) => {
      // A real transport closes its receive side when the sender exits too.
      abort.abort(error);
      throw error;
    });
    const results = await Promise.allSettled([sender, settledReceiver]);
    t.diagnostic(
      JSON.stringify({
        phase: `commit-${megabytes}MiB`,
        receivedSize,
        maximumChunk,
        stagedIterator,
        before,
        peak,
        after: process.memoryUsage(),
        center: center.replicationPosition(),
        replica: replica.position(),
        results: results.map((r) => (r.status === "rejected" ? String(r.reason) : r.status)),
      }),
    );
    assert.deepEqual(replica.position(), center.replicationPosition());
    assert.equal(projected, center.replicationPosition().revision);
    assert.equal(stagedIterator, true);
    assert.ok(maximumChunk <= 64 * 1024);
    if (megabytes > 16 || manyEvents) assert.ok(receivedSize > 16 * 1024 * 1024);
    assert.ok(!readdirSync(root).some((name) => name.endsWith(".commit") || name.endsWith(".object")));
    const read = openSqliteEventStore({ databasePath: path.join(root, "replica.sqlite"), readOnly: true });
    try {
      assert.deepEqual(read.outcome("large"), center.outcome("large"));
      assert.equal(read.revision(), events.length);
    } finally {
      read.close();
    }
  } finally {
    abort.abort(stop);
    slots.close();
    model.close();
    replica.close();
    center.close();
    rmSync(root, { recursive: true, force: true });
  }
}

test("1 MiB envelope reaches durable replica and common projection", async (t) => streamEnvelope(1, t));
test("20 MiB eventless outcome crosses the former 16 MiB limit", async (t) => streamEnvelope(20, t));
test("multi-event >16 MiB transaction streams to SQLite and projection", async (t) => streamEnvelope(20, t, true));

test("N-1 center full-envelope sender interoperates with the upgraded >16 MiB receiver", async (t) =>
  streamEnvelope(20, t, false, true));
test("one >16 MiB canonical event streams without an envelope-sized buffer", async (t) =>
  streamEnvelope(20, t, true, false, true));
