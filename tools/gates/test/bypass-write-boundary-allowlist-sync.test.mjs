// harness-test-tier: contract
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { scanBypassWriteCalls } from "../../check-bypass-write-boundary.mjs";

const repoRoot = fileURLToPath(new URL("../../../", import.meta.url));
const target = "packages/kernel/src/projection/rebuildable-task-projection.ts";

test("rebuildable task projection calls and allowlist declarations stay in exact sync", () => {
  const allowlist = JSON.parse(readFileSync(
    new URL("../../gate-allowlists/check-bypass-write-boundary.json", import.meta.url),
    "utf8"
  ));
  const declared = allowlist.entries["rebuildable-projection"]
    .map((entry) => entry.value)
    .filter((value) => value.startsWith(`${target}#`))
    .sort();
  const discovered = scanBypassWriteCalls(repoRoot)
    .filter((finding) => finding.category === "rebuildable-projection" && finding.key.startsWith(`${target}#`))
    .map((finding) => finding.key)
    .sort();

  assert.ok(discovered.some((key) => key.includes("#sqlite.prepare@")), "fixture must cover sqlite.prepare calls");
  assert.deepEqual(
    declared,
    discovered,
    "rebuildable-task-projection allowlist must declare every governed call exactly once and contain no stale positions"
  );
});
