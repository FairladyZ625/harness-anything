// harness-test-tier: contract
import assert from "node:assert/strict";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

const repoRoot = path.resolve(import.meta.dirname, "..");

test("stage0 manifest checker accepts the pinned public charter", () => {
  withFixture((root) => {
    const result = run(root);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /stage0-manifest: GREEN/u);
  });
});

test("stage0 manifest checker rejects unpinned charter text drift", () => {
  withFixture((root) => {
    const manifestPath = path.join(root, "docs-release/constitution/stage0.md");
    writeFileSync(manifestPath, `${readFileSync(manifestPath, "utf8")}\n漂移。\n`, "utf8");

    const result = run(root);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /pin: 不符/u);
  });
});

test("stage0 manifest checker rejects machine block drift", () => {
  withFixture((root) => {
    const manifestPath = path.join(root, "docs-release/constitution/stage0.md");
    const manifest = readFileSync(manifestPath, "utf8");
    writeFileSync(manifestPath, manifest.replace("[directed, undirected]", "[directed]"), "utf8");

    const result = run(root);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /relationDirections: 漂移/u);
  });
});

function withFixture(fn) {
  const root = mkdtempSync(path.join(tmpdir(), "ha-stage0-manifest-"));
  try {
    for (const relative of [
      "tools/check-stage0-manifest.mjs",
      "docs-release/constitution",
      "packages/kernel/src/domain/entity-relation.ts",
      "packages/kernel/src/domain/lifecycle-status.ts",
      "packages/kernel/src/domain/decision-lifecycle-status.ts"
    ]) {
      cpSync(path.join(repoRoot, relative), path.join(root, relative), { recursive: true });
    }
    fn(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function run(root) {
  return spawnSync(process.execPath, ["tools/check-stage0-manifest.mjs"], {
    cwd: root,
    encoding: "utf8"
  });
}
