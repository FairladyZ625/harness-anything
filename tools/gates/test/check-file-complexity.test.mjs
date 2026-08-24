// harness-test-tier: contract
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";
import test from "node:test";

const scriptPath = path.resolve(import.meta.dirname, "../../check-file-complexity.mjs");
const repoRoot = path.resolve(import.meta.dirname, "../../..");

// The single-file line-count check is suspended under dec_3879E19D9D1D76BAD538E77C1F
// while the remaining compressed production files are bulk-restored
// (task_2c909af2cae0b23abd1e34a2e2). This test is deliberately self-enforcing rather
// than a comment someone has to remember to read: it asserts the exact suspension
// notice appears in stdout, not merely that the script exits 0. Once the guard is
// removed, the real walk runs instead and prints either "File complexity check
// passed." or a list of violations — either way this assertion goes red on its own,
// forcing whoever re-enables the gate to also retire this test instead of leaving a
// stale, silent comment behind.
test("check-file-complexity stays suspended under dec_3879E19D9D1D76BAD538E77C1F until this assertion is retired", () => {
  const result = spawnSync(process.execPath, [scriptPath], { cwd: repoRoot, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /suspended under dec_3879E19D9D1D76BAD538E77C1F/u);
  assert.match(result.stdout, /task_2c909af2cae0b23abd1e34a2e2/u);
});
