// harness-test-tier: fast
import test from "node:test";
import { spawn } from "node:child_process";

test("runner timeout fixture becomes intentionally non-terminating", async () => {
  if (process.env.HARNESS_RUNNER_TIMEOUT_FIXTURE === "child") {
    const child = spawn(process.execPath, [
      "--input-type=module",
      "--eval",
      "process.on('SIGTERM', () => {}); setInterval(() => {}, 60_000)"
    ], {
      stdio: "ignore"
    });
    console.log(`runner timeout fixture child pid: ${child.pid}`);
  } else if (process.env.HARNESS_RUNNER_TIMEOUT_FIXTURE !== "hang") {
    return;
  }
  await new Promise(() => {});
});
