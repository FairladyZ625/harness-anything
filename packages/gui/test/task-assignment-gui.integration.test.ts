// harness-test-tier: integration
import assert from "node:assert/strict";
import test from "node:test";
import { parseDaemonGuiActionResponse, parseDaemonGuiReadResult } from "@harness-anything/daemon/client";
import { createLocalGuiServiceBridge } from "../src/index.ts";
import { startGuiResidentDaemonFixture } from "../test-support/resident-daemon.mjs";
import { restoreEnv } from "./service-bridge.fixtures.ts";

test("GUI assignment carries the read version and preserves assignment through a held-lease refusal", async () => {
  const fixture = await startGuiResidentDaemonFixture({
    daemonId: "gui-assignment",
    repoId: "gui-assignment",
    task: { taskId: "task-gui-assignment", title: "Assignment" },
  });
  const previous = {
    userRoot: process.env.HARNESS_DAEMON_USER_ROOT,
    daemonId: process.env.HARNESS_DAEMON_ID,
    repoId: process.env.HARNESS_DAEMON_REPO_ID,
    endpoint: process.env.HARNESS_DAEMON_ENDPOINT,
  };
  delete process.env.HARNESS_DAEMON_ENDPOINT;
  Object.assign(process.env, fixture.env);
  try {
    const bridge = createLocalGuiServiceBridge(fixture.rootDir),
      scope = { repoId: fixture.repoId, taskId: "task-gui-assignment" },
      read = async () =>
        parseDaemonGuiReadResult(
          "repo.tasks.list",
          await bridge.invoke("getTasks", { repoId: fixture.repoId }),
        ).rows.find((row) => row.taskId === scope.taskId)!.snapshot;
    const before = await read(),
      personId = before.task!.createdBy.principal.personId;
    const assigned = parseDaemonGuiActionResponse(
      "repo.task.assign",
      await bridge.invoke("assignTask", { ...scope, expectedVersion: before.revision, personId }),
    );
    assert.equal(assigned.outcome, "applied", JSON.stringify(assigned));
    const after = await read();
    assert.deepEqual(after.task!.assignment?.assignee, { kind: "person", personId });
    assert.ok(Date.parse(after.task!.assignment!.expiresAt) > Date.now() + 23 * 3600000);
    const stale = parseDaemonGuiActionResponse(
      "repo.task.unassign",
      await bridge.invoke("unassignTask", { ...scope, expectedVersion: before.revision }),
    );
    assert.equal(stale.ok, false);
    assert.deepEqual((await read()).task!.assignment, after.task!.assignment);
    const removed = parseDaemonGuiActionResponse(
      "repo.task.unassign",
      await bridge.invoke("unassignTask", { ...scope, expectedVersion: after.revision }),
    );
    assert.equal(removed.outcome, "applied", JSON.stringify(removed));
    assert.equal((await read()).task!.assignment, null);
    const explicit = "2099-01-01T00:00:00.000Z";
    await bridge.invoke("assignTask", {
      ...scope,
      expectedVersion: (await read()).revision,
      personId,
      expiresAt: explicit,
    });
    assert.equal((await read()).task!.assignment!.expiresAt, explicit);
    const started = parseDaemonGuiActionResponse(
      "repo.task.start",
      await bridge.invoke("startTask", { ...scope, executionId: "execution-gui-assignment" }),
    );
    assert.equal(started.outcome, "applied", JSON.stringify(started));
    const held = parseDaemonGuiActionResponse(
      "repo.task.unassign",
      await bridge.invoke("unassignTask", { ...scope, expectedVersion: (await read()).revision }),
    );
    assert.equal(held.ok, false);
    assert.equal((await read()).task!.assignment!.expiresAt, explicit);
  } finally {
    for (const [name, value] of Object.entries(previous)) restoreEnv(name, value);
    await fixture.stop();
  }
});
