// harness-test-tier: fast
import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { reviewDigest, validateReviewV1, type ReviewV1 } from "../../src/domain/review.ts";

// Historical pair from task_bf04a0fdb5bff97d360f4a7265-daemon-audit-phase1:
// - review-phase1-1.json is the recorded ReviewV1 verbatim from the canonical ledger projection;
// - review-phase1-1.packet.json is the review packet the arbiter submitted, byte for byte.
// The two digests below are the values that task's production consent (artifacts/consent.json)
// actually recorded. Deriving consent from the projected Review must keep reproducing them.
const review = JSON.parse(readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "../fixtures/review-consent/review-phase1-1.json"), "utf8")) as ReviewV1;
const packet = readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "../fixtures/review-consent/review-phase1-1.packet.json"));

test("the projected ReviewV1 is complete and reproduces the production consent digests", () => {
  assert.deepEqual(validateReviewV1(review), []);
  assert.equal(reviewDigest(review), "sha256:c58b4e95b787d1d65258a900acd0a2d44c9b126215aeb706c57c85312559ff1e");
  assert.equal(review.contentDigest, `sha256:${createHash("sha256").update(packet).digest("hex")}`);
  assert.equal(review.contentDigest, "sha256:8973a724a4887c3c533cd1e297937ad12c7de3bb1aefe30dbb8e8cc7f6a79841");
});
