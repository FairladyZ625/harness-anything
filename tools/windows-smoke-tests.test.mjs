// harness-test-tier: fast
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import {
  validateWindowsSmokeFiles,
  windowsSmokeTestFiles
} from "./windows-smoke-tests.mjs";
import { discoverTestTierManifest } from "./test-tier-manifest.mjs";

const repoRoot = path.resolve(import.meta.dirname, "..");

test("Windows PR smoke is an explicit cross-tier path, process, and filesystem subset", () => {
  const manifest = discoverTestTierManifest(repoRoot);
  const result = validateWindowsSmokeFiles(windowsSmokeTestFiles, manifest, {
    readSource: (file) => readFileSync(path.join(repoRoot, file), "utf8")
  });

  assert.equal(result.ok, true, result.errors.join("\n"));
  assert.deepEqual(result.categories, ["filesystem", "path", "process"]);
  assert.equal(result.tiers.includes("fast"), true);
  assert.equal(result.tiers.includes("contract"), true);
  assert.equal(result.tiers.includes("integration"), true);
  assert.equal(result.tiers.includes("nightly"), false);
});

test("Windows smoke validation rejects duplicates, unknown files, and unclassified categories", () => {
  const manifest = { fast: ["tools/a.test.mjs"], contract: [], integration: [], nightly: [] };
  const result = validateWindowsSmokeFiles([
    { path: "tools/a.test.mjs", categories: ["path"] },
    { path: "tools/a.test.mjs", categories: ["path"] },
    { path: "tools/missing.test.mjs", categories: [] }
  ], manifest, { readSource: () => "// harness-test-tier: fast\n" });

  assert.equal(result.ok, false);
  assert.match(result.errors.join("\n"), /duplicate Windows smoke file/u);
  assert.match(result.errors.join("\n"), /not present in the test tier manifest/u);
  assert.match(result.errors.join("\n"), /must declare at least one category/u);
});
