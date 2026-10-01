// harness-test-tier: integration
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { daemonProcessAlive } from "@harness-anything/daemon/internal/daemon-singleton";
import { stop, waitForProcessExit } from "./daemon-autostart-cli.fixture.ts";

test("autostart fixture stops its daemon even when the owning test throws", async () => {
  const parent = mkdtempSync(path.join(tmpdir(), "ha-autostart-cleanup-")),
    witness = path.join(parent, "witness.json"),
    childTest = path.join(parent, "failure.test.mjs"),
    fixtureModule = new URL("./daemon-autostart-cli.fixture.ts", import.meta.url).href;
  let fixture: { parent: string; root: string; userRoot: string; pid: number } | undefined;
  try {
    writeFileSync(
      childTest,
      `import test from "node:test";
import { writeFileSync } from "node:fs";
import { setup, run, readDaemonPid } from ${JSON.stringify(fixtureModule)};
test("intentional failure after daemon launch", () => {
  const fixture = setup();
  run(fixture.root, fixture.userRoot, ["daemon", "start", "--service"]);
  writeFileSync(${JSON.stringify(witness)}, JSON.stringify({ ...fixture, pid: readDaemonPid(fixture.userRoot, "default") }));
  throw new Error("intentional fixture-owner failure");
});
`,
    );
    const env = { ...process.env };
    delete env.NODE_TEST_CONTEXT;
    const child = spawnSync(process.execPath, ["--test", childTest], { encoding: "utf8", env, timeout: 30_000 });
    assert.equal(existsSync(witness), true, `${child.stderr}\n${child.stdout}`);
    fixture = JSON.parse(readFileSync(witness, "utf8"));
    assert.ok(fixture);
    assert.equal(child.status, 1, `${child.stderr}\n${child.stdout}`);
    assert.match(child.stdout, /intentional fixture-owner failure/u);
    assert.equal(daemonProcessAlive(fixture.pid), false, `fixture daemon ${fixture.pid} outlived its failed test`);
    assert.equal(existsSync(fixture.parent), false, "fixture removal must follow daemon exit");
  } finally {
    if (fixture) {
      stop(fixture.root, fixture.userRoot);
      await waitForProcessExit(fixture.pid);
      rmSync(fixture.parent, { recursive: true, force: true });
    }
    rmSync(parent, { recursive: true, force: true });
  }
});

// The owner is named by the preload the test runner gives every test child, not by this fixture:
// a test file that knows nothing about daemon ownership is covered the same way.
test("daemon exits when its fixture owner is killed", async () => {
  const parent = mkdtempSync(path.join(tmpdir(), "ha-autostart-owner-liveness-")),
    witness = path.join(parent, "witness.json"),
    childTest = path.join(parent, "owner-killed.test.mjs"),
    fixtureModule = new URL("./daemon-autostart-cli.fixture.ts", import.meta.url).href,
    ownerPreload = new URL("../../../tools/node-test-daemon-owner.mjs", import.meta.url).href;
  let fixture: { parent: string; root: string; userRoot: string; pid: number } | undefined;
  try {
    writeFileSync(
      childTest,
      `import test from "node:test";
import { writeFileSync } from "node:fs";
import { setup, run, readDaemonPid } from ${JSON.stringify(fixtureModule)};
test("daemon owner", () => {
  const fixture = setup();
  run(fixture.root, fixture.userRoot, ["daemon", "start", "--service"]);
  writeFileSync(${JSON.stringify(witness)}, JSON.stringify({ ...fixture, pid: readDaemonPid(fixture.userRoot, "default") }));
  process.kill(process.pid, "SIGKILL");
});
`,
    );
    const env = { ...process.env };
    delete env.NODE_TEST_CONTEXT;
    const child = spawnSync(process.execPath, [`--import=${ownerPreload}`, "--test", childTest], {
      encoding: "utf8",
      env,
      timeout: 30_000,
    });
    assert.equal(existsSync(witness), true, `${child.stderr}\n${child.stdout}`);
    fixture = JSON.parse(readFileSync(witness, "utf8"));
    assert.ok(fixture);
    assert.equal(child.status, 1, `${child.stderr}\n${child.stdout}`);
    // The stop is requested within one liveness tick; the process then waits for the installation
    // probes its startup spawned, which on a loaded machine outlast the default two seconds.
    await waitForProcessExit(fixture.pid, 10_000);
    assert.equal(daemonProcessAlive(fixture.pid), false, `fixture daemon ${fixture.pid} outlived its killed owner`);
  } finally {
    if (fixture) {
      stop(fixture.root, fixture.userRoot);
      await waitForProcessExit(fixture.pid);
      rmSync(fixture.parent, { recursive: true, force: true });
    }
    rmSync(parent, { recursive: true, force: true });
  }
});
