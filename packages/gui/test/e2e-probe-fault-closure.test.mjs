// harness-test-tier: integration
import assert from "node:assert/strict";
import { existsSync, globSync, readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { requestDaemonJsonRpcAt } from "../../daemon/src/client/local-json-rpc-client.ts";
import {
  installE2EProbeElectronForTest,
  recordE2EProbeFailure,
  runE2EProbeJourney,
} from "../../../tools/e2e-probe.mjs";
import { startGuiResidentDaemonFixture } from "../test-support/resident-daemon.mjs";

const workspaceRoot = path.resolve(import.meta.dirname, "../../..");

test(
  "isolated E2E probe closes an injected invalid_result with a 24h-deduplicated failure task",
  { timeout: 180_000 },
  async (t) => {
    const testRuntime = installE2EProbeElectronForTest(workspaceRoot);
    t.after(testRuntime.close);
    const fixture = await startGuiResidentDaemonFixture({
      prefix: "ha-e2e-probe-fault-",
      daemonId: "e2e-probe-fault",
      repoId: "e2e-probe-fault",
      task: { taskId: "task-e2e-probe-fixture", title: "Fixture task for injected probe failure" },
    });
    t.after(fixture.stop);
    const routeEnv = { ...testRuntime.env, ...fixture.env, HARNESS_DAEMON_ENDPOINT: fixture.endpoint },
      journey = await runE2EProbeJourney({
        workspaceRoot,
        rootDir: fixture.rootDir,
        env: routeEnv,
        injectFault: ({ step }) => {
          if (step === "board") throw Object.assign(new Error("injected invalid result"), { code: "invalid_result" });
        },
      });

    assert.equal(journey.outcome, "failed", JSON.stringify(journey));
    assert.equal(journey.failedStep, "board");
    assert.equal(journey.code, "invalid_result");
    assert.match(journey.failureSignature, /^[0-9a-f]{20}$/u);
    assert.equal(existsSync(journey.screenshotPath), true, "failure closure omitted the screenshot");
    assert.equal(existsSync(journey.bundlePath), true, "failure closure omitted the JSON bundle");

    const fixedNow = () => "2026-08-26T08:00:00.000Z",
      first = await recordE2EProbeFailure({
        rootDir: fixture.rootDir,
        workspaceRoot,
        bundlePath: journey.bundlePath,
        env: routeEnv,
        now: fixedNow,
      }),
      second = await recordE2EProbeFailure({
        rootDir: fixture.rootDir,
        workspaceRoot,
        bundlePath: journey.bundlePath,
        env: routeEnv,
        now: fixedNow,
      }),
      rows = await taskRows(fixture),
      failures = rows.filter((row) => row.snapshot.task?.title === `E2E probe failure [${journey.failureSignature}]`),
      artifacts = globSync("harness/tasks/**/artifacts/e2e-probe/failure.json", { cwd: fixture.rootDir });

    assert.equal(first.outcome, "failed");
    assert.equal(first.deduplicated, false);
    assert.equal(second.deduplicated, true);
    assert.equal(second.taskId, first.taskId);
    assert.deepEqual(
      failures.map(({ taskId }) => taskId),
      [first.taskId],
    );
    assert.equal(artifacts.length, 1, "the first closure did not publish exactly one textual failure bundle");
    assert.equal(
      JSON.parse(readFileSync(path.join(fixture.rootDir, artifacts[0]), "utf8")).failureSignature,
      journey.failureSignature,
    );
  },
);

async function taskRows(fixture) {
  const response = await requestDaemonJsonRpcAt(
    fixture.endpoint,
    "repo.tasks.list",
    { repo: { repoId: fixture.repoId }, payload: {} },
    1_000,
    20_000,
  );
  assert.equal(response.ok, true, JSON.stringify(response));
  return response.rows;
}
