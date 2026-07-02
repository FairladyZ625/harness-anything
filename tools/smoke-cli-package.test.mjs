import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { buildCliPackageArtifact } from "./smoke-cli-package.mjs";

test("CLI package smoke explicitly builds the CLI artifact even when npm lifecycle scripts are ignored", () => {
  const calls = [];

  buildCliPackageArtifact("/repo", {
    execFileSync: (command, args, options) => {
      calls.push({ command, args, options });
    },
    existsSync: () => true
  });

  assert.deepEqual(calls.map((call) => [call.command, call.args]), [
    ["npm", ["run", "build", "--workspace", "@harness-anything/cli"]]
  ]);
  assert.equal(calls[0].options.cwd, "/repo");
  assert.equal(calls[0].options.env.NPM_CONFIG_IGNORE_SCRIPTS, "false");
});

test("CLI package smoke reports a missing build artifact instead of packing stale dist", () => {
  assert.throws(
    () => buildCliPackageArtifact("/repo", {
      execFileSync: () => undefined,
      existsSync: () => false
    }),
    new RegExp(`explicit CLI package build did not produce ${escapeRegExp(path.join("/repo", "packages/cli/dist/cli/src/index.js"))}`, "u")
  );
});

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}
