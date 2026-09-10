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
      'import { readMarkdown } from "../../kernel/src/index.ts";',
      "function relationGraphPage() {",
      '  return readMarkdown("harness/tasks/task_x/INDEX.md");',
      "}",
      "",
    ].join("\n"),
  );
  writeRepoFile(rootDir, "packages/daemon/src/repo-cell-task-query.ts", "export {};\n");
  writeRepoFile(
    rootDir,
    "packages/daemon/src/agent-runtime-read.ts",
    [
      "export function runtimeReads(input) {",
      "  return {",
      "    events: () => {",
      "      const source = input.store.readHead()?.revision ?? 0;",
      "      return { source };",
      "    },",
      "  };",
      "}",
      "",
    ].join("\n"),
  );
  const result = auditEventReadTruth(rootDir);
  assert.match(
    result.findings.map((finding) => `${finding.file}:${finding.line} ${finding.reason}`).join("\n"),
    /task-query-read\.ts:3.*readMarkdown/u,
  );
  assert.match(
    result.findings.map((finding) => `${finding.file}:${finding.line} ${finding.reason}`).join("\n"),
    /agent-runtime-read\.ts:3.*source cursor must come from the projection reader watermark/u,
  );
  const positive = captureGate(() => main(["--root", rootDir, "--mode", "ratchet"]));
  assert.equal(positive.code, 1);
  assert.match(positive.stdout, /task-query-read\.ts:3/u);
});
