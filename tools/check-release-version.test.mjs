// harness-test-tier: contract
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
test("release version check rejects a mismatched tag", () =>
  assert.throws(() => execFileSync(process.execPath, ["tools/check-release-version.mjs", "v0.1.0-rc.1"]), /mismatch/));
test("release version check accepts the current package version", () =>
  assert.doesNotThrow(() => execFileSync(process.execPath, ["tools/check-release-version.mjs", "v0.0.1"])));
