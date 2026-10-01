// harness-test-tier: contract
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const scriptPath = path.join(repoRoot, "tools/check-integrity-single-source.mjs");

test("integrity single-source check rejects duplicate stable hash helpers", () => {
  const root = mkdtempSync(path.join(tmpdir(), "ha-integrity-single-source-"));
  mkdirSync(path.join(root, "packages/kernel/src/projection"), { recursive: true });
  writeFileSync(
    path.join(root, "packages/kernel/src/projection/bad.ts"),
    "function stablePayloadHash(value) { return value; }\n",
    "utf8",
  );

  assert.throws(
    () => execFileSync(process.execPath, [scriptPath], { cwd: root, encoding: "utf8", stdio: "pipe" }),
    /duplicate stablePayloadHash implementation/,
  );
});

test("integrity single-source check rejects duplicate frontmatter scalar helpers", () => {
  const root = mkdtempSync(path.join(tmpdir(), "ha-integrity-single-source-"));
  mkdirSync(path.join(root, "packages/adapters/local/src"), { recursive: true });
  writeFileSync(
    path.join(root, "packages/adapters/local/src/bad.ts"),
    "export function readScalar(frontmatter, key) { return frontmatter + key; }\n",
    "utf8",
  );

  assert.throws(
    () => execFileSync(process.execPath, [scriptPath], { cwd: root, encoding: "utf8", stdio: "pipe" }),
    /duplicate readScalar implementation/,
  );
});

test("integrity single-source check accepts imports and unrelated byte hashes", () => {
  const root = mkdtempSync(path.join(tmpdir(), "ha-integrity-single-source-"));
  mkdirSync(path.join(root, "packages/kernel/src/integrity"), { recursive: true });
  mkdirSync(path.join(root, "packages/kernel/src/markdown"), { recursive: true });
  mkdirSync(path.join(root, "packages/cli/src/commands"), { recursive: true });
  writeFileSync(
    path.join(root, "packages/kernel/src/integrity/stable-hash.ts"),
    "export function sha256Text(text) { return text; }\nexport function stablePayloadHash(value) { return value; }\nexport function stableStringify(value) { return String(value); }\n",
    "utf8",
  );
  writeFileSync(
    path.join(root, "packages/kernel/src/markdown/frontmatter.ts"),
    "export function readFrontmatter(body) { return body; }\nexport function readScalar(frontmatter, key) { return frontmatter + key; }\nexport function readNestedScalar(block, key) { return block + key; }\n",
    "utf8",
  );
  writeFileSync(
    path.join(root, "packages/cli/src/commands/good.ts"),
    "import { createHash } from 'node:crypto';\nimport { stablePayloadHash } from '@harness-anything/kernel/internal/integrity/stable-hash';\nexport const ok = [stablePayloadHash({ a: 1 }), createHash('sha256').update('bytes').digest('hex')];\n",
    "utf8",
  );

  const output = execFileSync(process.execPath, [scriptPath], { cwd: root, encoding: "utf8" });

  assert.match(output, /Integrity single-source check passed/);
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
    test(`check-integrity-single-source rejects ${state} required scan root ${omitted}`, () => {
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
          [path.join(repoRootForDiscovery, "tools/check-integrity-single-source.mjs")],
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
