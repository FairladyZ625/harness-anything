// harness-test-tier: fast
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");

// The derived-contracts gate imports kernel modules; after `effect` joined that chain (#1957),
// it failed with ERR_MODULE_NOT_FOUND when the job had no dependency install. The shared install
// artifact must be restored before the gate runs.
test("derived-contracts job restores shared dependencies before running the gate", () => {
  const workflow = readFileSync(path.join(rootDir, ".github/workflows/rewrite-ci.yml"), "utf8");
  const start = workflow.indexOf("  derived-contracts:");
  const job = workflow.slice(start, workflow.indexOf("\n  platform-smoke:", start));
  const download = job.indexOf("actions/download-artifact@v4"),
    install = job.indexOf('tar -xf "$RUNNER_TEMP/node-modules.tar" && touch packages/daemon/dist/build-id.txt'),
    gate = job.indexOf("tools/gates/derived-contracts.mjs --check");
  assert.match(job, /needs: install/u);
  assert.ok(
    download > 0 && install > download && gate > install,
    "shared dependencies must be restored before the derived-contracts gate",
  );
});
