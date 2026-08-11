// harness-test-tier: contract
import assert from "node:assert/strict";
import test from "node:test";
import { evaluateEvidenceEvent, validateEvidenceBody } from "../evidence-contract.mjs";

const common = [
  "Run-URL: https://github.com/example/repo/actions/runs/123456",
  "Commit-SHA: 0123456789abcdef0123456789abcdef01234567",
  "Failed-Test: packages/cli/test/help.test.ts",
  "Scope: cli/help",
  "Owner: rebuild-ci"
];

test("G17 accepts complete CI and paired performance evidence", () => {
  const body = [
    "Evidence-Type: ci",
    ...common,
    "",
    "Evidence-Type: performance",
    ...common,
    "Fixture: cli-help-cold-start-v1",
    "Phase: cold-start",
    "Baseline: 89abcdef0123456789abcdef0123456789abcdef"
  ].join("\n");
  assert.deepEqual(validateEvidenceBody(body).errors, []);
  assert.equal(evaluateEvidenceEvent({ issue: { body } }).status, "verified");
});

test("G18 reports unknown when required attribution fields are absent", () => {
  const result = evaluateEvidenceEvent({ pull_request: { body: "CI-Attribution: flaky test\nScope: cli" } });
  assert.equal(result.status, "unknown");
  assert.match(result.errors.join("\n"), /missing run-url.*missing commit-sha.*missing failed-test.*missing owner/su);
});

test("G18 rejects absolute thresholds and performance evidence without a comparison", () => {
  const noComparison = [
    "Performance-Claim: cold start <= 200ms",
    ...common,
    "Fixture: cli-help-cold-start-v1",
    "Phase: cold-start",
    "Baseline: absolute"
  ].join("\n");
  assert.equal(validateEvidenceBody(noComparison).status, "unknown");
  assert.match(validateEvidenceBody(noComparison).errors.join("\n"), /paired SHA or evidence URL/u);

  const absoluteOnly = "Performance-Claim: finishes under 200ms";
  assert.match(validateEvidenceBody(absoluteOnly).errors.join("\n"), /missing fixture.*missing phase.*missing baseline/su);
});

test("G17 returns N/A when an event makes no CI or performance claim", () => {
  assert.deepEqual(evaluateEvidenceEvent({ pull_request: { body: "Documentation only." } }), { status: "N/A", claims: [], errors: [] });
});
