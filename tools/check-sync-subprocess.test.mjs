// harness-test-tier: fast
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
  checkSyncSubprocess,
  inventoryCounts,
  scanSyncSubprocess
} from "./check-sync-subprocess.mjs";

const repoRoot = path.resolve(import.meta.dirname, "..");

test("repository inventory freezes the governed API and syntax-kind multisets", () => {
  const counts = inventoryCounts(scanSyncSubprocess(repoRoot));
  assert.equal(counts.total, 17);
  assert.deepEqual(counts.kinds, { import: 7, call: 10 });
  assert.deepEqual(counts.apis, { execFileSync: 15, spawnSync: 2 });
});

test("renamed named imports are resolved while comments and strings are ignored", () => {
  withFixture({
    "packages/daemon/src/worker.ts": 'import { execFileSync as run, spawn } from "node:child_process";\nimport type { execSync } from "node:child_process";\n// spawnSync("ignored")\nconst note = "execSync()";\nexport function invoke() { return run("git", ["status"]); }\n'
  }, (root) => {
    const sites = scanSyncSubprocess(root);
    assert.equal(sites.length, 2);
    assert.deepEqual(sites.map(({ kind, api }) => ({ kind, api })), [
      { kind: "import", api: "execFileSync" },
      { kind: "call", api: "execFileSync" }
    ]);
  });
});

test("namespace imports and CommonJS destructuring retain node:child_process provenance", () => {
  withFixture({
    "packages/kernel/src/namespace.ts": 'import * as childProcess from "node:child_process";\nexport const run = () => childProcess["spawnSync"]("git");\n',
    "packages/daemon/src/common.cjs": 'const { execSync: execute } = require("node:child_process");\nexecute("git status");\n'
  }, (root) => {
    const sites = scanSyncSubprocess(root);
    assert.deepEqual(sites.map(({ kind, api }) => ({ kind, api })), [
      { kind: "import", api: "execSync" },
      { kind: "call", api: "execSync" },
      { kind: "call", api: "spawnSync" }
    ]);
  });
});

test("indirect references and direct module access cannot bypass call detection", () => {
  withFixture({
    "packages/kernel/src/alias.ts": 'import { execSync } from "node:child_process";\nexport const indirect = execSync;\n',
    "packages/daemon/src/direct.cjs": 'require("node:child_process").spawnSync("git");\n'
  }, (root) => {
    const sites = scanSyncSubprocess(root);
    assert.deepEqual(sites.map(({ kind, api }) => ({ kind, api })), [
      { kind: "call", api: "spawnSync" },
      { kind: "import", api: "execSync" },
      { kind: "reference", api: "execSync" }
    ]);
  });
});

test("a new spawnSync site fails the ratchet", () => {
  withFixture({
    "packages/daemon/src/new-site.ts": 'import { spawnSync } from "node:child_process";\nexport function launch() { return spawnSync("git", ["status"]); }\n'
  }, (root) => {
    const findings = checkSyncSubprocess(scanSyncSubprocess(root), []);
    assert.equal(findings.filter((finding) => finding.includes("new synchronous subprocess")).length, 2, findings.join("\n"));
    assert.ok(findings.some((finding) => finding.includes("(spawnSync)")), findings.join("\n"));
  });
});

test("source identities survive formatting, responsibility split, and file rename", () => {
  withFixture({
    "packages/kernel/src/git.ts": 'import { /* @gate-identity check-sync-subprocess/sync-fixture-import */ execFileSync } from "node:child_process";\nexport function run() { return /* @gate-identity check-sync-subprocess/sync-fixture-call */ execFileSync("git", ["status"]); }\n'
  }, (root) => {
    const original = scanSyncSubprocess(root);
    const baseline = [
      { key: "sync-fixture-import", kind: "import", api: "execFileSync" },
      { key: "sync-fixture-call", kind: "call", api: "execFileSync" }
    ];
    assert.deepEqual(checkSyncSubprocess(original, baseline), []);

    const movedPath = path.join(root, "packages/daemon/src/git-runner.ts");
    mkdirSync(path.dirname(movedPath), { recursive: true });
    writeFileSync(movedPath, [
      'import { /* @gate-identity check-sync-subprocess/sync-fixture-import */ execFileSync } from "node:child_process";',
      "export function runGitStatus() {",
      "  return /* @gate-identity check-sync-subprocess/sync-fixture-call */ execFileSync(",
      '    "git",',
      '    ["status"],',
      "  );",
      "}"
    ].join("\n"));
    rmSync(path.join(root, "packages/kernel/src/git.ts"));
    const moved = scanSyncSubprocess(root);
    assert.deepEqual(moved.map((site) => site.key), original.map((site) => site.key));
    assert.deepEqual(checkSyncSubprocess(moved, baseline), []);
  });
});

test("duplicate source identities fail closed", () => {
  withFixture({
    "packages/kernel/src/git.ts": 'import { /* @gate-identity check-sync-subprocess/sync-fixture */ execFileSync } from "node:child_process";\nexport function run() { return /* @gate-identity check-sync-subprocess/sync-fixture */ execFileSync("git"); }\n'
  }, (root) => {
    const findings = checkSyncSubprocess(scanSyncSubprocess(root), [
      { key: "sync-fixture", kind: "import", api: "execFileSync" }
    ]);
    assert.ok(findings.some((finding) => finding.includes("duplicate source identity")), findings.join("\n"));
  });
});

test("a stable identity cannot transfer to a different synchronous API", () => {
  withFixture({
    "packages/kernel/src/git.ts": 'import { /* @gate-identity check-sync-subprocess/sync-fixture-import */ execSync } from "node:child_process";\nexport function run() { return /* @gate-identity check-sync-subprocess/sync-fixture-call */ execSync("git status"); }\n'
  }, (root) => {
    const findings = checkSyncSubprocess(scanSyncSubprocess(root), [
      { key: "sync-fixture-import", kind: "import", api: "execFileSync" },
      { key: "sync-fixture-call", kind: "call", api: "execFileSync" }
    ]);
    assert.equal(findings.filter((finding) => finding.includes("baseline freezes")).length, 2, findings.join("\n"));
  });
});

test("deleted sites make baseline entries stale", () => {
  withFixture({
    "packages/daemon/src/clean.ts": "export const clean = true;\n"
  }, (root) => {
    const findings = checkSyncSubprocess(scanSyncSubprocess(root), [
      { key: "sync-deleted", kind: "call", api: "execFileSync" }
    ]);
    assert.match(findings[0], /stale baseline entry/u);
  });
});

function withFixture(files, run) {
  const root = mkdtempSync(path.join(tmpdir(), "ha-sync-subprocess-"));
  try {
    for (const [relative, content] of Object.entries(files)) {
      const file = path.join(root, relative);
      mkdirSync(path.dirname(file), { recursive: true });
      writeFileSync(file, content);
    }
    run(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}
