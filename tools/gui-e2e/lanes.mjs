import { startGuiResidentDaemonFixture } from "../../packages/gui/test-support/resident-daemon.mjs";
import { seedTriadicEvents, writeTriadicLedger } from "../../packages/gui/test-support/triadic-ledger.mjs";
import { warmDaemonProjection } from "../e2e-probe.mjs";

export async function openLane({ lane, workspaceRoot, env, runRoot, startDriver }) {
  if (lane === "canonical") {
    await warmDaemonProjection({ rootDir: workspaceRoot, workspaceRoot, env });
    const driver = await startDriver({ workspaceRoot, rootDir: workspaceRoot, env, runRoot });
    driver.runRoot = runRoot;
    return { driver, close: () => driver.close() };
  }
  const originalTmpdir = process.env.TMPDIR;
  process.env.TMPDIR = "/tmp";
  let fixture;
  try {
    fixture = await startGuiResidentDaemonFixture({
      prefix: "hg-",
      daemonId: "g",
      repoId: "gui-e2e-catalog",
      task: { taskId: "task-gui-smoke", title: "Render the real triadic projection" },
      beforeRestart: seedTriadicEvents,
    });
  } finally {
    if (originalTmpdir === undefined) delete process.env.TMPDIR;
    else process.env.TMPDIR = originalTmpdir;
  }
  writeTriadicLedger(fixture.rootDir);
  const isolatedEnv = { ...env, ...fixture.env, HARNESS_DAEMON_ENDPOINT: fixture.endpoint };
  const driver = await startDriver({
    workspaceRoot,
    rootDir: fixture.rootDir,
    env: isolatedEnv,
    runRoot,
  });
  driver.runRoot = runRoot;
  return {
    driver,
    async close() {
      await driver.close();
      await fixture.stop();
    },
  };
}
