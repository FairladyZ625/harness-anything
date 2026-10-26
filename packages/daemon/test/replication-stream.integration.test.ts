// harness-test-tier: integration
// dec_9284BD6119D453EEECEED62450 分片 C(测试先行): 连续复制流、ACK 与恢复。
// 覆盖:无事件 rejected outcome 也复制且 sequence 前进而事件 revision 不动;ACK 丢失后重放不产生
// 重复 canonical 事件;断线重连从持久游标续传(不重新整包);游标超出保留窗口后明确 resync 并整包
// 重来;同一节点的第二个接收者把旧会话挤下线(单 owner fence);sequence 缺口被拒绝而不是跳号。
// 待对齐: 见 fleet-replication.fixture.ts 文头;resync.reason 为自由文本(A 已落地),killpoint 阶段名见子进程 fixture。
import assert from "node:assert/strict";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { TASK_EVENT_SHAPE_COMPAT_VERSION } from "@harness-anything/kernel";
import { daemonBuildStamp } from "../src/build-identity.ts";
import {
  fakeReplicationCenter,
  fleetReplicationFixture,
  replicationRepoId,
  replicationPeer,
  seedCenterData,
  type FleetReplicationFixture,
} from "./fleet-replication.fixture.ts";

const seededTask = { taskId: "task_stream000000000000000000001", executionId: "exe_stream", title: "Stream" };
let pressureCounter = 0;
const createPressure = (): string => `task_wp${String(++pressureCounter).padStart(6, "0")}00000000000000000000`;

// One bounded read against a mirror ledger. The edge is SIGKILLed in these tests, so it can leave an
// unrecovered WAL behind; a probe that opens without a busy handler gets SQLITE_BUSY_RECOVERY (261,
// "database is locked") on its first statement whenever another connection happens to be running that
// recovery, which under CI load is exactly what happened. Every probe here goes through one guard.
const readMirror = <T>(ledgerPath: string, read: (db: DatabaseSync) => T): T => {
    const db = new DatabaseSync(ledgerPath, { readOnly: true });
    try {
      db.exec("PRAGMA busy_timeout=5000");
      return read(db);
    } finally {
      db.close();
    }
  },
  mirrorEventCount = (ledgerPath: string): number =>
    readMirror(
      ledgerPath,
      (db) => (db.prepare("SELECT COUNT(*) AS rows_ FROM event").get() as { rows_: number }).rows_,
    ),
  mirrorOutcomeCount = (ledgerPath: string): number =>
    readMirror(
      ledgerPath,
      (db) => (db.prepare("SELECT COUNT(*) AS rows_ FROM command_outcome").get() as { rows_: number }).rows_,
    ),
  mirrorHead = (ledgerPath: string): number =>
    readMirror(
      ledgerPath,
      (db) => (db.prepare("SELECT COALESCE(MAX(revision), 0) AS head FROM event").get() as { head: number }).head,
    ),
  centerOutcomeCount = (fixture: FleetReplicationFixture): number =>
    readMirror(
      fixture.ledgerPath,
      (db) => (db.prepare("SELECT COUNT(*) AS rows_ FROM command_outcome").get() as { rows_: number }).rows_,
    );

test(
  "a rejected command with no events still replicates: sequence advances, revision does not",
  { timeout: 120_000 },
  async (t) => {
    const fixture = await fleetReplicationFixture(t);
    await seedCenterData(fixture, seededTask);
    await fixture.openCenter();
    const edge = fixture.startEdge("edge-one");
    const installed = await edge.waitForEvent("installed");
    const revisionAtInstall = installed.position.revision as number,
      outcomesAtInstall = mirrorOutcomeCount(String(installed.ledgerPath));
    const rejected = await fixture.centerRun({
      kind: "task-start",
      taskId: "task_missing00000000000000000000",
      executionId: "exe-missing",
    });
    assert.equal(rejected.outcome, "op_rejected", JSON.stringify(rejected));
    // The design's minimal validation (§1): the outcome is present on the mirror with the event
    // revision unchanged and the replication sequence moved — an event-N+1-only stream drops it.
    await edge.waitForWhere(
      (event) => event.event === "applied" && event.outcomeStatus === "rejected",
      "the no-event rejected outcome to be applied on the edge",
    );
    assert.equal(fixture.eventCount(), revisionAtInstall, "a rejected command appends no event at the center");
    assert.equal(mirrorHead(String(installed.ledgerPath)), revisionAtInstall, "mirror event head is unchanged");
    assert.equal(
      mirrorOutcomeCount(String(installed.ledgerPath)),
      outcomesAtInstall + 1,
      "the committed outcome row reached the mirror",
    );
    assert.equal(centerOutcomeCount(fixture), outcomesAtInstall + 1, "center and mirror agree on outcome rows");
  },
);

test(
  "the center rejects a replica without the current task-event shape before sending data",
  { timeout: 60_000 },
  async (t) => {
    const fixture = await fleetReplicationFixture(t);
    const center = await fixture.openCenter();
    const edge = await replicationPeer(fixture.track, center.port, fixture.cert, "edge-one", "secret-edge-one");
    const response = await edge.raw({
      type: "replica.start",
      repoId: replicationRepoId,
      position: null,
      taskEventShapeVersion: 2,
    });
    assert.equal(response.type, "replica.reject");
    if (response.type !== "replica.reject") return;
    assert.equal(response.code, "edge_upgrade_required");
    const expectedBuild = daemonBuildStamp().commit?.slice(0, 7) ?? "unknown";
    assert.equal(response.centerBuildCommit, daemonBuildStamp().commit);
    assert.ok(response.message.includes(expectedBuild));
    assert.equal(response.taskEventShapeVersion, 3);
    const status = center.status().replicas.find((replica) => replica.nodeId === "edge-one");
    assert.equal(status?.connected, false);
    assert.equal(status?.syncFailure?.code, "edge_upgrade_required");
    assert.ok(status?.syncFailure?.message.includes(expectedBuild));
  },
);

test("a lost ACK replays the durable suffix without duplicating canonical events", { timeout: 180_000 }, async (t) => {
  const fixture = await fleetReplicationFixture(t);
  await seedCenterData(fixture, seededTask);
  await fixture.openCenter();
  // The child dies right after the durable write of a record and before its ACK leaves.
  const edge = fixture.startEdge("edge-one", { killpoints: ["after-durable-before-ack"] });
  const installed = await edge.waitForEvent("installed");
  const appended = await fixture.centerRun({
    kind: "task-create",
    taskId: createPressure(),
    title: "write pressure",
  });
  assert.equal(appended.outcome, "applied", JSON.stringify(appended));
  const killpoint = await edge.waitForEvent("killpoint");
  assert.equal(killpoint.point, "after-durable-before-ack");
  const exit = await edge.exited;
  assert.equal(exit.code, 75, "the child died at the durable-before-ACK killpoint");
  const eventsAtKill = mirrorEventCount(String(installed.ledgerPath));
  assert.ok(eventsAtKill > 0, "the durable record is already in the mirror ledger");
  // Restart on the same mirror: the center must resend from the last durable ACK position.
  // Convergence happens first; only then is the absence of a second package transfer asserted,
  // because a converged mirror with zero basebackup headers proves the suffix replayed.
  const resumed = fixture.startEdge("edge-one", { retry: true });
  const headRevision = fixture.eventCount();
  await resumed.waitForWhere(
    () => mirrorHead(String(installed.ledgerPath)) === headRevision,
    `the resumed mirror to reach head revision ${headRevision}`,
    60_000,
  );
  assert.equal(
    resumed.events.filter((event) => event.event === "backup-header").length,
    0,
    "a resume inside the retention window must not re-run a full basebackup",
  );
  assert.equal(
    mirrorEventCount(String(installed.ledgerPath)),
    headRevision,
    "replayed records are applied exactly once: mirror row count equals the center's revision head",
  );
  const duplicateCheck = readMirror(String(installed.ledgerPath), (db) =>
    db.prepare("SELECT op_id, COUNT(*) AS n FROM event GROUP BY op_id HAVING n > 1").all(),
  );
  assert.deepEqual(duplicateCheck, [], "no canonical event exists twice on the mirror");
});

test("a disconnect resumes from the persisted cursor without a fresh basebackup", { timeout: 180_000 }, async (t) => {
  const fixture = await fleetReplicationFixture(t);
  await seedCenterData(fixture, seededTask);
  await fixture.openCenter();
  const edge = fixture.startEdge("edge-one");
  const installed = await edge.waitForEvent("installed");
  await fixture.centerRun({
    kind: "task-create",
    taskId: createPressure(),
    title: "write pressure",
  });
  await edge.waitForWhere(
    () => mirrorHead(String(installed.ledgerPath)) === fixture.eventCount(),
    "pre-kill convergence",
  );
  edge.kill();
  await edge.exited;
  const headBeforeRestart = fixture.eventCount();
  for (let index = 0; index < 3; index += 1) {
    const appended = await fixture.centerRun({
      kind: "task-create",
      taskId: createPressure(),
      title: "write pressure",
    });
    assert.equal(appended.outcome, "applied", JSON.stringify(appended));
  }
  assert.ok(fixture.eventCount() > headBeforeRestart);
  const resumed = fixture.startEdge("edge-one", { retry: true });
  // Convergence first: the resumed child has emitted nothing at this instant, so asserting on its
  // event history here would pass without observing the product. The mirror path is re-read after
  // the restart too — a resume that re-packaged installs a new generation under a new path, and a
  // poll of the pre-kill path would then wait on a file the product had already abandoned.
  await resumed.waitForWhere(
    () =>
      mirrorHead(String(resumed.lastEvent("installed")?.ledgerPath ?? installed.ledgerPath)) === fixture.eventCount(),
    "post-restart convergence to the center head",
    60_000,
  );
  // Resume on the same history: no second package transfer, only the ordered suffix.
  assert.equal(
    resumed.events.filter((event) => event.event === "backup-header").length,
    0,
    "reconnection inside the window streams the suffix instead of re-packaging",
  );
});

test(
  "a cursor outside the retention window triggers an explicit resync and a full re-backup",
  { timeout: 240_000 },
  async (t) => {
    // 待对齐: retentionWindowCommits 是 listenFleetTls 的拟名旋钮,A 落地 replication-slot 时核对。
    const fixture = await fleetReplicationFixture(t, { retentionWindowCommits: 2 });
    await seedCenterData(fixture, seededTask);
    await fixture.openCenter();
    const lagging = fixture.startEdge("edge-two", { holdAcks: true, retry: true });
    const firstInstall = await lagging.waitForEvent("installed");
    // Push the shared log past the tiny window while the node holds its durable cursor un-ACKed.
    for (let index = 0; index < 6; index += 1) {
      const appended = await fixture.centerRun({
        kind: "task-create",
        taskId: createPressure(),
        title: "write pressure",
      });
      assert.equal(appended.outcome, "applied", JSON.stringify(appended));
    }
    lagging.control({ control: "release-acks" });
    const resync = await lagging.waitForEvent("resync-required", 60_000);
    t.diagnostic(`resync reason: ${String(resync.reason)}`);
    assert.match(String(resync.reason), /window/u, "the lagging node is told why it must start over");
    // The lagging node is told why it must start over, then converges through a fresh package.
    await lagging.waitForWhere(
      (event) =>
        event.event === "backup-header" && lagging.events.filter((entry) => entry.event === "backup-header").length > 1,
      "a second base backup after the explicit resync",
      120_000,
    );
    const secondHeader = lagging.lastEvent("backup-header")!;
    assert.ok((secondHeader.position.sequence as number) > (firstInstall.position.sequence as number));
    await lagging.waitForWhere(
      (event) =>
        event.event === "installed" && lagging.events.filter((entry) => entry.event === "installed").length > 1,
      "the replacement generation to be installed",
      120_000,
    );
    const reinstalled = lagging.lastEvent("installed")!;
    await lagging.waitForWhere(
      () => mirrorHead(String(reinstalled.ledgerPath)) === fixture.eventCount(),
      "re-backup convergence to the center head",
      120_000,
    );
    // The other node was never blocked by the lagging one (per-node cursors, shared window).
    const healthy = fixture.startEdge("edge-one");
    const healthyInstall = await healthy.waitForEvent("installed");
    await healthy.waitForWhere(
      () => mirrorHead(String(healthyInstall.ledgerPath)) === fixture.eventCount(),
      "healthy node convergence",
      60_000,
    );
  },
);

test("a second receiver for one node takes over and the older session is cut", { timeout: 120_000 }, async (t) => {
  const fixture = await fleetReplicationFixture(t);
  await seedCenterData(fixture, seededTask);
  const center = await fixture.openCenter();
  const stale = await replicationPeer(fixture.track, center.port, fixture.cert, "edge-three", "secret-edge-three");
  // The stale session owns this node's replication for the repository once its start is served.
  const accepted = await stale.request({
    type: "replica.start",
    repoId: "replica-repo",
    position: null,
    edgeBuildCommit: null,
    taskEventShapeVersion: TASK_EVENT_SHAPE_COMPAT_VERSION,
  });
  assert.equal(accepted.type, "replica.accept");
  const first = await stale.receive();
  assert.equal(first.type, "replica.backup");
  const edge = fixture.startEdge("edge-three");
  await edge.waitForEvent("installed");
  // Single replication owner per node and repository: the newer start displaces the older stream.
  await stale.closed;
});

test("a sequence gap is rejected instead of skipped", { timeout: 180_000 }, async (t) => {
  const fixture = await fleetReplicationFixture(t);
  await seedCenterData(fixture, seededTask);
  await fixture.openCenter();
  const edge = fixture.startEdge("edge-one");
  const installed = await edge.waitForEvent("installed");
  await edge.waitForWhere(() => mirrorHead(String(installed.ledgerPath)) === fixture.eventCount(), "convergence");
  edge.kill();
  await edge.exited;
  // Reconnect the same mirror to a fake center that skips one commit sequence.
  const fake = await fakeReplicationCenter(t, fixture, (frame, send) => {
    if (frame.type !== "replica.start" || frame.position === null) return;
    const from = frame.position,
      // Eventless, well-formed commit envelopes: only the sequence skips a step.
      sendCommit = (sequence: number) => {
        const bytes = Buffer.from(
          JSON.stringify({
            position: { history: from.history, sequence, revision: from.revision },
            events: [],
            outcome: {
              opId: `op-gap-${sequence}`,
              status: "rejected",
              firstRevision: null,
              lastRevision: null,
              intentDigest: `sha256:${"a".repeat(64)}`,
              summary: "gap probe",
              rejectionCode: "operation_rejected",
              recordedAt: "2026-10-13T12:00:00.000Z",
              memberOpIds: [],
            },
            writer: null,
          }),
        );
        send({ type: "replica.commit", size: bytes.length });
        send({ type: "replica.data", offset: 0, data: bytes.toString("base64") });
        send({ type: "replica.commit.end" });
      };
    sendCommit(from.sequence + 1);
    sendCommit(from.sequence + 3); // skips sequence+2
  });
  const resumed = fixture.startEdge("edge-one", { port: fake.port });
  const headBefore = mirrorHead(String(installed.ledgerPath));
  const outcome = await Promise.race([
    resumed.waitForEvent("error", 30_000).then((event) => `error:${String(event.message)}`),
    resumed.waitForEvent("resync-required", 30_000).then((event) => `resync:${String(event.reason)}`),
  ]);
  t.diagnostic(`gap outcome: ${outcome}`);
  await resumed.exited;
  assert.equal(
    mirrorHead(String(installed.ledgerPath)),
    headBefore,
    "the record after the gap was not applied — the receiver refuses to jump the sequence",
  );
});
