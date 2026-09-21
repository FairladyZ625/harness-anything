// harness-test-tier: contract
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

const scriptPath = path.resolve(import.meta.dirname, "check-package-tarball-exports.mjs");

test("tarball exports check passes when declared exports and bin are packed", async () => {
  await withFixtureRepo((root) => {
    writePublicPackage(root, "good", {
      exports: { ".": "./dist/index.js", "./feature": { default: "./dist/feature.js" } },
      bin: { "good-cli": "dist/bin.js" },
      files: ["dist", "README.md", "package.json"],
    });
    writeFileSync(path.join(root, "packages/good/dist/index.js"), "export {};\n");
    writeFileSync(path.join(root, "packages/good/dist/feature.js"), "export {};\n");
    writeFileSync(path.join(root, "packages/good/dist/bin.js"), "#!/usr/bin/env node\n");

    const result = runCheck(root);

    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /Package tarball exports check passed/u);
  });
});

test("tarball exports check fails when an exports target is not packed", async () => {
  await withFixtureRepo((root) => {
    writePublicPackage(root, "bad", {
      exports: { ".": "./dist/index.js", "./client": "./src/client/index.ts" },
      files: ["dist", "README.md", "package.json"],
    });
    writeFileSync(path.join(root, "packages/bad/dist/index.js"), "export {};\n");

    const result = runCheck(root);

    assert.equal(result.status, 1);
    assert.match(result.stderr, /src\/client\/index\.ts is not in the npm pack tarball/u);
  });
});

test("tarball exports check fails when a bin target is not packed", async () => {
  await withFixtureRepo((root) => {
    writePublicPackage(root, "badbin", {
      bin: { "badbin-cli": "dist/bin.js" },
      files: ["dist", "README.md", "package.json"],
    });
    writeFileSync(path.join(root, "packages/badbin/dist/index.js"), "export {};\n");

    const result = runCheck(root);

    assert.equal(result.status, 1);
    assert.match(result.stderr, /bin target dist\/bin\.js is not in the npm pack tarball/u);
  });
});

test("tarball exports check skips private workspace packages", async () => {
  await withFixtureRepo((root) => {
    writeJson(root, "packages/internal/package.json", {
      name: "@fixture/internal",
      version: "0.0.1",
      private: true,
      exports: { ".": "./nowhere.js" },
    });

    const result = runCheck(root);

    assert.equal(result.status, 0, result.stderr);
  });
});

function runCheck(root) {
  return spawnSync(process.execPath, [scriptPath], {
    cwd: root,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
}

async function withFixtureRepo(fn) {
  const root = await mkdtemp(path.join(tmpdir(), "pack-exports-gate-"));
  try {
    writeJson(root, "package.json", {
      name: "fixture-root",
      private: true,
      workspaces: ["packages/*"],
    });
    fn(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

function writePublicPackage(root, dirName, overrides) {
  const dir = `packages/${dirName}`;
  mkdirSync(path.join(root, dir, "dist"), { recursive: true });
  writeJson(root, `${dir}/package.json`, {
    name: `@fixture/${dirName}`,
    version: "0.0.1",
    type: "module",
    ...overrides,
  });
  writeFileSync(path.join(root, dir, "README.md"), `# ${dirName}\n`);
}

function writeJson(root, relativePath, value) {
  const absolute = path.join(root, relativePath);
  mkdirSync(path.dirname(absolute), { recursive: true });
  writeFileSync(absolute, `${JSON.stringify(value, null, 2)}\n`);
}
