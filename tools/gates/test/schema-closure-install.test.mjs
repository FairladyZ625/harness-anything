// harness-test-tier: fast
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");

// The schema-closure gate walks kernel modules that import `effect`; a job without dependencies
// fails with ERR_MODULE_NOT_FOUND. The shared install artifact must be restored before the gate.
test("schema-closure job restores shared dependencies before running the gate", () => {
  const workflow = readFileSync(path.join(rootDir, ".github/workflows/rewrite-ci.yml"), "utf8");
  const start = workflow.indexOf("  schema-closure:");
  const job = workflow.slice(start, workflow.indexOf("\n  canonical-event-compat:", start));
  const download = job.indexOf("actions/download-artifact@v4"),
    install = job.indexOf('tar -xf "$RUNNER_TEMP/node-modules.tar" && touch packages/daemon/dist/build-id.txt'),
    gate = job.indexOf("tools/gates/schema-closure.mjs --check");
  assert.match(job, /needs: install/u);
  assert.ok(
    download > 0 && install > download && gate > install,
    "shared dependencies must be restored before the schema-closure gate",
  );
});
