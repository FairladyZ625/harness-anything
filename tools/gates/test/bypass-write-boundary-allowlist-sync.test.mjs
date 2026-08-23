// harness-test-tier: contract
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { scanBypassWriteCalls } from "../../check-bypass-write-boundary.mjs";

const repoRoot = fileURLToPath(new URL("../../../", import.meta.url));
const targetPrefix = "packages/kernel/src/projection/rebuildable-task-projection";
const preSplitSqliteCounts = {
  DatabaseSync: 1,
  "sqlite.exec": 5,
  "sqlite.prepare": 33
};

function belongsToRebuildableTaskProjection(key) {
  return key.startsWith(`${targetPrefix}.ts#`) || key.startsWith(`${targetPrefix}-`);
}

test("rebuildable task projection calls and allowlist declarations stay in exact sync", () => {
  const allowlist = JSON.parse(readFileSync(
    new URL("../../gate-allowlists/check-bypass-write-boundary.json", import.meta.url),
    "utf8"
  ));
  const declared = allowlist.entries["rebuildable-projection"]
    .map((entry) => entry.value)
    .filter(belongsToRebuildableTaskProjection)
    .sort();
  const discovered = scanBypassWriteCalls(repoRoot)
    .filter((finding) => finding.category === "rebuildable-projection" && belongsToRebuildableTaskProjection(finding.key))
    .map((finding) => finding.key)
    .sort();

  const discoveredSqliteCounts = Object.fromEntries(Object.keys(preSplitSqliteCounts).map((api) => [
    api,
    discovered.filter((key) => key.includes(`#${api}@`)).length
  ]));
  for (const [api, preSplitCount] of Object.entries(preSplitSqliteCounts)) {
    assert.ok(
      discoveredSqliteCounts[api] >= preSplitCount,
      `split fixture must preserve at least ${preSplitCount} ${api} call(s); discovered ${discoveredSqliteCounts[api]}`
    );
  }
  assert.deepEqual(
    declared,
    discovered,
    "rebuildable-task-projection split-module allowlist must declare every governed call exactly once and contain no stale positions"
  );
});
