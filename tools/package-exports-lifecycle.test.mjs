// harness-test-tier: fast
import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { backupName, ownerName, preparePackageExports, restorePackageExports } from "./package-exports-lifecycle.mjs";

test("prepare publishes dist exports and restore reinstates the source manifest", async () => {
  await withPackage((root, original) => {
    preparePackageExports(root, 999_999_999);
    assert.deepEqual(readPackage(root).exports, original.publishConfig.exports);
    assert.equal(existsSync(path.join(root, backupName)), true);

    restorePackageExports(root);
    assert.deepEqual(readPackage(root), original);
    assert.equal(existsSync(path.join(root, backupName)), false);
    assert.equal(existsSync(path.join(root, ownerName)), false);
  });
});

test("prepare recovers a rewrite left by a dead pack before starting again", async () => {
  await withPackage((root, original) => {
    preparePackageExports(root, 999_999_999);
    const firstPublished = readPackage(root);

    preparePackageExports(root, 999_999_998);
    assert.deepEqual(readPackage(root), firstPublished);
    restorePackageExports(root);
    assert.deepEqual(readPackage(root), original);
  });
});

test("prepare rejects a concurrent pack owned by a live process", async () => {
  await withPackage((root) => {
    preparePackageExports(root, process.pid);
    assert.throws(() => preparePackageExports(root, process.pid), /already being prepared/u);
    restorePackageExports(root);
  });
});

async function withPackage(fn) {
  const root = await mkdtemp(path.join(tmpdir(), "ha-pack-exports-"));
  const original = {
    name: "fixture",
    exports: { ".": "./src/index.ts" },
    publishConfig: { exports: { ".": "./dist/index.js" } },
  };
  writeFileSync(path.join(root, "package.json"), `${JSON.stringify(original, null, 2)}\n`);
  try {
    await fn(root, original);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

function readPackage(root) {
  return JSON.parse(readFileSync(path.join(root, "package.json"), "utf8"));
}
