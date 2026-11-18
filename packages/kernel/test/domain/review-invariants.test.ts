// harness-test-tier: fast
import assert from "node:assert/strict";
import test from "node:test";
import { submissionDigest } from "../../src/domain/execution.ts";
import { type ReviewFindingV1 } from "../../src/domain/review.ts";
import { reviewReverifyRoute } from "../../src/domain/review-reverify.ts";
import {
  applyTransition,
  TaskLifecycleContractError,
  emptyTaskLifecycleSnapshot,
  normalizeTaskLifecycleCommand,
  reduceTaskEvent,
  validateTransition,
  type RecordReviewCommand,
  type ReviewProof,
  type TaskLifecycleSnapshot,
} from "../../src/domain/task-lifecycle.contract.ts";
import { implementer, lifecycleFixture, reviewer } from "../store/task-lifecycle-fixture.ts";
import { checkProperty, removedChunks } from "./seeded-property.ts";

const fixture = lifecycleFixture({ complete: false });
const submitted = fixture.events.slice(0, 3).reduce(reduceTaskEvent, emptyTaskLifecycleSnapshot());
const currentCut = submitted.executions[0]!;
const checkedAt = "2026-08-11T00:07:00.000Z";
const blockingFinding = {
  findingId: "fix",
  text: "Correct the result",
  blocking: true,
  category: "correctness",
} as const;
const noteCategories = ["style", "diagnostic", "cleanup"] as const;

function recordReview(
  snapshot: TaskLifecycleSnapshot,
  findings: readonly ReviewFindingV1[],
  resolutions: RecordReviewCommand["resolutions"] = [],
): RecordReviewCommand {
  const cut = snapshot.executions.at(-1)!;
  return {
    ...normalizeTaskLifecycleCommand(
      { workspaceId: "workspace-1", actor: reviewer, source: "local", expectedRevision: snapshot.revision },
      {
        type: "RecordReview",
        taskId: cut.taskId,
        executionId: cut.executionId,
        iteration: cut.iteration,
        verdict: "changes_requested",
        reviewId: "review-current",
        reason: "Review findings require disposition",
        evidenceChecked: [],
        commitSha: cut.submission!.commitSha,
        contentDigest: `sha256:${"b".repeat(64)}`,
        submissionDigest: submissionDigest(cut.submission!),
        findings,
        resolutions,
      } satisfies RecordReviewCommand,
    ),
    eventId: "review-current-event",
    occurredAt: checkedAt,
    workspaceRevision: snapshot.revision + 1,
  };
}

function proof(reworkBudget: number): ReviewProof {
  return { actorBinding: reviewer, capability: "execution-review@v1", capabilityRef: "cap-review", reworkBudget };
}

test("review returns converge under the budget and an upheld rebuttal stops automatic rework", () => {
  checkProperty(
    (random, index) => ({
      budget: index % 11,
      history: Array.from({ length: random(15) }, () => random(3) === 0),
      rebutted: random(2) === 1,
      withdrawn: random(3) === 0,
      notes: Array.from({ length: 1 + random(6) }, (_, note) => ({
        findingId: `note-${note}`,
        text: `审查\t${random(1000)}`,
        category: noteCategories[random(noteCategories.length)]!,
        blocking: random(2) === 1,
      })),
    }),
    ({ budget, history, rebutted, withdrawn, notes }) => {
      let returns = 0;
      const executions = history.map((returned, index) => ({
        ...currentCut,
        executionId: `execution-prior-${index}`,
        iteration: returned ? returns++ : returns,
        state: returned ? ("changes_requested" as const) : ("abandoned" as const),
        closedAt: checkedAt,
      }));
      const cut = { ...currentCut, iteration: returns };
      const prior = {
        ...fixture.snapshot.reviews[0]!,
        verdict: "changes_requested" as const,
        iteration: returns - 1,
        executionId: executions.findLast((execution) => execution.state === "changes_requested")?.executionId ?? "",
        findings: [blockingFinding],
      };
      const snapshot: TaskLifecycleSnapshot = {
        ...submitted,
        task: { ...submitted.task!, iteration: returns },
        executions: [...executions, cut],
        reviews: returns > 0 ? [prior] : [],
        reviewResponses:
          rebutted && returns > 0
            ? [
                {
                  reviewId: prior.reviewId,
                  findingId: blockingFinding.findingId,
                  disposition: "rebut",
                  rationale: "The previous case is outside the supported contract",
                  actor: implementer,
                  respondedAt: checkedAt,
                },
              ]
            : [],
      };
      assert.equal(reviewReverifyRoute({ ...snapshot, execution: cut }).kind, returns > 0 ? "re-review" : "full");

      const upheld = returns > 0 && rebutted && !withdrawn;
      const resolutions =
        returns > 0 && rebutted
          ? [
              {
                reviewId: prior.reviewId,
                findingId: blockingFinding.findingId,
                resolution: withdrawn ? ("withdrawn" as const) : ("upheld" as const),
              },
            ]
          : [];
      const command = recordReview(snapshot, [blockingFinding, ...notes], resolutions);
      if (budget === 0) {
        // Settings require at least one return. Zero must fail at the writing boundary.
        assertReviewRejected(snapshot, command, 0, "invalid_proof");
      } else {
        const result = applyTransition(snapshot, command, proof(budget));
        const reopen = returns < budget && !upheld;
        assert.equal(result.event.type, "review_recorded");
        assert.equal(result.event.payload.edge?.on, reopen ? "changes_requested" : undefined);
        assert.equal(result.snapshot.task?.iteration, returns + Number(reopen));
        assert.equal(result.snapshot.executions.at(-1)?.state, reopen ? "changes_requested" : "submitted");
        assert.equal(result.snapshot.task?.currentNode, reopen ? "implementation" : "review");
      }

      const notesOnly = recordReview(snapshot, notes);
      assertReviewRejected(snapshot, notesOnly, 1, "invalid_review");
    },
  );
});

function assertReviewRejected(
  snapshot: TaskLifecycleSnapshot,
  command: RecordReviewCommand,
  budget: number,
  issueCode: string,
): void {
  assert.throws(
    () => applyTransition(snapshot, command, proof(budget)),
    (error: unknown) =>
      error instanceof TaskLifecycleContractError && error.issues.some(({ code }) => code === issueCode),
  );
}

function malformedFindingsCommand(findings: unknown): RecordReviewCommand {
  // Simulate JSON input at the lifecycle boundary, where TS types cannot guarantee field shape.
  return recordReview(submitted, findings as readonly ReviewFindingV1[]);
}

test("invalid finding elements remain structured validation failures", () => {
  const minimal = malformedFindingsCommand([null]); // Smallest counterexample from seed 1592594996.
  assert.deepEqual(validateTransition(submitted, minimal, proof(1)), [
    { code: "invalid_review", message: "review finding fields are incomplete or unknown" },
  ]);
  assertReviewRejected(submitted, minimal, 1, "invalid_review");

  checkProperty(
    (random) => [
      ...Array.from({ length: 1 + random(4) }, (_, index) => ({ ...blockingFinding, findingId: `valid-${index}` })),
      null,
    ],
    (input) => assertReviewRejected(submitted, malformedFindingsCommand(input), 1, "invalid_review"),
    function* (input) {
      for (const [start, end] of removedChunks(input.length)) {
        const candidate = [...input.slice(0, start), ...input.slice(end)];
        if (candidate.includes(null)) yield candidate;
      }
    },
    32,
  );
});
