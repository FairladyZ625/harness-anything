// harness-test-tier: fast
import assert from "node:assert/strict";
import test from "node:test";
import { Schema } from "effect";
import {
  domainStatuses,
  explainStatusTransition,
  needsReviewArtifacts,
  statusCoarseClass,
} from "../../src/domain/lifecycle-status.ts";
import { decisionStates } from "../../src/domain/decision-event.ts";
import { DomainStatusSchema } from "../../src/schemas/registry.ts";

test("domain status vocabulary is exactly the seven canonical coordination states", () => {
  assert.deepEqual(
    [...domainStatuses],
    ["planned", "active", "submitted", "blocked", "in_review", "done", "cancelled"],
  );
  assert.equal(domainStatuses.includes("unknown" as never), false);
});

test("domain statuses classify into open, terminal and review-artifact states", () => {
  assert.equal(statusCoarseClass("planned"), "open");
  assert.equal(statusCoarseClass("active"), "open");
  assert.equal(statusCoarseClass("submitted"), "open");
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

test("domain owns canonical lifecycle status transition semantics", () => {
  const allowed = new Set([
    "planned->planned",
    "planned->active",
    "planned->blocked",
    "planned->cancelled",
    "active->active",
    "active->planned",
    "active->submitted",
    "active->blocked",
    "active->cancelled",
    "submitted->submitted",
    "submitted->active",
    "submitted->in_review",
    "submitted->cancelled",
    "blocked->blocked",
    "blocked->active",
    "blocked->cancelled",
    "in_review->in_review",
    "in_review->active",
    "in_review->blocked",
    "in_review->done",
    "in_review->cancelled",
    "done->done",
    "cancelled->cancelled",
    "cancelled->planned",
    "cancelled->active",
    "cancelled->in_review",
  ]);

  for (const from of domainStatuses) {
    for (const to of domainStatuses) {
      assert.equal(explainStatusTransition(from, to).allowed, allowed.has(`${from}->${to}`), `${from} -> ${to}`);
    }
  }
  assert.deepEqual(explainStatusTransition("done", "active"), { allowed: false, reason: "terminal_status" });
  assert.deepEqual(explainStatusTransition("done", "planned"), { allowed: false, reason: "terminal_status" });
  assert.deepEqual(explainStatusTransition("cancelled", "blocked"), { allowed: false, reason: "terminal_status" });
  assert.deepEqual(explainStatusTransition("planned", "done"), { allowed: false, reason: "unsupported_transition" });
  // The adjudication corridor (owner ruling 2026-09-19): done is reachable only through
  // in_review, and only the owner's adjudication moves a submitted cut.
  assert.deepEqual(explainStatusTransition("active", "done"), { allowed: false, reason: "unsupported_transition" });
  assert.deepEqual(explainStatusTransition("active", "in_review"), {
    allowed: false,
    reason: "unsupported_transition",
  });
  assert.deepEqual(explainStatusTransition("submitted", "done"), {
    allowed: false,
    reason: "unsupported_transition",
  });
  assert.deepEqual(explainStatusTransition("submitted", "planned"), {
    allowed: false,
    reason: "unsupported_transition",
  });
});

test("Decision event vocabulary exposes only canonical projection states", () => {
  assert.deepEqual(
    [...decisionStates],
    ["proposed", "in_effect", "rejected", "deferred", "superseded", "outcome_retired"],
  );
});
