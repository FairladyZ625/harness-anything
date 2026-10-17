// harness-test-tier: contract
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { findErrorClassificationViolations } from "./check-error-classification.mjs";

test("error classification gate rejects substring classification", () => {
  withTempRoot((rootDir) => {
    const sourceDir = path.join(rootDir, "packages/cli/src");
    mkdirSync(sourceDir, { recursive: true });
    writeFileSync(
      path.join(sourceDir, "bad.ts"),
      [
        "const message = error.message;",
        'if (message.includes("task not found")) throw error;',
        'if (message.startsWith("invalid_registry_key:")) throw error;',
        'if (error.message.startsWith("invalid_registry_key:")) throw error;',
        'if (raw.includes("invalid transition")) throw error;',
        'if (String(cause).includes("lock")) throw error;',
        "return assertNever(error);",
      ].join("\n"),
    );

    const violations = findErrorClassificationViolations(rootDir, ["packages/cli/src"]);

    assert.equal(violations.length, 6);
    assert.deepEqual(
      violations.map((violation) => violation.rule),
      [
        "message-includes",
        "message-starts-with",
        "message-starts-with",
        "raw-includes",
        "stringified-error-includes",
        "cli-error-assert-never",
      ],
    );
  });
});

test("error classification gate allows typed error classification", () => {
  withTempRoot((rootDir) => {
    const sourceDir = path.join(rootDir, "packages/cli/src");
    mkdirSync(sourceDir, { recursive: true });
    writeFileSync(
      path.join(sourceDir, "good.ts"),
      [
        'if (error._tag === "TaskNotFound") return "task_not_found";',
        'if (cause instanceof WriteLockHeldError) return "write_conflict";',
      ].join("\n"),
    );

    assert.deepEqual(findErrorClassificationViolations(rootDir, ["packages/cli/src"]), []);
  });
});

// The gate enumerates through git, so fixture roots must be repositories; the
// local excludesFile pin keeps the host user's global ignores out of the test.
function makeGateRoot(prefix) {
  const rootDir = mkdtempSync(path.join(tmpdir(), prefix));
  for (const args of [
    ["init", "--quiet"],
    ["config", "core.excludesFile", "/dev/null"],
  ])
    execFileSync("git", args, { cwd: rootDir });
  return rootDir;
}

function withTempRoot(fn) {
  const rootDir = makeGateRoot("ha-error-gate-");
  try {
    fn(rootDir);
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
}

import { spawnSync as runGate } from "node:child_process";
import { mkdirSync as makeGateDir, writeFileSync as writeGateFile, rmSync as removeGateRoot } from "node:fs";

const requiredScanRoots = ["packages/cli/src", "packages/kernel/src", "packages/adapters"];
for (const omitted of requiredScanRoots) {
  for (const state of ["missing", "empty", "excluded-only"]) {
    test(`check-error-classification rejects ${state} required scan root ${omitted}`, () => {
      const root = makeGateRoot("ha-gate-discovery-");
      try {
        for (const scanRoot of requiredScanRoots) {
          if (scanRoot === omitted && state === "missing") continue;
          makeGateDir(path.join(root, scanRoot), { recursive: true });
          if (scanRoot !== omitted) writeGateFile(path.join(root, scanRoot, "good.ts"), "export const ok = true;\n");
          if (scanRoot === omitted && state === "excluded-only") {
            makeGateDir(path.join(root, scanRoot, "dist"), { recursive: true });
            writeGateFile(path.join(root, scanRoot, "dist/ignored.ts"), "export const ignored = true;\n");
            writeGateFile(path.join(root, ".gitignore"), "dist/\n");
          }
        }
        const result = runGate(
          process.execPath,
          [path.join(repoRootForDiscovery, "tools/check-error-classification.mjs")],
          { cwd: root, encoding: "utf8" },
        );
        assert.notEqual(result.status, 0, result.stdout + result.stderr);
        assert.match(result.stderr, /ENOENT|no source files/u);
      } finally {
        removeGateRoot(root, { recursive: true, force: true });
      }
    });
  }
}
const repoRootForDiscovery = path.resolve(import.meta.dirname, "..");
