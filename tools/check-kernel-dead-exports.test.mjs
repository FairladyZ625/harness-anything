import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import test from "node:test";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const checkerPath = path.join(repoRoot, "tools/check-kernel-dead-exports.mjs");

test("kernel dead-export check accepts the repository zero-consumption baseline", () => {
  const result = runChecker(repoRoot);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Kernel dead-export check passed/);
});

test("kernel dead-export check catches new unused value and type exports as bypass fixtures", () => {
  const root = makeFixtureRoot();
  const policyRoot = mkdtempSync(path.join(tmpdir(), "ha-f8a-policy-"));
  try {
    writeKernel(root, [
      "export { usedValue, unusedValue } from './symbols.ts';",
      "export type { UnusedType } from './symbols.ts';"
    ], [
      "export const usedValue = true;",
      "export const unusedValue = false;",
      "export interface UnusedType { readonly ok: boolean; }"
    ]);
    writeConsumer(root, "import { usedValue } from '../../kernel/src/index.ts';\nexport const value = usedValue;\n");
    writeAllowlist(policyRoot, ["NotARealExport"]);

    const result = runChecker(root, { env: { HARNESS_GATE_ALLOWLIST_DIR: policyRoot } });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /kernel export unusedValue has zero non-test consumers/);
    assert.match(result.stderr, /kernel export UnusedType has zero non-test consumers/);
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(policyRoot, { recursive: true, force: true });
  }
});

test("kernel dead-export check treats aliased named imports as real consumers", () => {
  const root = makeFixtureRoot();
  const policyRoot = mkdtempSync(path.join(tmpdir(), "ha-f8a-policy-"));
  try {
    writeKernel(root, [
      "export { usedValue, unusedValue } from './symbols.ts';"
    ], [
      "export const usedValue = true;",
      "export const unusedValue = false;"
    ]);
    writeConsumer(root, "import { usedValue as liveValue } from '../../kernel/src/index.ts';\nexport const value = liveValue;\n");
    writeAllowlist(policyRoot, ["unusedValue"]);

    const result = runChecker(root, { env: { HARNESS_GATE_ALLOWLIST_DIR: policyRoot } });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /Kernel dead-export check passed/);
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(policyRoot, { recursive: true, force: true });
  }
});

function makeFixtureRoot() {
  const root = mkdtempSync(path.join(tmpdir(), "ha-f8a-dead-exports-"));
  mkdirSync(path.join(root, "packages/kernel/src"), { recursive: true });
  mkdirSync(path.join(root, "packages/application/src"), { recursive: true });
  writeFileSync(path.join(root, "packages/kernel/tsconfig.json"), JSON.stringify({
    compilerOptions: {
      module: "NodeNext",
      moduleResolution: "NodeNext",
      target: "ES2024",
      strict: true,
      allowImportingTsExtensions: true,
      noEmit: true
    },
    include: ["src/**/*.ts"]
  }, null, 2), "utf8");
  return root;
}

function writeKernel(root, indexLines, symbolLines) {
  writeFileSync(path.join(root, "packages/kernel/src/index.ts"), `${indexLines.join("\n")}\n`, "utf8");
  writeFileSync(path.join(root, "packages/kernel/src/symbols.ts"), `${symbolLines.join("\n")}\n`, "utf8");
}

function writeConsumer(root, body) {
  writeFileSync(path.join(root, "packages/application/src/consumer.ts"), body, "utf8");
}

function writeAllowlist(policyRoot, names) {
  writeFileSync(path.join(policyRoot, "check-kernel-dead-exports.json"), JSON.stringify({
    schema: "harness-anything/gate-allowlist/v1",
    gateId: "check-kernel-dead-exports",
    entries: {
      zeroConsumptionExports: names.map((name) => ({
        value: name,
        ref: "task_01KWWCBRSV0V3AWTCM3ZZ1J998",
        reason: "fixture allowlist entry"
      }))
    }
  }, null, 2), "utf8");
}

function runChecker(root, options = {}) {
  return spawnSync(process.execPath, [checkerPath], {
    cwd: root,
    encoding: "utf8",
    env: { ...process.env, ...(options.env ?? {}) }
  });
}
