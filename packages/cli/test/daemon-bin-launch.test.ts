// harness-test-tier: fast
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import test from "node:test";
import { cliDaemonServeLaunch, daemonServeEntry } from "../src/daemon/client.ts";

test("CLI resident modes resolve the installed daemon manifest and launch its absolute bin", () => {
  const manifestPath = createRequire(import.meta.url).resolve("@harness-anything/daemon/package.json");
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  const entry = path.resolve(path.dirname(manifestPath), manifest.bin["harness-anything-daemon"]);
  assert.equal(manifest.version, "0.0.1");
  assert.equal(daemonServeEntry(), entry);
  for (const mode of ["serve", "--service"] as const) {
    const launch = cliDaemonServeLaunch("/daemon-user", "blue", process.execPath, undefined, mode);
    assert.equal(launch.command, process.execPath);
    assert.deepEqual(launch.args, [entry, mode, "--user-root", "/daemon-user", "--daemon-id", "blue"]);
    assert.equal(launch.env.HARNESS_ACTOR, undefined);
    assert.equal(launch.env.HARNESS_DAEMON_RELAY, undefined);
  }
});
