// harness-test-tier: fast
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { checkCliInstallability } from "./check-cli-installability.mjs";

test("CLI installability accepts a native terminal dependency only when it is optional", () => {
  const root = installabilityFixture({ nodePtyOptional: true });
  try {
    const result = checkCliInstallability(root);
    assert.equal(result.ok, true);
    assert.deepEqual(result.violations, []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("CLI installability rejects node-pty when it becomes a required daemon dependency", () => {
  const root = installabilityFixture({ nodePtyOptional: false });
  try {
    const result = checkCliInstallability(root);
    assert.equal(result.ok, false);
    assert.deepEqual(result.violations, [
      "packages/daemon -> node-pty: node-pty@1.1.0 has a native install script but no bundled prebuild for linux-x64, linux-arm64; move the capability behind optionalDependencies"
    ]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("CLI installability records prebuild-backed native packages without requiring a compiler", () => {
  const root = installabilityFixture({ nodePtyOptional: true, includePrebuildBacked: true });
  try {
    const result = checkCliInstallability(root);
    assert.equal(result.ok, true);
    assert.deepEqual(result.prebuildBackedNativePackages, ["better-sqlite3@12.11.1"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

function installabilityFixture(options) {
  const root = mkdtempSync(path.join(tmpdir(), "ha-cli-installability-"));
  writeJson(root, "packages/cli/tsconfig.build.json", {
    include: ["src/**/*.ts", "../daemon/src/**/*.ts"]
  });
  writeJson(root, "packages/cli/package.json", {
    name: "@harness-anything/cli",
    dependencies: options.includePrebuildBacked ? { "better-sqlite3": "12.11.1" } : {}
  });
  writeJson(root, "packages/daemon/package.json", {
    name: "@harness-anything/daemon",
    dependencies: options.nodePtyOptional ? {} : { "node-pty": "1.1.0" },
    optionalDependencies: options.nodePtyOptional ? { "node-pty": "1.1.0" } : {}
  });
  writeJson(root, "node_modules/node-pty/package.json", {
    name: "node-pty",
    version: "1.1.0",
    scripts: { install: "node scripts/prebuild.js || node-gyp rebuild" }
  });
  writeFile(root, "node_modules/node-pty/binding.gyp", "{}\n");
  if (options.includePrebuildBacked) {
    writeJson(root, "node_modules/better-sqlite3/package.json", {
      name: "better-sqlite3",
      version: "12.11.1",
      scripts: { install: "prebuild-install || node-gyp rebuild --release" }
    });
    writeFile(root, "node_modules/better-sqlite3/binding.gyp", "{}\n");
  }
  return root;
}

function writeJson(root, relativePath, value) {
  writeFile(root, relativePath, `${JSON.stringify(value, null, 2)}\n`);
}

function writeFile(root, relativePath, body) {
  const file = path.join(root, relativePath);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, body);
}
