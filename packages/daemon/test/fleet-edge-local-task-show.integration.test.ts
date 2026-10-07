// harness-test-tier: integration
import assert from "node:assert/strict";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fleetNodeClaimFixture } from "./fleet-node-claim.fixtures.ts";
import { fleetEdgeHostFixture } from "./fleet-edge-host.fixture.ts";
import { localAuthFixture } from "./fleet-tls-session.fixture.ts";
import { readEdgeRepository } from "../src/fleet-edge-task-read.ts";
import { runFleetReplicaPullClient } from "../src/fleet/edge.ts";
import { locateFleetMirrorView } from "../src/fleet-edge-mirror.ts";

const quota = 64 * 1024 * 1024;

test(
  "edge task show answers through the edge cell, field-identical with the center, and self-heals",
  { timeout: 180_000 },
  async (t) => {
    const f = await fleetNodeClaimFixture(t, undefined, undefined, undefined, undefined, true);
    assert.equal(
      (await f.command("center-node", { kind: "task-create", taskId: "show-1", title: "Shown locally" })).outcome,
      "applied",
    );
    assert.equal((await f.command("center-node", { kind: "task-start", taskId: "show-1" })).outcome, "applied");
    assert.equal(
      (await f.command("center-node", { kind: "task-progress-append", taskId: "show-1", text: "edge progress row" }))
        .outcome,
      "applied",
    );
    const e = await fleetEdgeHostFixture(t, f);
    const pull = () =>
      runFleetReplicaPullClient({ ...f.peer("node-one"), viewRoot: e.viewRoot, diskQuotaBytes: quota });
    const local = (taskId: string) => e.command({ kind: "task-show", taskId });
    const center = async (taskId: string) =>
      (await f.host.run("lease-repo", { kind: "task-show", taskId } as never, localAuthFixture())) as unknown as {
        readonly outcome: string;
        readonly code?: string;
        readonly evidence?: string;
      };
    const settle = async () => {
      const replica = f.host.replica("lease-repo");
      replica.activate();
      await replica.waitForCut(f.eventCount());
      await pull();
    };
    await settle();
    e.signIn("person-two");
    assert.equal((await local("show-1")).code, "authorization_denied");
    e.signIn("person-one");

    // 1. The edge answer is the center's answer, field by field, with the freshness envelope added.
    const edge = await local("show-1"),
      truth = await center("show-1");
    assert.equal(edge.ok, true, JSON.stringify(edge));
    assert.equal(edge.outcome, "applied");
    assert.deepEqual(JSON.parse(String(edge.evidence)), JSON.parse(String(truth.evidence)));
    assert.equal((edge.freshness as { state: string }).state, "fresh");
    assert.match(String(edge.summary), /freshness=fresh/u);
    const payload = JSON.parse(String(edge.evidence)) as {
      readonly task: { readonly title: string };
      readonly progress: readonly unknown[];
      readonly lease: unknown;
    };
    assert.equal(payload.task.title, "Shown locally");
    assert.ok(payload.progress.length >= 1, "the replicated progress table must carry the appended row");
    assert.ok(payload.lease, "the replicated lease table must carry the started task's lease");

    // 2. A task the center does not have is the center's not-found answer, not an empty success.
    const missingEdge = await local("show-missing"),
      missingTruth = await center("show-missing");
    assert.equal(missingEdge.ok, false);
    assert.equal(missingEdge.outcome, missingTruth.outcome);
    assert.equal(missingEdge.code, missingTruth.code);
    assert.ok(typeof missingEdge.code === "string" && missingEdge.code.length > 0, JSON.stringify(missingEdge));

    // 3. Past its age budget the answer is still given, marked stale.
    const confirmationPath = path.join(
      locateFleetMirrorView(e.viewRoot, "lease-repo")!.viewDir,
      "head-confirmation.json",
    );
    const confirmation = JSON.parse(readFileSync(confirmationPath, "utf8")) as { confirmedAt: number };
    writeFileSync(confirmationPath, JSON.stringify({ ...confirmation, confirmedAt: Date.now() - 5 * 60_000 }));
    const later = await local("show-1");
    assert.equal(later.ok, true);
    assert.equal((later.freshness as { state: string }).state, "stale");
    assert.match(String(later.warnings), /已 5 分钟未连中心/u);

    // 4. This edge's own write is visible to its next read: the read waits for the applied cut.
    const write = await e.command({ kind: "task-create", taskId: "show-2", title: "Written on the edge" });
    assert.equal(write.outcome, "applied", JSON.stringify(write));
    const waited = await local("show-2");
    assert.equal(waited.ok, true, JSON.stringify(waited));
    assert.ok((waited.cut as { revision: number }).revision >= (write.appliedCut as { revision: number }).revision);
    assert.match(String(waited.evidence), /Written on the edge/u);

    // 5. A damaged local model is rebuilt from the verified local cut.
    const view = locateFleetMirrorView(e.viewRoot, "lease-repo")!;
    rmSync(path.join(view.viewDir, "read-model.sqlite"), { force: true });
    rmSync(path.join(view.viewDir, "read-model.sqlite-wal"), { force: true });
    rmSync(path.join(view.viewDir, "read-model.sqlite-shm"), { force: true });
    assert.equal((await local("show-1")).ok, true);
    writeFileSync(path.join(view.viewDir, "read-model.sqlite"), "not a database");
    assert.equal((await local("show-1")).ok, true);

    // 6. With the center gone, the edge still answers with the center's last answer.
    const current = await center("show-1");
    const readSetTruth = await f.host.run(
      "lease-repo",
      { kind: "task-read-set", taskId: "show-1" } as never,
      localAuthFixture(),
    );
    const workTruth = await f.host.run(
      "lease-repo",
      { kind: "work-show", taskId: "show-1" } as never,
      localAuthFixture(),
    );
    await f.center.close();
    const work = await e.command({ kind: "work-show", taskId: "show-1" });
    assert.equal(work.outcome, "applied", JSON.stringify(work));
    assert.deepEqual(JSON.parse(String(work.evidence)), JSON.parse(String(workTruth.evidence)));
    assert.ok(work.cut, "work show must use the replica cut with the center disconnected");
    const readSet = await e.command({ kind: "task-read-set", taskId: "show-1" });
    assert.equal(readSet.outcome, "applied", JSON.stringify(readSet));
    assert.deepEqual(JSON.parse(String(readSet.evidence)), JSON.parse(String(readSetTruth.evidence)));
    assert.ok(readSet.cut, "task-read-set must be served from the replica cut");
    const offline = await local("show-1");
    assert.equal(offline.ok, true, JSON.stringify(offline));
    assert.deepEqual(JSON.parse(String(offline.evidence)), JSON.parse(String(current.evidence)));

    // 7. An edge that never pulled has no local answer and says so.
    const empty = await fleetEdgeHostFixture(t, f, { name: "edge-empty" });
    assert.equal((await empty.command({ kind: "task-show", taskId: "show-1" })).code, "LOCAL_UNAVAILABLE");
  },
);

test("an edge read that cannot reach its own write cut in time says so without reading", async () => {
  const answer = await readEdgeRepository(
    {
      viewRoot: "/nonexistent-edge-view",
      nodeId: "node-one",
      repoId: "lease-repo",
      minCut: { revision: 10, headDigest: `sha256:${"f".repeat(64)}` },
      writeReadWaitMs: 5,
      action: { kind: "task-show", taskId: "show-1" },
    },
    async () => {
      throw new Error("the minCut wait must not request the center");
    },
    async () => {
      throw new Error("a pending write must not be answered from an older cut");
    },
  );
  assert.equal(answer.code, "write_committed_read_pending");
  assert.equal(answer.outcome, "pending");
});
