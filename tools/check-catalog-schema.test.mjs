// harness-test-tier: contract
import assert from "node:assert/strict";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import test from "node:test";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const checker = path.join(repoRoot, "tools", "check-catalog-schema.mjs");
const assetRelative = "packages/cli/src/commands/extensions/assets/software-coding";

test("catalog contract lock accepts pinned assets and rejects unversioned body drift", () => {
  const root = mkdtempSync(path.join(tmpdir(), "ha-catalog-lock-"));
  try {
    cpSync(path.join(repoRoot, assetRelative), path.join(root, assetRelative), { recursive: true });
    const clean = run(root);
    assert.equal(clean.status, 0, clean.stderr);

    const bodyPath = path.join(root, assetRelative, "templates/task.plan/en-US.md");
    writeFileSync(bodyPath, `${readFileSync(bodyPath, "utf8")}\nUnversioned drift.\n`, "utf8");
    const drifted = run(root);
    assert.equal(drifted.status, 1);
    assert.match(drifted.stderr, /catalog lock mismatch/u);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

function run(root) {
  return spawnSync(process.execPath, [checker], { cwd: root, encoding: "utf8" });
}
