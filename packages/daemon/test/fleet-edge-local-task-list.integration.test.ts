// harness-test-tier: integration
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fleetNodeClaimFixture } from "./fleet-node-claim.fixtures.ts";
import { localAuthFixture } from "./fleet-tls-session.fixture.ts";
import { answerEdgeTaskList } from "../src/fleet-edge-task-read.ts";
import { runFleetEdgeTask } from "../src/fleet-edge-task.ts";
import { runFleetReplicaPullClient } from "../src/fleet/edge.ts";
import { locateFleetMirrorView } from "../src/fleet-edge-mirror.ts";

const quota = 64 * 1024 * 1024;

test(
  "edge task list answers locally with center-identical rows, reports freshness, and self-heals",
  { timeout: 180_000 },
  async (t) => {
    const f = await fleetNodeClaimFixture(t, undefined, undefined, undefined, undefined, true);
    for (let index = 0; index < 3; index += 1)
      assert.equal(
        (await f.command("center-node", { kind: "task-create", taskId: `local-${index}`, title: `Local ${index}` }))
          .outcome,
        "applied",
      );
    const viewRoot = path.join(f.root, "view");
    let pulls = 0;
    const pull = async () => {
      pulls += 1;
      return runFleetReplicaPullClient({ ...f.peer("node-one"), viewRoot, diskQuotaBytes: quota });
    };
    const local = (action: Record<string, unknown> = { kind: "task-list" }, now?: () => number, budgets = {}) =>
      answerEdgeTaskList({ viewRoot, repoId: "lease-repo", action, ...budgets }, pull, now);
    const center = async (action: Record<string, unknown> = { kind: "task-list" }) =>
      (await f.host.run("lease-repo", action as never, localAuthFixture())) as unknown as Record<string, unknown>;
    // The center's projection publishes the read model with the cut it describes; wait until the
    // pulled cut carries all three tasks.
    const settle = async (count: number) => {
      for (let attempt = 0; attempt < 100; attempt += 1) {
        await pull();
        const answer = await local();
        if (answer.ok === true && (answer.rows as unknown[]).length === count) return answer;
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      assert.fail(`edge read model never reached ${count} rows`);
    };

    // 1. Local answers are the center's answers, for the default page and for filters and paging.
    await settle(3);
    pulls = 0;
    for (const action of [
      { kind: "task-list" },
      { kind: "task-list", search: "local 1" },
      { kind: "task-list", limit: 2 },
      { kind: "task-list", status: "planned" },
    ]) {
      const edge = await local(action),
        truth = await center(action);
      assert.equal(edge.ok, true, JSON.stringify(edge));
      assert.deepEqual(edge.rows, truth.rows, JSON.stringify(action));
      assert.deepEqual(edge.page ?? null, truth.page ?? null, JSON.stringify(action));
      assert.equal((edge.freshness as { state: string }).state, "fresh");
    }
    assert.deepEqual(await local({ kind: "task-list", depth: 0 }), {
      schema: "command-receipt/v2",
      command: "task-list",
      ok: false,
      outcome: "op_rejected",
      code: "invalid_command",
      error: {
        code: "invalid_command",
        hint: "Task list depth must be a positive integer or all; use it with --parent <task-id>.",
      },
    });
    assert.equal(pulls, 0, "a local answer must not touch the center");

    // 2. Past its age budget the answer is still given, marked stale; a no-change pull is a fresh
    // head confirmation.
    const later = await local({ kind: "task-list" }, () => Date.now() + 5 * 60_000);
    assert.equal(later.ok, true);
    assert.equal((later.rows as unknown[]).length, 3);
    assert.equal((later.freshness as { state: string }).state, "stale");
    assert.match(String(later.warning), /已 5 分钟未连中心/u);
    assert.equal(
      ((await local({ kind: "task-list" }, () => Date.now() + 20, { maxAgeMs: 10 })).freshness as { state: string })
        .state,
      "stale",
      "a configured age budget applies",
    );
    await pull();
    assert.equal(((await local()).freshness as { state: string }).state, "fresh");

    // 3. A new center task arrives with the next pull, as one changed row.
    assert.equal(
      (await f.command("center-node", { kind: "task-create", taskId: "local-3", title: "Local 3" })).outcome,
      "applied",
    );
    assert.equal(((await local()).rows as unknown[]).length, 3, "the edge answers from its own cut until it pulls");
    await settle(4);
    assert.deepEqual((await local()).rows, (await center()).rows);

    // 4. A deleted or damaged local model is rebuilt from the verified local cut without the center.
    const view = locateFleetMirrorView(viewRoot, "lease-repo")!;
    pulls = 0;
    rmSync(path.join(view.viewDir, "tasks-read-model.sqlite"), { force: true });
    assert.equal(((await local()).rows as unknown[]).length, 4);
    writeFileSync(path.join(view.viewDir, "tasks-read-model.sqlite"), "not a database");
    rmSync(path.join(view.viewDir, "tasks-read-model.sqlite-wal"), { force: true });
    rmSync(path.join(view.viewDir, "tasks-read-model.sqlite-shm"), { force: true });
    assert.equal(((await local()).rows as unknown[]).length, 4);
    assert.equal(pulls, 0, "self-heal from the local cut must not touch the center");

    // 5. With the center gone, the real edge route still answers locally.
    await f.center.close();
    const offline = await runFleetEdgeTask({
      payload: {
        ...f.peer("node-one"),
        host: "localhost",
        caPath: path.join(f.root, "tls.crt"),
        viewRoot,
        quotaBytes: quota,
        action: { kind: "task-list" },
      },
    });
    assert.equal(offline.ok, true, JSON.stringify(offline));
    assert.equal((offline.rows as unknown[]).length, 4);

    // 6. An edge that never pulled has no local answer and says so instead of returning an empty list.
    const emptyRoot = mkdtempSync(path.join(tmpdir(), "ha-edge-empty-"));
    t.after(() => rmSync(emptyRoot, { recursive: true, force: true }));
    const unavailable = await answerEdgeTaskList(
      { viewRoot: emptyRoot, repoId: "lease-repo", action: { kind: "task-list" } },
      () => runFleetReplicaPullClient({ ...f.peer("node-one"), viewRoot: emptyRoot, diskQuotaBytes: quota }),
    );
    assert.equal(unavailable.code, "LOCAL_UNAVAILABLE");
  },
);
