// harness-test-tier: contract
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
      "  /* @gate-identity check-bypass-write-boundary/fixture-write */ writeFileSync('harness/generated-human.md', 'ok', 'utf8');",
      "}"
    ]);
    writeAllowlist(policyRoot, "fixture-write");

    const result = runChecker(root, policyRoot);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /Bypass write boundary check passed/u);
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(policyRoot, { recursive: true, force: true });
  }
});

test("worktree settlement fixture requires every physical write call to be governed", () => {
  const root = makeFixtureRoot();
  const policyRoot = mkdtempSync(path.join(tmpdir(), "ha-w8-policy-"));
  const lines = [
    "import { closeSync, fsyncSync, mkdirSync, openSync, renameSync, writeFileSync } from 'node:fs';",
    "export function settle() {",
    "  /* @gate-identity check-bypass-write-boundary/fixture-mkdir */ mkdirSync('harness/context', { recursive: true });",
    "  const descriptor = /* @gate-identity check-bypass-write-boundary/fixture-open */ openSync('harness/context/.tmp', 'w');",
    "  /* @gate-identity check-bypass-write-boundary/fixture-write */ writeFileSync(descriptor, 'frozen');",
    "  /* @gate-identity check-bypass-write-boundary/fixture-fsync */ fsyncSync(descriptor);",
    "  /* @gate-identity check-bypass-write-boundary/fixture-close */ closeSync(descriptor);",
    "  /* @gate-identity check-bypass-write-boundary/fixture-rename */ renameSync('harness/context/.tmp', 'harness/context/doc.md');",
    "}"
  ];
  const allowed = ["fixture-mkdir", "fixture-open", "fixture-write", "fixture-fsync", "fixture-close", "fixture-rename"];
  try {
    writeStore(root, lines); writeAllowlist(policyRoot, allowed);
    assert.equal(runChecker(root, policyRoot).status, 0);
    writeStore(root, [...lines, "writeFileSync('harness/escape.md', 'escape');"]);
    const rejected = runChecker(root, policyRoot);
    assert.notEqual(rejected.status, 0);
    assert.match(rejected.stderr, /fixture\.ts:.*writeFileSync/u);
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
      "  /* @gate-identity check-bypass-write-boundary/fixture-write */ writeFileSync('harness/generated-human.md', 'ok', 'utf8');",
      "}"
    ]);
    writeAllowlist(policyRoot, "fixture-write");

    const result = runChecker(root, policyRoot);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /Bypass write boundary check passed/u);
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(policyRoot, { recursive: true, force: true });
  }
});

test("source identities survive formatting and a responsibility split into a renamed file", () => {
  const root = makeFixtureRoot();
  const policyRoot = mkdtempSync(path.join(tmpdir(), "ha-w8-policy-"));
  try {
    writeStore(root, [
      "import { writeFileSync } from 'node:fs';",
      "export function apply() { return /* @gate-identity check-bypass-write-boundary/fixture-write */ writeFileSync('harness/generated-human.md', 'ok', 'utf8'); }"
    ]);
    writeAllowlist(policyRoot, "fixture-write");
    assert.equal(runChecker(root, policyRoot).status, 0);

    writeFileSync(path.join(root, "packages/kernel/src/store/generated-human-writer.ts"), [
      "import { writeFileSync } from 'node:fs';",
      "export function writeGeneratedHuman() {",
      "  return /* @gate-identity check-bypass-write-boundary/fixture-write */ writeFileSync(",
      "    'harness/generated-human.md',",
      "    'ok',",
      "    'utf8',",
      "  );",
      "}"
    ].join("\n"), "utf8");
    rmSync(path.join(root, "packages/kernel/src/store/fixture.ts"));

    const moved = runChecker(root, policyRoot);
    assert.equal(moved.status, 0, moved.stderr);
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(policyRoot, { recursive: true, force: true });
  }
});

test("duplicate source identities fail closed", () => {
  const root = makeFixtureRoot();
  const policyRoot = mkdtempSync(path.join(tmpdir(), "ha-w8-policy-"));
  try {
    writeStore(root, [
      "import { writeFileSync } from 'node:fs';",
      "export function apply() {",
      "  /* @gate-identity check-bypass-write-boundary/fixture-write */ writeFileSync('one', 'one');",
      "  /* @gate-identity check-bypass-write-boundary/fixture-write */ writeFileSync('two', 'two');",
      "}"
    ]);
    writeAllowlist(policyRoot, "fixture-write");
    const result = runChecker(root, policyRoot);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /source identity fixture-write is attached to more than one governed call/u);
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(policyRoot, { recursive: true, force: true });
  }
});

test("a stable identity cannot transfer to a different write API", () => {
  const root = makeFixtureRoot();
  const policyRoot = mkdtempSync(path.join(tmpdir(), "ha-w8-policy-"));
  try {
    writeStore(root, [
      "import { rmSync } from 'node:fs';",
      "export function apply() {",
      "  /* @gate-identity check-bypass-write-boundary/fixture-write */ rmSync('harness/generated-human.md');",
      "}"
    ]);
    writeAllowlist(policyRoot, "fixture-write");
    const result = runChecker(root, policyRoot);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /changed API from writeFileSync to rmSync/u);
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
    writeAllowlist(policyRoot, []);

    const result = runChecker(root, policyRoot);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /packages\/kernel\/src\/store\/fixture\.ts:.*writeFileSync/u);
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(policyRoot, { recursive: true, force: true });
  }
});

test("bypass write boundary rejects SQLite access and kernel local mutators outside the coordinator allowlist", () => {
  const root = makeFixtureRoot();
  const policyRoot = mkdtempSync(path.join(tmpdir(), "ha-w8-policy-"));
  try {
    writeFileSync(path.join(root, "packages/kernel/src/local/lease.ts"), [
      "import { DatabaseSync } from 'node:sqlite';",
      "export function bypass() {",
      "  const db = new DatabaseSync('lease.sqlite');",
      "  db.prepare('INSERT INTO lease_cas VALUES (?)').run('x');",
      "}"
    ].join("\n"), "utf8");
    writeAllowlist(policyRoot, []);

    const result = runChecker(root, policyRoot);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /packages\/kernel\/src\/local\/lease\.ts:.*DatabaseSync/u);
    assert.match(result.stderr, /packages\/kernel\/src\/local\/lease\.ts:.*sqlite\.prepare/u);
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
    writeAllowlist(policyRoot, "missing-write");
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
    key: "fixture-write"
  }]);
  assert.equal(result.migratedCount, 1);
  assert.equal(result.allowlist.entries.coordinatedCore[0].value, "fixture-write");
  assert.equal(source.entries.coordinatedCore[0].value, "a.ts#writeFileSync@4:3");
});

function makeFixtureRoot() {
  const root = mkdtempSync(path.join(tmpdir(), "ha-w8-boundary-"));
  mkdirSync(path.join(root, "packages/kernel/src/store"), { recursive: true });
  mkdirSync(path.join(root, "packages/kernel/src/local"), { recursive: true });
  mkdirSync(path.join(root, "packages/kernel/src/projection"), { recursive: true });
  mkdirSync(path.join(root, "packages/adapters/local/src"), { recursive: true });
  mkdirSync(path.join(root, "packages/cli/src/commands"), { recursive: true });
  return root;
}

function writeStore(root, lines) {
  writeFileSync(path.join(root, "packages/kernel/src/store/fixture.ts"), `${lines.join("\n")}\n`, "utf8");
}

function writeAllowlist(policyRoot, allowedValue = []) {
  const apiByIdentity = {
    "fixture-close": "closeSync",
    "fixture-fsync": "fsyncSync",
    "fixture-mkdir": "mkdirSync",
    "fixture-open": "openSync",
    "fixture-rename": "renameSync"
  };
  const entry = (Array.isArray(allowedValue) ? allowedValue : [allowedValue]).map((value) => ({
    value,
    api: apiByIdentity[value] ?? "writeFileSync",
    ref: "task_01KWW58383X74ZK28Y068CQ2TG",
    reason: "fixture placeholder"
  }));
  const entries = {
    coordinatedCore: entry,
    "rebuildable-projection": [],
    exemptHumanOrBootstrap: [],
    legacyArchive: [],
    freshGateRegistry: []
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
