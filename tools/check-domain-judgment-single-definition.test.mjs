// harness-test-tier: integration
import assert from "node:assert/strict";
import { cpSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { checkDomainJudgmentSingleDefinition } from "./check-domain-judgment-single-definition.mjs";

const repoRoot = path.resolve(import.meta.dirname, "..");

// The gate enumerates through git; a directory inside the real repository would
// resolve to the outer repo's tree, so the checked-in fixture runs from a copy
// that is its own repository.
function fixtureFindings(t) {
  const fixture = mkdtempSync(path.join(tmpdir(), "ha-domain-judgment-fixture-"));
  t.after(() => rmSync(fixture, { recursive: true, force: true }));
  cpSync(path.join(repoRoot, "tools/fixtures/domain-judgment-single-definition"), fixture, { recursive: true });
  for (const args of [
    ["init", "--quiet"],
    ["config", "core.excludesFile", "/dev/null"],
  ])
    spawnSync("git", args, { cwd: fixture });
  return checkDomainJudgmentSingleDefinition(fixture);
}

test("domain judgment single-definition gate accepts the repository", () => {
  const result = spawnSync("node", [path.join(repoRoot, "tools/check-domain-judgment-single-definition.mjs")], {
    cwd: repoRoot,
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /seven judgments resolve to kernel domain services/u);
});

test("positive fixture: a renderer readiness definition is refused", (t) => {
  const findings = fixtureFindings(t);
  assert.ok(
    findings.some(
      (finding) => finding.includes("closeoutReadiness") && finding.includes("packages/gui/src/duplicate-readiness.ts"),
    ),
    findings.join("\n"),
  );
});

test("positive fixture: startability, query validation, and status vocabulary copies are refused", (t) => {
  const findings = fixtureFindings(t);
  for (const [judgment, file] of [
    ["startability", "packages/daemon/src/duplicate-judgments.ts"],
    ["queryPayloadValidation", "packages/daemon/src/duplicate-judgments.ts"],
    ["statusVocabulary", "packages/daemon/src/duplicate-judgments.ts"],
  ])
    assert.ok(
      findings.some((finding) => finding.includes(judgment) && finding.includes(file)),
      findings.join("\n"),
    );
});

test("positive fixture: daemon start preview and CLI cancellation eligibility copies are refused", (t) => {
  const findings = fixtureFindings(t);
  assert.ok(
    findings.some((finding) => finding.includes("second Task startability preview")),
    findings.join("\n"),
  );
  assert.ok(
    findings.some((finding) => finding.includes("cancellation eligibility")),
    findings.join("\n"),
  );
});
