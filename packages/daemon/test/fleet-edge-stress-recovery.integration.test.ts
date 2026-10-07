// harness-test-tier: integration
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fleetNodeClaimFixture } from "./fleet-node-claim.fixtures.ts";
import { fleetEdgeHostFixture } from "./fleet-edge-host.fixture.ts";
import { localAuthFixture } from "./fleet-tls-session.fixture.ts";
import { runFleetReplicaPullClient } from "../src/fleet/edge.ts";
import { locateFleetMirrorView } from "../src/fleet-edge-mirror.ts";
import { withEdgeReadModel } from "../src/fleet-edge-task-read.ts";

const quota = 64 * 1024 * 1024;

/**
 * Settle the center's cut store to the ledger head. The edge daemon is deliberately NOT started
 * here: its resident sync loop follows every new center cut, so retention and crash injections
 * must run against a daemon-less view before any host owns it.
 */
async function settledCenter(t: Parameters<typeof fleetNodeClaimFixture>[0], tasks: readonly string[]) {
  const f = await fleetNodeClaimFixture(t, undefined, undefined, undefined, undefined, true);
  for (const taskId of tasks)
    assert.equal(
      (await f.command("center-node", { kind: "task-create", taskId, title: `Stress ${taskId}` })).outcome,
      "applied",
    );
  const replica = f.host.replica("lease-repo");
  replica.activate();
  await replica.waitForCut(f.eventCount());
  const pull = (viewRoot: string, extra: Record<string, unknown> = {}) =>
    runFleetReplicaPullClient({ ...f.peer("node-one"), viewRoot, diskQuotaBytes: quota, ...extra });
  return { f, pull };
}

/** The daemon-free read face: the same kernel query body the edge cell answers through. */
function localRowCounts(viewRoot: string): number {
  return withEdgeReadModel(
    { viewRoot, repoId: "lease-repo", nodeId: "node-one", principalId: "person-one" },
    (projection) => projection.list().rows.length,
  );
}

test(
  "an edge past the center's cut retention window is rebuilt by snapshot and answers locally",
  { timeout: 300_000 },
  async (t) => {
    const { f, pull } = await settledCenter(t, ["keep-0", "keep-1", "keep-2"]);
    const viewRoot = path.join(f.root, "retention-view");
    await pull(viewRoot);
    const behindAt = f.eventCount();
    assert.equal(localRowCounts(viewRoot), 3);

    // Push the center past its 64-cut retention so the edge's acked cut is no longer addressable.
    let created = 3,
      lastId = "keep-2";
    for (let guard = 0; f.eventCount() < behindAt + 70 && guard < 60; guard += 1) {
      lastId = `flood-${guard}`;
      assert.equal(
        (await f.command("center-node", { kind: "task-create", taskId: lastId, title: `Flood ${guard}` })).outcome,
        "applied",
      );
      created += 1;
    }
    assert.ok(f.eventCount() >= behindAt + 70, "the center must advance past the retained cut window");
    const replica = f.host.replica("lease-repo");
    replica.activate();
    await replica.waitForCut(f.eventCount());
    assert.equal(
      f.center.status().replicas.find((row) => row.viewId === "node-one")?.delivery,
      "snapshot_required",
      "the center must have demoted this edge beyond delta retention",
    );

    const schemas: string[] = [];
    await pull(viewRoot, { onFrame: (frame: { schema: string }) => schemas.push(frame.schema) });
    assert.equal(schemas.includes("fleet.snapshot.begin/v1"), true, JSON.stringify(schemas));
    assert.equal(schemas.includes("fleet.delta.begin/v1"), false, JSON.stringify(schemas));

    // The real daemon entry answers the rebuilt view end to end.
    const e = await fleetEdgeHostFixture(t, f, { viewRoot });
    const answer = await e.command({ kind: "task-list" });
    assert.equal(answer.ok, true, JSON.stringify(answer));
    assert.equal((answer.rows as unknown[]).length, created);
    assert.ok(
      (answer.rows as { taskId: string }[]).some((row) => row.taskId === lastId),
      "the newest center task is present after the snapshot rebuild",
    );
    assert.equal((answer.freshness as { state: string }).state, "fresh");
    const doctor = (await e.host.run("lease-repo", { kind: "doctor-health" }, localAuthFixture())) as unknown as Record<
      string,
      unknown
    >;
    assert.equal(doctor.rebuildCount, 0, "a snapshot catch-up is ordinary sync, not a model rebuild");
  },
);

test(
  "a damaged WAL and a destroyed read-model database self-heal with the rebuild counted",
  { timeout: 180_000 },
  async (t) => {
    const { f, pull } = await settledCenter(t, ["wal-0", "wal-1", "wal-2"]);
    const viewRoot = path.join(f.root, "wal-view");
    await pull(viewRoot);
    const e = await fleetEdgeHostFixture(t, f, { viewRoot });
    const local = (action: Record<string, unknown> = { kind: "task-list" }) => e.command(action);
    const healthy = await local();
    assert.equal(healthy.ok, true, JSON.stringify(healthy));
    assert.equal((healthy.rows as unknown[]).length, 3);
    const viewDir = locateFleetMirrorView(e.viewRoot, "lease-repo")!.viewDir;
    const doctor = async () =>
      (await e.host.run("lease-repo", { kind: "doctor-health" }, localAuthFixture())) as unknown as Record<
        string,
        unknown
      >;
    assert.equal((await doctor()).rebuildCount, 0);

    // 1. WAL damage alone cannot change an answer: committed rows live in the checkpointed main file,
    //    and frames that fail their checksums are discarded rather than trusted.
    writeFileSync(path.join(viewDir, "read-model.sqlite-wal"), "garbage write-ahead frames");
    writeFileSync(path.join(viewDir, "read-model.sqlite-shm"), "garbage shared memory index");
    const walDamaged = await local();
    assert.equal(walDamaged.ok, true, JSON.stringify(walDamaged));
    assert.equal((walDamaged.rows as unknown[]).length, 3);
    assert.equal((walDamaged.freshness as { state: string }).state, "fresh");
    assert.equal((await doctor()).rebuildCount, 0, "a discarded WAL is not a rebuild");

    // 2. A destroyed main database is deleted and rebuilt from the verified local cut.
    writeFileSync(path.join(viewDir, "read-model.sqlite"), "not a database");
    const rebuilt = await local();
    assert.equal(rebuilt.ok, true, JSON.stringify(rebuilt));
    assert.equal((rebuilt.rows as unknown[]).length, 3);
    assert.equal((rebuilt.freshness as { state: string }).state, "fresh");
    const observed = await doctor();
    assert.equal(observed.rebuildCount, 1, JSON.stringify(observed));
    assert.equal(observed.failureCode, null, "a successful rebuild clears the failure observation");
  },
);

test(
  "a materializer crash mid-pull leaves the last published cut answering and the replay pull recovers",
  { timeout: 180_000 },
  async (t) => {
    const { f, pull } = await settledCenter(t, ["crash-0", "crash-1", "crash-2"]);
    const viewRoot = path.join(f.root, "crash-view");
    await pull(viewRoot);
    assert.equal(localRowCounts(viewRoot), 3);
    const create = async (taskId: string) => {
      assert.equal(
        (await f.command("center-node", { kind: "task-create", taskId, title: `Crash ${taskId}` })).outcome,
        "applied",
      );
      const replica = f.host.replica("lease-repo");
      replica.activate();
      await replica.waitForCut(f.eventCount());
    };
    const crashPull = (point: "after_page" | "before_current_rename") =>
      runFleetReplicaPullClient({
        ...f.peer("node-one"),
        viewRoot,
        diskQuotaBytes: quota,
        edgeKillpoint: (observed) => {
          if (observed === point) throw new Error(`simulated materializer crash ${point}`);
        },
      });

    // 1. Crash while pages are still arriving: staging is durable, current is untouched.
    await create("crash-3");
    await assert.rejects(crashPull("after_page"), /simulated materializer crash after_page/u);
    assert.equal(localRowCounts(viewRoot), 3, "the previous cut keeps answering");
    await pull(viewRoot);
    assert.equal(localRowCounts(viewRoot), 4);

    // 2. Crash after the result cut exists but before the current pointer moves.
    await create("crash-4");
    await assert.rejects(crashPull("before_current_rename"), /simulated materializer crash before_current_rename/u);
    assert.equal(localRowCounts(viewRoot), 4, "an unpublished cut is never answered");
    await pull(viewRoot);
    assert.equal(localRowCounts(viewRoot), 5);

    // The real daemon entry answers the recovered view end to end.
    const e = await fleetEdgeHostFixture(t, f, { viewRoot });
    const answer = await e.command({ kind: "task-list" });
    assert.equal(answer.ok, true, JSON.stringify(answer));
    assert.equal((answer.rows as unknown[]).length, 5);
    assert.equal((answer.freshness as { state: string }).state, "fresh");
    const doctor = (await e.host.run("lease-repo", { kind: "doctor-health" }, localAuthFixture())) as unknown as Record<
      string,
      unknown
    >;
    assert.equal(doctor.failureCode, null, "the recovering pull clears the crash observation");
  },
);

test("edge-local task list reads hold a measured p95 within the stress budget", { timeout: 240_000 }, async (t) => {
  const tasks = Array.from({ length: 12 }, (_value, index) => `p95-${index}`);
  const { f, pull } = await settledCenter(t, tasks);
  const viewRoot = path.join(f.root, "p95-view");
  await pull(viewRoot);
  const e = await fleetEdgeHostFixture(t, f, { viewRoot });
  const local = () => e.command({ kind: "task-list" });
  // The first read pays any pending model build; measure the steady answering path afterwards.
  const warm = await local();
  assert.equal(warm.ok, true, JSON.stringify(warm));
  assert.equal((warm.rows as unknown[]).length, tasks.length);
  const samples: number[] = [];
  for (let index = 0; index < 200; index += 1) {
    const started = performance.now();
    const answer = await local();
    const elapsed = performance.now() - started;
    assert.equal(answer.ok, true, JSON.stringify(answer));
    assert.equal((answer.rows as unknown[]).length, tasks.length);
    samples.push(elapsed);
  }
  const percentile = (fraction: number) => {
    const ordered = [...samples].sort((left, right) => left - right);
    return ordered[Math.min(ordered.length - 1, Math.ceil(fraction * ordered.length) - 1)]!;
  };
  const report = {
    samples: samples.length,
    p50Ms: Math.round(percentile(0.5) * 10) / 10,
    p95Ms: Math.round(percentile(0.95) * 10) / 10,
    p99Ms: Math.round(percentile(0.99) * 10) / 10,
    maxMs: Math.round(Math.max(...samples) * 10) / 10,
  };
  t.diagnostic(`edge local read latency: ${JSON.stringify(report)}`);
  assert.ok(report.p95Ms < 500, `p95 ${report.p95Ms}ms exceeded the 500ms stress budget`);
});
