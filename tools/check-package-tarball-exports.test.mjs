// harness-test-tier: contract
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

const scriptPath = path.resolve(import.meta.dirname, "check-package-tarball-exports.mjs");

test("checks the manifest produced inside the tarball", async () => {
  await withFixtureRepo((root) => {
    writePackage(root, "good", {
      exports: { ".": "./src/index.ts" },
      files: ["dist", "package.json"],
      scripts: { prepack: "node rewrite-exports.mjs dist", postpack: "node rewrite-exports.mjs src" },
    });
    writeFileSync(path.join(root, "packages/good/dist/index.js"), "export {};\n");
    writeFileSync(
      path.join(root, "packages/good/rewrite-exports.mjs"),
      'import fs from "node:fs"; const p=JSON.parse(fs.readFileSync("package.json")); p.exports={".":`./${process.argv[2]}/index.${process.argv[2]==="dist"?"js":"ts"}`}; fs.writeFileSync("package.json",JSON.stringify(p));\n',
    );

    const result = runCheck(root);

    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /Package tarball exports check passed/u);
  });
});

test("accepts wildcard export targets present in the tarball", async () => {
  await withFixtureRepo((root) => {
    writePackage(root, "wildcard", {
      exports: { "./internal/*.ts": "./dist/*.js" },
      files: ["dist", "package.json"],
    });
    writeFileSync(path.join(root, "packages/wildcard/dist/index.js"), "export {};\n");

    const result = runCheck(root);

    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /Package tarball exports check passed/u);
  });
});

test("rejects a packed manifest that drops declared subpath exports", async () => {
  await withFixtureRepo((root) => {
    writePackage(root, "incomplete", {
      exports: { "./server": "./dist/server.js" },
      publishConfig: { exports: { "./server": "./dist/server.js", "./ui": "./dist/ui.js" } },
      files: ["dist", "package.json"],
    });
    writeFileSync(path.join(root, "packages/incomplete/dist/server.js"), "export {};\n");
    writeFileSync(path.join(root, "packages/incomplete/dist/ui.js"), "export {};\n");

    const result = runCheck(root);
    assert.equal(result.status, 1, result.stdout);
    assert.match(result.stderr, /packed exports differ from publishConfig\.exports/u);
  });
});

test("rejects missing exports and bin targets", async () => {
  await withFixtureRepo((root) => {
    writePackage(root, "bad", {
      exports: { ".": "./dist/index.js", "./client": "./src/client.ts" },
      bin: { bad: "dist/bin.js" },
      files: ["dist", "package.json"],
    });
    writeFileSync(path.join(root, "packages/bad/dist/index.js"), "export {};\n");

    const result = runCheck(root);

    assert.equal(result.status, 1);
    assert.match(result.stderr, /exports target \.\/src\/client\.ts is not in the npm pack tarball/u);
    assert.match(result.stderr, /bin target dist\/bin\.js is not in the npm pack tarball/u);
  });
});

test("skips private workspace packages", async () => {
  await withFixtureRepo((root) => {
    writePackage(root, "internal", { private: true, exports: { ".": "./missing.js" } });
    const result = runCheck(root);
    assert.equal(result.status, 0, result.stderr);
  });
});

test("checks every kernel facet JSON file inside the tarball", async () => {
  await withFixtureRepo((root) => {
    writePackage(root, "kernel", {
      name: "@harness-anything/kernel",
      exports: { ".": "./dist/index.js" },
      files: ["dist"],
    });
    writeFileSync(path.join(root, "packages/kernel/dist/index.js"), "export {};\n");
    const action = "domain/action-source-facets/tools.json",
      contract = "domain/source-contract-facets/kernel.json";
    for (const file of [action, contract]) writeJson(root, `packages/kernel/src/${file}`, {});
    writeJson(root, `packages/kernel/dist/${action}`, {});

    const red = runCheck(root);
    assert.equal(red.status, 1, red.stdout);
    assert.match(red.stderr, /ontology facet target \.\/dist\/domain\/source-contract-facets\/kernel\.json/u);

    writeJson(root, `packages/kernel/dist/${contract}`, {});
    const green = runCheck(root);
    assert.equal(green.status, 0, green.stderr);
  });
});

function runCheck(root) {
  return spawnSync(process.execPath, [scriptPath], { cwd: root, encoding: "utf8" });
}

async function withFixtureRepo(fn) {
  const root = await mkdtemp(path.join(tmpdir(), "pack-exports-gate-"));
  try {
    writeJson(root, "package.json", { name: "fixture-root", private: true, workspaces: ["packages/*"] });
    await fn(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

function writePackage(root, dirName, overrides) {
  mkdirSync(path.join(root, `packages/${dirName}/dist`), { recursive: true });
  writeJson(root, `packages/${dirName}/package.json`, {
    name: `@fixture/${dirName}`,
    version: "0.0.1",
    type: "module",
    ...overrides,
  });
}

function writeJson(root, relativePath, value) {
  const absolute = path.join(root, relativePath);
  mkdirSync(path.dirname(absolute), { recursive: true });
  writeFileSync(absolute, `${JSON.stringify(value, null, 2)}\n`);
}
