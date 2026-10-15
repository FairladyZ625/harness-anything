// harness-test-tier: integration
// dec_9284BD6119D453EEECEED62450 分片 C(测试先行): 进程级 1 中心 + 3 边缘端到端。
// 覆盖:三边缘全量镜像读一致(同一投影、同一 schema/索引);边缘并发写回流中心且每个命令只产生
// 一次 canonical 事件;边缘 doc submit 经中心接纳后对象复制到所有镜像;边缘发起 Agent 派工在中心
// 只出现一次 canonical runtime 事件并复制;撤销节点注册切断其复制会话;中心关闭后边缘本地读仍回答;
// 边缘本地手改停留在工作副本,不进 canonical 事件流。
// 待对齐: 见 fleet-replication.fixture.ts 文件头;runtime 派工帧与节点注册表的 admin 操作沿用现有合同。
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { createHash, randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { makeTaskProjectionReader } from "@harness-anything/kernel";
import { AccessAdminService } from "../src/access-admin-service.ts";
import { OidcSessionService } from "../src/oidc-session-service.ts";
import {
  fleetReplicationFixture,
  replicationNodes,
  seedCenterData,
  waitForState,
} from "./fleet-replication.fixture.ts";
import { rawPeer } from "./fleet-tls-session.fixture.ts";

const seededTask = { taskId: "task_e2e0000000000000000000001", executionId: "exe_e2e", title: "End to end" };

const mirrorHead = (ledgerPath: string): number => {
    const db = new DatabaseSync(ledgerPath, { readOnly: true });
    try {
      return (db.prepare("SELECT COALESCE(MAX(revision), 0) AS head FROM event").get() as { head: number }).head;
    } finally {
      db.close();
    }
  },
  mirrorSequence = (ledgerPath: string): number => {
    const db = new DatabaseSync(ledgerPath, { readOnly: true });
    try {
      return (db.prepare("SELECT sequence FROM replication_state WHERE singleton = 1").get() as { sequence: number })
        .sequence;
    } finally {
      db.close();
    }
  },
  mirrorEventRows = (ledgerPath: string, where: string, params: readonly unknown[] = []): unknown[] => {
    const db = new DatabaseSync(ledgerPath, { readOnly: true });
    try {
      return db.prepare(`SELECT * FROM event WHERE ${where}`).all(...params);
    } finally {
      db.close();
    }
  },
  centerEventRows = (
    fixture: ReturnType<typeof fleetReplicationFixture>,
    where: string,
    params: readonly unknown[] = [],
  ): unknown[] => {
    const db = new DatabaseSync(fixture.ledgerPath, { readOnly: true });
    try {
      return db.prepare(`SELECT * FROM event WHERE ${where}`).all(...params);
    } finally {
      db.close();
    }
  },
  tableRows = (databasePath: string): Record<string, unknown[][]> => {
    const db = new DatabaseSync(databasePath, { readOnly: true });
    try {
      const tables = db
        .prepare("SELECT name FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
        .all() as { name: string }[];
      return Object.fromEntries(
        tables.map(({ name }) => {
          const columns = db.prepare(`PRAGMA table_info(${JSON.stringify(name)})`).all() as {
            name: string;
            pk: number;
          }[];
          const primaryKey = columns.filter((column) => column.pk > 0).sort((a, b) => a.pk - b.pk);
          const order = (primaryKey.length ? primaryKey : columns).map((column) => `"${column.name}"`).join(", ");
          return [name, db.prepare(`SELECT * FROM "${name}" ORDER BY ${order}`).all()];
        }),
      );
    } finally {
      db.close();
    }
  },
  containsBytes = (dir: string, needle: Buffer): boolean => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (containsBytes(full, needle)) return true;
      } else if (entry.isFile() && statSync(full).size >= needle.length && readFileSync(full).equals(needle))
        return true;
    }
    return false;
  },
  taskListDigest = (reader: ReturnType<typeof makeTaskProjectionReader>) =>
    reader.withSession((queries) =>
      queries
        .list({})
        .rows.map((row) => `${row.taskId}:${row.updatedAt}`)
        .sort(),
    );

/** Compare every table in a center database and its complete edge mirror. */
const compareDatabase = (centerPath: string, edgePath: string, label: string): void => {
  const { replication_log: edgeLog, ...edgeTables } = tableRows(edgePath),
    { replication_log: centerLog, ...centerTables } = tableRows(centerPath);
  assert.deepEqual(edgeTables, centerTables, `${label}: every table row matches center`);
  if (edgeLog === undefined) return;
  const applied = (edgeTables.replication_state as unknown as readonly { sequence: number }[])[0]!.sequence,
    firstRetained = (edgeLog[0] as unknown as { sequence: number } | undefined)?.sequence ?? applied;
  assert.deepEqual(
    edgeLog,
    (centerLog ?? []).filter((row) => {
      const sequence = (row as unknown as { sequence: number }).sequence;
      return sequence >= firstRetained && sequence <= applied;
    }),
    `${label}: every retained edge log row matches the center through its applied position`,
  );
  assert.equal((edgeLog.at(-1) as unknown as { sequence: number } | undefined)?.sequence, applied);
};

test("three process-level edges hold one consistent mirror of every center read", { timeout: 240_000 }, async (t) => {
  const fixture = await fleetReplicationFixture(t);
  const seeded = await seedCenterData(fixture, seededTask);
  await fixture.openCenter();
  const edges = replicationNodes.map((nodeId) => fixture.startEdge(nodeId));
  const installs = await Promise.all(edges.map((edge) => edge.waitForEvent("installed")));
  await Promise.all(
    installs.map((installed, index) =>
      edges[index]!.waitForWhere(
        () => mirrorHead(String(installed.ledgerPath)) === fixture.eventCount(),
        "initial convergence",
        90_000,
      ),
    ),
  );
  const centerReader = fixture.centerReader(),
    centerList = taskListDigest(centerReader),
    centerRevision = centerReader.withSession((queries) => queries.readCut().watermark);
  assert.equal(centerRevision, fixture.eventCount());
  const noteBytes = readFileSync(
    path.isAbsolute(seeded.planPath) ? seeded.planPath : path.join(fixture.repo, "harness", seeded.planPath),
  );
  for (const [index, installed] of installs.entries()) {
    const reader = makeTaskProjectionReader({
      rootDir: edges[index]!.root,
      projectionPath: String(installed.projectionPath),
    });
    assert.deepEqual(
      taskListDigest(reader),
      centerList,
      `edge ${edges[index]!.nodeId} lists exactly what the center lists`,
    );
    assert.equal(
      reader.withSession((queries) => queries.readCut().watermark),
      centerRevision,
    );
    reader.close();
    // The whole-repo package carries authored content objects, not only ledger rows.
    assert.ok(
      containsBytes(String(installed.generationDir), noteBytes),
      `edge ${edges[index]!.nodeId} mirror holds the seeded note bytes`,
    );
  }
  centerReader.close();
  // Concurrent authored writes from all three edges: each is one canonical event at the center.
  const beforeWrites = fixture.eventCount();
  const written = await Promise.all(
    replicationNodes.map((nodeId, index) =>
      fixture.edgeTaskCommand(nodeId, {
        kind: "task-create",
        taskId: `task_wb${String(index).padStart(2, "0")}0000000000000000000000`,
        title: `write-back from ${nodeId}`,
      }),
    ),
  );
  for (const result of written) assert.equal(result.schema, "fleet.task.result/v1", JSON.stringify(result));
  assert.equal(fixture.eventCount(), beforeWrites + 3, "exactly one canonical event per edge command");
  await Promise.all(
    installs.map((installed, index) =>
      edges[index]!.waitForWhere(
        () => mirrorHead(String(installed.ledgerPath)) === fixture.eventCount(),
        "write-back convergence",
        90_000,
      ),
    ),
  );
  for (const installed of installs) {
    const rows = mirrorEventRows(
      String(installed.ledgerPath),
      "json_extract(event_json, '$.payload.task.title') LIKE 'write-back from %'",
    );
    assert.equal(rows.length, 3, "each write-back event appears exactly once on every mirror");
  }
  // A document submitted from one edge lands at the center and replicates to the other two.
  const edgeNote = Buffer.from("# Edge-submitted note\n\nAuthored on edge-two over the wire.\n"),
    submitted = await fixture.edgeDocSubmit("edge-two", `harness/tasks/${seededTask.taskId}/edge-note.md`, edgeNote);
  assert.equal(submitted.schema, "fleet.doc.result/v1", JSON.stringify(submitted));
  assert.equal((submitted as { outcome?: string }).outcome, "applied");
  await Promise.all(
    installs.map((installed, index) =>
      edges[index]!.waitForWhere(
        () => mirrorHead(String(installed.ledgerPath)) === fixture.eventCount(),
        "doc submit convergence",
        90_000,
      ),
    ),
  );
  assert.ok(containsBytes(String(installs[0]!.generationDir), edgeNote), "edge-one received the submitted object");
  assert.ok(containsBytes(String(installs[2]!.generationDir), edgeNote), "edge-three received the submitted object");
  // An agent dispatch from an edge is one canonical runtime event, mirrored once everywhere.
  // 待对齐: runtime 派工帧按 A 分片 protocol 落地核对;事件唯一性以 runtimeSessionId 计数。
  // Dispatch identities are derived from the repository idempotency key (repo-cell-runtime-ingress).
  const idempotencyKey = `edge-dispatch-${randomUUID()}`,
    dispatchHash = createHash("sha256").update(`replica-repo\0${idempotencyKey}`).digest("hex"),
    runtimeSessionId = `runtime_${dispatchHash.slice(24, 48)}`;
  const peer = await rawPeer(fixture.track, fixture.centerPort(), fixture.cert, "edge-one", "secret-edge-one");
  const metadata = await peer.request({
    schema: "fleet.repo.metadata.get/v1",
    messageId: "metadata",
    repoId: "replica-repo",
  });
  if (metadata.schema !== "fleet.repo.metadata.result/v1") throw new Error(JSON.stringify(metadata));
  const dispatch = await peer.request({
    schema: "fleet.runtime.event/v1",
    messageId: "dispatch",
    writerEpoch: metadata.writerEpoch,
    repoId: "replica-repo",
    opId: `runtime-spawn-${dispatchHash.slice(0, 32)}`,
    eventType: "runtime_dispatch_requested",
    payload: {
      dispatchId: `dispatch_${dispatchHash.slice(0, 24)}`,
      runtimeSessionId,
      instanceId: "runtime-instance-edge",
      installationId: `installation-${seededTask.taskId}`,
      kindId: "codex",
      idempotencyKey,
      definitionSnapshotRef: "artifact:runtime-definition/edge",
      definitionSnapshot: {
        schema: "agent-definition-snapshot/v1",
        configVersion: 1,
        instanceId: "runtime-instance-edge",
        installationId: `installation-${seededTask.taskId}`,
        kindId: "codex",
        providerId: "openai",
        model: "gpt-5.6-sol",
        reasoningEffort: "high",
        baseUrl: null,
        authMode: "subscription",
      },
    },
    result: null,
    // A task-less dispatch: edge-one holds no lease on the center-started seeded task.
    dispatchContext: { role: null, taskId: null, executionId: null },
  });
  t.diagnostic(`runtime dispatch reply: ${dispatch.schema}`);
  peer.close();
  const bySession = "json_extract(event_json, '$.payload.runtimeSessionId') = ?";
  await waitForState(
    () => centerEventRows(fixture, bySession, [runtimeSessionId]).length === 1,
    "the dispatch to settle as exactly one canonical runtime event",
  );
  await Promise.all(
    installs.map((installed, index) =>
      edges[index]!.waitForWhere(
        () => mirrorHead(String(installed.ledgerPath)) === fixture.eventCount(),
        "dispatch convergence",
        90_000,
      ),
    ),
  );
  const settledProjection = fixture.centerReader(),
    settledWatermark = settledProjection.withSession((queries) => queries.readCut().watermark);
  settledProjection.close();
  await Promise.all(
    installs.map((installed) =>
      waitForState(() => {
        const db = new DatabaseSync(String(installed.projectionPath), { readOnly: true });
        try {
          return (
            (
              db.prepare("SELECT watermark FROM projection_meta WHERE singleton=1").get() as
                | { watermark: number }
                | undefined
            )?.watermark >= settledWatermark
          );
        } finally {
          db.close();
        }
      }, `projection watermark ${settledWatermark} on ${installed.nodeId}`),
    ),
  );
  for (const installed of installs) {
    assert.equal(
      mirrorEventRows(String(installed.ledgerPath), bySession, [runtimeSessionId]).length,
      1,
      "the runtime event replicated exactly once to every mirror",
    );
  }
  for (const installed of installs) {
    compareDatabase(fixture.ledgerPath, String(installed.ledgerPath), "ledger");
    compareDatabase(
      path.join(fixture.repo, ".harness/cache/task.sqlite"),
      String(installed.projectionPath),
      "projection",
    );
  }
});

test("full mirror comparison covers rejected and no-event commits", { timeout: 180_000 }, async (t) => {
  const fixture = await fleetReplicationFixture(t);
  await seedCenterData(fixture, seededTask);
  await fixture.openCenter();
  const edge = fixture.startEdge("edge-one");
  const installed = await edge.waitForEvent("installed");
  const rejected = await fixture.centerRun({
    kind: "task-start",
    taskId: "task_missing00000000000000000000",
    executionId: "exe-missing",
  });
  assert.equal(rejected.outcome, "op_rejected", JSON.stringify(rejected));
  await edge.waitForWhere(
    (event) => event.event === "applied" && event.outcomeStatus === "rejected",
    "the rejected no-event outcome to be replicated",
  );
  compareDatabase(fixture.ledgerPath, String(installed.ledgerPath), "rejected ledger");
  compareDatabase(
    path.join(fixture.repo, ".harness/cache/task.sqlite"),
    String(installed.projectionPath),
    "rejected projection",
  );

  const noEvent = await fixture.centerRun({
    kind: "task-start",
    taskId: seededTask.taskId,
    executionId: "ignored-new-execution",
  });
  assert.equal(noEvent.outcome, "no_changes", JSON.stringify(noEvent));
  compareDatabase(fixture.ledgerPath, String(installed.ledgerPath), "no-event ledger");
  compareDatabase(
    path.join(fixture.repo, ".harness/cache/task.sqlite"),
    String(installed.projectionPath),
    "no-event projection",
  );
});

test("full mirror comparison covers retention-window base-backup resync", { timeout: 240_000 }, async (t) => {
  const fixture = await fleetReplicationFixture(t, { retentionWindowCommits: 2 });
  await seedCenterData(fixture, seededTask);
  await fixture.openCenter();
  const lagging = fixture.startEdge("edge-two", { holdAcks: true, retry: true });
  const firstInstall = await lagging.waitForEvent("installed");
  for (let index = 0; index < 6; index += 1) {
    const appended = await fixture.centerRun({
      kind: "task-create",
      taskId: `task_resync${String(index).padStart(2, "0")}0000000000000000000`,
      title: "retention pressure",
    });
    assert.equal(appended.outcome, "applied", JSON.stringify(appended));
  }
  lagging.control({ control: "release-acks" });
  const resync = await lagging.waitForEvent("resync-required", 60_000);
  assert.match(String(resync.reason), /window/u, "the lagging node is told why it must start over");
  await lagging.waitForWhere(
    (event) =>
      event.event === "backup-header" && lagging.events.filter((entry) => entry.event === "backup-header").length > 1,
    "a second base backup after the explicit resync",
    120_000,
  );
  const secondHeader = lagging.lastEvent("backup-header")!;
  assert.ok((secondHeader.position.sequence as number) > (firstInstall.position.sequence as number));
  await lagging.waitForWhere(
    (event) => event.event === "installed" && lagging.events.filter((entry) => entry.event === "installed").length > 1,
    "the replacement generation to be installed",
    120_000,
  );
  const reinstalled = lagging.lastEvent("installed")!;
  await lagging.waitForWhere(
    () => mirrorSequence(String(reinstalled.ledgerPath)) === mirrorSequence(fixture.ledgerPath),
    "re-backup convergence to the center head",
    120_000,
  );
  compareDatabase(fixture.ledgerPath, String(reinstalled.ledgerPath), "resync ledger");
  compareDatabase(
    path.join(fixture.repo, ".harness/cache/task.sqlite"),
    String(reinstalled.projectionPath),
    "resync projection",
  );
});

test("revoking a node's registration cuts its replication session", { timeout: 120_000 }, async (t) => {
  const fixture = await fleetReplicationFixture(t);
  await seedCenterData(fixture, seededTask);
  const center = await fixture.openCenter();
  const edge = fixture.startEdge("edge-three");
  await edge.waitForEvent("installed");
  const admin = new AccessAdminService(new OidcSessionService(fixture.userRoot), fixture.userRoot, {
      onNodeRemoved: (nodeId) => center.disconnectNode(nodeId),
    }),
    listed = (await admin.run({ operation: "node-list", operationId: randomUUID() })) as {
      nodes: { nodeId: string; version: string }[];
    },
    target = listed.nodes.find((node) => node.nodeId === "edge-three");
  assert.ok(target, `edge-three is registered: ${JSON.stringify(listed)}`);
  const removed = await admin.run({
    operation: "node-unregister",
    operationId: randomUUID(),
    nodeId: "edge-three",
    expectedVersion: target.version,
  });
  assert.equal((removed as { ok?: boolean }).ok, true, JSON.stringify(removed));
  // The cut lands on the live replication session, not only in the registry.
  await Promise.race([edge.exited, edge.waitForEvent("error", 30_000)]);
  const rejected = await rawPeer(fixture.track, center.port, fixture.cert, "edge-three", "secret-edge-three").then(
    (peer) => peer.request({ schema: "fleet.repo.metadata.get/v1", messageId: "after-cut", repoId: "replica-repo" }),
    (error) => `connect-failed:${String(error)}`,
  );
  t.diagnostic(`post-revoke session state: ${typeof rejected === "string" ? rejected : rejected.schema}`);
});

test(
  "edge-local edits stay working-copy candidates and the center answers reads while it is down for edges",
  { timeout: 180_000 },
  async (t) => {
    const fixture = await fleetReplicationFixture(t);
    await seedCenterData(fixture, seededTask);
    const center = await fixture.openCenter();
    const edge = fixture.startEdge("edge-one");
    const installed = await edge.waitForEvent("installed");
    await edge.waitForWhere(() => mirrorHead(String(installed.ledgerPath)) === fixture.eventCount(), "convergence");
    // A hand edit in the edge's work tree never becomes a canonical event on its own.
    const localEdit = path.join(edge.viewRoot, "harness", "tasks", seededTask.taskId, "local-note.md");
    mkdirSync(path.dirname(localEdit), { recursive: true });
    writeFileSync(localEdit, "# Local edit\n\nNever submitted through the center.\n");
    const headBeforeEdit = fixture.eventCount();
    const control = await fixture.edgeTaskCommand("edge-two", {
      kind: "task-create",
      taskId: `task_ctrl00000000000000000000001`,
      title: "positive control while edge-one holds a local edit",
    });
    assert.equal(control.schema, "fleet.task.result/v1", JSON.stringify(control));
    await edge.waitForWhere(
      () => mirrorHead(String(installed.ledgerPath)) === fixture.eventCount(),
      "the control write replicates past the local edit",
      90_000,
    );
    assert.equal(fixture.eventCount(), headBeforeEdit + 1, "only the control write reached the canonical stream");
    assert.equal(existsSync(path.join(fixture.repo, "harness", "tasks", seededTask.taskId, "local-note.md")), false);
    // With the center closed, edge-local reads still answer from the installed generation.
    await center.close();
    const offline = makeTaskProjectionReader({ rootDir: edge.root, projectionPath: String(installed.projectionPath) });
    const rows = offline.withSession((queries) => queries.list({}).rows);
    assert.ok(
      rows.some((row) => row.taskId === seededTask.taskId),
      "the offline edge keeps serving full-mirror reads",
    );
    offline.close();
  },
);
