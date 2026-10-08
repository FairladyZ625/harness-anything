// harness-test-tier: integration
import assert from "node:assert/strict";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fleetNodeClaimFixture } from "./fleet-node-claim.fixtures.ts";
import { fleetEdgeHostFixture } from "./fleet-edge-host.fixture.ts";
import { localAuthFixture } from "./fleet-tls-session.fixture.ts";
import { runFleetReplicaPullClient } from "../src/fleet/edge.ts";
import { READ_MODEL_SCHEMA_GENERATION } from "@harness-anything/kernel";
import { managedRbacSessionStore } from "../src/managed-rbac-service.ts";
import { locateFleetMirrorView } from "../src/fleet-edge-mirror.ts";

const quota = 64 * 1024 * 1024;

test(
  "edge task list answers through the edge cell with center-identical rows, reports freshness, and self-heals",
  { timeout: 180_000 },
  async (t) => {
    const f = await fleetNodeClaimFixture(t, undefined, undefined, undefined, undefined, true);
    for (let index = 0; index < 3; index += 1)
      assert.equal(
        (await f.command("center-node", { kind: "task-create", taskId: `local-${index}`, title: `Local ${index}` }))
          .outcome,
        "applied",
      );
    const e = await fleetEdgeHostFixture(t, f);
    const pull = () =>
      runFleetReplicaPullClient({ ...f.peer("node-one"), viewRoot: e.viewRoot, diskQuotaBytes: quota });
    const local = (action: Record<string, unknown> = { kind: "task-list" }) => e.command(action);
    const center = async (action: Record<string, unknown> = { kind: "task-list" }) =>
      (await f.host.run("lease-repo", action as never, localAuthFixture())) as unknown as Record<string, unknown>;
    // The center publishes the read model with the cut it describes: wait for the cut at the ledger
    // head, then one pull carries every task.
    const settle = async (count: number) => {
      const replica = f.host.replica("lease-repo");
      replica.activate();
      await replica.waitForCut(f.eventCount());
      await pull();
      assert.equal(locateFleetMirrorView(e.viewRoot, "lease-repo")?.schemaGeneration, READ_MODEL_SCHEMA_GENERATION);
      const answer = await local();
      assert.equal(answer.ok, true, JSON.stringify(answer));
      assert.equal((answer.rows as unknown[]).length, count, JSON.stringify(answer.rows));
      return answer;
    };

    // 1. Only the replica's authorized owner reads it.
    await settle(3);
    e.signIn("person-two");
    assert.equal((await local()).code, "authorization_denied");
    e.signIn("person-one");
    const currentPath = path.join(locateFleetMirrorView(e.viewRoot, "lease-repo")!.viewDir, "current.json");
    const currentWithoutAuthorization = JSON.parse(readFileSync(currentPath, "utf8")) as Record<string, unknown>;
    delete currentWithoutAuthorization.authorizationOwner;
    delete currentWithoutAuthorization.authorizationShapeDigest;
    writeFileSync(currentPath, JSON.stringify(currentWithoutAuthorization));
    assert.equal((await local()).code, "authorization_denied", "a view without authorization metadata is not readable");
    await pull();

    // 2. Past its age budget the answer is still given, marked stale; a pull is a fresh head confirmation.
    const confirmationPath = path.join(
      locateFleetMirrorView(e.viewRoot, "lease-repo")!.viewDir,
      "head-confirmation.json",
    );
    const confirmation = JSON.parse(readFileSync(confirmationPath, "utf8")) as { confirmedAt: number };
    writeFileSync(confirmationPath, JSON.stringify({ ...confirmation, confirmedAt: Date.now() - 5 * 60_000 }));
    const later = await local();
    assert.equal(later.ok, true, JSON.stringify(later));
    assert.equal((later.rows as unknown[]).length, 3);
    assert.equal((later.freshness as { state: string }).state, "stale");
    assert.match(String(later.warnings), /已 5 分钟未连中心/u);
    assert.match(String(later.summary), /已 5 分钟未连中心/u);
    await pull();
    assert.equal(((await local()).freshness as { state: string }).state, "fresh");

    // 3. A new center task arrives with the next pull.
    assert.equal(
      (await f.command("center-node", { kind: "task-create", taskId: "local-3", title: "Local 3" })).outcome,
      "applied",
    );
    await settle(4);

    // 4. A deleted or damaged local model is rebuilt from the verified local cut.
    const view = locateFleetMirrorView(e.viewRoot, "lease-repo")!;
    rmSync(path.join(view.viewDir, "read-model.sqlite"), { force: true });
    assert.equal(((await local()).rows as unknown[]).length, 4);
    writeFileSync(path.join(view.viewDir, "read-model.sqlite"), "not a database");
    rmSync(path.join(view.viewDir, "read-model.sqlite-wal"), { force: true });
    rmSync(path.join(view.viewDir, "read-model.sqlite-shm"), { force: true });
    assert.equal(((await local()).rows as unknown[]).length, 4);

    // 5. With the center gone, local answers stay the center's answers for filters and paging.
    const actions = [
      { kind: "task-list" },
      { kind: "task-list", search: "local 1" },
      { kind: "task-list", limit: 2 },
      { kind: "task-list", status: "planned" },
    ];
    const truths = await Promise.all(actions.map((action) => center(action)));
    const workActions = [{ kind: "work-list" }, { kind: "work-list", all: true }];
    const workTruths = await Promise.all(workActions.map((action) => center(action)));
    await f.center.close();
    for (const [index, action] of actions.entries()) {
      const edge = await local(action),
        truth = truths[index]!;
      assert.equal(edge.ok, true, JSON.stringify(edge));
      assert.deepEqual(edge.rows, truth.rows, JSON.stringify(action));
      assert.deepEqual(edge.page ?? null, truth.page ?? null, JSON.stringify(action));
      assert.equal((edge.freshness as { state: string }).state, "fresh");
      for (const row of edge.rows as readonly { taskId: string }[])
        assert.match(String(edge.summary), new RegExp(row.taskId, "u"));
      assert.match(String(edge.summary), /freshness=fresh/u);
    }
    assert.equal((await local({ kind: "task-list", depth: 0 })).code, "invalid_command");
    for (const [index, action] of workActions.entries()) {
      const edge = await local(action);
      assert.equal(edge.ok, true, JSON.stringify(edge));
      assert.deepEqual(JSON.parse(String(edge.evidence)), JSON.parse(String(workTruths[index]!.evidence)));
    }

    // 6. An edge that never pulled has no local answer and says so instead of returning an empty list.
    const empty = await fleetEdgeHostFixture(t, f, { name: "edge-empty" });
    assert.equal((await empty.command({ kind: "task-list" })).code, "LOCAL_UNAVAILABLE");
  },
);

test(
  "edge task list waits locally for this edge's write cut and times out without returning an older answer",
  { timeout: 180_000 },
  async (t) => {
    const f = await fleetNodeClaimFixture(t, undefined, undefined, undefined, undefined, true);
    await f.command("center-node", { kind: "task-create", taskId: "write-read-base", title: "Base" });
    const e = await fleetEdgeHostFixture(t, f);
    const base = f.host.replica("lease-repo");
    base.activate();
    await base.waitForCut(f.eventCount());
    await runFleetReplicaPullClient({ ...f.peer("node-one"), viewRoot: e.viewRoot, diskQuotaBytes: quota });
    const written = await e.command({ kind: "task-create", taskId: "independent-write", title: "Independent write" });
    assert.equal(written.outcome, "applied", JSON.stringify(written));
    assert.ok(written.appliedCut);
    const read = await e.command({ kind: "task-list" });
    assert.equal(read.ok, true, JSON.stringify(read));
    assert.ok((read.cut as { revision: number }).revision >= (written.appliedCut as { revision: number }).revision);
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
  const edgeOne = await fleetEdgeHostFixture(t, f, { name: "edge-one", viewRoot: first }),
    edgeTwo = await fleetEdgeHostFixture(t, f, {
      name: "edge-two",
      viewRoot: second,
      personId: "person-two",
      nodeId: "node-two",
    });
  assert.equal((await edgeOne.command({ kind: "task-list" })).code, "authorization_denied");
  const allowedTwo = await edgeTwo.command({ kind: "task-list" });
  assert.equal(allowedTwo.ok, true, JSON.stringify(allowedTwo));
});

test(
  "expired edge token reads stale locally when center and Keycloak are unreachable; rejection ends the session",
  { timeout: 180_000 },
  async (t) => {
    const f = await fleetNodeClaimFixture(t, undefined, undefined, undefined, undefined, true);
    await f.command("center-node", { kind: "task-create", taskId: "offline-token", title: "Offline token" });
    let rejected = false;
    const e = await fleetEdgeHostFixture(t, f, {
      oidcPorts: {
        fetch: (async () => {
          if (rejected) return Response.json({ error: "invalid_grant" }, { status: 400 });
          throw new TypeError("Keycloak unreachable");
        }) as typeof fetch,
      },
    });
    const replica = f.host.replica("lease-repo");
    replica.activate();
    await replica.waitForCut(f.eventCount());
    await runFleetReplicaPullClient({ ...f.peer("node-one"), viewRoot: e.viewRoot, diskQuotaBytes: quota });
    const confirmationPath = path.join(
      locateFleetMirrorView(e.viewRoot, "lease-repo")!.viewDir,
      "head-confirmation.json",
    );
    const confirmation = JSON.parse(readFileSync(confirmationPath, "utf8"));
    writeFileSync(confirmationPath, JSON.stringify({ ...confirmation, confirmedAt: Date.now() - 300_000 }));
    const store = managedRbacSessionStore(e.edgeUser);
    const session = JSON.parse(store.read()!);
    store.write(JSON.stringify({ ...session, expiresAt: Date.now() - 1000 }));
    await f.center.close();
    const answer = await e.command({ kind: "task-list" });
    assert.equal(answer.outcome, "applied", JSON.stringify(answer));
    assert.equal((answer.freshness as { state: string }).state, "stale");
    assert.ok((answer.rows as { taskId: string }[]).some((row) => row.taskId === "offline-token"));
    const read = await e.host.read("lease-repo", "repo.tasks.list", {}, localAuthFixture());
    assert.equal((read.freshness as { state: string }).state, "stale");
    const write = await e.host.run(
      "lease-repo",
      { kind: "task-create", taskId: "closed-write", title: "Closed" } as never,
      localAuthFixture(),
    );
    assert.equal(write.code, "repo_mode_read_only");
    rejected = true;
    assert.equal((await e.command({ kind: "task-list" })).code, "authentication_required");
    assert.equal(store.read(), undefined);
    e.signIn("person-one");
    store.write(
      JSON.stringify({ ...JSON.parse(store.read()!), expiresAt: Date.now() - 1000, sessionExpiresAt: Date.now() - 1 }),
    );
    rejected = false;
    assert.equal((await e.command({ kind: "task-list" })).code, "authentication_required");
  },
);
