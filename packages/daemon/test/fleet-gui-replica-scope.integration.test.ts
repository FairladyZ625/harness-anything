// harness-test-tier: integration
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import tls from "node:tls";
import { syncBuiltinESMExports } from "node:module";
import { fleetNodeClaimFixture } from "./fleet-node-claim.fixtures.ts";
import { fleetEdgeHostFixture } from "./fleet-edge-host.fixture.ts";
import { localAuthFixture } from "./fleet-tls-session.fixture.ts";
import { runFleetReplicaPullClient } from "../src/fleet/edge.ts";
import { locateFleetMirrorView } from "../src/fleet-edge-mirror.ts";

test(
  "GUI reads bind the configured node view and doc previews bind each edge workspace while offline",
  { timeout: 120_000 },
  async (t) => {
    const f = await fleetNodeClaimFixture(t, undefined, undefined, undefined, undefined, true),
      viewRoot = path.join(f.root, "shared-view-root"),
      quota = 64 * 1024 * 1024,
      created = await f.command("center-node", { kind: "task-create", taskId: "scope-task", title: "Own view" });
    assert.equal(created.outcome, "applied", JSON.stringify(created));
    const pull = async (nodeId: string) => {
      await f.host.replica("lease-repo").prepare();
      await f.host.replica("lease-repo").waitForCut(f.eventCount());
      await runFleetReplicaPullClient({ ...f.peer(nodeId), viewRoot, diskQuotaBytes: quota });
    };
    await pull("node-one");
    await f.command("center-node", { kind: "task-create", taskId: "newer-task", title: "Newer other view" });
    await pull("node-two");
    await f.center.close();
    const a = await fleetEdgeHostFixture(t, f, { name: "a", viewRoot, nodeId: "node-one" }),
      b = await fleetEdgeHostFixture(t, f, { name: "b", viewRoot, nodeId: "node-two" }),
      read = (edge: typeof a) => edge.host.read("lease-repo", "repo.tasks.list", {}, localAuthFixture()),
      connections = t.mock.method(tls, "connect");
    syncBuiltinESMExports();
    try {
      const older = await read(a),
        newer = await read(b);
      assert.deepEqual(
        older.rows.map((row) => row.taskId),
        ["scope-task"],
      );
      assert.deepEqual(
        newer.rows.map((row) => row.taskId),
        ["newer-task", "scope-task"],
      );
      assert.ok(older.cut!.revision < newer.cut!.revision);
      const row = older.rows[0]!,
        logical = `${row.packagePath}/task_plan.md`,
        canonical = await a.host.read(
          "lease-repo",
          "repo.tasks.document.read",
          { taskId: "scope-task", path: "task_plan.md" },
          localAuthFixture(),
        );
      for (const edge of [a, b]) {
        const target = path.join(edge.edgeRoot, "harness", logical);
        mkdirSync(path.dirname(target), { recursive: true });
        writeFileSync(target, canonical.body);
      }
      const aPath = path.join(a.edgeRoot, "harness", logical);
      for (const state of ["clean", "eligible", "deletion"]) {
        if (state === "eligible") writeFileSync(aPath, "# Changed only in A\n");
        if (state === "deletion") rmSync(aPath);
        for (const kind of ["doc-status", "doc-dry-run"]) {
          const result = await a.command({ kind, paths: [logical] });
          assert.equal(result.ok, true, JSON.stringify(result));
          assert.deepEqual(
            (result.rows as { state: string }[]).map(({ state }) => state),
            [state],
          );
          assert.equal((result.cut as { revision: number }).revision, older.cut!.revision);
          const independent = await b.command({ kind, paths: [logical] });
          assert.equal(independent.ok, true, JSON.stringify(independent));
          assert.deepEqual(
            (independent.rows as { state: string }[]).map(({ state }) => state),
            ["clean"],
          );
          assert.equal((independent.cut as { revision: number }).revision, newer.cut!.revision);
        }
      }
      const view = locateFleetMirrorView(viewRoot, "lease-repo", "node-one")!,
        currentPath = path.join(view.viewDir, "current.json"),
        currentBytes = readFileSync(currentPath),
        current = JSON.parse(currentBytes.toString("utf8"));
      writeFileSync(currentPath, JSON.stringify({ ...current, authorizationShapeDigest: "mismatched-owner-digest" }));
      await assert.rejects(read(a), { code: "authorization_denied" });
      assert.equal((await read(b)).rows.length, 2);
      writeFileSync(currentPath, currentBytes);
      rmSync(currentPath);
      await assert.rejects(read(a), { code: "replica_unavailable" });
      assert.equal((await read(b)).rows.length, 2);
      assert.equal(connections.mock.callCount(), 0);
      t.diagnostic(
        `two node views at revisions ${older.cut!.revision}/${newer.cut!.revision}; local doc states clean/eligible/deletion independent; owner digest mismatch denied; missing own view unavailable; center TLS calls=0`,
      );
    } finally {
      connections.mock.restore();
      syncBuiltinESMExports();
    }
  },
);
