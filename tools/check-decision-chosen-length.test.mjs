// harness-test-tier: contract
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
  checkDecisionChosenLength,
  formatDecisionChosenLengthReport,
  readDecisionChoices
} from "./check-decision-chosen-length.mjs";

test("new overlong chosen entry fails while parallel short entries pass", () => {
  withFixture((fixture) => {
    writeDecision(fixture.decisionsRoot, "dec_NEW", ["Readable judgment.", "x".repeat(121)]);

    const result = checkDecisionChosenLength(fixture.options);

    assert.equal(result.status, "checked");
    assert.deepEqual(result.violations, [
      "dec_NEW/CH2 is 121 characters; new chosen entries may not exceed 120"
    ]);
    assert.match(formatDecisionChosenLengthReport(result), /split parallel judgments/u);
    assert.match(formatDecisionChosenLengthReport(result), /harness\/standards\/decision-writing\.md/u);
  });
});

test("exact historical content is exempt but changed debt is not", () => {
  withFixture((fixture) => {
    writeDecision(fixture.decisionsRoot, "dec_OLD", ["x".repeat(121)]);
    const [choice] = readDecisionChoices(fixture.decisionsRoot);
    writeBaseline(fixture.baselinePath, [choice]);

    assert.deepEqual(checkDecisionChosenLength(fixture.options).violations, []);

    writeDecision(fixture.decisionsRoot, "dec_OLD", ["y".repeat(121)]);
    assert.deepEqual(checkDecisionChosenLength(fixture.options).violations, [
      "dec_OLD/CH1 changed while still over limit; baseline content must not drift"
    ]);
  });
});

test("remediated historical debt requires the baseline to shrink", () => {
  withFixture((fixture) => {
    writeDecision(fixture.decisionsRoot, "dec_OLD", ["x".repeat(121)]);
    const [choice] = readDecisionChoices(fixture.decisionsRoot);
    writeBaseline(fixture.baselinePath, [choice]);
    writeDecision(fixture.decisionsRoot, "dec_OLD", ["Readable judgment."]);

    assert.deepEqual(checkDecisionChosenLength(fixture.options).violations, [
      "dec_OLD/CH1 no longer exceeds 120; remove its stale baseline entry"
    ]);
  });
});

test("public checkout validates the baseline and reports the private ledger not applicable", () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-decision-chosen-public-"));
  const baselinePath = path.join(rootDir, "tools/decision-chosen-length-baseline.json");
  mkdirSync(path.join(rootDir, "tools"), { recursive: true });
  mkdirSync(path.join(rootDir, "packages/cli/src/commands/core"), { recursive: true });
  writeFileSync(
    path.join(rootDir, "packages/cli/src/commands/core/decision-writing-standard.ts"),
    "export const decisionChosenTextMaxLength = 120;\n"
  );
  writeBaseline(baselinePath, []);
  try {
    const result = checkDecisionChosenLength({ repoRoot: rootDir, baselinePath });

    assert.equal(result.status, "not-applicable");
    assert.match(result.reason, /does not declare harness\/harness\.yaml/u);
    assert.match(formatDecisionChosenLengthReport(result), /Baseline validated/u);
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

function withFixture(fn) {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-decision-chosen-gate-"));
  const decisionsRoot = path.join(rootDir, "decisions");
  const baselinePath = path.join(rootDir, "baseline.json");
  mkdirSync(decisionsRoot, { recursive: true });
  writeBaseline(baselinePath, []);
  try {
    fn({
      decisionsRoot,
      baselinePath,
      options: { repoRoot: process.cwd(), decisionsRoot, baselinePath }
    });
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
}

function writeDecision(decisionsRoot, decisionId, chosen) {
  const decisionRoot = path.join(decisionsRoot, `decision-${decisionId}`);
  mkdirSync(decisionRoot, { recursive: true });
  writeFileSync(path.join(decisionRoot, "decision.md"), [
    "---",
    "schema: decision-package/v1",
    `decision_id: ${decisionId}`,
    "chosen:",
    ...chosen.map((text, index) => `  - { id: "CH${index + 1}", text: ${JSON.stringify(text)} }`),
    "rejected:",
    "  - { id: \"RJ1\", text: \"No\", why_not: \"Reason\" }",
    "---",
    ""
  ].join("\n"));
}

function writeBaseline(baselinePath, choices) {
  writeFileSync(baselinePath, `${JSON.stringify({
    schema: "harness-anything/decision-chosen-length-baseline/v1",
    maxChosenTextLength: 120,
    measuredAt: "2026-07-25",
    source: "harness/decisions/*/decision.md",
    entries: choices.map(({ key, length, sha256 }) => ({ key, length, sha256 }))
  }, null, 2)}\n`);
}
