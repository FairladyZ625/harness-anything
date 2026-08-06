// harness-test-tier: fast
import assert from "node:assert/strict";
import test from "node:test";
import {
  createDaemonLaunchConfiguration,
  defaultDaemonIdleExitMs
} from "@harness-anything/daemon";

// dec_01KZA1ZS0JHS9ZRQXESMC1W5HB: the code default for the daemon idle-exit
// timer must not be a subsecond value. Interactive single-writer daemons
// (dev / self-hosted) stay resident by default; a subsecond idle charged every
// normal thinking pause a full cold restart. Either 0 (resident / never
// idle-exit) or >= 1s satisfies the invariant. This test nails the invariant,
// not the specific number, so a future tuning adjustment won't trip a
// content-free red.

test("default daemon idle-exit is not subsecond (interactive single-writer daemons stay resident)", () => {
  assert.ok(
    defaultDaemonIdleExitMs === 0 || defaultDaemonIdleExitMs >= 1000,
    `defaultDaemonIdleExitMs must not be subsecond (either 0 = resident, or >= 1000ms); got ${defaultDaemonIdleExitMs}`
  );
});

test("an explicit idleExitMs override is rendered into the daemon launch args", () => {
  const configuration = createDaemonLaunchConfiguration({
    target: {
      canonicalRoot: "/repo",
      repoId: "canonical",
      socketPath: "/repo/daemon.sock",
      userRoot: "/user-root"
    },
    entrypoint: "/repo/packages/cli/src/index.ts",
    idleExitMs: 5_000,
    execPath: "/usr/bin/node",
    execArgv: [],
    env: {}
  });
  const idleMsIndex = configuration.args.indexOf("--idle-ms");
  assert.notEqual(idleMsIndex, -1, "launch args must include --idle-ms");
  assert.equal(configuration.args[idleMsIndex + 1], "5000");
});
