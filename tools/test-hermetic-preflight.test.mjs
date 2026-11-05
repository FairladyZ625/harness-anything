// harness-test-tier: fast
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir, userInfo } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { assessHermeticConfig, main, parsePreflightArgs } from "./test-hermetic-preflight.mjs";

const identityHome = "/home/tester";
const defaultUserRoot = path.resolve(identityHome, ".harness");

test("preflight rejects the default daemon with separate user-root and socket failures", () => {
  const result = assessHermeticConfig({
    userRoot: defaultUserRoot,
    daemonId: "default",
    userRootSource: "flag",
    identityHome,
  });

  assert.equal(result.ok, false);
  assert.deepEqual(result.failures, [
    `user-root path: ${defaultUserRoot} is the default daemon root; choose a dedicated directory.`,
    "socket namespace: the default user-root with daemon-id default resolves to the user's default daemon endpoint.",
  ]);
});

test("preflight reports a missing user root", () => {
  const result = assessHermeticConfig({
    userRoot: undefined,
    daemonId: undefined,
    userRootSource: undefined,
    identityHome: "/home/runner",
  });
  assert.equal(result.ok, false);
  assert.deepEqual(result.failures, [
    "user-root source: pass --user-root explicitly; implicit daemon configuration is not permitted.",
  ]);
});

test("preflight accepts an explicit dedicated user root with the default daemon id", () => {
  const result = assessHermeticConfig({
    userRoot: "/tmp/harness-test-isolation/run-42",
    daemonId: undefined,
    userRootSource: "flag",
    identityHome: "/home/runner",
  });
  assert.deepEqual(result, { ok: true, failures: [], effectiveDaemonId: "default" });
});

test("preflight refuses an environment-only user root", () => {
  const config = parsePreflightArgs([], {
    HARNESS_DAEMON_USER_ROOT: "/tmp/harness-test-isolation/run-42",
    HARNESS_DAEMON_ID: "test-isolation-42",
  });
  assert.deepEqual(assessHermeticConfig({ ...config, identityHome: "/home/runner" }).failures, [
    "user-root source: pass --user-root explicitly; an environment-only value is not an auditable isolation boundary.",
  ]);
});

test("preflight command accepts explicit values", () => {
  assert.equal(main(["--user-root", "/tmp/harness-test-isolation/run-42"], {}), 0);
});

// os.homedir() follows the mutable HOME a runtime may redirect. The production daemon root is
// the account's real home, so the CLI must reject it even when a child HOME points elsewhere.
test("preflight rejects the production daemon root while HOME is redirected", () => {
  const redirectedHome = mkdtempSync(path.join(tmpdir(), "ha-preflight-redirected-home-"));
  try {
    const productionRoot = path.join(userInfo().homedir, ".harness");
    const child = runPreflight(redirectedHome, ["--user-root", productionRoot, "--daemon-id", "default"]);

    assert.equal(child.status, 1, child.stderr);
    assert.ok(child.stderr.includes(`user-root path: ${productionRoot} is the default daemon root`), child.stderr);
    assert.match(child.stderr, /socket namespace: .* default daemon endpoint/u);
  } finally {
    rmSync(redirectedHome, { recursive: true, force: true });
  }
});

test("preflight admits a dedicated root under the same redirected HOME", () => {
  const redirectedHome = mkdtempSync(path.join(tmpdir(), "ha-preflight-redirected-home-"));
  try {
    const child = runPreflight(redirectedHome, [
      "--user-root",
      "/tmp/harness-test-isolation/dedicated-root",
      "--daemon-id",
      "default",
    ]);

    assert.equal(child.status, 0, child.stderr);
    assert.match(child.stdout, /^PASS hermetic test configuration:/u);
  } finally {
    rmSync(redirectedHome, { recursive: true, force: true });
  }
});

function runPreflight(home, args) {
  return spawnSync(
    process.execPath,
    [fileURLToPath(new URL("./test-hermetic-preflight.mjs", import.meta.url)), ...args],
    { encoding: "utf8", env: { ...process.env, HOME: home, USERPROFILE: home } },
  );
}
