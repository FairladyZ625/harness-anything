// harness-test-tier: integration
import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { requestDaemonJsonRpcAt } from "../../daemon/src/client/local-json-rpc-client.ts";
import { installE2EProbeElectronForTest, runE2EProbeJourney } from "../../../tools/e2e-probe.mjs";
import { startGuiResidentDaemonFixture } from "../test-support/resident-daemon.mjs";

const workspaceRoot = path.resolve(import.meta.dirname, "../../..");

test(
  "canonical E2E probe traverses the live GUI without mutating daemon task state",
  { timeout: 180_000 },
  async (t) => {
    const testRuntime = installE2EProbeElectronForTest(workspaceRoot);
    t.after(testRuntime.close);
    const fixture = await startGuiResidentDaemonFixture({
      prefix: "ha-e2e-probe-read-only-",
      daemonId: "e2e-probe-read-only",
      repoId: "e2e-probe-read-only",
      task: { taskId: "task-e2e-probe", title: "Probe the canonical read journey" },
    });
    t.after(fixture.stop);
    const before = await taskProjection(fixture),
      result = await runE2EProbeJourney({
        workspaceRoot,
        rootDir: fixture.rootDir,
        env: { ...testRuntime.env, ...fixture.env, HARNESS_DAEMON_ENDPOINT: fixture.endpoint },
      }),
      after = await taskProjection(fixture);

    assert.equal(result.outcome, "healthy", JSON.stringify(result));
    assert.deepEqual(result.completedSteps, [
      "bridge_ready",
      "task_projection",
      "board",
      "task_detail",
      "task_dispatch",
      "sessions",
      "agent_squad",
      "navigation_history",
    ]);
    assert.equal(after.sourceRevision, before.sourceRevision, "the read-only journey appended a canonical event");
    assert.deepEqual(
      after.rows.map(taskIdentity),
      before.rows.map(taskIdentity),
      "the read-only journey created or amended a task",
    );
    assert.equal(
      after.rows.some((row) => row.snapshot.task?.title?.startsWith("E2E probe failure [")),
      false,
    );
  },
);

async function taskProjection(fixture) {
  const response = await requestDaemonJsonRpcAt(
    fixture.endpoint,
    "repo.tasks.list",
    { repo: { repoId: fixture.repoId }, payload: {} },
    1_000,
    20_000,
  );
  assert.equal(response.ok, true, JSON.stringify(response));
  return { rows: response.rows, sourceRevision: response.sourceRevision };
}

function taskIdentity(row) {
  return {
    taskId: row.taskId,
    title: row.snapshot.task?.title,
    status: row.snapshot.task?.status,
    updatedAt: row.snapshot.task?.updatedAt,
  };
}
