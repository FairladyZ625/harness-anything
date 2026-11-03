// harness-test-tier: integration
// dec_9284BD6119D453EEECEED62450 分片 C(测试先行): replica generation 的安装与生命周期。
// 覆盖:不支持 projection schema 返回版本错误且不反复下载同一个打不开的包;校验通过后、指针切换前
// 崩溃只留下旧完整代或无代(未发布暂存不是可读状态);旧 reader 持有句柄期间新代原子发布,旧代在
// reader 关闭后才回收。
// 待对齐: 见 fleet-replication.fixture.ts 文件头;generation 目录与 current 指针的布局名按
// replica-generation.ts 落地核对,本文件只经 installed 事件报告的路径观察,不硬编码布局。
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";
import test from "node:test";
import { makeTaskProjectionReader } from "@harness-anything/storage";

import {
  fakeReplicationCenter,
  fleetReplicationFixture,
  seedCenterData,
  waitForState,
} from "./fleet-replication.fixture.ts";

const seededTask = { taskId: "task_gen0000000000000000000001", executionId: "exe_gen", title: "Generations" };

test("an unsupported projection schema is a version error, not a download loop", { timeout: 120_000 }, async (t) => {
  const fixture = await fleetReplicationFixture(t);
  const packageBytes = Buffer.alloc(2048, 9),
    packageDigest = createHash("sha256").update(packageBytes).digest("hex");
  const fake = await fakeReplicationCenter(t, fixture, (frame, send) => {
    if (frame.type !== "replica.start") return;
    send({
      type: "replica.backup",
      metadata: {
        schema: "fleet-basebackup/v2",
        readerProfile: null,
        repoId: "replica-repo",
        position: { history: "h".repeat(16), sequence: 2, revision: 2 },
        ledgerGeneration: 1,
        // A schema the current shared reader cannot open: downloading it again cannot help.
        projectionSchema: 424_242,
      },
      size: packageBytes.length,
      sha256: packageDigest,
    });
    send({ type: "replica.data", offset: 0, data: packageBytes.toString("base64") });
    send({ type: "replica.backup.end" });
  });
  const edge = fixture.startEdge("edge-one", { port: fake.port });
  const failure = await edge.waitForEvent("error");
  t.diagnostic(`schema rejection: ${JSON.stringify(failure)}`);
  const exit = await edge.exited;
  assert.equal(exit.code, 1, "the receiver fails on the version error instead of installing");
  assert.equal(edge.lastEvent("installed"), undefined, "no readable generation was published");
  const counts = fake.counts();
  assert.equal(
    counts["replica.start"],
    1,
    "the same unopenable package is requested exactly once — no re-download loop",
  );
});

test(
  "a crash between package verification and pointer switch leaves no readable generation",
  { timeout: 180_000 },
  async (t) => {
    const fixture = await fleetReplicationFixture(t);
    await seedCenterData(fixture, seededTask);
    await fixture.openCenter();
    const edge = fixture.startEdge("edge-one", { killpoints: ["after-package-verified-before-install"] });
    const killpoint = await edge.waitForEvent("killpoint");
    assert.equal(killpoint.point, "after-package-verified-before-install");
    const exit = await edge.exited;
    assert.equal(exit.code, 76);
    assert.equal(edge.lastEvent("installed"), undefined, "the crash happened before any generation was published");
    // 待对齐: current 指针文件名按 replica-generation 落地核对;崩溃只可能留下旧完整代或无代。
    assert.equal(existsSync(path.join(edge.mirrorRoot, "current.json")), false, "no current pointer was published");
    // A crash may only leave the old complete generation or none; the restart converges normally.
    const resumed = fixture.startEdge("edge-one", { retry: true });
    const installed = await resumed.waitForEvent("installed", 60_000);
    assert.ok(typeof installed.projectionPath === "string" && existsSync(String(installed.projectionPath)));
  },
);

test(
  "an old reader keeps its generation while a new one publishes, and is recycled after close",
  { timeout: 240_000 },
  async (t) => {
    // 待对齐: retentionWindowCommits 拟名旋钮;第二次整包由超窗 resync 触发,与流测试同一机制。
    const fixture = await fleetReplicationFixture(t, { retentionWindowCommits: 2 });
    await seedCenterData(fixture, seededTask);
    await fixture.openCenter();
    const edge = fixture.startEdge("edge-one", { holdAcks: true, retry: true });
    const firstInstall = await edge.waitForEvent("installed");
    const firstGeneration = String(firstInstall.generationDir),
      firstProjection = String(firstInstall.projectionPath);
    // A reader pins the first generation for its whole lifetime. Pins live in the edge process that
    // collects generations, so this test-process reader registers its pin there.
    edge.control({ control: "acquire-reader" });
    const pinned = await edge.waitForEvent("reader-acquired");
    assert.equal(pinned.generationDir, firstGeneration, "the pin names the generation being read");
    const holdingReader = makeTaskProjectionReader({ rootDir: edge.root, projectionPath: firstProjection });
    const heldList = holdingReader.withSession((queries) => queries.list({}).rows.length);
    assert.ok(heldList > 0, "the held reader sees the seeded task rows");
    // Drive the node out of the window so a fresh package publishes a second generation.
    for (let index = 0; index < 6; index += 1) {
      const appended = await fixture.centerRun({
        kind: "task-create",
        taskId: `task_pressure${String(index).padStart(2, "0")}00000000000000000000`,
        title: `generation pressure ${index}`,
      });
      assert.equal(appended.outcome, "applied", JSON.stringify(appended));
    }
    edge.control({ control: "release-acks" });
    await edge.waitForEvent("resync-required", 60_000);
    // waitForEvent answers with the first matching event, which is the first install; wait for the second.
    await edge.waitForWhere(
      () => edge.events.filter((event) => event.event === "installed").length === 2,
      "a second installed generation",
      120_000,
    );
    const secondInstall = edge.lastEvent("installed")!;
    const secondGeneration = String(secondInstall.generationDir);
    assert.notEqual(secondGeneration, firstGeneration, "a new generation was published");
    assert.equal(existsSync(secondGeneration), true, "the new generation is durable before the pointer names it");
    assert.equal(existsSync(firstGeneration), true, "the pinned old generation survives the publish");
    // The holding reader still answers from the old generation, unaffected by the publish.
    assert.equal(
      holdingReader.withSession((queries) => queries.list({}).rows.length),
      heldList,
      "the pinned reader keeps its snapshot across the publish",
    );
    const switchedReader = makeTaskProjectionReader({
      rootDir: edge.root,
      projectionPath: String(secondInstall.projectionPath),
    });
    assert.ok(
      switchedReader.withSession((queries) => queries.list({}).rows.length) >= heldList,
      "the new generation carries at least the old rows",
    );
    // After the last reader of the old generation closes, the old directory is recycled.
    holdingReader.close();
    edge.control({ control: "release-reader" });
    await waitForState(() => !existsSync(firstGeneration), "the old generation directory to be recycled", 60_000);
    switchedReader.close();
  },
);
