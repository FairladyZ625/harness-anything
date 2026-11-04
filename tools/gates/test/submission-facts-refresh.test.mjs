// harness-test-tier: contract
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  SUBMISSION_FACTS_END,
  SUBMISSION_FACTS_START,
  renderSubmissionFacts,
  replaceSubmissionFacts,
} from "../../../packages/kernel/src/domain/submission-facts.ts";

const fixture = JSON.parse(
  readFileSync(new URL("./fixtures/submission-facts-rework-pr-body.json", import.meta.url), "utf8"),
);

test("a reworked frozen submission rewrites only the marked PR delivery facts", () => {
  const refreshed = replaceSubmissionFacts(fixture.beforeBody, renderSubmissionFacts(fixture.submission));
  assert.equal(refreshed, fixture.afterBody);
  assert.match(refreshed, /Production delta: \+322\/-56 \(net \+266\)/u);
  assert.match(refreshed, /Delivery commit: `7006e8626/u);
  assert.match(refreshed, /Authored prose stays\./u);
  assert.match(refreshed, /Authored verification stays\./u);
  assert.equal(
    refreshed.split(SUBMISSION_FACTS_START).length - 1,
    1,
    "the reworked body keeps exactly one machine-owned facts region",
  );
  assert.equal(refreshed.split(SUBMISSION_FACTS_END).length - 1, 1);
});
