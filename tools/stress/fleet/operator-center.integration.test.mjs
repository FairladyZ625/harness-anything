// harness-test-tier: integration
import assert from "node:assert/strict";
import { closeSync, cpSync, existsSync, mkdirSync, openSync, readFileSync, rmSync } from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import test from "node:test";

const sourceRoot = path.resolve(import.meta.dirname, "../../.."),
  deploymentRoot = "/tmp/harness-s4-operator-deployment",
  appRoot = path.join(deploymentRoot, "app"),
  controlRoot = path.join(deploymentRoot, "control");

// This entry deploys a long-lived center for the operator's GUI observation. It is an operator
// action, not a CI arm: it binds a fixed port, keeps a daemon alive after the test returns and
// refuses to replace a live center. CI therefore skips it explicitly; run it on the campaign VM with
// HARNESS_STRESS_OPERATOR_CENTER=1.
const operatorCenterRequested = process.env.HARNESS_STRESS_OPERATOR_CENTER === "1";

test(
  "S4 deploys an isolated long-lived operator center",
  {
    timeout: 180_000,
    skip: operatorCenterRequested ? false : "operator-only deployment; set HARNESS_STRESS_OPERATOR_CENTER=1",
  },
  async () => {
    if (existsSync(path.join(controlRoot, "status.json"))) {
      const previous = JSON.parse(readFileSync(path.join(controlRoot, "status.json"), "utf8"));
      assert.throws(() => process.kill(previous.pid, 0), /ESRCH/u, "refusing to replace a live operator center");
    }
    rmSync(deploymentRoot, { recursive: true, force: true });
    mkdirSync(deploymentRoot, { recursive: true });
    cpSync(sourceRoot, appRoot, {
      recursive: true,
      filter: (source) => !source.includes(`${path.sep}.test-isolation-state${path.sep}`),
    });
    const stdout = openSync(path.join(deploymentRoot, "center.stdout.log"), "a"),
      stderr = openSync(path.join(deploymentRoot, "center.stderr.log"), "a"),
      child = spawn(process.execPath, [path.join(appRoot, "tools/stress/fleet/operator-center.mjs"), controlRoot], {
        cwd: appRoot,
        detached: true,
        stdio: ["ignore", stdout, stderr],
      });
    child.unref();
    closeSync(stdout);
    closeSync(stderr);
    const deadline = Date.now() + 60_000;
    while (!existsSync(path.join(controlRoot, "status.json")) && Date.now() < deadline)
      await new Promise((resolve) => setTimeout(resolve, 250));
    assert.equal(existsSync(path.join(controlRoot, "status.json")), true, readLog("center.stderr.log"));
    const status = JSON.parse(readFileSync(path.join(controlRoot, "status.json"), "utf8"));
    assert.equal(status.port, 7443);
    assert.deepEqual(status.repoIds, ["stress-seed-1", "stress-seed-2", "stress-seed-3"]);
    process.stdout.write(`OPERATOR_CENTER_REPORT\t${JSON.stringify(status)}\n`);
  },
);

function readLog(name) {
  const file = path.join(deploymentRoot, name);
  return existsSync(file) ? readFileSync(file, "utf8") : `${file} is absent`;
}
