// harness-test-tier: integration
import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { fleetNodeClaimFixture } from "./fleet-node-claim.fixtures.ts";
import { fleetEdgeHostFixture } from "./fleet-edge-host.fixture.ts";
import { catchUpReplica } from "./replica-catch-up.fixture.ts";

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
  const pull = (viewRoot: string, extra: Record<string, unknown> = {}) =>
    catchUpReplica({
      ...f.peer("node-one"),
      viewRoot,
      diskQuotaBytes: quota,
      ...extra,
    });
  return { f, pull };
}

// Cut-retention snapshots, read-model self-heal, and page killpoints were retired by
// dec_9284BD6119D453EEECEED62450. Generation publication/staging and WAL retention
// remain covered by replica-generation and fleet-replica-resident-stream integration tests.

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
