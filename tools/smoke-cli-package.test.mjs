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
    rmSync: (...args) => removals.push(args)
  });

  assert.deepEqual(removals, [["/repo/packages/cli/dist", { recursive: true, force: true }]]);
  assert.deepEqual(calls.map((call) => [call.command, call.args]), [
    ["npm", ["run", "build", "--workspace", "@harness-anything/cli"]],
    [process.execPath, ["/repo/packages/cli/dist/cli/src/index.js", "--json", "version"]]
  ]);
  assert.equal(calls[0].options.cwd, "/repo");
  assert.equal(calls[0].options.env.NPM_CONFIG_IGNORE_SCRIPTS, "false");
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
      rmSync: () => undefined
    }),
    /clean CLI package build produced an unusable bin/u
  );
});

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}
