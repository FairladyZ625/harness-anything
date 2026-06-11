import assert from "node:assert/strict";
import test from "node:test";
import { Schema } from "effect";
import {
  domainStatuses,
  needsReviewArtifacts,
  statusCoarseClass
} from "../../src/domain/lifecycle-status.ts";
import { DomainStatusSchema } from "../../src/schemas/registry.ts";

test("domain status vocabulary is exactly the six canonical coordination states", () => {
  assert.deepEqual([...domainStatuses], [
    "planned",
    "active",
    "blocked",
    "in_review",
    "done",
    "cancelled"
  ]);
  assert.equal(domainStatuses.includes("unknown" as never), false);
});

test("domain statuses classify into open, terminal and review-artifact states", () => {
  assert.equal(statusCoarseClass("planned"), "open");
  assert.equal(statusCoarseClass("active"), "open");
  assert.equal(statusCoarseClass("blocked"), "open");
  assert.equal(statusCoarseClass("in_review"), "open");
  assert.equal(statusCoarseClass("done"), "terminal");
  assert.equal(statusCoarseClass("cancelled"), "terminal");
  assert.equal(needsReviewArtifacts("in_review"), true);
  assert.equal(needsReviewArtifacts("done"), true);
  assert.equal(needsReviewArtifacts("cancelled"), false);
});

test("status schema decodes every domain status and rejects non-domain snapshot display values", () => {
  for (const status of domainStatuses) {
    assert.equal(Schema.decodeUnknownSync(DomainStatusSchema)(status), status);
  }

  assert.throws(() => Schema.decodeUnknownSync(DomainStatusSchema)("unknown"));
});
