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

test("prepare maps private source exports to dist without adding publish configuration", async () => {
  const original = {
    name: "private-fixture",
    private: true,
    exports: {
      ".": "./src/index.ts",
      "./internal/*": "./src/internal/*.ts",
      "./conditional": { import: "./src/conditional.ts", default: "./src/fallback.ts" },
    },
  };
  await withPackage((root) => {
    preparePackageExports(root, 999_999_999);
    assert.deepEqual(readPackage(root).exports, {
      ".": "./dist/index.js",
      "./internal/*": "./dist/internal/*.js",
      "./conditional": { import: "./dist/conditional.js", default: "./dist/fallback.js" },
    });
    assert.equal("publishConfig" in readPackage(root), false);

    restorePackageExports(root);
    assert.deepEqual(readPackage(root), original);
  }, original);
});

test("prepare still requires publish exports before packing a public package", async () => {
  const original = { name: "public-fixture", exports: { ".": "./src/index.ts" } };
  await withPackage((root) => {
    assert.throws(() => preparePackageExports(root, 999_999_999), /must define publishConfig\.exports/u);
    assert.deepEqual(readPackage(root), original);
    assert.equal(existsSync(path.join(root, backupName)), false);
    assert.equal(existsSync(path.join(root, ownerName)), false);
  }, original);
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

async function withPackage(
  fn,
  original = {
    name: "fixture",
    exports: { ".": "./src/index.ts" },
    publishConfig: { exports: { ".": "./dist/index.js" } },
  },
) {
  const root = await mkdtemp(path.join(tmpdir(), "ha-pack-exports-"));
  writePackage(root, original);
  try {
    await fn(root, original);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

function writePackage(root, value) {
  writeFileSync(path.join(root, "package.json"), `${JSON.stringify(value, null, 2)}\n`);
}

function readPackage(root) {
  return JSON.parse(readFileSync(path.join(root, "package.json"), "utf8"));
}
