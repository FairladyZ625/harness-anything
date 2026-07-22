// harness-test-tier: contract
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { checkPackageBoundaryContract } from "./check-package-boundary-contract.mjs";

test("package boundary contract derives undeclared real dependencies from its package inventory", () => {
  const root = mkdtempSync(path.join(tmpdir(), "ha-package-boundary-"));
  try {
    writeJson(root, "tools/package-boundaries.json", {
      schema: "harness-anything/package-boundaries/v1",
      packages: {
        a: { name: "@fixture/a", root: "packages/a", allowedDependencies: ["b"] },
        b: { name: "@fixture/b", root: "packages/b", allowedDependencies: [] }
      },
      deepSubpaths: []
    });
    writeViolationBaseline(root, []);
    writeJson(root, "packages/a/package.json", { name: "@fixture/a", exports: { ".": "./src/index.ts" } });
    writeJson(root, "packages/b/package.json", { name: "@fixture/b", exports: { ".": "./src/index.ts" } });
    writeText(root, "packages/a/src/index.ts", "export { value } from '@fixture/b';\n");
    writeText(root, "packages/b/src/index.ts", "export const value = 1;\n");

    const result = checkPackageBoundaryContract(root);
    assert.deepEqual(result.findings, ["a must declare dependency @fixture/b"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("package boundary contract rejects a new forbidden edge even when its dependency is declared", () => {
  const root = mkdtempSync(path.join(tmpdir(), "ha-package-boundary-"));
  try {
    writeJson(root, "tools/package-boundaries.json", {
      schema: "harness-anything/package-boundaries/v1",
      packages: {
        a: { name: "@fixture/a", root: "packages/a", allowedDependencies: [] },
        b: { name: "@fixture/b", root: "packages/b", allowedDependencies: [] }
      },
      deepSubpaths: []
    });
    writeViolationBaseline(root, []);
    writeJson(root, "packages/a/package.json", { name: "@fixture/a", exports: { ".": "./src/index.ts" }, dependencies: { "@fixture/b": "0.1.0" } });
    writeJson(root, "packages/b/package.json", { name: "@fixture/b", exports: { ".": "./src/index.ts" } });
    writeText(root, "packages/a/src/index.ts", "export { value } from '@fixture/b';\n");
    writeText(root, "packages/b/src/index.ts", "export const value = 1;\n");

    const result = checkPackageBoundaryContract(root);
    assert.deepEqual(result.findings, [
      "package boundary violation exceeds baseline: packages/a/src/index.ts (a -> b) current=1 baseline=0"
    ]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("package boundary contract accepts only the exact enumerated violation baseline", () => {
  const root = mkdtempSync(path.join(tmpdir(), "ha-package-boundary-"));
  try {
    writeJson(root, "tools/package-boundaries.json", {
      schema: "harness-anything/package-boundaries/v1",
      packages: {
        a: { name: "@fixture/a", root: "packages/a", allowedDependencies: [] },
        b: { name: "@fixture/b", root: "packages/b", allowedDependencies: [] }
      },
      deepSubpaths: []
    });
    writeViolationBaseline(root, [{ file: "packages/a/src/index.ts", source: "a", target: "b", count: 1 }]);
    writeJson(root, "packages/a/package.json", { name: "@fixture/a", exports: { ".": "./src/index.ts" }, dependencies: { "@fixture/b": "0.1.0" } });
    writeJson(root, "packages/b/package.json", { name: "@fixture/b", exports: { ".": "./src/index.ts" } });
    writeText(root, "packages/a/src/index.ts", "export { value } from '@fixture/b';\n");
    writeText(root, "packages/b/src/index.ts", "export const value = 1;\n");

    assert.deepEqual(checkPackageBoundaryContract(root).findings, []);
    writeText(root, "packages/a/src/index.ts", "export { value } from '@fixture/b';\nexport type { Value } from '@fixture/b';\n");
    assert.match(checkPackageBoundaryContract(root).findings.join("\n"), /current=2 baseline=1/u);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("package boundary contract requires owner and sunset for every deep subpath", () => {
  const root = mkdtempSync(path.join(tmpdir(), "ha-package-boundary-"));
  try {
    writeJson(root, "tools/package-boundaries.json", {
      schema: "harness-anything/package-boundaries/v1",
      packages: { a: { name: "@fixture/a", root: "packages/a", allowedDependencies: [] } },
      deepSubpaths: [{ package: "a", subpath: "./internal" }]
    });
    writeViolationBaseline(root, []);
    assert.throws(() => checkPackageBoundaryContract(root), /requires package, subpath, target, owner, sunset, and a non-negative maxProductionConsumers ratchet/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("package boundary contract ratchets deep subpath production consumers", () => {
  const root = mkdtempSync(path.join(tmpdir(), "ha-package-boundary-"));
  try {
    writeJson(root, "tools/package-boundaries.json", {
      schema: "harness-anything/package-boundaries/v1",
      packages: {
        a: { name: "@fixture/a", root: "packages/a", allowedDependencies: ["b"] },
        b: { name: "@fixture/b", root: "packages/b", allowedDependencies: [] }
      },
      deepSubpaths: [{ package: "b", subpath: "./internal", target: "./src/internal.ts", owner: "fixture", sunset: "migrate to root", maxProductionConsumers: 0 }]
    });
    writeViolationBaseline(root, []);
    writeJson(root, "packages/a/package.json", { name: "@fixture/a", exports: { ".": "./src/index.ts" }, dependencies: { "@fixture/b": "0.1.0" } });
    writeJson(root, "packages/b/package.json", { name: "@fixture/b", exports: { ".": "./src/index.ts", "./internal": "./src/internal.ts" } });
    writeText(root, "packages/a/src/index.ts", "export { value } from '@fixture/b/internal';\n");
    writeText(root, "packages/b/src/index.ts", "export { value } from './internal.ts';\n");
    writeText(root, "packages/b/src/internal.ts", "export const value = 1;\n");

    assert.match(checkPackageBoundaryContract(root).findings.join("\n"), /deep subpath consumer count exceeds sunset ratchet: b:\.\/internal current=1 baseline=0/u);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("package boundary contract records source-path strings as real ratcheted edges", () => {
  const root = mkdtempSync(path.join(tmpdir(), "ha-package-boundary-"));
  try {
    writeJson(root, "tools/package-boundaries.json", {
      schema: "harness-anything/package-boundaries/v1",
      packages: {
        a: { name: "@fixture/a", root: "packages/a", allowedDependencies: [] },
        b: { name: "@fixture/b", root: "packages/b", allowedDependencies: [] }
      },
      deepSubpaths: []
    });
    writeJson(root, "tools/package-boundary-violations.json", {
      schema: "harness-anything/package-boundary-violations/v2",
      total: 0,
      violations: [],
      sourcePathTotal: 1,
      sourcePathViolations: [{ file: "packages/a/src/index.ts", source: "a", target: "b", count: 1 }]
    });
    writeJson(root, "packages/a/package.json", { name: "@fixture/a", exports: { ".": "./src/index.ts" } });
    writeJson(root, "packages/b/package.json", { name: "@fixture/b", exports: { ".": "./src/index.ts" } });
    writeText(root, "packages/a/src/index.ts", "export const target = '../../b/src/index.ts';\n");
    writeText(root, "packages/b/src/index.ts", "export const value = 1;\n");

    const result = checkPackageBoundaryContract(root);
    assert.deepEqual(result.findings, []);
    assert.deepEqual([...result.realEdges.get("a")], ["b"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

function writeJson(root, relativePath, value) {
  writeText(root, relativePath, `${JSON.stringify(value, null, 2)}\n`);
}

function writeViolationBaseline(root, violations) {
  writeJson(root, "tools/package-boundary-violations.json", {
    schema: "harness-anything/package-boundary-violations/v2",
    total: violations.reduce((sum, entry) => sum + entry.count, 0),
    violations,
    sourcePathTotal: 0,
    sourcePathViolations: []
  });
}

function writeText(root, relativePath, value) {
  const target = path.join(root, relativePath);
  mkdirSync(path.dirname(target), { recursive: true });
  writeFileSync(target, value, "utf8");
}
