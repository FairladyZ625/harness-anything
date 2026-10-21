// harness-test-tier: integration
// TC-FLEET-CHAOS-03 (design: harness/tasks/task_0f452959ff91b5dcaa78604f61-fleet/artifacts/
// fleet-concurrency-test-design.md §3.3): a replication connection cut inside a content object must
// leave the edge mirror at its last durable ACK, and the next session must catch the same mirror up
// to the center exactly once — no loss, no duplicate, no re-package.
//
// The cut is triggered by the center's own stream: a TLS-terminating relay watches the downstream
// replication lines and destroys both sockets right after the first `replica.data` frame that
// follows a `replica.object` header. The edge therefore dies mid-object at a frame boundary chosen
// by observed content, never by a wall-clock sleep. The reconnect goes straight to the real center,
// so resume/replay under test is the production path.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { connect, createServer, type TLSSocket } from "node:tls";
import path from "node:path";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { makeTaskProjectionReader } from "@harness-anything/kernel";
import {
  fleetReplicationFixture,
  seedCenterData,
  waitForState,
  type FleetReplicationFixture,
} from "./fleet-replication.fixture.ts";

type ReplicationPositionClaim = { readonly history: string; readonly sequence: number; readonly revision: number };

const seededTask = { taskId: "task_walcut00000000000000000000001", executionId: "exe_walcut", title: "WAL cut" },
  // Far larger than one replication chunk, so the cut leaves most of the object unseen.
  artifactBytes = Buffer.alloc(512 * 1024, 0x5a);

const mirrorPosition = (ledgerPath: string): { sequence: number; revision: number } => {
  const db = new DatabaseSync(ledgerPath, { readOnly: true });
  try {
    db.exec("PRAGMA busy_timeout=5000");
    // revision lives on ledger_meta, the sequence on replication_state; readReplicationPosition joins them.
    return db.prepare("SELECT sequence, revision FROM replication_state JOIN ledger_meta USING(singleton)").get() as {
      sequence: number;
      revision: number;
    };
  } finally {
    db.close();
  }
};

const eventRows = (ledgerPath: string): number => {
  const db = new DatabaseSync(ledgerPath, { readOnly: true });
  try {
    db.exec("PRAGMA busy_timeout=5000");
    return (db.prepare("SELECT COUNT(*) AS n FROM event").get() as { n: number }).n;
  } finally {
    db.close();
  }
};

const stagedFiles = (mirrorRoot: string): string[] => {
  const staging = path.join(mirrorRoot, "staging");
  return existsSync(staging) ? readdirSync(staging) : [];
};

/** The sha256 object root of the installed generation: `objects/sha256` next to the ledger file. */
const objectRootOf = (ledgerPath: string): string => path.join(path.dirname(ledgerPath), "objects", "sha256");

/** Forwards replication lines and cuts both sides on the first payload frame after `replica.object`. */
async function cuttingRelay(
  upstreamPort: number,
  certificate: Buffer,
  key: Buffer,
): Promise<{
  readonly port: number;
  readonly cut: Promise<{ readonly bytes: number }>;
  /** Every `replica.start` position the edge itself sent, in order: the resume claim under test. */
  readonly startPositions: readonly (ReplicationPositionClaim | null)[];
  readonly close: () => void;
}> {
  let fired!: (result: { readonly bytes: number }) => void;
  const cut = new Promise<{ readonly bytes: number }>((resolve) => (fired = resolve)),
    sockets = new Set<TLSSocket>(),
    startPositions: (ReplicationPositionClaim | null)[] = [];
  let cutDone = false;
  const server = createServer({ key, cert: certificate }, (downstream) => {
    const upstream = connect(
      { host: "127.0.0.1", port: upstreamPort, ca: certificate, servername: "localhost" },
      () => undefined,
    );
    sockets.add(downstream);
    sockets.add(upstream);
    downstream.on("error", () => undefined);
    upstream.on("error", () => undefined);
    let tail = "",
      objectHeaderSeen = false,
      forwarded = 0;
    // Line-framed relay in both directions; the cut point is a whole JSON line the center sent.
    upstream.on("data", (chunk: Buffer) => {
      tail += chunk.toString("latin1");
      for (;;) {
        const end = tail.indexOf("\n");
        if (end < 0) break;
        const line = tail.slice(0, end + 1);
        tail = tail.slice(end + 1);
        if (!objectHeaderSeen && line.includes('"type":"replica.object"')) {
          objectHeaderSeen = true;
        } else if (objectHeaderSeen && !cutDone && line.includes('"type":"replica.data"')) {
          // Deliver exactly one payload frame, then drop: the object is now partially received.
          cutDone = true;
          forwarded += line.length;
          if (!downstream.destroyed) downstream.write(line, "latin1");
          fired({ bytes: forwarded });
          downstream.destroy();
          upstream.destroy();
          return;
        }
        if (downstream.destroyed) return;
        forwarded += line.length;
        downstream.write(line, "latin1");
      }
    });
    let resumeTail = "";
    downstream.on("data", (chunk: Buffer) => {
      resumeTail += chunk.toString("latin1");
      for (;;) {
        const end = resumeTail.indexOf("\n");
        if (end < 0) break;
        const line = resumeTail.slice(0, end);
        resumeTail = resumeTail.slice(end + 1);
        // The client's own claim about where it resumes; the center trusts this frame.
        if (line.includes('"type":"replica.start"'))
          startPositions.push((JSON.parse(line) as { position: ReplicationPositionClaim | null }).position);
      }
      if (!upstream.destroyed) upstream.write(chunk);
    });
    downstream.on("close", () => {
      sockets.delete(downstream);
      sockets.delete(upstream);
      upstream.destroy();
    });
    upstream.on("close", () => {
      sockets.delete(downstream);
      sockets.delete(upstream);
      downstream.destroy();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object", "cutting relay must listen");
  return {
    port: address.port,
    cut,
    startPositions,
    close: () => {
      server.close();
      for (const socket of sockets) socket.destroy();
      sockets.clear();
    },
  };
}

test(
  "a replication cut inside a content object leaves the mirror at its ACK and the next session catches up exactly once",
  { timeout: 180_000 },
  async (t) => {
    const fixture: FleetReplicationFixture = await fleetReplicationFixture(t);
    await seedCenterData(fixture, seededTask);
    await fixture.openCenter();

    // The edge installs its baseline through the relay; the cut targets a later artifact, so the
    // object travels as `replica.object` instead of inside the base backup.
    const relay = await cuttingRelay(fixture.centerPort(), fixture.cert, fixture.key);
    t.after(() => relay.close());
    const cutEdge = fixture.startEdge("edge-one", { port: relay.port }),
      installed = await cutEdge.waitForEvent("installed"),
      ledgerPath = String(installed.ledgerPath),
      cutGenerationId = readReplicaGenerationId(cutEdge.mirrorRoot),
      objectRoot = objectRootOf(ledgerPath),
      beforeCut = mirrorPosition(ledgerPath),
      eventsBeforeCut = eventRows(ledgerPath);

    writeFileSync(path.join(fixture.repo, "big.bin"), artifactBytes);
    const added = await fixture.centerRun({
      kind: "task-artifact-add",
      taskId: seededTask.taskId,
      source: "big.bin",
      destination: "reports/big.bin",
    });
    assert.equal(added.outcome, "applied", JSON.stringify(added));
    assert.ok(fixture.eventCount() > beforeCut.revision, "the center accepted the artifact event");

    const failure = await cutEdge.waitForEvent("error", 60_000);
    await cutEdge.exited;
    const cutPoint = await relay.cut;
    assert.ok(cutPoint.bytes > 0);
    // A peer that goes away mid-object is not a center fault. The listener must treat the sender's
    // EPIPE/ECONNRESET as the session ending, exactly like a closed socket, not report it as a
    // center error that hides real handler failures in the same log.
    assert.deepEqual(
      fixture.transportErrors,
      [],
      `a peer disconnect must not be reported as a center failure: ${JSON.stringify(fixture.transportErrors)}`,
    );

    // Durability boundary: the cut advanced neither the sequence nor the revision, applied no commit,
    // and left no received object file behind.
    assert.equal(
      failure.code,
      null,
      `the receiver reports a transport failure, not an invented domain code: ${JSON.stringify(failure)}`,
    );
    assert.match(String(failure.message), /closed|abort|drop|lost/iu, String(failure.message));
    assert.deepEqual(mirrorPosition(ledgerPath), beforeCut, "the cut advanced neither sequence nor revision");
    assert.equal(eventRows(ledgerPath), eventsBeforeCut, "no partially received object was applied");
    assert.deepEqual(stagedFiles(cutEdge.mirrorRoot), [], "the half-received object was removed, not published");
    const digest = createHash("sha256").update(artifactBytes).digest("hex"),
      partialObject = path.join(objectRoot, digest.slice(0, 2), digest.slice(2));
    assert.equal(existsSync(partialObject), false, "the content-addressed object was never published");

    // The cut session began with no generation, so its own start carried position null (a base
    // backup). The resume claim under test is the *next* session's frame.
    assert.deepEqual(
      relay.startPositions,
      [null],
      "the cut session was the first: it started from no generation, so no resume was skipped",
    );

    // Reconnect the same mirror to the real center; the edge resumes from its last durable ACK.
    const replacement = await cuttingRelay(fixture.centerPort(), fixture.cert, fixture.key);
    t.after(() => replacement.close());
    const resumed = fixture.startEdge("edge-one", { retry: true, port: replacement.port }),
      resume = await resumed.waitForEvent("resumed");
    assert.equal(
      (resume.position as { sequence: number }).sequence,
      beforeCut.sequence,
      "the resumed generation was reopened at the durable position",
    );
    await waitForState(
      () => replacement.startPositions.length === 1,
      "the resumed session to send its replica.start",
      60_000,
    );
    assert.equal(
      replacement.startPositions[0]?.sequence,
      beforeCut.sequence,
      `the wire frame names the durable ACK, so the center replays the suffix instead of the whole log: ${JSON.stringify(replacement.startPositions)}`,
    );
    const centerRevision = makeTaskProjectionReader({ rootDir: fixture.repo }).withSession(
        (queries) => queries.readCut().watermark,
      ),
      centerSequence = centerSequenceOf(fixture.ledgerPath);
    await waitForState(
      () => {
        try {
          return mirrorPosition(ledgerPath).revision === centerRevision;
        } catch {
          return false;
        }
      },
      "the resumed mirror to reach the center revision",
      120_000,
    );
    assert.equal(
      resumed.events.filter((event) => event.event === "backup-header").length,
      0,
      "an in-window resume replays the suffix instead of re-packaging the repository",
    );
    assert.equal(
      readReplicaGenerationId(cutEdge.mirrorRoot),
      cutGenerationId,
      "the resume kept the installed generation instead of replacing it with a fresh base backup",
    );

    // Exactly-once, byte-identical convergence.
    assert.deepEqual(readFileSync(partialObject), artifactBytes, "the object arrived byte-identical to the center's");
    const mirrored = new DatabaseSync(ledgerPath, { readOnly: true });
    try {
      mirrored.exec("PRAGMA busy_timeout=5000");
      assert.deepEqual(
        mirrored.prepare("SELECT op_id, COUNT(*) AS n FROM event GROUP BY op_id HAVING n > 1").all(),
        [],
        "the resumed replay applied every canonical op exactly once",
      );
    } finally {
      mirrored.close();
    }
    assert.equal(eventRows(ledgerPath), centerRevision, "no canonical event was lost across the cut");
    assert.equal(mirrorPosition(ledgerPath).sequence, centerSequence, "the mirror log equals the center head");
    assert.deepEqual(stagedFiles(resumed.mirrorRoot), [], "the successful replay left no staging debris");
  },
);

/** The published replica generation id; a re-backup installs a new one. */
function readReplicaGenerationId(mirrorRoot: string): string {
  return (JSON.parse(readFileSync(path.join(mirrorRoot, "current.json"), "utf8")) as { id: string }).id;
}

function centerSequenceOf(ledgerPath: string): number {
  const db = new DatabaseSync(ledgerPath, { readOnly: true });
  try {
    db.exec("PRAGMA busy_timeout=5000");
    return (db.prepare("SELECT sequence FROM replication_state").get() as { sequence: number }).sequence;
  } finally {
    db.close();
  }
}
