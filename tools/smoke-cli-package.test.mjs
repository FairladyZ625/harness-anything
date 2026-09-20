// harness-test-tier: contract
import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { assertUnstartableDaemonFailedClosed, buildCliPackageArtifact, env } from "./smoke-cli-package.mjs";

test("CLI package smoke explicitly builds the CLI artifact even when npm lifecycle scripts are ignored", () => {
  const calls = [];

  withHostHarnessPollution(() =>
    buildCliPackageArtifact("/repo", {
      platform: "linux",
      execFileSync: (command, args, options) => {
        calls.push({ command, args, options });
      },
      existsSync: () => true,
    }),
  );

  assert.deepEqual(
    calls.map((call) => [call.command, call.args]),
    [["npm", ["run", "build", "--workspace", "@harness-anything/cli"]]],
  );
  assert.equal(calls[0].options.cwd, "/repo");
  assert.equal(calls[0].options.env.NPM_CONFIG_IGNORE_SCRIPTS, "false");
  assert.ok(
    Object.keys(calls[0].options.env).every((key) => !key.startsWith("HARNESS_")),
    "host HARNESS_* routing must not reach the npm build subprocess",
  );
  assert.equal(calls[0].options.env.PATH, process.env.PATH);
});

test("CLI package smoke resolves npm.cmd through ComSpec on Windows", () => {
  const calls = [];

  withHostHarnessPollution(() =>
    buildCliPackageArtifact("C:\\repo", {
      platform: "win32",
      environment: { ComSpec: "C:\\Windows\\System32\\cmd.exe" },
      execFileSync: (command, args, options) => {
        calls.push({ command, args, options });
      },
      existsSync: () => true,
    }),
  );

  assert.deepEqual(
    calls.map((call) => [call.command, call.args]),
    [["C:\\Windows\\System32\\cmd.exe", ["/d", "/s", "/c", "npm.cmd run build --workspace @harness-anything/cli"]]],
  );
  assert.equal(calls[0].options.windowsHide, true);
  assert.equal(calls[0].options.windowsVerbatimArguments, true);
  assert.ok(
    Object.keys(calls[0].options.env).every((key) => !key.startsWith("HARNESS_")),
    "host HARNESS_* routing must not reach the npm build subprocess",
  );
  assert.equal(calls[0].options.env.ComSpec, "C:\\Windows\\System32\\cmd.exe");
});

test("packaged CLI run environment keeps only the smoke's own HARNESS_DAEMON_USER_ROOT binding", () => {
  withHostHarnessPollution((sentinels) => {
    const childEnv = env("/smoke/user-root", "/smoke/home");
    assert.deepEqual(
      Object.keys(childEnv).filter((key) => key.startsWith("HARNESS_")),
      ["HARNESS_DAEMON_USER_ROOT"],
    );
    assert.equal(childEnv.HARNESS_DAEMON_USER_ROOT, "/smoke/user-root");
    assert.equal(childEnv.HOME, "/smoke/home");
    assert.equal(childEnv.GIT_CONFIG_GLOBAL, "/dev/null");
    assert.equal(childEnv.PATH, process.env.PATH);
    for (const [key, value] of Object.entries(sentinels))
      assert.equal(process.env[key], value, "the host environment object must stay unmodified");
  });
});

test("CLI package smoke reports a missing build artifact instead of packing stale dist", () => {
  assert.throws(
    () =>
      buildCliPackageArtifact("/repo", {
        execFileSync: () => undefined,
        existsSync: () => false,
      }),
    new RegExp(
      `explicit CLI package build did not produce ${escapeRegExp(path.join("/repo", "packages/cli/dist/cli/src/index.js"))}`,
      "u",
    ),
  );
});

test("CLI package smoke accepts only classified unstartable-daemon failures that leave no harness tree", () => {
  for (const code of ["daemon_bind_timeout", "daemon_spawn_permission"])
    assert.doesNotThrow(() =>
      assertUnstartableDaemonFailedClosed({ status: 1, receipt: { ok: false, error: { code } } }, false),
    );
  assert.throws(
    () =>
      assertUnstartableDaemonFailedClosed(
        { status: 0, receipt: { ok: false, error: { code: "daemon_spawn_permission" } } },
        false,
      ),
    /non-zero/u,
  );
  assert.throws(
    () =>
      assertUnstartableDaemonFailedClosed(
        { status: 1, receipt: { ok: true, error: { code: "daemon_spawn_permission" } } },
        false,
      ),
    /ok=false/u,
  );
  assert.throws(
    () =>
      assertUnstartableDaemonFailedClosed({ status: 1, receipt: { ok: false, error: { code: "unexpected" } } }, false),
    /unexpected unstartable-daemon code/u,
  );
  assert.throws(
    () =>
      assertUnstartableDaemonFailedClosed(
        { status: 1, receipt: { ok: false, error: { code: "daemon_spawn_permission" } } },
        true,
      ),
    /created harness/u,
  );
});

function withHostHarnessPollution(run) {
  const sentinels = {
    HARNESS_ACTOR: "agent:runtime-session:sentinel-runtime",
    HARNESS_CANONICAL_ROOT: "/tmp/ha-cli-smoke-sentinel/canonical-root",
    HARNESS_DAEMON_ENDPOINT: "/tmp/ha-cli-smoke-sentinel/daemon-endpoint.sock",
    HARNESS_DAEMON_ID: "sentinel-daemon",
    HARNESS_DAEMON_REPO_ID: "sentinel-repo",
    HARNESS_DAEMON_USER_ROOT: "/tmp/ha-cli-smoke-sentinel/user-root",
    HARNESS_TASK_BOUND: "1",
  };
  const saved = {};
  for (const [key, value] of Object.entries(sentinels)) {
    saved[key] = process.env[key];
    process.env[key] = value;
  }
  try {
    run(sentinels);
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}
