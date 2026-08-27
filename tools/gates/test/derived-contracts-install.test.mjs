// harness-test-tier: fast
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");

// The derived-contracts gate imports kernel modules; once packages/kernel/src/entity/session.ts
// pulled `effect` onto that chain (#1957) the job failed with ERR_MODULE_NOT_FOUND on main
// (run 33112386830) because it never installed dependencies. The install step must precede the gate.
test("derived-contracts job installs dependencies before running the gate", () => {
  const workflow = readFileSync(path.join(rootDir, ".github/workflows/rebuild-gates.yml"), "utf8");
  const start = workflow.indexOf("  derived-contracts:");
  const job = workflow.slice(start, workflow.indexOf("\n  evidence-contract:", start));
  const install = job.indexOf("npm ci"),
    gate = job.indexOf("tools/gates/derived-contracts.mjs --check");
  assert.ok(install > 0 && gate > install, "npm ci must run before the derived-contracts gate");
});
