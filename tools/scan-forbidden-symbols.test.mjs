// harness-test-tier: contract
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const scriptPath = path.join(repoRoot, "tools/scan-forbidden-symbols.mjs");

test("forbidden symbol scan rejects unknown write task sentinel", () => {
  const root = mkdtempSync(path.join(tmpdir(), "ha-forbidden-symbols-"));
  mkdirSync(path.join(root, "packages/kernel/src"), { recursive: true });
  writeFileSync(path.join(root, "packages/kernel/src/bad.ts"), "export const bad = { taskId : 'unknown' };", "utf8");

  assert.throws(
    () => execFileSync(process.execPath, [scriptPath], { cwd: root, encoding: "utf8", stdio: "pipe" }),
    /forbidden symbol taskId: "unknown"/,
  );
});

test("forbidden symbol scan rejects layout override globals", () => {
  const root = mkdtempSync(path.join(tmpdir(), "ha-forbidden-symbols-"));
  mkdirSync(path.join(root, "packages/cli/src"), { recursive: true });
  writeFileSync(
    path.join(root, "packages/cli/src/bad.ts"),
    "setHarnessLayoutOverrides({ authoredRoot: 'harness' });",
    "utf8",
  );

  assert.throws(
    () => execFileSync(process.execPath, [scriptPath], { cwd: root, encoding: "utf8", stdio: "pipe" }),
    /forbidden symbol setHarnessLayoutOverrides/,
  );
});

test("forbidden symbol scan accepts package source without banned tokens", () => {
  const root = mkdtempSync(path.join(tmpdir(), "ha-forbidden-symbols-"));
  mkdirSync(path.join(root, "packages/kernel/src"), { recursive: true });
  writeFileSync(path.join(root, "packages/kernel/src/good.ts"), 'export const ok = { taskId: "task-1" };', "utf8");

  const output = execFileSync(process.execPath, [scriptPath], { cwd: root, encoding: "utf8" });

  assert.match(output, /Forbidden symbol scan passed/);
});

import { spawnSync as runGate } from "node:child_process";
import {
  mkdtempSync as makeGateRoot,
  mkdirSync as makeGateDir,
  writeFileSync as writeGateFile,
  rmSync as removeGateRoot,
} from "node:fs";

const requiredScanRoots = ["packages"];
for (const omitted of requiredScanRoots) {
  for (const state of ["missing", "empty", "excluded-only"]) {
    test(`scan-forbidden-symbols rejects ${state} required scan root ${omitted}`, () => {
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
        const result = runGate(
          process.execPath,
          [path.join(repoRootForDiscovery, "tools/scan-forbidden-symbols.mjs")],
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
