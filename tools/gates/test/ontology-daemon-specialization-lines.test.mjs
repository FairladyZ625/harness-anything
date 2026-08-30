// harness-test-tier: fast
import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { evaluateSpecializationLines, main } from "../ontology-daemon-specialization-lines.mjs";
import { captureGate, makeRepo, writeRepoFile } from "./helpers.mjs";

const repoRoot = path.resolve(import.meta.dirname, "../../..");
const sourcePath = "packages/daemon/src/repo-cell-action-dispatch.ts";
const baselinePath = "tools/gates/ontology-daemon-specialization-lines.json";

function baseline(limit) {
  return `${JSON.stringify({ schema: "ontology-daemon-specialization-lines/v1", files: { [sourcePath]: limit } })}\n`;
}

test("G0-5 ratchet accepts the repository, detects growth, and refuses an upward baseline", () => {
  assert.equal(captureGate(() => main(["--root", repoRoot, "--base", "origin/main", "--mode", "ratchet"])).code, 0);
  const { rootDir, base } = makeRepo({ [sourcePath]: "one\ntwo\n", [baselinePath]: baseline(2) });
  writeRepoFile(rootDir, sourcePath, "one\ntwo\nthree\nfour\nfive\nsix\nseven\n");
  const growth = evaluateSpecializationLines({ rootDir, base });
  assert.match(growth.findings.join("\n"), /exceeds baseline 2 by 5 lines/u);

  writeRepoFile(rootDir, baselinePath, baseline(7));
  const raised = evaluateSpecializationLines({ rootDir, base });
  assert.match(raised.findings.join("\n"), /shrink-only baseline rose from 2 to 7/u);
  const positive = captureGate(() => main(["--root", rootDir, "--base", base, "--mode", "ratchet"]));
  assert.equal(positive.code, 1);
  assert.match(positive.stderr, /shrink-only baseline rose from 2 to 7/u);
});
