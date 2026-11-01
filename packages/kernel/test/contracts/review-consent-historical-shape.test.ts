// harness-test-tier: contract
import assert from "node:assert/strict";
import test from "node:test";
import { compileTaskLifecycleWrite, emptyTaskLifecycleSnapshot, reduceTaskEvent } from "../../src/index.ts";
import {
  applyTransition,
  normalizeTaskLifecycleCommand,
  reviewDigest,
  validateCurrentTaskEvent,
  validateTaskEvent,
  type ReviewConsentProof,
  type ReviewV1,
  type TaskEventV1,
  type TaskLifecycleSnapshot,
} from "../../src/domain/task-lifecycle.contract.ts";
import { validateCanonicalWriteBundle } from "../../src/ports/canonical-event-store.ts";
import { implementer, lifecycleFixture } from "../store/task-lifecycle-fixture.ts";

// W8 (#4011) made `findings` and `resolutions` required on a newly written Review/v1. A consent
// event embeds the Review the ledger already admitted, so its copy must be validated at the shape
// that recording boundary admitted, not at the current new-record shape. Everything below starts
// from the fixture's current-shape review and strips only the post-W8 arrays, reproducing an
// approved review registered before the upgrade (it already carried its `submissionDigest` pin).

type HistoricalReview = Omit<ReviewV1, "findings" | "resolutions">;

function historicalReviewOf(review: ReviewV1): HistoricalReview {
  const { findings: _findings, resolutions: _resolutions, ...historical } = review;
  void _findings;
  void _resolutions;
  return historical;
}

function historySnapshot(): { readonly snapshot: TaskLifecycleSnapshot; readonly review: HistoricalReview } {
  const { events } = lifecycleFixture({ complete: false });
  let snapshot = emptyTaskLifecycleSnapshot(),
    review: HistoricalReview | undefined;
  for (const event of events) {
    // The fixture's own consent event binds the current-shape review; rebuild the consent below.
    if (event.type === "review_consent_recorded") continue;
    if (event.type !== "review_recorded") {
      snapshot = reduceTaskEvent(snapshot, event);
      continue;
    }
    review = historicalReviewOf(event.payload.review);
    snapshot = reduceTaskEvent(snapshot, {
      ...event,
      payload: { ...event.payload, review: review as unknown as ReviewV1 },
    } as TaskEventV1);
  }
  assert.ok(review);
  return { snapshot, review };
}

function recordedConsent(reviewShape?: (review: ReviewV1) => Record<string, unknown>) {
  const { snapshot, review } = historySnapshot(),
    recorded = snapshot.reviews[0] as ReviewV1,
    command = {
      ...normalizeTaskLifecycleCommand(
        { workspaceId: "workspace-1", actor: implementer, source: "local", expectedRevision: snapshot.revision },
        {
          type: "RecordReviewConsent",
          taskId: recorded.taskId,
          executionId: recorded.executionId,
          reviewId: recorded.reviewId,
          consentId: "consent-historical",
          reviewDigest: reviewDigest(recorded),
          contentDigest: recorded.contentDigest,
        },
      ),
      eventId: "event-consent-historical",
      workspaceRevision: snapshot.revision + 1,
      occurredAt: "2026-08-11T00:09:00.000Z",
    },
    result = applyTransition(snapshot, command, {
      actorBinding: implementer,
      capability: "execution-consent@v1",
      capabilityRef: "cap-consent",
    } as ReviewConsentProof);
  return {
    ...result,
    event: reviewShape
      ? ({ ...result.event, payload: { ...result.event.payload, review: reviewShape(recorded) } } as TaskEventV1)
      : result.event,
    review,
  };
}

test("an approved review recorded before Review/v1 required findings and resolutions may be consented", () => {
  const { event, snapshot, review } = recordedConsent();
  assert.equal(event.type, "review_consent_recorded");
  assert.deepEqual(Object.keys(review).sort(), [
    "actor",
    "capabilityRef",
    "commitSha",
    "contentDigest",
    "evidenceChecked",
    "executionId",
    "iteration",
    "reason",
    "reviewId",
    "reviewedAt",
    "schema",
    "submissionDigest",
    "taskId",
    "verdict",
  ]);
  // Readable as history (unchanged) and now admissible as a current consent write.
  assert.deepEqual(validateTaskEvent(event), []);
  assert.deepEqual(validateCurrentTaskEvent(event), []);
  // The embedded copy is byte-identical to the recorded Review: consent still pins the original digest.
  assert.deepEqual(event.payload.review, review);
  assert.equal(event.payload.consent.reviewDigest, reviewDigest(review as unknown as ReviewV1));
  const compiled = compileTaskLifecycleWrite({
    event,
    snapshot,
    packagePath: "tasks/task-1-fixture",
    currentDocuments: [],
  });
  assert.doesNotThrow(
    () => validateCanonicalWriteBundle({ event: compiled.event, plan: compiled.plan, blobs: compiled.blobs }),
    "the canonical write boundary must admit the historical consent",
  );
});

test("owner override consent accepts the same historical review copy", () => {
  const { event, snapshot } = recordedConsent(),
    execution = event.payload.execution,
    submission = execution.submission;
  assert.ok(submission);
  const overridden = {
    ...event,
    type: "review_consent_overridden",
    payload: {
      ...event.payload,
      disposition: {
        schema: "review-disposition/v1",
        dispositionId: "disposition-consent-historical",
        taskId: event.taskId,
        executionId: execution.executionId,
        iteration: execution.iteration,
        submissionDigest: event.payload.consent.submissionDigest,
        disposedReviewIds: ["review-disposed"],
        rationale: "Owner disposed an earlier changes_requested review on this cut.",
        actor: event.actor,
        source: event.source,
        disposedAt: event.occurredAt,
      },
    },
  } as TaskEventV1;
  assert.equal(snapshot.task?.status, "in_review");
  assert.deepEqual(validateTaskEvent(overridden), []);
  assert.deepEqual(validateCurrentTaskEvent(overridden), []);
});

test("a newly written review still needs the current Review/v1 shape", () => {
  const { events } = lifecycleFixture({ complete: false }),
    recorded = events.find((event) => event.type === "review_recorded");
  assert.ok(recorded?.type === "review_recorded");
  const { findings: _findings, ...withoutFindings } = recorded.payload.review;
  void _findings;
  const stripped = {
    ...recorded,
    payload: { ...recorded.payload, review: withoutFindings },
  } as TaskEventV1;
  assert.deepEqual(validateTaskEvent(stripped), [], "the historical read path still accepts it");
  assert.match(
    validateCurrentTaskEvent(stripped)
      .map(({ message }) => message)
      .join("\n"),
    /Review\/v1 fields are incomplete or unknown/u,
    "current review writes must keep requiring findings",
  );

  // The loosened consent branch still enforces every field its own recording boundary required.
  for (const missing of ["verdict", "contentDigest", "reviewId"] as const) {
    const { event } = recordedConsent((review) => {
      const copy = { ...review } as Record<string, unknown>;
      delete copy[missing];
      return copy;
    });
    assert.match(
      validateCurrentTaskEvent(event)
        .map(({ message }) => message)
        .join("\n"),
      /Review\/v1 fields are incomplete or unknown/u,
      `consent must still require ${missing}`,
    );
  }
});
