// harness-test-tier: integration
// dec_9284BD6119D453EEECEED62450 real-machine hardening of the resident edge stream (runFleetReplicaSync):
// edge-runtime confirmations never run inside the receiver's ACK path; an edge upgraded in place over
// the retired cut/pull layout starts a fresh replica instead of failing on the old pointer; content
// objects larger than the in-memory envelope bound stream to staging files and are digest-checked.
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { connect, createServer, type Socket } from "node:net";
import { statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { DatabaseSync } from "node:sqlite";
import {
  runFleetReplicaSync,
  waitForFleetReplicaSequence,
  type ReplicaSyncOptions,
} from "../src/fleet/replica-sync.ts";
import { readReplicaGeneration } from "../src/fleet/replica-generation.ts";
import { runWalReceiver } from "../src/fleet/walreceiver.ts";
import { REPLICATION_CHUNK_BYTES, type ReplicationFrame } from "../src/fleet/protocol.ts";
import {
  fleetReplicationFixture,
  replicationRepoId,
  seedCenterData,
  waitForState,
  type FleetReplicationFixture,
} from "./fleet-replication.fixture.ts";

const seededTask = { taskId: "task_harden00000000000000000000001", executionId: "exe_harden", title: "Harden" };
let pressureCounter = 0;
const pressure = async (fixture: FleetReplicationFixture, count = 1) => {
  for (let index = 0; index < count; index += 1) {
    const appended = await fixture.centerRun({
      kind: "task-create",
      taskId: `task_hd${String(++pressureCounter).padStart(6, "0")}00000000000000000000`,
      title: "hardening pressure",
    });
    assert.equal(appended.outcome, "applied", JSON.stringify(appended));
  }
};
const centerSequence = (fixture: FleetReplicationFixture): number => {
  const db = new DatabaseSync(fixture.ledgerPath, { readOnly: true });
  try {
    db.exec("PRAGMA busy_timeout=5000");
    return (db.prepare("SELECT sequence FROM replication_state").get() as { sequence: number }).sequence;
  } finally {
    db.close();
  }
};
const viewKey = (viewRoot: string) => ({ viewRoot, repoId: replicationRepoId, nodeId: "edge-one" });

export function startHardeningStream(
  t: TestContext,
  fixture: FleetReplicationFixture,
  viewRoot: string,
  extra: Partial<ReplicaSyncOptions> = {},
) {
  const controller = new AbortController(),
    failures: unknown[] = [];
  const running = runFleetReplicaSync({
    hostname: "127.0.0.1",
    port: fixture.centerPort(),
    ca: fixture.cert,
    servername: "localhost",
    nodeId: "edge-one",
    credential: "secret-edge-one",
    readAccessToken: async () => "device-token-edge-one",
    repoId: replicationRepoId,
    viewRoot,
    diskQuotaBytes: 64 * 1024 * 1024,
    signal: controller.signal,
    onFailure: (error) => failures.push(error),
    ...extra,
  });
  const stop = async () => {
    controller.abort();
    await running;
  };
  t.after(stop);
  return { stop, failures };
}

test(
  "a confirmation that waits for a later replicated commit does not stall the stream that applies it",
  { timeout: 120_000 },
  async (t) => {
    const fixture = await fleetReplicationFixture(t);
    await seedCenterData(fixture, seededTask);
    await fixture.openCenter();
    const viewRoot = mkdtempSync(path.join(tmpdir(), "ha-harden-view-"));
    let calls = 0,
      waitedForLaterCommit = false;
    // The squad reconcile shape: a confirmation writes at the center, then waits for the edge to apply
    // that write (write-then-read). Awaiting it inside the ACK path deadlocks the receiver.
    const stream = startHardeningStream(t, fixture, viewRoot, {
      onConfirmed: async () => {
        if (calls++ > 0) return;
        await pressure(fixture);
        await waitForFleetReplicaSequence(viewKey(viewRoot), centerSequence(fixture), AbortSignal.timeout(20_000));
        waitedForLaterCommit = true;
      },
    });
    await waitForState(() => waitedForLaterCommit, "the confirmation's write-then-read to complete", 60_000);
    assert.deepEqual(stream.failures, [], "the stream never failed while the confirmation waited");
  },
);

test("a failing confirmation is reported and never fails the replication stream", { timeout: 120_000 }, async (t) => {
  const fixture = await fleetReplicationFixture(t);
  await seedCenterData(fixture, seededTask);
  await fixture.openCenter();
  const viewRoot = mkdtempSync(path.join(tmpdir(), "ha-harden-view-")),
    viewDir = path.join(viewRoot, "repos", replicationRepoId, "views", "edge-one"),
    confirmFailures: unknown[] = [];
  const stream = startHardeningStream(t, fixture, viewRoot, {
    onConfirmed: () => {
      throw new Error("center rejected the reconcile");
    },
    onConfirmedFailure: (error) => confirmFailures.push(error),
  });
  await waitForState(
    () => readReplicaGeneration(viewDir)?.metadata.position.sequence === centerSequence(fixture),
    "initial convergence",
    60_000,
  );
  await pressure(fixture, 3);
  await waitForState(
    () => readReplicaGeneration(viewDir)?.metadata.position.sequence === centerSequence(fixture),
    "convergence across failing confirmations",
    60_000,
  );
  assert.ok(confirmFailures.length >= 1, "the confirmation failure was reported");
  assert.deepEqual(stream.failures, [], "confirmation failures are not stream failures");
});

test(
  "an edge upgraded over the retired cut/pull layout discards it and installs a generation",
  { timeout: 120_000 },
  async (t) => {
    const fixture = await fleetReplicationFixture(t);
    await seedCenterData(fixture, seededTask);
    await fixture.openCenter();
    const viewRoot = mkdtempSync(path.join(tmpdir(), "ha-harden-view-")),
      repoDir = path.join(viewRoot, "repos", replicationRepoId),
      viewDir = path.join(repoDir, "views", "edge-one");
    // The retired replica used viewId = nodeId, so its pointer sits exactly where a generation pointer goes.
    mkdirSync(path.join(viewDir, "cuts", "7-g1"), { recursive: true });
    writeFileSync(path.join(viewDir, "cuts", "7-g1", "manifest.json"), "{}");
    mkdirSync(path.join(viewDir, ".staging", "transfer"), { recursive: true });
    writeFileSync(path.join(viewDir, "read-model.sqlite"), "");
    mkdirSync(path.join(repoDir, "cas", "sha256", "ab"), { recursive: true });
    writeFileSync(path.join(repoDir, "manifests.sqlite"), "");
    writeFileSync(
      path.join(viewDir, "current.json"),
      JSON.stringify({
        cut: { revision: 7, headDigest: `sha256:${"0".repeat(64)}` },
        schemaGeneration: 1,
        manifestDigest: `sha256:${"1".repeat(64)}`,
        readerProfile: { personId: "edge-operator", nodeId: "edge-one" },
        authorizationShapeDigest: `sha256:${"2".repeat(64)}`,
      }),
    );
    assert.equal(readReplicaGeneration(viewDir), null, "the retired pointer names no generation");
    const stream = startHardeningStream(t, fixture, viewRoot);
    await waitForState(
      () => readReplicaGeneration(viewDir)?.metadata.position.sequence === centerSequence(fixture),
      "a fresh generation over the retired layout",
      60_000,
    );
    for (const retired of [
      path.join(viewDir, "cuts"),
      path.join(viewDir, ".staging"),
      path.join(viewDir, "read-model.sqlite"),
      path.join(repoDir, "cas"),
      path.join(repoDir, "manifests.sqlite"),
    ])
      assert.equal(existsSync(retired), false, `${retired} was discarded`);
    assert.deepEqual(stream.failures, []);
  },
);

/** Feeds one commit carrying one content object to the receiver, then stops it. */
async function receiveOneObjectCommit(object: Buffer, announcedSha256: string) {
  const directory = mkdtempSync(path.join(tmpdir(), "ha-harden-objects-")),
    stop = new Error("stop"),
    commit = Buffer.from(
      JSON.stringify({ position: { history: "h", sequence: 1, revision: 0 }, events: [], outcome: null, writer: null }),
    ),
    data = (bytes: Buffer): ReplicationFrame[] => {
      const frames: ReplicationFrame[] = [];
      for (let offset = 0; offset < bytes.length; offset += REPLICATION_CHUNK_BYTES)
        frames.push({
          type: "replica.data",
          offset,
          data: bytes.subarray(offset, offset + REPLICATION_CHUNK_BYTES).toString("base64"),
        });
      return frames;
    },
    frames: ReplicationFrame[] = [
      { type: "replica.commit", size: commit.length },
      ...data(commit),
      { type: "replica.object", sha256: announcedSha256, size: object.length },
      ...data(object),
      { type: "replica.object.end" },
      { type: "replica.commit.end" },
    ],
    installed: { sha256: string; bytes: Buffer }[] = [],
    applied: number[] = [];
  const result = await runWalReceiver({
    peer: {
      send: async () => undefined,
      receive: async () => {
        const next = frames.shift();
        if (!next) throw stop;
        return next;
      },
    },
    repoId: replicationRepoId,
    directory,
    quotaBytes: 64 * 1024 * 1024,
    // Far below the object: the object never sits in memory, only the commit envelope does.
    maxBufferedBytes: 64 * 1024,
    signal: new AbortController().signal,
    target: {
      position: () => null,
      install: async () => {
        throw new Error("unexpected install");
      },
      installObject: async (sha256, file) => {
        installed.push({ sha256, bytes: readFileSync(file) });
      },
      apply: (applying) => {
        applied.push(applying.position.sequence);
      },
      project: async () => undefined,
    },
  }).then(
    () => null,
    (error: unknown) => error,
  );
  return { result, stop, installed, applied };
}

test("a content object larger than the in-memory bound streams to staging and installs before apply", async () => {
  const object = Buffer.alloc(512 * 1024, 0x61),
    sha256 = createHash("sha256").update(object).digest("hex");
  const received = await receiveOneObjectCommit(object, sha256);
  assert.equal(received.result, received.stop, String(received.result));
  assert.equal(received.installed.length, 1);
  assert.equal(received.installed[0]!.sha256, sha256);
  assert.ok(received.installed[0]!.bytes.equals(object), "the staged object holds the exact bytes");
  assert.deepEqual(received.applied, [1], "the commit applies after its object is installed");
});

test("a streamed content object whose bytes differ from its digest is rejected before apply", async () => {
  const object = Buffer.alloc(256 * 1024, 0x62);
  const received = await receiveOneObjectCommit(object, "0".repeat(64));
  assert.match(String(received.result), /digest differs/u);
  assert.deepEqual(received.installed, []);
  assert.deepEqual(received.applied, []);
});

test("an idle connected edge costs the center no busy event loop", { timeout: 120_000 }, async (t) => {
  const fixture = await fleetReplicationFixture(t);
  await seedCenterData(fixture, seededTask);
  await fixture.openCenter();
  const viewRoot = mkdtempSync(path.join(tmpdir(), "ha-harden-view-")),
    viewDir = path.join(viewRoot, "repos", replicationRepoId, "views", "edge-one");
  startHardeningStream(t, fixture, viewRoot);
  await waitForState(
    () => readReplicaGeneration(viewDir)?.metadata.position.sequence === centerSequence(fixture),
    "initial convergence",
    60_000,
  );
  // The center's sender and the edge's receiver both live in this process; idle, they must sleep.
  await new Promise((resolve) => setTimeout(resolve, 500));
  const before = process.cpuUsage();
  await new Promise((resolve) => setTimeout(resolve, 2_000));
  const used = process.cpuUsage(before),
    cpuMs = (used.user + used.system) / 1000;
  assert.ok(cpuMs < 600, `idle replication used ${cpuMs.toFixed(0)} ms CPU in 2 s`);
});

/** A TCP relay whose center-to-edge direction can go silent without closing: a half-open link. */
async function silenceableRelay(t: TestContext, target: number) {
  const live = new Set<Socket>();
  let silent = false;
  const server = createServer((client) => {
    const upstream = connect(target, "127.0.0.1");
    live.add(client).add(upstream);
    const drop = () => {
      client.destroy();
      upstream.destroy();
      live.delete(client);
      live.delete(upstream);
    };
    client.on("error", drop).on("close", drop);
    upstream.on("error", drop).on("close", drop);
    client.pipe(upstream);
    upstream.on("data", (chunk: Buffer) => {
      if (!silent) client.write(chunk);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => {
    for (const socket of live) socket.destroy();
    server.close();
  });
  return {
    port: (server.address() as { port: number }).port,
    silence: (value: boolean) => {
      silent = value;
    },
  };
}

test("an idle stream is kept fresh by center keepalives", { timeout: 120_000 }, async (t) => {
  const fixture = await fleetReplicationFixture(t, { replicationKeepaliveMs: 200 });
  await seedCenterData(fixture, seededTask);
  await fixture.openCenter();
  const viewRoot = mkdtempSync(path.join(tmpdir(), "ha-harden-view-")),
    viewDir = path.join(viewRoot, "repos", replicationRepoId, "views", "edge-one");
  const stream = startHardeningStream(t, fixture, viewRoot, { idleTimeoutMs: 1_500 });
  await waitForState(
    () => readReplicaGeneration(viewDir)?.metadata.position.sequence === centerSequence(fixture),
    "initial convergence",
    60_000,
  );
  // Let the convergence round (its trailing progress and ACK) settle before observing idleness.
  await new Promise((resolve) => setTimeout(resolve, 1_000));
  const confirmedAt = statSync(path.join(viewDir, "current.json")).mtimeMs;
  // No commits: only keepalives arrive. They must refresh the read freshness and never trip the
  // edge's idle timeout.
  await new Promise((resolve) => setTimeout(resolve, 3_000));
  assert.ok(
    statSync(path.join(viewDir, "current.json")).mtimeMs > confirmedAt,
    "keepalive progress refreshed the confirmed position",
  );
  assert.deepEqual(stream.failures, [], "keepalives kept the idle stream alive");
});

test("a silent center connection is detected and the stream reconnects", { timeout: 120_000 }, async (t) => {
  const fixture = await fleetReplicationFixture(t, { replicationKeepaliveMs: 200 });
  await seedCenterData(fixture, seededTask);
  await fixture.openCenter();
  const viewRoot = mkdtempSync(path.join(tmpdir(), "ha-harden-view-")),
    viewDir = path.join(viewRoot, "repos", replicationRepoId, "views", "edge-one"),
    link = await silenceableRelay(t, fixture.centerPort());
  const stream = startHardeningStream(t, fixture, viewRoot, { port: link.port, idleTimeoutMs: 1_500 });
  await waitForState(
    () => readReplicaGeneration(viewDir)?.metadata.position.sequence === centerSequence(fixture),
    "initial convergence",
    60_000,
  );
  link.silence(true);
  await waitForState(
    () => stream.failures.some((error) => (error as { code?: string }).code === "replica_keepalive_missed"),
    "the edge to notice the silent connection",
    30_000,
  );
  link.silence(false);
  await pressure(fixture, 2);
  await waitForState(
    () => readReplicaGeneration(viewDir)?.metadata.position.sequence === centerSequence(fixture),
    "convergence after reconnecting",
    60_000,
  );
});
