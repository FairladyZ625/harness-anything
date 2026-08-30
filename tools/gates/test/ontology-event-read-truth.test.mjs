// harness-test-tier: fast
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { auditEventReadTruth, main } from "../ontology-event-read-truth.mjs";
import { captureGate, writeRepoFile } from "./helpers.mjs";

const repoRoot = path.resolve(import.meta.dirname, "../../..");

test("G0-3 reports the base advisory and points to an L1 read injected into a narrow branch", () => {
  assert.equal(captureGate(() => main(["--root", repoRoot])).code, 0);
  const rootDir = mkdtempSync(path.join(tmpdir(), "ontology-event-read-"));
  writeRepoFile(
    rootDir,
    "packages/daemon/src/task-query-read.ts",
    [
      'import { readRelationGraphProjection } from "../../kernel/src/index.ts";',
      "function relationGraphPage() {",
      "  return readRelationGraphProjection({ rootDir: process.cwd() });",
      "}",
      "",
    ].join("\n"),
  );
  writeRepoFile(rootDir, "packages/daemon/src/repo-cell-task-query.ts", "export {};\n");
  const result = auditEventReadTruth(rootDir);
  assert.match(
    result.findings.map((finding) => `${finding.file}:${finding.line} ${finding.reason}`).join("\n"),
    /task-query-read\.ts:3.*readRelationGraphProjection/u,
  );
  const positive = captureGate(() => main(["--root", rootDir, "--mode", "ratchet"]));
  assert.equal(positive.code, 1);
  assert.match(positive.stdout, /task-query-read\.ts:3/u);
});
