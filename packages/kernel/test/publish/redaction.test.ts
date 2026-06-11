import assert from "node:assert/strict";
import test from "node:test";
import { buildPublishableProjection } from "../../src/index.ts";

test("publishable projection rejects unsafe payloads before producing public output", () => {
  const result = buildPublishableProjection({
    sourceTaskId: "PRIVATE:kr-07",
    title: "Public closeout",
    summary: "Evidence lives at /Users/example/project/.harness-private/review.md",
    links: [
      {
        label: "Private artifact",
        href: "PRIVATE:coding-agent-harness/planning/tasks/kr-07/review.md",
        kind: "artifact"
      }
    ],
    readiness: {
      closeoutReadiness: "passed",
      reviewGate: "passed",
      ciGate: "passed",
      evidenceLinks: [
        {
          label: "PR",
          href: "https://example.invalid/pull/7",
          kind: "review"
        }
      ]
    }
  });

  assert.equal(result.ok, false);
  assert.equal(result.code, "redaction_failed");
  assert.equal(result.findings.some((finding) => finding.ruleId === "absolute-local-path"), true);
  assert.equal(result.findings.some((finding) => finding.ruleId === "private-harness-path"), true);
  assert.equal(result.findings.some((finding) => finding.ruleId === "private-evidence-marker"), true);
  assert.equal(result.findings.some((finding) => finding.path === "sourceTaskId"), true);
});

test("publishable projection rejects local path bypass variants", () => {
  for (const unsafeText of [
    "/tmp/private-review.md",
    "/Volumes/Secret/review.md",
    "file:///Users/example/secret.md",
    "C:\\Users\\example\\secret.md"
  ]) {
    const result = buildPublishableProjection({
      sourceTaskId: "kr-07",
      title: "Public closeout",
      summary: `Unsafe evidence ${unsafeText}`,
      links: [],
      readiness: passedReadiness()
    });

    assert.equal(result.ok, false);
    assert.equal(result.code, "redaction_failed");
  }
});

test("publishable projection rejects secret marker bypass variants", () => {
  for (const unsafeText of [
    "api_key=abc123",
    "Authorization: Bearer abc123",
    "ACCESS_TOKEN=abc123",
    "-----BEGIN PRIVATE KEY-----"
  ]) {
    const result = buildPublishableProjection({
      sourceTaskId: "kr-07",
      title: "Public closeout",
      summary: unsafeText,
      links: [],
      readiness: passedReadiness()
    });

    assert.equal(result.ok, false);
    assert.equal(result.code, "redaction_failed");
  }
});

test("publishable projection emits public-safe redaction report for clean payloads", () => {
  const result = buildPublishableProjection({
    sourceTaskId: "kr-07",
    title: "Public closeout",
    summary: "Review, CI, and closeout evidence passed.",
    links: [
      {
        label: "Merge commit",
        href: "https://example.invalid/commit/abc123",
        kind: "commit"
      }
    ],
    readiness: {
      closeoutReadiness: "passed",
      reviewGate: "passed",
      ciGate: "passed",
      evidenceLinks: [
      {
        label: "Review evidence",
        href: "https://example.invalid/pull/7",
        kind: "review"
      }
      ]
    }
  });

  assert.equal(result.ok, true);
  assert.equal(result.projection.visibility, "public-safe");
  assert.equal(result.projection.redactionReport.passed, true);
  assert.deepEqual(result.projection.redactionReport.findings, []);
});

function passedReadiness() {
  return {
    closeoutReadiness: "passed" as const,
    reviewGate: "passed" as const,
    ciGate: "passed" as const,
    evidenceLinks: [
      {
        label: "Review evidence",
        href: "https://example.invalid/pull/7",
        kind: "review" as const
      }
    ]
  };
}
