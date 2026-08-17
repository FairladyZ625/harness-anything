// harness-test-tier: integration
import assert from "node:assert/strict";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { checkDomainJudgmentSingleDefinition } from "./check-domain-judgment-single-definition.mjs";

const repoRoot = path.resolve(import.meta.dirname, "..");

test("domain judgment single-definition gate accepts the repository", () => {
  const result = spawnSync("node", [path.join(repoRoot, "tools/check-domain-judgment-single-definition.mjs")], { cwd: repoRoot, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /four judgments resolve to kernel domain services/u);
});

test("positive fixture: a renderer readiness definition is refused", () => {
  const fixture = path.join(repoRoot, "tools/fixtures/domain-judgment-single-definition");
  const findings = checkDomainJudgmentSingleDefinition(fixture);
  assert.ok(findings.some((finding) => finding.includes("closeoutReadiness") && finding.includes("packages/gui/src/duplicate-readiness.ts")), findings.join("\n"));
});
