// harness-test-tier: integration
// dec_9284BD6119D453EEECEED62450 分片 C(测试先行): 连续复制流、ACK 与恢复。
// 覆盖:无事件 rejected outcome 也复制且 sequence 前进而事件 revision 不动;ACK 丢失后重放不产生
// 重复 canonical 事件;断线重连从持久游标续传(不重新整包);游标超出保留窗口后明确 resync 并整包
// 重来;同一节点的第二个接收者把旧会话挤下线(单 owner fence);sequence 缺口被拒绝而不是跳号。
// 待对齐: 见 fleet-replication.fixture.ts 文件头;resync 的 code 词表与 killpoint 阶段名是拟名。
import assert from "node:assert/strict";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import {
  fakeReplicationCenter,
  fleetReplicationFixture,
  replicationPeer,
  seedCenterData,
  type FleetReplicationFixture,
} from "./fleet-replication.fixture.ts";

const seededTask = { taskId: "task_stream000000000000000000001", executionId: "exe_stream", title: "Stream" };

const mirrorEventCount = (ledgerPath: string): number => {
    const db = new DatabaseSync(ledgerPath, { readOnly: true });
    try {
      return (db.prepare("SELECT COUNT(*) AS rows_ FROM event").get() as { rows_: number }).rows_;
    } finally {
      db.close();
    }
  },
  mirrorOutcomeCount = (ledgerPath: string): number => {
    const db = new DatabaseSync(ledgerPath, { readOnly: true });
    try {
      return (db.prepare("SELECT COUNT(*) AS rows_ FROM command_outcome").get() as { rows_: number }).rows_;
    } finally {
      db.close();
    }
  },
  mirrorHead = (ledgerPath: string): number => {
    const db = new DatabaseSync(ledgerPath, { readOnly: true });
    try {
      return (db.prepare("SELECT COALESCE(MAX(revision), 0) AS head FROM event").get() as { head: number }).head;
    } finally {
      db.close();
    }
  },
  centerOutcomeCount = (fixture: FleetReplicationFixture): number => {
    const db = new DatabaseSync(fixture.ledgerPath, { readOnly: true });
    try {
      return (db.prepare("SELECT COUNT(*) AS rows_ FROM command_outcome").get() as { rows_: number }).rows_;
    } finally {
      db.close();
    }
  };

test(
  "a rejected command with no events still replicates: sequence advances, revision does not",
  { timeout: 120_000 },
  async (t) => {
    const fixture = await fleetReplicationFixture(t);
    await seedCenterData(fixture, seededTask);
    await fixture.openCenter();
    const edge = fixture.startEdge("edge-one");
    const installed = await edge.waitForEvent("installed");
    const revisionAtInstall = installed.revision as number,
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

test("a lost ACK replays the durable suffix without duplicating canonical events", { timeout: 180_000 }, async (t) => {
  const fixture = await fleetReplicationFixture(t);
  await seedCenterData(fixture, seededTask);
  await fixture.openCenter();
  // The child dies right after the durable write of a record and before its ACK leaves.
  const edge = fixture.startEdge("edge-one", { killpoints: ["after-durable-before-ack"] });
  const installed = await edge.waitForEvent("installed");
  const appended = await fixture.centerRun({
    kind: "task-progress-append",
    taskId: seededTask.taskId,
    executionId: seededTask.executionId,
    text: "record whose ACK will be lost",
    evidence: [],
    baseDocumentSha256: null,
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
    resumed.events.filter((event) => event.event === "basebackup-header").length,
    0,
    "a resume inside the retention window must not re-run a full basebackup",
  );
  assert.equal(
    mirrorEventCount(String(installed.ledgerPath)),
    headRevision,
    "replayed records are applied exactly once: mirror row count equals the center's revision head",
  );
  const duplicateCheck = new DatabaseSync(String(installed.ledgerPath), { readOnly: true });
  try {
    const rows = duplicateCheck.prepare("SELECT op_id, COUNT(*) AS n FROM event GROUP BY op_id HAVING n > 1").all();
    assert.deepEqual(rows, [], "no canonical event exists twice on the mirror");
  } finally {
    duplicateCheck.close();
  }
});

test("a disconnect resumes from the persisted cursor without a fresh basebackup", { timeout: 180_000 }, async (t) => {
  const fixture = await fleetReplicationFixture(t);
  await seedCenterData(fixture, seededTask);
  await fixture.openCenter();
  const edge = fixture.startEdge("edge-one");
  const installed = await edge.waitForEvent("installed");
  await fixture.centerRun({
    kind: "task-progress-append",
    taskId: seededTask.taskId,
    executionId: seededTask.executionId,
    text: "before the disconnect",
    evidence: [],
    baseDocumentSha256: null,
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
      kind: "task-progress-append",
      taskId: seededTask.taskId,
      executionId: seededTask.executionId,
      text: `while the edge is down ${index}`,
      evidence: [],
      baseDocumentSha256: null,
    });
    assert.equal(appended.outcome, "applied", JSON.stringify(appended));
  }
  assert.ok(fixture.eventCount() > headBeforeRestart);
  const resumed = fixture.startEdge("edge-one", { retry: true });
  // Resume on the same history: no second package transfer, only the ordered suffix.
  assert.equal(
    resumed.events.filter((event) => event.event === "basebackup-header").length,
    0,
    "reconnection inside the window streams the suffix instead of re-packaging",
  );
  await resumed.waitForWhere(
    () => mirrorHead(String(installed.ledgerPath)) === fixture.eventCount(),
    "post-restart convergence to the center head",
    60_000,
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
        kind: "task-progress-append",
        taskId: seededTask.taskId,
        executionId: seededTask.executionId,
        text: `window pressure ${index}`,
        evidence: [],
        baseDocumentSha256: null,
      });
      assert.equal(appended.outcome, "applied", JSON.stringify(appended));
    }
    lagging.control({ control: "release-acks" });
    const resync = await lagging.waitForEvent("resync-required", 60_000);
    t.diagnostic(`resync code: ${String(resync.code)}`);
    // The lagging node is told why it must start over, then converges through a fresh package.
    const secondHeader = await lagging.waitForEvent("basebackup-header", 120_000);
    assert.ok((secondHeader.sequence as number) > (firstInstall.sequence as number));
    await lagging.waitForWhere(
      () => mirrorHead(String(firstInstall.ledgerPath)) === fixture.eventCount(),
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
  const edge = fixture.startEdge("edge-three");
  await edge.waitForEvent("installed");
  // Single owner per node: the registered receiver displaces the parked raw session.
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
    if (frame.schema === "fleet.basebackup.request/v1") {
      // The gap scenario must not fall back into a package transfer; fail fast instead.
      send({
        schema: "fleet.error/v1",
        messageId: "no-backup",
        inReplyTo: frame.messageId,
        code: "fake_center_no_backup",
        message: "gap fixture serves no packages",
        retryable: false,
        resumeOffset: null,
      });
      return;
    }
    if (frame.schema !== "fleet.replication.start/v1") return;
    const from = (frame.fromSequence as number | null) ?? 0,
      record = (sequence: number) => ({
        schema: "fleet.replication.record/v1",
        messageId: `record-${sequence}`,
        sequence,
        firstRevision: null,
        lastRevision: null,
        opId: `op-gap-${sequence}`,
        outcomeStatus: "rejected",
        rejectionCode: "operation_rejected",
        events: [],
        contentRefs: [],
      });
    send(record(from + 1));
    send(record(from + 3)); // skips from+2
  });
  const resumed = fixture.startEdge("edge-one", { port: fake.port });
  const headBefore = mirrorHead(String(installed.ledgerPath));
  const outcome = await Promise.race([
    resumed.waitForEvent("error", 30_000).then((event) => `error:${String(event.code)}`),
    resumed.waitForEvent("resync-required", 30_000).then((event) => `resync:${String(event.code)}`),
  ]);
  t.diagnostic(`gap outcome: ${outcome}`);
  await resumed.exited;
  assert.equal(
    mirrorHead(String(installed.ledgerPath)),
    headBefore,
    "the record after the gap was not applied — the receiver refuses to jump the sequence",
  );
});
