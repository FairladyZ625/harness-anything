import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { migrateBypassWriteAnchors } from "./migrate-bypass-write-anchors.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const checkerPath = path.join(repoRoot, "tools/check-bypass-write-boundary.mjs");

test("bypass write boundary accepts explicitly governed fs write calls", () => {
  const root = makeFixtureRoot();
  const policyRoot = mkdtempSync(path.join(tmpdir(), "ha-w8-policy-"));
  try {
    writeStore(root, [
      "import { writeFileSync } from 'node:fs';",
      "export function apply() {",
      "  writeFileSync('harness/generated-human.md', 'ok', 'utf8');",
      "}"
    ]);
    writeAllowlist(policyRoot, "packages/kernel/src/store/fixture.ts#writeFileSync@1");

    const result = runChecker(root, policyRoot);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /Bypass write boundary check passed/u);
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(policyRoot, { recursive: true, force: true });
  }
});

test("bypass write boundary stable anchors survive unrelated leading lines", () => {
  const root = makeFixtureRoot();
  const policyRoot = mkdtempSync(path.join(tmpdir(), "ha-w8-policy-"));
  try {
    writeStore(root, [
      "// unrelated leading line",
      "import { writeFileSync } from 'node:fs';",
      "export function apply() {",
      "  writeFileSync('harness/generated-human.md', 'ok', 'utf8');",
      "}"
    ]);
    writeAllowlist(policyRoot, "packages/kernel/src/store/fixture.ts#writeFileSync@1");

    const result = runChecker(root, policyRoot);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /Bypass write boundary check passed/u);
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(policyRoot, { recursive: true, force: true });
  }
});

test("bypass write boundary rejects new fs writes outside the allowlist", () => {
  const root = makeFixtureRoot();
  const policyRoot = mkdtempSync(path.join(tmpdir(), "ha-w8-policy-"));
  try {
    writeStore(root, [
      "import * as fs from 'node:fs';",
      "export function bypass() {",
      "  fs.writeFileSync('harness/tasks/task-1/artifacts/evidence.json', '{}', 'utf8');",
      "}"
    ]);
    writeAllowlist(policyRoot);

    const result = runChecker(root, policyRoot);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /packages\/kernel\/src\/store\/fixture\.ts#writeFileSync@1/u);
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(policyRoot, { recursive: true, force: true });
  }
});

test("bypass write boundary rejects stale stable anchors", () => {
  const root = makeFixtureRoot();
  const policyRoot = mkdtempSync(path.join(tmpdir(), "ha-w8-policy-"));
  try {
    writeStore(root, ["export function noWrites() {}"]);
    writeAllowlist(policyRoot, "packages/kernel/src/store/fixture.ts#writeFileSync@1");
    const result = runChecker(root, policyRoot);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /allowlist entry is stale and should be removed/u);
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(policyRoot, { recursive: true, force: true });
  }
});

test("bypass write anchor migration converts legacy positions mechanically", () => {
  const source = {
    schema: "harness-anything/gate-allowlist/v1",
    gateId: "check-bypass-write-boundary",
    entries: {
      coordinatedCore: [{ value: "a.ts#writeFileSync@4:3", ref: "task_X", reason: "fixture" }]
    }
  };
  const result = migrateBypassWriteAnchors(source, [{
    legacyKey: "a.ts#writeFileSync@4:3",
    key: "a.ts#writeFileSync@1"
  }]);
  assert.equal(result.migratedCount, 1);
  assert.equal(result.allowlist.entries.coordinatedCore[0].value, "a.ts#writeFileSync@1");
  assert.equal(source.entries.coordinatedCore[0].value, "a.ts#writeFileSync@4:3");
});

function makeFixtureRoot() {
  const root = mkdtempSync(path.join(tmpdir(), "ha-w8-boundary-"));
  mkdirSync(path.join(root, "packages/kernel/src/store"), { recursive: true });
  mkdirSync(path.join(root, "packages/adapters/local/src"), { recursive: true });
  mkdirSync(path.join(root, "packages/cli/src/commands"), { recursive: true });
  return root;
}

function writeStore(root, lines) {
  writeFileSync(path.join(root, "packages/kernel/src/store/fixture.ts"), `${lines.join("\n")}\n`, "utf8");
}

function writeAllowlist(policyRoot, allowedValue = "packages/kernel/src/store/unused.ts#writeFileSync@1:1") {
  const entry = [{
    value: allowedValue,
    ref: "task_01KWW58383X74ZK28Y068CQ2TG",
    reason: "fixture placeholder"
  }];
  const entries = {
    coordinatedCore: entry,
    exemptHumanOrBootstrap: entry,
    legacyArchive: entry,
    freshGateRegistry: entry
  };
  writeFileSync(path.join(policyRoot, "check-bypass-write-boundary.json"), JSON.stringify({
    schema: "harness-anything/gate-allowlist/v1",
    gateId: "check-bypass-write-boundary",
    entries
  }, null, 2), "utf8");
}

function runChecker(root, policyRoot) {
  return spawnSync(process.execPath, [checkerPath], {
    cwd: root,
    encoding: "utf8",
    env: { ...process.env, HARNESS_GATE_ALLOWLIST_DIR: policyRoot }
  });
}
