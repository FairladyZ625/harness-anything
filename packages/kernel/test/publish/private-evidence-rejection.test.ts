// harness-test-tier: contract
import assert from "node:assert/strict";
import test from "node:test";
import { buildPublishableProjection } from "../../src/index.ts";

test("publishable projection treats closeout evidence readiness as descriptive", () => {
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

  assert.equal(result.ok, true);
  if (result.ok) assert.equal(result.projection.readiness.closeoutReadiness, "passed");
});

test("publishable projection treats review and CI readiness as descriptive", () => {
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

  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.projection.readiness.reviewGate, "passed");
    assert.equal(result.projection.readiness.ciGate, "passed");
  }
});
