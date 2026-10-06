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
      answerEdgeTaskList({ viewRoot, repoId: "lease-repo", principalId: "person-one", action, ...budgets }, pull, now);
    const center = async (action: Record<string, unknown> = { kind: "task-list" }) =>
      (await f.host.run("lease-repo", action as never, localAuthFixture())) as unknown as Record<string, unknown>;
    // The center publishes the read model with the cut it describes: wait for the cut at the ledger
    // head, then one pull carries every task. The cut source builds only once activated, as the
    // center does when it first serves a replica request.
    const settle = async (count: number) => {
      const replica = f.host.replica("lease-repo");
      replica.activate();
      await replica.waitForCut(f.eventCount());
      await pull();
      const answer = await local();
      assert.equal(answer.ok, true, JSON.stringify(answer));
      assert.equal((answer.rows as unknown[]).length, count, JSON.stringify(answer.rows));
      return answer;
    };

    // 1. Local answers are the center's answers, for the default page and for filters and paging.
    await settle(3);
    const nonOwner = await answerEdgeTaskList(
      { viewRoot, repoId: "lease-repo", principalId: "person-two", action: { kind: "task-list" } },
      async () => {
        throw new Error("non-owner local read must not pull");
      },
    );
    assert.equal(nonOwner.code, "authorization_denied", JSON.stringify(nonOwner));
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
      // The CLI prints `summary` for a human: it carries the rows, as the center's receipt does.
      for (const row of edge.rows as readonly { taskId: string }[])
        assert.match(String(edge.summary), new RegExp(row.taskId, "u"));
      assert.match(String(edge.summary), /freshness=fresh/u);
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
    assert.match(String(later.summary), /已 5 分钟未连中心/u);
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
    rmSync(path.join(view.viewDir, "read-model.sqlite"), { force: true });
    assert.equal(((await local()).rows as unknown[]).length, 4);
    writeFileSync(path.join(view.viewDir, "read-model.sqlite"), "not a database");
    rmSync(path.join(view.viewDir, "read-model.sqlite-wal"), { force: true });
    rmSync(path.join(view.viewDir, "read-model.sqlite-shm"), { force: true });
    assert.equal(((await local()).rows as unknown[]).length, 4);
    assert.equal(pulls, 0, "self-heal from the local cut must not touch the center");

    // 5. With the center gone, the real edge route still answers locally.
    await f.center.close();
    const offline = await runFleetEdgeTask({
      payload: {
        ...f.peer("node-one"),
        principalId: "person-one",
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

test(
  "edge task list waits locally for concurrent write cuts and times out without returning an older answer",
  { timeout: 180_000 },
  async (t) => {
    const f = await fleetNodeClaimFixture(t, undefined, undefined, undefined, undefined, true),
      viewRoot = path.join(f.root, "view");
    await f.command("center-node", { kind: "task-create", taskId: "write-read-base", title: "Base" });
    const pull = () => runFleetReplicaPullClient({ ...f.peer("node-one"), viewRoot, diskQuotaBytes: quota });
    const base = f.host.replica("lease-repo");
    base.activate();
    await base.waitForCut(f.eventCount());
    await pull();

    const writes = await Promise.all([
      f.command("center-node", { kind: "task-create", taskId: "write-read-one", title: "First concurrent write" }),
      f.command("node-two", { kind: "task-create", taskId: "write-read-two", title: "Second concurrent write" }),
    ]);
    const appliedCuts = writes.map((write) => write.appliedCut);
    assert.ok(
      appliedCuts.every(
        (cut) => cut && Number.isSafeInteger(cut.revision) && /^sha256:[0-9a-f]{64}$/u.test(cut.headDigest),
      ),
    );
    const target = appliedCuts.reduce((left, right) => (left!.revision > right!.revision ? left : right))!;
    let pulls = 0;
    const read = answerEdgeTaskList(
      { viewRoot, repoId: "lease-repo", principalId: "person-one", minCut: target, action: { kind: "task-list" } },
      async () => {
        pulls += 1;
        return pull();
      },
    );
    assert.equal(pulls, 0, "waiting is local and does not create a center request");
    await pull();
    const current = await read;
    assert.equal(current.ok, true, JSON.stringify(current));
    assert.ok((current.cut as { revision: number }).revision >= target.revision);
    assert.deepEqual(
      new Set((current.rows as { taskId: string }[]).map((row) => row.taskId)),
      new Set(["write-read-base", "write-read-one", "write-read-two"]),
    );

    const timedOut = await answerEdgeTaskList(
      {
        viewRoot,
        repoId: "lease-repo",
        principalId: "person-one",
        minCut: { revision: target.revision + 10, headDigest: `sha256:${"f".repeat(64)}` },
        writeReadWaitMs: 5,
        action: { kind: "task-list" },
      },
      async () => {
        throw new Error("minCut wait must not request the center");
      },
    );
    assert.equal(timedOut.code, "write_committed_read_pending");
    assert.equal(timedOut.outcome, "pending");
    const withoutMinCut = await answerEdgeTaskList(
      { viewRoot, repoId: "lease-repo", principalId: "person-one", action: { kind: "task-list" } },
      async () => {
        throw new Error("a usable local answer must not request the center");
      },
    );
    assert.equal(withoutMinCut.ok, true);
  },
);

test(
  "edge daemon remembers a write cut across independent write and read requests",
  { timeout: 180_000 },
  async (t) => {
    const f = await fleetNodeClaimFixture(t, undefined, undefined, undefined, undefined, true),
      viewRoot = path.join(f.root, "view"),
      edge = (action: Record<string, unknown>) =>
        runFleetEdgeTask({
          payload: {
            ...f.peer("node-one"),
            principalId: "person-one",
            host: "localhost",
            caPath: path.join(f.root, "tls.crt"),
            viewRoot,
            quotaBytes: quota,
            action: action as never,
          },
        });
    const written = await edge({ kind: "task-create", taskId: "independent-write", title: "Independent write" });
    assert.equal(written.outcome, "applied", JSON.stringify(written));
    assert.ok(written.appliedCut);
    const read = await edge({ kind: "task-list" });
    assert.equal(read.ok, true, JSON.stringify(read));
    assert.ok((read.rows as { taskId: string }[]).some((row) => row.taskId === "independent-write"));
  },
);

test("same repository pulls keep per-node authorization metadata independent", { timeout: 180_000 }, async (t) => {
  const f = await fleetNodeClaimFixture(t, undefined, undefined, undefined, undefined, true);
  f.owners.reassign("node-two", "person-two");
  await f.command("center-node", { kind: "task-create", taskId: "dual-owner", title: "Dual owner" });
  const first = path.join(f.root, "view-one"),
    second = path.join(f.root, "view-two");
  await runFleetReplicaPullClient({ ...f.peer("node-one"), viewRoot: first, diskQuotaBytes: quota });
  await runFleetReplicaPullClient({ ...f.peer("node-two"), viewRoot: second, diskQuotaBytes: quota });
  const one = locateFleetMirrorView(first, "lease-repo")!,
    two = locateFleetMirrorView(second, "lease-repo")!;
  assert.equal(one.authorizationOwner, "person-one");
  assert.equal(two.authorizationOwner, "person-two");
  assert.notEqual(one.authorizationShapeDigest, two.authorizationShapeDigest);
  f.owners.keycloak.revoke("person-one", "lease-repo", ["repository-read"]);
  await assert.rejects(runFleetReplicaPullClient({ ...f.peer("node-one"), viewRoot: first, diskQuotaBytes: quota }), {
    code: "authorization_denied",
  });
  const deniedOne = await answerEdgeTaskList(
      { viewRoot: first, repoId: "lease-repo", principalId: "person-one", action: { kind: "task-list" } },
      async () => undefined,
    ),
    allowedTwo = await answerEdgeTaskList(
      { viewRoot: second, repoId: "lease-repo", principalId: "person-two", action: { kind: "task-list" } },
      async () => undefined,
    );
  assert.equal(deniedOne.code, "authorization_denied");
  assert.equal(allowedTwo.ok, true, JSON.stringify(allowedTwo));
});
