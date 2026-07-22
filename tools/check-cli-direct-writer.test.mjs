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

test("CLI direct-writer gate reports shared fs APIs until their exact scoped registry key is declared", () => {
  const root = mkdtempSync(path.join(tmpdir(), "ha-cli-direct-writer-close-"));
  try {
    const sourceDir = path.join(root, "packages/cli/src");
    mkdirSync(sourceDir, { recursive: true });
    writeFileSync(path.join(sourceDir, "close-writer.ts"), [
      'import { closeSync } from "node:fs";',
      "export function closeNow(fd: number) {",
      "  closeSync(fd);",
      "}",
      ""
    ].join("\n"), "utf8");

    const result = spawnSync(process.execPath, [checkerPath, "--root", root], { encoding: "utf8" });

    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /packages\/cli\/src\/close-writer\.ts:3:\d+ \[canonical-fs\] closeSync/u);
    mkdirSync(path.join(root, "tools"), { recursive: true });
    writeFileSync(path.join(root, "tools/write-road-registry.json"), JSON.stringify({
      rows: [{
        id: "repository.bootstrap.admin",
        channel: { pathClass: "admin-bootstrap" },
        directWrites: [{ key: "packages/cli/src/close-writer.ts#closeSync@2" }]
      }]
    }), "utf8");

    const mismatched = spawnSync(process.execPath, [checkerPath, "--root", root], { encoding: "utf8" });
    assert.notEqual(mismatched.status, 0);
    assert.match(mismatched.stderr, /closeSync is not in a declared bootstrap\/local\/derived\/transport scope/u);

    writeFileSync(path.join(root, "tools/write-road-registry.json"), JSON.stringify({
      rows: [{
        id: "repository.bootstrap.admin",
        channel: { pathClass: "admin-bootstrap" },
        directWrites: [{ key: "packages/cli/src/close-writer.ts#closeSync@1" }]
      }]
    }), "utf8");

    const declared = spawnSync(process.execPath, [checkerPath, "--root", root], { encoding: "utf8" });
    assert.equal(declared.status, 0, declared.stderr);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
