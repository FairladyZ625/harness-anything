import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { Schema } from "effect";
import { reviewDeclaration } from "../../src/entity/review-declaration.ts";
import { resolveEntityDocumentPath } from "../../src/entity/declaration.ts";
import { withTempStore } from "./helpers.ts";

const actor = {
  principal: { personId: "person-reviewer" },
  executor: { kind: "agent" as const, id: "reviewer-agent" },
  responsibleHuman: "person-reviewer"
};

function review(verdict: unknown) {
  return {
    schema: "review/v1",
    review_id: "rev_01J00000000000000000000000",
    task_ref: "task/task_01J00000000000000000000000",
    execution_ref: "execution/task_01J00000000000000000000000/exe_01J00000000000000000000000",
    reviewer_actor: actor,
    reviewer_session_ref: "session/ses_01J00000000000000000000000",
    findings: "The submitted round satisfies the acceptance criteria.",
    verdict,
    archive_warnings_acknowledged: false,
    reviewed_at: "2026-07-11T00:00:00.000Z"
  };
}

test("Review is a hosted entity whose verdict schema fails closed", () => {
  const decode = Schema.decodeUnknownSync(reviewDeclaration.schema);
  const approved = decode({ ...review("approved"), direction_change: "forbidden" });
  assert.equal(approved.verdict, "approved");
  assert.equal("direction_change" in approved, false);
  assert.equal(decode(review("changes_requested")).verdict, "changes_requested");
  assert.equal(decode(review("dismissed")).verdict, "dismissed");
  assert.throws(() => decode(review("direction_changed")));

  withTempStore((rootDir) => {
    const taskId = "task_01J00000000000000000000000";
    const reviewId = "rev_01J00000000000000000000000";
    mkdirSync(path.join(rootDir, "harness/tasks", taskId), { recursive: true });
    assert.equal(
      resolveEntityDocumentPath(rootDir, reviewDeclaration, { taskId, reviewId }),
      path.join(rootDir, "harness/tasks", taskId, "reviews", `${reviewId}.md`)
    );
  });
});
