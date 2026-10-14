// harness-test-tier: integration
// `ha daemon fleet edge sync` on a fresh edge: the admitted connection becomes the workspace's
// fleet-edge.json and the resident replica stream starts on it; a sync with a changed connection
// rewrites the file and restarts the stream on the new settings.
import assert from "node:assert/strict";
import { existsSync, statSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fleetNodeClaimFixture } from "./fleet-node-claim.fixtures.ts";
import { fleetEdgeHostFixture } from "./fleet-edge-host.fixture.ts";
import { readFleetEdgeConfig } from "../src/client/fleet-edge-config.ts";

test(
  "a successful edge sync persists its connection and starts the resident stream",
  { timeout: 180_000 },
  async (t) => {
    const f = await fleetNodeClaimFixture(t, undefined, undefined, undefined, undefined, true);
    assert.equal(
      (await f.command("center-node", { kind: "task-create", taskId: "synced-0", title: "Synced 0" })).outcome,
      "applied",
    );
    const e = await fleetEdgeHostFixture(t, f, { writeEdgeConfig: false });
    const configFile = path.join(e.edgeRoot, "fleet-edge.json");
    assert.equal(existsSync(configFile), false);
    const { schema: _schema, waitTimeoutMs: _wait, ...connection } = e.config;
    let id = 100;
    const edgeSync = async (payload: Record<string, unknown>) => {
      id += 1;
      const response = await e.rpc.handle({
        jsonrpc: "2.0",
        id,
        method: "daemon.fleet.edge.sync",
        params: { payload: { ...payload, workspaceRoot: e.edgeRoot, timeoutMs: 30_000 } },
      });
      if (!response || Array.isArray(response) || !("result" in response))
        throw new Error(`edge sync failed: ${JSON.stringify(response)}`);
      return response.result as Record<string, unknown>;
    };

    const first = await edgeSync(connection);
    assert.equal(first.ok, true, JSON.stringify(first));
    assert.equal(first.outcome, "applied");
    assert.deepEqual(readFleetEdgeConfig(e.edgeRoot), connection);
    assert.equal(statSync(configFile).mode & 0o777, 0o600, "the file carries the machine credential");

    // A changed connection is rewritten and the stream restarts on it; sync waits on the new stream.
    assert.equal(
      (await f.command("center-node", { kind: "task-create", taskId: "synced-1", title: "Synced 1" })).outcome,
      "applied",
    );
    const changed = { ...connection, quotaBytes: connection.quotaBytes * 2 };
    const second = await edgeSync(changed);
    assert.equal(second.ok, true, JSON.stringify(second));
    assert.deepEqual(readFleetEdgeConfig(e.edgeRoot), changed);
    const listed = await e.command({ kind: "task-list" });
    const rows = listed.rows as Array<{ readonly taskId?: string }>;
    assert.deepEqual(
      rows
        .map((row) => row.taskId)
        .filter((taskId) => taskId?.startsWith("synced-"))
        .sort(),
      ["synced-0", "synced-1"],
    );
  },
);
