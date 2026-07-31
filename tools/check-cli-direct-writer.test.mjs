// harness-test-tier: contract
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

const checkerPath = path.resolve("tools/check-cli-direct-writer.mjs");

test("CLI direct-writer gate reports a newly introduced coordinator sink at file:line", () => {
  const root = mkdtempSync(path.join(tmpdir(), "ha-cli-direct-writer-"));
  try {
    const sourceDir = path.join(root, "packages/cli/src");
    mkdirSync(sourceDir, { recursive: true });
    writeFileSync(path.join(sourceDir, "undeclared-writer.ts"), [
      'import { makeOperationalJournaledWriteCoordinator } from "@harness-anything/kernel";',
      "export function write(rootDir: string) {",
      "  return makeOperationalJournaledWriteCoordinator({ rootDir, operationalActor: { scope: 'operational', kind: 'agent', id: 'rogue' } });",
      "}",
      ""
    ].join("\n"), "utf8");

    const result = spawnSync(process.execPath, [checkerPath, "--root", root], { encoding: "utf8" });

    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /packages\/cli\/src\/undeclared-writer\.ts:3:\d+ \[coordinator\]/u);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("CLI direct-writer gate defers filesystem write inventory to the write-road registry", () => {
  const root = mkdtempSync(path.join(tmpdir(), "ha-cli-direct-writer-close-"));
  try {
    const sourceDir = path.join(root, "packages/cli/src");
    mkdirSync(sourceDir, { recursive: true });
    writeFileSync(path.join(sourceDir, "close-writer.ts"), [
      'import { writeFileSync } from "node:fs";',
      "export function writeNow() {",
      "  writeFileSync('harness/tasks/task-1/INDEX.md', '# undeclared', 'utf8');",
      "}",
      ""
    ].join("\n"), "utf8");

    const result = spawnSync(process.execPath, [checkerPath, "--root", root], { encoding: "utf8" });

    assert.equal(result.status, 0, result.stderr);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
