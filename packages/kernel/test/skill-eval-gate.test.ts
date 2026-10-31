// harness-test-tier: fast
import assert from "node:assert/strict";
import test from "node:test";
import { evaluateSkillCase, judgeSkillEvaluation } from "../src/skill-eval-gate.ts";

test("scores skill contract text, contains, regex, JSON structure, and forbidden words", () => {
  const result = evaluateSkillCase(
    { usageMarker: "<!-- skill:report -->", requiredText: ["Verified"] },
    {
      id: "public-summary",
      output: '<!-- skill:report --> Verified: result complete {"status":"ok","metrics":{"count":2}}',
      expect: {
        contains: ["result complete"],
        regex: [
          { pattern: "^<!-- skill:report -->", flags: "m" },
          { pattern: "verified", flags: "i" },
        ],
        json: { status: "ok", metrics: { count: 2 } },
        forbidden: ["unverified", "secret"],
      },
    },
  );

  assert.equal(result.pass, true);
  assert.deepEqual(result.failures, []);
});

test("reports missing contract text and mechanically failed expectations", () => {
  const result = evaluateSkillCase(
    { usageMarker: "<!-- skill:required -->", requiredText: ["approved"] },
    {
      id: "public-summary",
      output: 'The answer is pending {"status":"failed"} and contains unsafe advice.',
      expect: {
        contains: ["completed"],
        regex: [{ pattern: "^PASS" }],
        json: { status: "ok" },
        forbidden: ["unsafe"],
      },
    },
  );

  assert.equal(result.pass, false);
  assert.equal(result.failures.length, 6);
});

test("rejects malformed regular expressions as invalid case definitions", () => {
  assert.throws(
    () => evaluateSkillCase({}, { id: "bad-regex", output: "text", expect: { regex: [{ pattern: "[" }] } }),
    (error: unknown) => (error as { code?: string }).code === "VALIDATION_ERROR",
  );
});

test("scores malformed JSON output as a failed expectation", () => {
  const result = evaluateSkillCase(
    {},
    { id: "invalid-json", output: '{"status":', expect: { json: { status: "ok" } } },
  );

  assert.equal(result.pass, false);
  assert.deepEqual(result.failures, ["output contains no parseable JSON object"]);
});

test("binds a passing evaluation to an execution cut and emits a standard gate witness", () => {
  const judged = judgeSkillEvaluation({
    skillId: "weekly-report",
    version: "1.2.0",
    versionDigest: "a".repeat(64),
    evaluationId: "eval-001",
    outputs: [
      { caseId: "public-1", output: "verified" },
      { caseId: "hidden-1", output: "complete" },
    ],
    passed: 2,
    total: 2,
    threshold: 0.75,
    occurredAt: "2026-10-31T00:00:00.000Z",
  });

  assert.equal(judged.status, "passed");
  assert.equal(judged.execution.schema, "execution/v1");
  assert.equal(judged.execution.submission?.completionClaim, "Skill evaluation weekly-report@1.2.0");
  assert.equal(judged.execution.gateRuns[0]?.state, "completed");
  assert.equal(judged.witness.schema, "completion-gate-witness/v1");
  assert.equal(judged.witness.result, "pass");
  assert.equal(judged.witness.predicateType, "ha.skill-eval/v1");
  assert.equal(judged.witness.provenance?.source, "runner");
});

test("retains a failed evaluation as a failed witness and rejects inconsistent totals", () => {
  const judged = judgeSkillEvaluation({
    skillId: "weekly-report",
    version: "1.2.0",
    versionDigest: "b".repeat(64),
    evaluationId: "eval-002",
    outputs: [{ caseId: "public-1", output: "incomplete" }],
    passed: 0,
    total: 1,
    threshold: 1,
    occurredAt: "2026-10-31T00:00:00.000Z",
  });

  assert.equal(judged.status, "failed");
  assert.equal(judged.witness.result, "fail");
  assert.throws(
    () =>
      judgeSkillEvaluation({
        skillId: "weekly-report",
        version: "1.2.0",
        versionDigest: "b".repeat(64),
        evaluationId: "eval-003",
        outputs: [],
        passed: 0,
        total: 1,
        threshold: 1,
        occurredAt: "2026-10-31T00:00:00.000Z",
      }),
    (error: unknown) => (error as { code?: string }).code === "VALIDATION_ERROR",
  );
});
