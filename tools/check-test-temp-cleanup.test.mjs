// harness-test-tier: contract
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { checkTestTempCleanup } from "./check-test-temp-cleanup.mjs";

function withSyntheticRoot(fn) {
  const root = mkdtempSync(path.join(tmpdir(), "ha-check-test-temp-cleanup-"));
  try {
    return fn(root);
  } finally {
    rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
}

function writeTestFile(root, relPath, content) {
  const fullPath = path.join(root, relPath);
  mkdirSync(path.dirname(fullPath), { recursive: true });
  writeFileSync(fullPath, content, "utf8");
}

test("positive control: rejects bare recursive rmSync in packages/*/test", () => {
  withSyntheticRoot((root) => {
    writeTestFile(
      root,
      "packages/cli/test/bare-cleanup.test.ts",
      [
        'import { rmSync } from "node:fs";',
        'import * as fs from "node:fs";',
        "export function cleanup(tempDir: string) {",
        "  rmSync(tempDir, { recursive: true, force: true });",
        "  fs.rmSync(tempDir, { recursive: true });",
        "}",
      ].join("\n"),
    );

    const result = checkTestTempCleanup(root);
    assert.equal(result.ok, false);
    assert.equal(result.counts.violations, 2);
    assert.match(result.findings[0], /packages\/cli\/test\/bare-cleanup\.test\.ts:4:/u);
    assert.match(result.findings[0], /removeTempRepository/u);
    assert.match(result.findings[1], /packages\/cli\/test\/bare-cleanup\.test\.ts:5:/u);
  });
});

test("negative control: allows removeTempRepository and non-recursive single-file rmSync", () => {
  withSyntheticRoot((root) => {
    writeTestFile(
      root,
      "packages/cli/test/clean-cleanup.test.ts",
      [
        'import { rmSync } from "node:fs";',
        'import { removeTempRepository } from "../../../tools/fixtures/remove-temp-repository.ts";',
        "// Comment mentioning rmSync(dir, { recursive: true, force: true }) is ignored.",
        "export function cleanup(tempDir: string, singleFile: string) {",
        "  rmSync(singleFile, { force: true });",
        "  removeTempRepository(tempDir);",
        "}",
      ].join("\n"),
    );

    const result = checkTestTempCleanup(root);
    assert.equal(result.ok, true, result.findings.join("\n"));
    assert.equal(result.counts.violations, 0);
    assert.equal(result.counts.filesScanned, 1);
  });
});

test("live repository passes check-test-temp-cleanup with zero violations", () => {
  const result = checkTestTempCleanup(process.cwd());
  assert.equal(result.ok, true, result.findings.join("\n"));
  assert.equal(result.counts.violations, 0);
  assert.ok(result.counts.filesScanned > 500, `expected >500 test files scanned, got ${result.counts.filesScanned}`);
});
