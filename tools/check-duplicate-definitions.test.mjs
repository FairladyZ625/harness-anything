import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

const scriptPath = path.resolve(import.meta.dirname, "check-duplicate-definitions.mjs");

test("duplicate definition check rejects same-package function duplicates", () => {
  const root = makeFixtureRoot();
  writePackage(root, "packages/alpha", "@harness-anything/alpha");
  writeSource(root, "packages/alpha/src/one.ts", "function duplicateHelper() { return 1; }\n");
  writeSource(root, "packages/alpha/src/two.ts", "export function duplicateHelper() { return 2; }\n");

  const result = runCheck(root);

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /alpha\/duplicateHelper: duplicate function definitions/u);
  assert.match(result.stderr, /packages\/alpha\/src\/one\.ts:1/u);
  assert.match(result.stderr, /packages\/alpha\/src\/two\.ts:1/u);
});

test("duplicate definition check allows explicitly allowlisted duplicates", () => {
  const root = makeFixtureRoot();
  writePackage(root, "packages/cli", "@harness-anything/cli");
  writeSource(root, "packages/cli/src/one.ts", "function layoutOverridesFromInput() { return undefined; }\n");
  writeSource(root, "packages/cli/src/two.ts", "function layoutOverridesFromInput() { return undefined; }\n");

  const result = runCheck(root);

  assert.equal(result.status, 0);
  assert.match(result.stdout, /Duplicate function definition check passed/u);
});

test("duplicate definition check ignores duplicates across package boundaries", () => {
  const root = makeFixtureRoot();
  writePackage(root, "packages/alpha", "@harness-anything/alpha");
  writePackage(root, "packages/beta", "@harness-anything/beta");
  writeSource(root, "packages/alpha/src/index.ts", "function sharedName() { return 'alpha'; }\n");
  writeSource(root, "packages/beta/src/index.ts", "function sharedName() { return 'beta'; }\n");

  const result = runCheck(root);

  assert.equal(result.status, 0);
  assert.match(result.stdout, /Duplicate function definition check passed/u);
});

test("duplicate definition check ignores test files and test directories", () => {
  const root = makeFixtureRoot();
  writePackage(root, "packages/alpha", "@harness-anything/alpha");
  writeSource(root, "packages/alpha/src/index.ts", "function productionName() { return true; }\n");
  writeSource(root, "packages/alpha/src/index.test.ts", "function productionName() { return false; }\n");
  writeSource(root, "packages/alpha/src/test/helper.ts", "function productionName() { return false; }\n");

  const result = runCheck(root);

  assert.equal(result.status, 0);
  assert.match(result.stdout, /Duplicate function definition check passed/u);
});

function makeFixtureRoot() {
  const root = mkdtempSync(path.join(tmpdir(), "ha-duplicate-definitions-"));
  writeJson(root, "package.json", {
    name: "fixture",
    workspaces: ["packages/*"]
  });
  return root;
}

function writePackage(root, relativePath, name) {
  writeJson(root, `${relativePath}/package.json`, {
    name,
    type: "module"
  });
}

function writeJson(root, relativePath, value) {
  writeFile(root, relativePath, `${JSON.stringify(value, null, 2)}\n`);
}

function writeSource(root, relativePath, body) {
  writeFile(root, relativePath, body);
}

function writeFile(root, relativePath, body) {
  const absolute = path.join(root, relativePath);
  mkdirSync(path.dirname(absolute), { recursive: true });
  writeFileSync(absolute, body, "utf8");
}

function runCheck(root) {
  return spawnSync(process.execPath, [scriptPath], {
    cwd: root,
    encoding: "utf8"
  });
}
