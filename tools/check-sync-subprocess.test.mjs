// harness-test-tier: fast
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { checkSyncSubprocess, inventoryCounts, scanSyncSubprocess } from "./check-sync-subprocess.mjs";

const repoRoot = path.resolve(import.meta.dirname, "..");

test("repository inventory freezes the governed API and syntax-kind multisets", () => {
  const counts = inventoryCounts(scanSyncSubprocess(repoRoot));
  // dec_BBA713052997C3EF5F5D3DD952 moved schedule occurrence worktrees onto the async managed-worktree path,
  // retiring its five synchronous git sites.
  assert.equal(counts.total, 13);
  assert.deepEqual(counts.kinds, { import: 5, call: 8 });
  assert.deepEqual(counts.apis, { execFileSync: 11, spawnSync: 2 });
});

test("renamed named imports are resolved while comments and strings are ignored", () => {
  withFixture(
    {
      "packages/daemon/src/worker.ts":
        'import { execFileSync as run, spawn } from "node:child_process";\nimport type { execSync } from "node:child_process";\n// spawnSync("ignored")\nconst note = "execSync()";\nexport function invoke() { return run("git", ["status"]); }\n',
    },
    (root) => {
      const sites = scanSyncSubprocess(root);
      assert.equal(sites.length, 2);
      assert.deepEqual(
        sites.map(({ kind, api }) => ({ kind, api })),
        [
          { kind: "import", api: "execFileSync" },
          { kind: "call", api: "execFileSync" },
        ],
      );
    },
  );
});

test("namespace imports and CommonJS destructuring retain node:child_process provenance", () => {
  withFixture(
    {
      "packages/kernel/src/namespace.ts":
        'import * as childProcess from "node:child_process";\nexport const run = () => childProcess["spawnSync"]("git");\n',
      "packages/daemon/src/common.cjs":
        'const { execSync: execute } = require("node:child_process");\nexecute("git status");\n',
    },
    (root) => {
      const sites = scanSyncSubprocess(root);
      assert.deepEqual(
        sites.map(({ kind, api }) => ({ kind, api })),
        [
          { kind: "import", api: "execSync" },
          { kind: "call", api: "execSync" },
          { kind: "call", api: "spawnSync" },
        ],
      );
    },
  );
});

test("indirect references and direct module access cannot bypass call detection", () => {
  withFixture(
    {
      "packages/kernel/src/alias.ts":
        'import { execSync } from "node:child_process";\nexport const indirect = execSync;\n',
      "packages/daemon/src/direct.cjs": 'require("node:child_process").spawnSync("git");\n',
    },
    (root) => {
      const sites = scanSyncSubprocess(root);
      assert.deepEqual(
        sites.map(({ kind, api }) => ({ kind, api })),
        [
          { kind: "call", api: "spawnSync" },
          { kind: "import", api: "execSync" },
          { kind: "reference", api: "execSync" },
        ],
      );
    },
  );
});

test("a new spawnSync site fails the ratchet", () => {
  withFixture(
    {
      "packages/daemon/src/new-site.ts":
        'import { spawnSync } from "node:child_process";\nexport function launch() { return spawnSync("git", ["status"]); }\n',
    },
    (root) => {
      const findings = checkSyncSubprocess(scanSyncSubprocess(root), []);
      assert.equal(
        findings.filter((finding) => finding.includes("new synchronous subprocess")).length,
        2,
        findings.join("\n"),
      );
      assert.ok(
        findings.some((finding) => finding.includes("(spawnSync)")),
        findings.join("\n"),
      );
    },
  );
});

test("source identities survive formatting, responsibility split, and file rename", () => {
  withFixture(
    {
      "packages/kernel/src/git.ts":
        'import { /* @gate-identity check-sync-subprocess/sync-fixture-import */ execFileSync } from "node:child_process";\nexport function run() { return /* @gate-identity check-sync-subprocess/sync-fixture-call */ execFileSync("git", ["status"]); }\n',
    },
    (root) => {
      const original = scanSyncSubprocess(root);
      const baseline = [
        { key: "sync-fixture-import", kind: "import", api: "execFileSync" },
        { key: "sync-fixture-call", kind: "call", api: "execFileSync" },
      ];
      assert.deepEqual(checkSyncSubprocess(original, baseline), []);

      const movedPath = path.join(root, "packages/daemon/src/git-runner.ts");
      mkdirSync(path.dirname(movedPath), { recursive: true });
      writeFileSync(
        movedPath,
        [
          'import { /* @gate-identity check-sync-subprocess/sync-fixture-import */ execFileSync } from "node:child_process";',
          "export function runGitStatus() {",
          "  return /* @gate-identity check-sync-subprocess/sync-fixture-call */ execFileSync(",
          '    "git",',
          '    ["status"],',
          "  );",
          "}",
        ].join("\n"),
      );
      rmSync(path.join(root, "packages/kernel/src/git.ts"));
      const moved = scanSyncSubprocess(root);
      assert.deepEqual(
        moved.map((site) => site.key),
        original.map((site) => site.key),
      );
      assert.deepEqual(checkSyncSubprocess(moved, baseline), []);
    },
  );
});

test("duplicate source identities fail closed", () => {
  withFixture(
    {
      "packages/kernel/src/git.ts":
        'import { /* @gate-identity check-sync-subprocess/sync-fixture */ execFileSync } from "node:child_process";\nexport function run() { return /* @gate-identity check-sync-subprocess/sync-fixture */ execFileSync("git"); }\n',
    },
    (root) => {
      const findings = checkSyncSubprocess(scanSyncSubprocess(root), [
        { key: "sync-fixture", kind: "import", api: "execFileSync" },
      ]);
      assert.ok(
        findings.some((finding) => finding.includes("duplicate source identity")),
        findings.join("\n"),
      );
    },
  );
});

test("a stable identity cannot transfer to a different synchronous API", () => {
  withFixture(
    {
      "packages/kernel/src/git.ts":
        'import { /* @gate-identity check-sync-subprocess/sync-fixture-import */ execSync } from "node:child_process";\nexport function run() { return /* @gate-identity check-sync-subprocess/sync-fixture-call */ execSync("git status"); }\n',
    },
    (root) => {
      const findings = checkSyncSubprocess(scanSyncSubprocess(root), [
        { key: "sync-fixture-import", kind: "import", api: "execFileSync" },
        { key: "sync-fixture-call", kind: "call", api: "execFileSync" },
      ]);
      assert.equal(findings.filter((finding) => finding.includes("baseline freezes")).length, 2, findings.join("\n"));
    },
  );
});

test("deleted sites make baseline entries stale", () => {
  withFixture(
    {
      "packages/daemon/src/clean.ts": "export const clean = true;\n",
    },
    (root) => {
      const findings = checkSyncSubprocess(scanSyncSubprocess(root), [
        { key: "sync-deleted", kind: "call", api: "execFileSync" },
      ]);
      assert.match(findings[0], /stale baseline entry/u);
    },
  );
});

function withFixture(files, run) {
  const root = mkdtempSync(path.join(tmpdir(), "ha-sync-subprocess-"));
  try {
    for (const scanRoot of ["packages/daemon/src", "packages/kernel/src"]) {
      mkdirSync(path.join(root, scanRoot), { recursive: true });
      writeFileSync(path.join(root, scanRoot, "clean.ts"), "export const clean = true;\n");
    }
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

import { spawnSync as runGate } from "node:child_process";
import {
  mkdtempSync as makeGateRoot,
  mkdirSync as makeGateDir,
  writeFileSync as writeGateFile,
  rmSync as removeGateRoot,
} from "node:fs";

const requiredScanRoots = ["packages/daemon/src", "packages/kernel/src"];
for (const omitted of requiredScanRoots) {
  for (const state of ["missing", "empty", "excluded-only"]) {
    test(`check-sync-subprocess rejects ${state} required scan root ${omitted}`, () => {
      const root = makeGateRoot(path.join(tmpdir(), "ha-gate-discovery-"));
      try {
        for (const scanRoot of requiredScanRoots) {
          if (scanRoot === omitted && state === "missing") continue;
          makeGateDir(path.join(root, scanRoot), { recursive: true });
          if (scanRoot !== omitted) writeGateFile(path.join(root, scanRoot, "good.ts"), "export const ok = true;\n");
          if (scanRoot === omitted && state === "excluded-only") {
            makeGateDir(path.join(root, scanRoot, "dist"), { recursive: true });
            writeGateFile(path.join(root, scanRoot, "dist/ignored.ts"), "export const ignored = true;\n");
          }
        }
        const result = runGate(process.execPath, [path.join(repoRootForDiscovery, "tools/check-sync-subprocess.mjs")], {
          cwd: root,
          encoding: "utf8",
        });
        assert.notEqual(result.status, 0, result.stdout + result.stderr);
        assert.match(result.stderr, /ENOENT|no source files/u);
      } finally {
        removeGateRoot(root, { recursive: true, force: true });
      }
    });
  }
}
const repoRootForDiscovery = path.resolve(import.meta.dirname, "..");

// An empty ratchet must not turn lost source coverage into a passing scan.
test("empty baseline cannot wash out missing source discovery", () => {
  const root = mkdtempSync(path.join(tmpdir(), "ha-sync-empty-baseline-"));
  try {
    assert.throws(() => checkSyncSubprocess(scanSyncSubprocess(root), []), /ENOENT/u);
    for (const scanRoot of requiredScanRoots) mkdirSync(path.join(root, scanRoot), { recursive: true });
    assert.throws(() => checkSyncSubprocess(scanSyncSubprocess(root), []), /no source files/u);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
