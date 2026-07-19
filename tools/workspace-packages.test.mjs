// harness-test-tier: fast
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { discoverWorkspacePackages, discoverWorkspaceSourceRoots } from "./workspace-packages.mjs";

test("workspace package inventory expands root workspace patterns and deduplicates overlap", () => {
  const root = mkdtempSync(path.join(tmpdir(), "ha-workspaces-"));
  try {
    writeJson(root, "package.json", { workspaces: ["packages/*", "packages/adapters/*"] });
    writeJson(root, "packages/core/package.json", { name: "core" });
    writeJson(root, "packages/adapters/local/package.json", { name: "local" });
    mkdirSync(path.join(root, "packages/core/src"), { recursive: true });
    mkdirSync(path.join(root, "packages/adapters/local/src"), { recursive: true });

    assert.deepEqual(discoverWorkspacePackages(root).map((entry) => entry.relativeRoot), [
      "packages/adapters/local",
      "packages/core"
    ]);
    assert.deepEqual(discoverWorkspaceSourceRoots(root), [
      "packages/adapters/local/src",
      "packages/core/src"
    ]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

function writeJson(root, relativePath, value) {
  const target = path.join(root, relativePath);
  mkdirSync(path.dirname(target), { recursive: true });
  writeFileSync(target, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}
