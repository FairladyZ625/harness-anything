// harness-test-tier: fast
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");

// The schema-closure gate walks kernel modules that import `effect`; a job that never installs
// dependencies fails with ERR_MODULE_NOT_FOUND on the first push after such an import lands
// (main run 33075473572). The install step must precede the gate.
test("schema-closure job installs dependencies before running the gate", () => {
  const workflow = readFileSync(path.join(rootDir, ".github/workflows/rebuild-gates.yml"), "utf8");
  const start = workflow.indexOf("  schema-closure:");
  const job = workflow.slice(start, workflow.indexOf("\n  canonical-event-compat:", start));
  const install = job.indexOf("npm ci"),
    gate = job.indexOf("tools/gates/schema-closure.mjs --check");
  assert.ok(install > 0 && gate > install, "npm ci must run before the schema-closure gate");
});
