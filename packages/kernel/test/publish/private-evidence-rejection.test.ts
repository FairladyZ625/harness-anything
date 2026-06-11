import assert from "node:assert/strict";
import test from "node:test";
import { buildPublishableProjection } from "../../src/index.ts";

test("publishable projection rejects missing closeout evidence", () => {
  const result = buildPublishableProjection({
    sourceTaskId: "kr-07",
    title: "Public closeout",
    summary: "Review evidence is not complete yet.",
    links: [],
    readiness: {
      closeoutReadiness: "ready",
      reviewGate: "passed",
      ciGate: "passed",
      evidenceLinks: [
        {
          label: "Review",
          href: "https://example.invalid/pull/7",
          kind: "review"
        }
      ]
    }
  });

  assert.equal(result.ok, false);
  assert.equal(result.code, "closeout_not_ready");
  assert.equal(result.findings.some((finding) => finding.ruleId === "publish-readiness"), true);
});

test("publishable projection rejects missing review or CI evidence", () => {
  const result = buildPublishableProjection({
    sourceTaskId: "kr-07",
    title: "Public closeout",
    summary: "Closeout exists but review and CI are incomplete.",
    links: [],
    readiness: {
      closeoutReadiness: "passed",
      reviewGate: "missing",
      ciGate: "failed",
      evidenceLinks: []
    }
  });

  assert.equal(result.ok, false);
  assert.equal(result.code, "closeout_not_ready");
});
