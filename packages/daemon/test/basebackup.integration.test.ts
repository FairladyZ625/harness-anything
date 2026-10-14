// harness-test-tier: integration
// dec_9284BD6119D453EEECEED62450 分片 C(测试先行): 基础备份包行为。
// 覆盖:写入继续时备份固定单一 N/S;首条流记录在备份位置之后(首次同步不逐行 rebuild);
// 整包字节损坏/截断被拒绝且不切换 generation;同一 N/S 的三个边缘拿到同一份包;传输期间中心可响应。
// 待对齐: 见 fleet-replication.fixture.ts 文件头——本文件只经 fixture 与子进程驱动真实边界。
import assert from "node:assert/strict";
import { existsSync, readdirSync } from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import {
  fakeReplicationCenter,
  fleetReplicationFixture,
  queryPlanRows,
  replicationNodes,
  seedCenterData,
  sqliteObjects,
} from "./fleet-replication.fixture.ts";

const seededTask = { taskId: "task_backup0000000000000000000001", executionId: "exe_backup", title: "Backup N/S" };
let pressureCounter = 0;
const createPressure = (): string => `task_wp${String(++pressureCounter).padStart(6, "0")}00000000000000000000`;

test(
  "basebackup freezes one N/S while writes continue and the stream resumes strictly after it",
  { timeout: 120_000 },
  async (t) => {
    const fixture = await fleetReplicationFixture(t);
    await seedCenterData(fixture, seededTask);
    await fixture.openCenter();
    // Writes keep landing on the single write queue while the package is being built and shipped.
    const edge = fixture.startEdge("edge-one");
    const header = await edge.waitForEvent("backup-header"),
      installed = await edge.waitForEvent("installed");
    const writesUnderBackup = (async () => {
      for (let index = 0; index < 4; index += 1) {
        const appended = await fixture.centerRun({
          kind: "task-create",
          taskId: createPressure(),
          title: "write pressure",
        });
        assert.equal(appended.outcome, "applied", JSON.stringify(appended));
      }
    })();
    assert.equal(typeof header.position.revision, "number");
    assert.ok((header.position.revision as number) >= 1, "the backup must cover at least the seeded events");
    assert.equal(
      installed.position.revision,
      header.position.revision,
      "the installed mirror reports the package revision",
    );
    assert.equal(
      installed.position.sequence,
      header.position.sequence,
      "the installed mirror reports the package commit sequence",
    );
    // The mirror ledger at install time already holds exactly the packaged event revisions —
    // a whole-file backup, not a rebuild that would converge only after replay.
    const mirrorLedger = new DatabaseSync(String(installed.ledgerPath), { readOnly: true });
    try {
      mirrorLedger.exec("PRAGMA busy_timeout=5000");
      const row = mirrorLedger.prepare("SELECT COALESCE(MAX(revision), 0) AS head FROM event").get() as {
        head: number;
      };
      assert.equal(row.head, header.position.revision, "mirror ledger head equals the frozen N");
      assert.equal(
        (mirrorLedger.prepare("SELECT COUNT(*) AS rows_ FROM command_outcome").get() as { rows_: number }).rows_ > 0,
        true,
        "the package carries committed outcomes, not only events",
      );
    } finally {
      mirrorLedger.close();
    }
    // First stream record after the backup starts past the backup position: no historical replay.
    const firstApplied = await edge.waitForEvent("applied");
    assert.ok(
      (firstApplied.position.sequence as number) > (installed.position.sequence as number),
      `stream resumed after the backup position (first=${firstApplied.position.sequence}, backup=${installed.position.sequence})`,
    );
    await writesUnderBackup;
  },
);

test(
  "a corrupted or truncated package is rejected whole and no generation becomes readable",
  { timeout: 120_000 },
  async (t) => {
    const fixture = await fleetReplicationFixture(t);
    const packageBytes = Buffer.alloc(4096, 7);
    const servePackage = (send: (frame: Record<string, unknown>) => void, corrupt: boolean, truncate: boolean) => {
      // The backup frame always tells the truth about the intended package; corruption and
      // truncation happen to the bytes on the wire, exactly the network/staging damage the
      // whole-archive digest exists to catch (the center's write boundary cannot see these).
      const sha256 = createHash("sha256").update(packageBytes).digest("hex");
      send({
        type: "replica.backup",
        metadata: {
          schema: "fleet-basebackup/v2",
          repoId: "replica-repo",
          position: { history: "h".repeat(16), sequence: 3, revision: 3 },
          ledgerGeneration: 1,
          projectionSchema: 1,
        },
        size: packageBytes.length,
        sha256,
      });
      const bytesToSend = truncate ? packageBytes.subarray(0, 1024) : corrupt ? Buffer.alloc(4096, 6) : packageBytes;
      for (let offset = 0; offset < bytesToSend.length; offset += 1024) {
        send({
          type: "replica.data",
          offset,
          data: bytesToSend.subarray(offset, offset + 1024).toString("base64"),
        });
      }
      send({ type: "replica.backup.end" });
    };
    for (const [label, corrupt, truncate] of [
      ["corrupted", true, false],
      ["truncated", false, true],
    ] as const) {
      const fake = await fakeReplicationCenter(t, fixture, (frame, send) => {
        if (frame.type === "replica.start") servePackage(send, corrupt, truncate);
      });
      const edge = fixture.startEdge("edge-one", { port: fake.port });
      const failure = await edge.waitForEvent("error");
      t.diagnostic(`${label} package rejection: ${JSON.stringify(failure)}`);
      const exit = await edge.exited;
      assert.equal(exit.code, 1, `${label} package must fail the receiver, not install`);
      assert.equal(edge.lastEvent("installed"), undefined, `${label} package must not become a readable generation`);
      // 待对齐: current 指针文件名按 replica-generation 落地核对;未发布暂存不是可读状态。
      assert.equal(existsSync(path.join(edge.mirrorRoot, "current")), false, `${label}: no current pointer published`);
      assert.equal(readdirSync(edge.mirrorRoot).length > 0, true, "staging evidence stays inside the mirror root");
    }
  },
);

test(
  "three edges share one package for the same N/S and the center keeps answering during transfer",
  { timeout: 180_000 },
  async (t) => {
    const fixture = await fleetReplicationFixture(t);
    await seedCenterData(fixture, seededTask);
    await fixture.openCenter();
    const edges = replicationNodes.map((nodeId) => fixture.startEdge(nodeId));
    const firstHeader = await edges[0]!.waitForEvent("backup-header");
    // While the first package is still in flight the center answers reads and accepts writes.
    const duringTransfer = await fixture.centerRun({
      kind: "task-create",
      taskId: createPressure(),
      title: "write pressure",
    });
    assert.equal(duringTransfer.outcome, "applied", JSON.stringify(duringTransfer));
    const headers = [
        firstHeader,
        await edges[1]!.waitForEvent("backup-header"),
        await edges[2]!.waitForEvent("backup-header"),
      ],
      installs = await Promise.all(edges.map((edge) => edge.waitForEvent("installed")));
    for (const header of headers.slice(1)) {
      assert.equal(header.sha256, firstHeader.sha256, "the same N/S ships the same package bytes");
      assert.equal(header.size, firstHeader.size);
      assert.equal(header.position.revision, firstHeader.position.revision);
      assert.equal(header.position.sequence, firstHeader.position.sequence);
    }
    for (const installed of installs) {
      assert.equal(installed.position.revision, firstHeader.position.revision);
      // The center projection and the installed mirror are the same schema and index set:
      // the shared reader identity the whole design stands on (C1 of dec_9284BD61).
      assert.deepEqual(sqliteObjects(String(installed.projectionPath)), sqliteObjects(fixture.centerReader().path));
      const plan = queryPlanRows(
        String(installed.projectionPath),
        "SELECT task_id FROM event_index WHERE task_id = ?",
        [seededTask.taskId],
      );
      assert.match(
        plan.map((row) => row.detail).join(" "),
        /USING (?:COVERING )?INDEX event_index_task_id/u,
        "task_id lookups ride the index instead of scanning event_index",
      );
      assert.equal(
        plan.some((row) => /SCAN event_index/u.test(row.detail)),
        false,
      );
    }
    // Convergence: every edge applies the in-flight write from above and reaches the ledger head.
    const headRevision = fixture.eventCount(),
      mirrorHead = (ledgerPath: string): number => {
        const db = new DatabaseSync(ledgerPath, { readOnly: true });
        try {
          db.exec("PRAGMA busy_timeout=5000");
          return (db.prepare("SELECT COALESCE(MAX(revision), 0) AS head FROM event").get() as { head: number }).head;
        } finally {
          db.close();
        }
      };
    await Promise.all(
      installs.map((installed, index) =>
        edges[index]!.waitForWhere(
          () => mirrorHead(String(installed.ledgerPath)) === headRevision,
          `mirror ledger to reach revision ${headRevision}`,
          60_000,
        ),
      ),
    );
  },
);
