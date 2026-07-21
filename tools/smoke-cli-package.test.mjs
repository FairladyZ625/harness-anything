// harness-test-tier: contract
import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { buildCliPackageArtifact } from "./smoke-cli-package.mjs";

test("CLI package smoke explicitly builds the CLI artifact even when npm lifecycle scripts are ignored", () => {
  const calls = [];
  const removals = [];

  buildCliPackageArtifact("/repo", {
    execFileSync: (command, args, options) => {
      calls.push({ command, args, options });
      if (command === process.execPath) {
        return JSON.stringify({ ok: true, schema: "command-receipt/v2", command: "version" });
      }
    },
    existsSync: () => true,
    statSync: () => ({ mode: 0o100755 }),
    rmSync: (...args) => removals.push(args)
  });

  assert.deepEqual(removals, [[path.join("/repo", "packages/cli/dist"), { recursive: true, force: true }]]);
  assert.deepEqual(calls.map((call) => [call.command, call.args]), [
    ["npm", ["run", "build", "--workspace", "@harness-anything/cli"]],
    [process.execPath, [path.join("/repo", "packages/cli/dist/cli/src/index.js"), "--json", "version"]]
  ]);
  assert.equal(calls[0].options.cwd, "/repo");
  assert.equal(calls[0].options.env.NPM_CONFIG_IGNORE_SCRIPTS, "false");
  assert.equal(calls[1].options.env.HARNESS_DAEMON_MODE, "fixture");
  assert.equal(calls[1].options.env.HARNESS_DAEMON_PROFILE, "isolated");
  assert.equal(calls[1].options.env.HARNESS_CLI_TEST_FIXTURE_PRELOAD, "1");
});

test("CLI package smoke reports a missing build artifact instead of packing stale dist", () => {
  assert.throws(
    () => buildCliPackageArtifact("/repo", {
      execFileSync: () => undefined,
      existsSync: () => false,
      rmSync: () => undefined
    }),
    new RegExp(`explicit CLI package build did not produce ${escapeRegExp(path.join("/repo", "packages/cli/dist/cli/src/index.js"))}`, "u")
  );
});

test("CLI package smoke rejects a clean build whose bin cannot execute", () => {
  assert.throws(
    () => buildCliPackageArtifact("/repo", {
      execFileSync: (command) => command === process.execPath
        ? JSON.stringify({ ok: false, schema: "command-receipt/v2", command: "version" })
        : undefined,
      existsSync: () => true,
      statSync: () => ({ mode: 0o100755 }),
      rmSync: () => undefined
    }),
    /clean CLI package build produced an unusable bin/u
  );
});

test("CLI package smoke rejects a clean build whose bin lost its execute bit", () => {
  assert.throws(
    () => buildCliPackageArtifact("/repo", {
      execFileSync: () => JSON.stringify({ ok: true, schema: "command-receipt/v2", command: "version" }),
      existsSync: () => true,
      statSync: () => ({ mode: 0o100644 }),
      rmSync: () => undefined,
      platform: "linux"
    }),
    new RegExp(`clean CLI package build produced a non-executable bin: ${escapeRegExp(path.join("/repo", "packages/cli/dist/cli/src/index.js"))}`, "u")
  );
});

test("CLI package smoke does not require an execute bit on Windows", () => {
  assert.doesNotThrow(() => buildCliPackageArtifact("/repo", {
    execFileSync: () => JSON.stringify({ ok: true, schema: "command-receipt/v2", command: "version" }),
    existsSync: () => true,
    statSync: () => ({ mode: 0o100644 }),
    rmSync: () => undefined,
    platform: "win32"
  }));
});

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}
