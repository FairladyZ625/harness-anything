// harness-test-tier: integration
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fleetNodeClaimFixture } from "./fleet-node-claim.fixtures.ts";
import { localAuthFixture } from "./fleet-tls-session.fixture.ts";
import { answerEdgeTaskShow } from "../src/fleet-edge-task-read.ts";
import { runFleetEdgeTask } from "../src/fleet-edge-task.ts";
import { runFleetReplicaPullClient } from "../src/fleet/edge.ts";
import { locateFleetMirrorView } from "../src/fleet-edge-mirror.ts";

const quota = 64 * 1024 * 1024;

test(
  "edge task show answers locally, field-identical with the center, and self-heals",
  { timeout: 180_000 },
  async (t) => {
    const f = await fleetNodeClaimFixture(t, undefined, undefined, undefined, undefined, true);
    assert.equal(
      (await f.command("center-node", { kind: "task-create", taskId: "show-1", title: "Shown locally" })).outcome,
      "applied",
    );
    assert.equal((await f.command("center-node", { kind: "task-start", taskId: "show-1" })).outcome, "applied");
    assert.equal(
      (
        await f.command("center-node", {
          kind: "task-progress-append",
          taskId: "show-1",
          text: "edge progress row",
        })
      ).outcome,
      "applied",
    );
    const viewRoot = path.join(f.root, "view");
    let pulls = 0;
    const pull = async () => {
      pulls += 1;
      return runFleetReplicaPullClient({ ...f.peer("node-one"), viewRoot, diskQuotaBytes: quota });
    };
    const local = (taskId: string, now?: () => number) =>
      answerEdgeTaskShow({ viewRoot, repoId: "lease-repo", action: { kind: "task-show", taskId } }, pull, now);
    const center = async (taskId: string) =>
      (await f.host.run("lease-repo", { kind: "task-show", taskId } as never, localAuthFixture())) as unknown as {
        readonly outcome: string;
        readonly code?: string;
        readonly evidence?: string;
        readonly summary?: string;
      };
    // The center publishes the read model with the cut it describes: wait for the cut at the ledger
    // head, then one pull carries every table the answer reads.
    const settle = async () => {
      const replica = f.host.replica("lease-repo");
      replica.activate();
      await replica.waitForCut(f.eventCount());
      await pull();
    };
    await settle();

    // 1. The edge answer is the center's answer, field by field, with the freshness envelope added.
    pulls = 0;
    const edge = await local("show-1"),
      truth = await center("show-1");
    assert.equal(edge.ok, true, JSON.stringify(edge));
    assert.equal(edge.outcome, "applied");
    assert.deepEqual(
      JSON.parse(String(edge.evidence)),
      JSON.parse(String(truth.evidence)),
      JSON.stringify(edge.evidence),
    );
    assert.equal((edge.freshness as { state: string }).state, "fresh");
    assert.match(String(edge.summary), /freshness=fresh/u);
    const payload = JSON.parse(String(edge.evidence)) as {
      readonly task: { readonly status: string; readonly title: string };
      readonly progress: readonly unknown[];
      readonly lease: unknown;
    };
    assert.equal(payload.task.title, "Shown locally");
    assert.ok(payload.progress.length >= 1, "the replicated progress table must carry the appended row");
    assert.ok(payload.lease, "the replicated lease table must carry the started task's lease");
    assert.equal(pulls, 0, "a local answer must not touch the center");

    // 2. A task the center does not have is the center's not-found answer, not an empty success.
    const missingEdge = await local("show-missing"),
      missingTruth = await center("show-missing");
    assert.equal(missingEdge.ok, false);
    assert.equal(missingEdge.outcome, missingTruth.outcome);
    assert.equal(missingEdge.code, missingTruth.code);
    assert.ok(typeof missingEdge.code === "string" && missingEdge.code.length > 0, JSON.stringify(missingEdge));

    // 3. Past its age budget the answer is still given, marked stale.
    const later = await local("show-1", () => Date.now() + 5 * 60_000);
    assert.equal(later.ok, true);
    assert.equal((later.freshness as { state: string }).state, "stale");
    assert.match(String(later.warning), /已 5 分钟未连中心/u);
    assert.equal((later.freshness as { state: string }).state, "stale");

    // 4. A new progress row arrives with the next pull.
    assert.equal(
      (
        await f.command("center-node", {
          kind: "task-progress-append",
          taskId: "show-1",
          text: "second edge progress row",
        })
      ).outcome,
      "applied",
    );
    const before = (await local("show-1")).evidence;
    await settle();
    assert.notEqual((await local("show-1")).evidence, before, "the pulled model must reflect the new row");
    const current = await center("show-1");
    assert.equal(current.outcome, "applied");
    assert.deepEqual(JSON.parse(String((await local("show-1")).evidence)), JSON.parse(String(current.evidence)));

    // 5. A damaged local model is rebuilt from the verified local cut without the center.
    const view = locateFleetMirrorView(viewRoot, "lease-repo")!;
    pulls = 0;
    rmSync(path.join(view.viewDir, "read-model.sqlite"), { force: true });
    rmSync(path.join(view.viewDir, "read-model.sqlite-wal"), { force: true });
    rmSync(path.join(view.viewDir, "read-model.sqlite-shm"), { force: true });
    assert.equal((await local("show-1")).ok, true);
    writeFileSync(path.join(view.viewDir, "read-model.sqlite"), "not a database");
    rmSync(path.join(view.viewDir, "read-model.sqlite-wal"), { force: true });
    rmSync(path.join(view.viewDir, "read-model.sqlite-shm"), { force: true });
    const healed = await local("show-1");
    assert.equal(healed.ok, true, JSON.stringify(healed));
    assert.equal(pulls, 0, "self-heal from the local cut must not touch the center");

    // 6. With the center gone, the real edge route still answers locally.
    await f.center.close();
    const offline = await runFleetEdgeTask({
      payload: {
        ...f.peer("node-one"),
        host: "localhost",
        caPath: path.join(f.root, "tls.crt"),
        viewRoot,
        quotaBytes: quota,
        action: { kind: "task-show", taskId: "show-1" },
      },
    });
    assert.equal(offline.ok, true, JSON.stringify(offline));
    assert.deepEqual(JSON.parse(String(offline.evidence)), JSON.parse(String(current.evidence)));

    // 7. An edge that never pulled has no local answer and says so.
    const emptyRoot = mkdtempSync(path.join(tmpdir(), "ha-edge-empty-"));
    t.after(() => rmSync(emptyRoot, { recursive: true, force: true }));
    const unavailable = await answerEdgeTaskShow(
      { viewRoot: emptyRoot, repoId: "lease-repo", action: { kind: "task-show", taskId: "show-1" } },
      () => runFleetReplicaPullClient({ ...f.peer("node-one"), viewRoot: emptyRoot, diskQuotaBytes: quota }),
    );
    assert.equal(unavailable.code, "LOCAL_UNAVAILABLE");
  },
);
