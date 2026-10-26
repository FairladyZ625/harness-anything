// harness-test-tier: contract
import assert from "node:assert/strict";
import { emptyCompletionContract, retiredHostedCiSource } from "../domain/completion.fixtures.ts";
import test from "node:test";
import { makeOfflineCompletionChain } from "../../src/store/offline-completion-chain.ts";
import { claimGateRun } from "../../src/domain/gate-run.ts";
import {
  REPLAY_TASK_GRAPH,
  compileCompletionGateWitness,
  compileExecutionAnnotation,
  compileTaskLifecycleWrite,
  currentTaskForWrite,
  lifecycleDocumentPaths,
  reduceTaskEvent,
  type TaskEventV1,
  type TaskLifecycleSnapshot,
} from "../../src/index.ts";
import { lifecycleFixture, implementer, reviewer, twoRoundLifecycleEvents } from "../store/task-lifecycle-fixture.ts";
import { submissionDigest } from "../../src/domain/execution.ts";
import { completionEvidenceBasis } from "../../src/domain/completion-evidence.ts";
import { closeoutReadiness } from "../../src/domain/closeout-readiness.ts";
import { canonicalGateReceipts } from "../../src/domain/task-lifecycle-contract-support.ts";
import { validateTaskGraph } from "../../src/domain/task-graph.ts";
import {
  applyTransition,
  normalizeTaskLifecycleCommand,
  emptyTaskLifecycleSnapshot,
  validateCurrentTaskEvent,
  validateTaskEvent,
} from "../../src/domain/task-lifecycle.contract.ts";

const actor = { principal: { personId: "person-owner" }, executor: null } as const;
const metadata = {
  idempotencyKey: null,
  parentTaskId: null,
  workKind: "fix" as const,
  riskTier: "medium" as const,
  urgency: null,
  verticalId: "software/coding",
  presetId: "standard-task",
  profileId: "baseline",
  moduleKey: null,
  slug: "legacy-release",
  surfaces: [] as readonly string[],
  fromLegacyId: null,
};

test("retired CI is omitted from completion receipt cuts even when an old receipt exists", () => {
  const gates = [
      {
        gateId: "ci",
        appliesTo: "code" as const,
        witness: {
          kind: "github-actions" as const,
          predicateType: "ci/v1",
          resultSchema: { type: "object" },
          adapterId: "github-actions" as const,
          adapterOptions: {
            workflows: ["rewrite-ci"],
            branch: "main",
            event: "push",
            coverage: "exact" as const,
            selection: "newest" as const,
          },
        },
      },
    ],
    fixture = lifecycleFixture({ gates, complete: false }),
    current = fixture.snapshot.executions[0]!;
  const snapshot: TaskLifecycleSnapshot = {
    ...fixture.snapshot,
    gateWitnesses: [
      {
        schema: "completion-gate-witness/v1",
        witnessId: "old-ci-witness",
        receiptId: "old-ci-receipt",
        checkerId: "github-actions",
        gateId: "ci",
        result: "pass",
        taskId: current.taskId,
        executionId: current.executionId,
        commitSha: current.submission!.commitSha,
        iteration: current.iteration,
        actor: implementer,
        source: "local",
        verifiedAt: "2026-08-11T00:04:30.000Z",
      } as TaskLifecycleSnapshot["gateWitnesses"][number],
    ],
  };
  assert.deepEqual(
    canonicalGateReceipts(snapshot, current, {
      required: true,
      merged: true,
      targetBranch: "main",
      platform: "github",
    }),
    [],
  );
});

test("current lifecycle writes accept a historical GUI assessment boolean", () => {
  const { events } = lifecycleFixture(),
    submitted = events.find((event) => event.type === "execution_submitted");
  assert.ok(submitted?.type === "execution_submitted");
  assert.ok(submitted.payload.execution.submission);

  const legacyEvent = {
    ...submitted,
    payload: {
      ...submitted.payload,
      execution: {
        ...submitted.payload.execution,
        submission: {
          ...submitted.payload.execution.submission,
          riskTierAssessment: {
            schema: "task-risk-tier-assessment/v1",
            declaredTier: "medium",
            effectiveTier: "medium",
            deliveryBaseSha: null,
            deliveryHeadSha: "a".repeat(40),
            matchedPathReviewers: [],
            reasons: [],
            guiAcceptanceRequired: true,
          },
        },
      },
    },
  } as TaskEventV1;

  assert.deepEqual(validateTaskEvent(legacyEvent), []);
  assert.deepEqual(validateCurrentTaskEvent(legacyEvent), []);
});

function executionReceipt(gateIds: readonly "ci"[]): string {
  const gates = gateIds.map((gateId) => ({
      gateId,
      appliesTo: "code" as const,
      witness: {
        ...retiredHostedCiSource,
        adapterId: "github-actions" as const,
        adapterOptions: {
          workflows: ["rewrite-ci"],
          branch: "main",
          event: "push",
          coverage: "exact" as const,
          selection: "newest" as const,
        },
      },
    })),
    fixture = lifecycleFixture({ gates, complete: false }),
    event = fixture.events.at(-1)!,
    compiled = compileTaskLifecycleWrite({
      event,
      snapshot: fixture.snapshot,
      packagePath: "tasks/task-1-fixture",
      currentDocuments: [],
    }),
    receipt = compiled.blobs.find(({ body }) => body.startsWith("# Execution "));
  assert.ok(receipt);
  return receipt.body;
}

function reviewSecondRound(input: {
  readonly verdict: "approved" | "changes_requested";
  readonly findings: readonly { readonly findingId: string; readonly blocking: boolean; readonly text: string }[];
  readonly resolutions: readonly {
    readonly reviewId: string;
    readonly findingId: string;
    readonly resolution: "upheld" | "withdrawn";
  }[];
}): ReturnType<typeof applyTransition> {
  const rounds = twoRoundLifecycleEvents({
      firstReviewFindings: [{ findingId: "F-1", blocking: true, text: "The original issue." }],
    }),
    execution = rounds.snapshot.executions.at(-1)!,
    responded = applyTransition(
      rounds.snapshot,
      {
        ...normalizeTaskLifecycleCommand(
          {
            workspaceId: "workspace-1",
            actor: implementer,
            source: "local",
            expectedRevision: rounds.snapshot.revision,
          },
          {
            type: "RespondReview",
            taskId: execution.taskId,
            executionId: execution.executionId,
            responses: [
              {
                reviewId: "review-round-one",
                findingId: "F-1",
                disposition: "rebut",
                rationale: "The previous issue has been addressed in this cut.",
              },
            ],
          },
        ),
        eventId: "event-review-resolution-response",
        workspaceRevision: rounds.snapshot.revision + 1,
        occurredAt: "2026-08-11T00:05:30.000Z",
      },
      { actorBinding: implementer, capability: "execution-review-response@v1", capabilityRef: "cap-response" },
    ),
    submission = {
      completionClaim: "reworked implementation",
      deliverables: [],
      outputs: [],
      verificationNotes: ["tests"],
      knownGaps: [],
      residualRisks: [],
      commitSha: "b".repeat(40),
      reviewResponses: responded.snapshot.reviewResponses,
      completionContract: {
        ...emptyCompletionContract,
        closeoutGates: { review: true, consent: true, factDisposition: true },
      },
    },
    submitted = applyTransition(
      responded.snapshot,
      {
        ...normalizeTaskLifecycleCommand(
          {
            workspaceId: "workspace-1",
            actor: implementer,
            source: "local",
            expectedRevision: responded.snapshot.revision,
          },
          { type: "SubmitExecution", taskId: execution.taskId, executionId: execution.executionId, submission },
        ),
        eventId: "event-review-resolution-submit",
        workspaceRevision: responded.snapshot.revision + 1,
        occurredAt: "2026-08-11T00:06:00.000Z",
      },
      { actorBinding: implementer, leaseVersion: 0, sessionDisposition: "complete" },
    );
  return applyTransition(
    submitted.snapshot,
    {
      ...normalizeTaskLifecycleCommand(
        {
          workspaceId: "workspace-1",
          actor: reviewer,
          source: "local",
          expectedRevision: submitted.snapshot.revision,
        },
        {
          type: "RecordReview",
          taskId: execution.taskId,
          executionId: execution.executionId,
          reviewId: "review-round-two",
          verdict: input.verdict,
          reason: "Re-review the returned cut.",
          evidenceChecked: ["changed cut"],
          commitSha: submission.commitSha,
          iteration: submitted.snapshot.task!.iteration,
          contentDigest: `sha256:${"d".repeat(64)}`,
          submissionDigest: submissionDigest(submission),
          findings: input.findings,
          resolutions: input.resolutions,
        },
      ),
      eventId: "event-review-resolution-record",
      workspaceRevision: submitted.snapshot.revision + 1,
      occurredAt: "2026-08-11T00:07:00.000Z",
    },
    { actorBinding: reviewer, capability: "execution-review@v1", capabilityRef: "cap-review", reworkBudget: 2 },
  );
}

test("upheld prior finding keeps the cut at review for CEO disposition", () => {
  const result = reviewSecondRound({
    verdict: "changes_requested",
    findings: [{ findingId: "F-2", blocking: true, text: "A second blocking concern." }],
    resolutions: [{ reviewId: "review-round-one", findingId: "F-1", resolution: "upheld" }],
  });

  assert.equal(result.snapshot.task?.status, "in_review");
  assert.equal(result.snapshot.executions.at(-1)?.state, "submitted");
  assert.equal(result.event.type, "review_recorded");
  assert.equal(result.event.payload.edge, undefined);
});

test("a re-review must resolve every prior finding the worker rebutted", () => {
  assert.throws(
    () =>
      reviewSecondRound({
        verdict: "changes_requested",
        findings: [{ findingId: "F-2", blocking: true, text: "A second blocking concern." }],
        resolutions: [],
      }),
    /exactly one resolution for rebutted finding review-round-one\/F-1/u,
  );
});

test("withdrawn prior finding with no new blocker does not reopen the cut", () => {
  const result = reviewSecondRound({
    verdict: "approved",
    findings: [],
    resolutions: [{ reviewId: "review-round-one", findingId: "F-1", resolution: "withdrawn" }],
  });

  assert.equal(result.snapshot.task?.status, "in_review");
  assert.equal(result.snapshot.executions.at(-1)?.state, "submitted");
  assert.equal(result.event.type, "review_recorded");
  assert.equal(result.event.payload.edge, undefined);
});

test("a new blocking finding without an upheld resolution reopens the cut", () => {
  const result = reviewSecondRound({
    verdict: "changes_requested",
    findings: [{ findingId: "F-2", blocking: true, text: "A new blocking concern." }],
    resolutions: [{ reviewId: "review-round-one", findingId: "F-1", resolution: "withdrawn" }],
  });

  assert.equal(result.snapshot.task?.status, "active");
  assert.equal(result.snapshot.task?.iteration, 2);
  assert.equal(result.snapshot.executions.at(-1)?.state, "changes_requested");
  assert.ok(result.event.type === "review_recorded" && result.event.payload.edge);
});

test("a withdrawn prior F-1 does not suppress a distinct new F-1 in the next review", () => {
  const result = reviewSecondRound({
    verdict: "changes_requested",
    findings: [{ findingId: "F-1", blocking: true, text: "A new issue with a reused local id." }],
    resolutions: [{ reviewId: "review-round-one", findingId: "F-1", resolution: "withdrawn" }],
  });

  assert.equal(result.snapshot.task?.status, "active");
  assert.equal(result.snapshot.task?.iteration, 2);
  assert.equal(result.snapshot.executions.at(-1)?.state, "changes_requested");
});

test("Execution receipts distinguish undeclared gates from required missing witnesses", () => {
  const ungated = executionReceipt([]);
  assert.match(ungated, /- Checker witnesses: not_required/u);
  assert.doesNotMatch(ungated, /Code-doc witness/u, "the retired witness line is gone from the record");

  const ci = executionReceipt(["ci"]);
  assert.match(ci, /- Checker witnesses: pending/u);
  assert.doesNotMatch(ci, /Code-doc witness/u);
});

test("an amended delivery re-derives the record anchors; the closeout prose carries none", () => {
  const { events } = lifecycleFixture(),
    submitted = events.findIndex((event) => event.type === "execution_submitted"),
    firstCommit = "a".repeat(40),
    amendedCommit = "b".repeat(40),
    recordPath = "tasks/task-1/executions/execution-1.md",
    snapshotAtSubmit = events
      .slice(0, submitted + 1)
      .reduce((state, event) => reduceTaskEvent(state, event), emptyTaskLifecycleSnapshot()),
    firstCut = compileTaskLifecycleWrite({
      event: events[submitted] as TaskEventV1,
      snapshot: snapshotAtSubmit,
      packagePath: "tasks/task-1",
      currentDocuments: [],
    }),
    // Blobs parallel changedPaths by index; claims carry the paths, blobs carry the bodies.
    firstRecord = firstCut.blobs[firstCut.changedPaths.indexOf(recordPath)]!.body;
  assert.match(firstRecord, new RegExp(`- Commit: ${firstCommit}`));
  // The amended cut lands after one more delivery commit: same prose, new commit.
  const amended = applyTransition(
      snapshotAtSubmit,
      {
        ...normalizeTaskLifecycleCommand(
          {
            workspaceId: "workspace-1",
            actor: implementer,
            source: "local",
            expectedRevision: snapshotAtSubmit.revision,
          },
          {
            type: "SubmitExecution",
            taskId: "task-1",
            executionId: "execution-1",
            amend: true,
            submission: {
              completionClaim: "implemented",
              deliverables: [],
              outputs: [],
              verificationNotes: ["tests"],
              knownGaps: [],
              residualRisks: [],
              commitSha: amendedCommit,
              completionContract: { ...emptyCompletionContract, gates: [] },
            },
          },
        ),
        eventId: "event-amended-cut",
        workspaceRevision: snapshotAtSubmit.revision + 1,
        occurredAt: "2026-08-11T00:10:00.000Z",
      },
      { actorBinding: implementer, leaseVersion: null, sessionDisposition: "complete" },
    ),
    amendedCut = compileTaskLifecycleWrite({
      event: amended.event,
      snapshot: amended.snapshot,
      packagePath: "tasks/task-1",
      currentDocuments: [],
    }),
    amendedRecord = amendedCut.blobs[amendedCut.changedPaths.indexOf(recordPath)]!.body;
  // The record's anchor re-derives from the frozen submission on every submit; the closeout
  // prose (completionClaim) never carried one, so an appended commit cannot leave a stale SHA
  // for a reviewer to compare against (the PR #3546 rejection cycle).
  assert.match(amendedRecord, new RegExp(`- Commit: ${amendedCommit}`));
  assert.doesNotMatch(amendedRecord, new RegExp(firstCommit));
  assert.equal(amendedCut.changedPaths.includes(recordPath), true);
});

test("a late changes_requested review may reopen a consented cut for a fresh iteration", () => {
  const { snapshot } = lifecycleFixture({ complete: false }),
    approved = snapshot.reviews[0]!,
    lateReview = {
      ...normalizeTaskLifecycleCommand(
        { workspaceId: "workspace-1", actor: implementer, source: "local", expectedRevision: snapshot.revision },
        {
          type: "RecordReview",
          taskId: snapshot.task!.taskId,
          executionId: snapshot.executions[0]!.executionId,
          reviewId: "review-late-changes",
          verdict: "changes_requested" as const,
          reason: "A late finding reopens the approved cut.",
          evidenceChecked: ["late audit"],
          commitSha: approved.commitSha,
          iteration: approved.iteration,
          contentDigest: approved.contentDigest,
          submissionDigest: approved.submissionDigest,
          findings: [{ findingId: "late-finding", blocking: true, text: "A late blocking finding." }],
          resolutions: [],
        },
      ),
      eventId: "event-late-changes-after-consent",
      workspaceRevision: snapshot.revision + 1,
      occurredAt: "2026-08-11T00:07:00.000Z",
    };
  const returned = applyTransition(snapshot, lateReview, {
    actorBinding: implementer,
    capability: "execution-review@v1",
    capabilityRef: "cap-review",
    reworkBudget: 2,
  });
  assert.equal(returned.event.type, "review_recorded");
  assert.equal(returned.snapshot.task?.status, "active");
  assert.equal(returned.snapshot.executions[0]?.state, "changes_requested");
  assert.equal(returned.snapshot.consents.length, 1, "the historical cut retains its consent record");
  assert.equal(returned.snapshot.edgesTaken.at(-1)?.edgeId, "review-changes-requested");
  const secondExecutionId = "execution-after-consented-return",
    started = applyTransition(
      returned.snapshot,
      {
        ...normalizeTaskLifecycleCommand(
          {
            workspaceId: "workspace-1",
            actor: implementer,
            source: "local",
            expectedRevision: returned.snapshot.revision,
          },
          {
            type: "StartExecution",
            taskId: snapshot.task!.taskId,
            executionId: secondExecutionId,
          },
        ),
        eventId: "event-start-after-consented-return",
        workspaceRevision: returned.snapshot.revision + 1,
        occurredAt: "2026-08-11T00:08:00.000Z",
      },
      {
        actorBinding: implementer,
        deliveryBaseline: { kind: "commit", commitSha: "0".repeat(40) },
        reservation: {
          taskId: snapshot.task!.taskId,
          executionId: secondExecutionId,
          expiresAt: "2026-08-11T01:08:00.000Z",
          ttlMs: 1_800_000,
          previousHolder: null,
          reason: "initial_claim",
          version: 0,
        },
      },
    );
  assert.equal(started.snapshot.task?.iteration, 1);
  assert.equal(started.snapshot.executions.at(-1)?.executionId, secondExecutionId);
  const responded = applyTransition(
    started.snapshot,
    {
      ...normalizeTaskLifecycleCommand(
        {
          workspaceId: "workspace-1",
          actor: implementer,
          source: "local",
          expectedRevision: started.snapshot.revision,
        },
        {
          type: "RespondReview",
          taskId: snapshot.task!.taskId,
          executionId: secondExecutionId,
          responses: [
            {
              reviewId: "review-late-changes",
              findingId: "late-finding",
              disposition: "adopt",
              rationale: "The late finding is addressed in this fresh iteration.",
            },
          ],
        },
      ),
      eventId: "event-respond-after-consented-return",
      workspaceRevision: started.snapshot.revision + 1,
      occurredAt: "2026-08-11T00:08:30.000Z",
    },
    { actorBinding: implementer, capability: "execution-review-response@v1", capabilityRef: "cap-response" },
  );
  const resubmitted = applyTransition(
    responded.snapshot,
    {
      ...normalizeTaskLifecycleCommand(
        {
          workspaceId: "workspace-1",
          actor: implementer,
          source: "local",
          expectedRevision: responded.snapshot.revision,
        },
        {
          type: "SubmitExecution",
          taskId: snapshot.task!.taskId,
          executionId: secondExecutionId,
          submission: {
            completionClaim: "reworked cut",
            deliverables: [],
            outputs: [],
            verificationNotes: ["tests"],
            knownGaps: [],
            residualRisks: [],
            commitSha: "b".repeat(40),
            reviewResponses: responded.snapshot.reviewResponses,
            completionContract: { ...emptyCompletionContract, gates: [] },
          },
        },
      ),
      eventId: "event-resubmit-after-consented-return",
      workspaceRevision: responded.snapshot.revision + 1,
      occurredAt: "2026-08-11T00:09:00.000Z",
    },
    { actorBinding: implementer, leaseVersion: 0, sessionDisposition: "complete" },
  );
  assert.equal(resubmitted.snapshot.executions.at(-1)?.state, "submitted");
  assert.equal(
    resubmitted.snapshot.consents.some((value) => value.executionId === secondExecutionId),
    false,
  );
  assert.equal(
    resubmitted.snapshot.reviews.some((value) => value.executionId === secondExecutionId),
    false,
  );
});

test("blocking task findings require one response before the next submit", () => {
  const rounds = twoRoundLifecycleEvents(),
    second = rounds.snapshot.executions.at(-1)! as TaskLifecycleSnapshot["executions"][number],
    reviewRequiredCompletionContract = {
      ...emptyCompletionContract,
      closeoutGates: { review: true, consent: true, factDisposition: true },
    },
    secondSubmission = {
      completionClaim: "reworked implementation",
      deliverables: [],
      outputs: [],
      verificationNotes: ["tests"],
      knownGaps: [],
      residualRisks: [],
      commitSha: "b".repeat(40),
      completionContract: reviewRequiredCompletionContract,
    },
    respondedToFirstRound = applyTransition(
      rounds.snapshot,
      {
        ...normalizeTaskLifecycleCommand(
          {
            workspaceId: "workspace-1",
            actor: implementer,
            source: "local",
            expectedRevision: rounds.snapshot.revision,
          },
          {
            type: "RespondReview",
            taskId: second.taskId,
            executionId: second.executionId,
            responses: [
              {
                reviewId: "review-round-one",
                findingId: "fixture-finding",
                disposition: "adopt",
                rationale: "The fixture finding is addressed.",
              },
            ],
          },
        ),
        eventId: "event-fixture-finding-response",
        workspaceRevision: rounds.snapshot.revision + 1,
        occurredAt: "2026-08-11T00:05:30.000Z",
      },
      { actorBinding: implementer, capability: "execution-review-response@v1", capabilityRef: "cap-response" },
    ),
    submitted = applyTransition(
      respondedToFirstRound.snapshot,
      {
        ...normalizeTaskLifecycleCommand(
          {
            workspaceId: "workspace-1",
            actor: implementer,
            source: "local",
            expectedRevision: respondedToFirstRound.snapshot.revision,
          },
          {
            type: "SubmitExecution",
            taskId: second.taskId,
            executionId: second.executionId,
            submission: { ...secondSubmission, reviewResponses: respondedToFirstRound.snapshot.reviewResponses },
          },
        ),
        eventId: "event-findings-submit",
        workspaceRevision: respondedToFirstRound.snapshot.revision + 1,
        occurredAt: "2026-08-11T00:06:00.000Z",
      },
      { actorBinding: implementer, leaseVersion: 0, sessionDisposition: "complete" },
    ),
    review = applyTransition(
      submitted.snapshot,
      {
        ...normalizeTaskLifecycleCommand(
          {
            workspaceId: "workspace-1",
            actor: reviewer,
            source: "local",
            expectedRevision: submitted.snapshot.revision,
          },
          {
            type: "RecordReview",
            taskId: second.taskId,
            executionId: second.executionId,
            reviewId: "review-blocking-finding",
            verdict: "changes_requested",
            reason: "Address the blocking finding.",
            evidenceChecked: ["contract"],
            commitSha: secondSubmission.commitSha,
            iteration: submitted.snapshot.task!.iteration,
            contentDigest: `sha256:${"c".repeat(64)}`,
            submissionDigest: submissionDigest(submitted.snapshot.executions.at(-1)!.submission!),
            findings: [{ findingId: "F-1", blocking: true, text: "The cut needs a correction." }],
            resolutions: [],
          },
        ),
        eventId: "event-findings-review",
        workspaceRevision: submitted.snapshot.revision + 1,
        occurredAt: "2026-08-11T00:07:00.000Z",
      },
      { actorBinding: reviewer, capability: "execution-review@v1", capabilityRef: "cap-review", reworkBudget: 2 },
    ),
    thirdExecutionId = "execution-round-three",
    started = applyTransition(
      review.snapshot,
      {
        ...normalizeTaskLifecycleCommand(
          {
            workspaceId: "workspace-1",
            actor: implementer,
            source: "local",
            expectedRevision: review.snapshot.revision,
          },
          { type: "StartExecution", taskId: second.taskId, executionId: thirdExecutionId },
        ),
        eventId: "event-findings-start",
        workspaceRevision: review.snapshot.revision + 1,
        occurredAt: "2026-08-11T00:08:00.000Z",
      },
      {
        actorBinding: implementer,
        deliveryBaseline: { kind: "commit", commitSha: "0".repeat(40) },
        reservation: {
          taskId: second.taskId,
          executionId: thirdExecutionId,
          expiresAt: "2026-08-11T01:08:00.000Z",
          ttlMs: 1_800_000,
          previousHolder: null,
          reason: "initial_claim",
          version: 0,
        },
      },
    );

  assert.throws(
    () =>
      applyTransition(
        started.snapshot,
        {
          ...normalizeTaskLifecycleCommand(
            {
              workspaceId: "workspace-1",
              actor: implementer,
              source: "local",
              expectedRevision: started.snapshot.revision,
            },
            {
              type: "SubmitExecution",
              taskId: second.taskId,
              executionId: thirdExecutionId,
              submission: { ...secondSubmission, commitSha: "d".repeat(40) },
            },
          ),
          eventId: "event-findings-submit-missing-response",
          workspaceRevision: started.snapshot.revision + 1,
          occurredAt: "2026-08-11T00:09:00.000Z",
        },
        { actorBinding: implementer, leaseVersion: 0, sessionDisposition: "complete" },
      ),
    /exactly one response for blocking finding review-blocking-finding\/F-1/u,
  );

  const responded = applyTransition(
      started.snapshot,
      {
        ...normalizeTaskLifecycleCommand(
          {
            workspaceId: "workspace-1",
            actor: implementer,
            source: "local",
            expectedRevision: started.snapshot.revision,
          },
          {
            type: "RespondReview",
            taskId: second.taskId,
            executionId: thirdExecutionId,
            responses: [
              {
                reviewId: "review-blocking-finding",
                findingId: "F-1",
                disposition: "rebut",
                rationale: "The correction is addressed.",
              },
            ],
          },
        ),
        eventId: "event-findings-response",
        workspaceRevision: started.snapshot.revision + 1,
        occurredAt: "2026-08-11T00:09:30.000Z",
      },
      { actorBinding: implementer, capability: "execution-review-response@v1", capabilityRef: "cap-response" },
    ),
    response = responded.snapshot.reviewResponses?.find((value) => value.reviewId === "review-blocking-finding");
  assert.equal(responded.event.type, "task_review_responded");
  assert.equal(response?.reviewId, "review-blocking-finding");
  const accepted = applyTransition(
    responded.snapshot,
    {
      ...normalizeTaskLifecycleCommand(
        {
          workspaceId: "workspace-1",
          actor: implementer,
          source: "local",
          expectedRevision: responded.snapshot.revision,
        },
        {
          type: "SubmitExecution",
          taskId: second.taskId,
          executionId: thirdExecutionId,
          submission: {
            ...secondSubmission,
            commitSha: "d".repeat(40),
            reviewResponses: responded.snapshot.reviewResponses,
          },
        },
      ),
      eventId: "event-findings-submit-answered",
      workspaceRevision: responded.snapshot.revision + 1,
      occurredAt: "2026-08-11T00:10:00.000Z",
    },
    { actorBinding: implementer, leaseVersion: 0, sessionDisposition: "complete" },
  );
  assert.equal(accepted.snapshot.executions.at(-1)?.submission?.reviewResponses?.length, 2);
});

test("a historical owner return still publishes its instruction as a managed task document", () => {
  // The manual return command retired with the automatic review loop (dec_E369B861 CH5); journals
  // still replay submission_returned events, and their managed documents must keep compiling.
  const fixture = twoRoundLifecycleEvents(),
    reopened = fixture.events.find((event) => event.type === "review_recorded")!,
    // The publication path compiles the historical envelope shape; it does not re-derive the
    // transition invariants, so the synthetic return mirrors the retired reduce's output.
    returned = {
      ...reopened,
      type: "submission_returned",
      payload: {
        task: reopened.payload.task,
        execution: reopened.payload.execution,
        reason: "owner accepted the changes_requested report; rework the cut",
        reviewId: reopened.payload.review.reviewId,
      },
    } as unknown as typeof reopened,
    submittedSnapshot = fixture.events
      .slice(0, 3)
      .reduce((snapshot, event) => reduceTaskEvent(snapshot, event), emptyTaskLifecycleSnapshot());
  const compiled = compileTaskLifecycleWrite({
    event: returned,
    snapshot: submittedSnapshot,
    packagePath: "tasks/task-two-round",
    currentDocuments: [],
  });
  assert.ok(compiled.changedPaths.includes("tasks/task-two-round/returns/iteration-0.md"));
  assert.match(compiled.blobs.map((blob) => blob.body).join("\n"), /owner accepted the changes_requested report/u);
});

test("lease release replay ignores only the retired longRunning task metadata", () => {
  const task = {
      schema: "task/v2",
      taskId: "task-legacy-release",
      title: "Legacy release",
      taskClass: "standard",
      status: "active",
      graph: REPLAY_TASK_GRAPH,
      currentNode: "implementation",
      iteration: 0,
      createdBy: actor,
      completionGateIds: [],
      presetSnapshotDigest: null,
      pinned: false,
      metadata: { ...metadata, longRunning: false },
    } as const,
    execution = {
      schema: "execution/v1",
      executionId: "execution-legacy-release",
      taskId: task.taskId,
      nodeId: "implementation",
      iteration: 0,
      state: "active",
      actor,
      claimedAt: "2026-08-15T20:36:06.914Z",
      submittedAt: null,
      closedAt: null,
      submission: null,
      gateRuns: [],
    } as const,
    lease = {
      schema: "lease/v1",
      taskId: task.taskId,
      executionId: execution.executionId,
      actor,
      source: "local",
      phase: "held",
      expiresAt: "2026-08-15T21:06:06.914Z",
      ttlMs: 1_800_000,
      version: 1,
    } as const,
    snapshot: TaskLifecycleSnapshot = {
      ...emptyTaskLifecycleSnapshot(1),
      task,
      executions: [execution],
      lease,
    },
    release: TaskEventV1 = {
      schema: "task-event/v1",
      eventId: "event-release",
      workspaceRevision: 2,
      opId: "op-release",
      taskId: task.taskId,
      type: "lease_released",
      actor,
      source: "local",
      occurredAt: "2026-08-24T01:05:05.136Z",
      payload: {
        task: currentTaskForWrite(task),
        execution,
        releasedLease: { ...lease, phase: "orphaned" },
        mutation: { command: "release", reason: "expired lease", fields: ["lease"] },
        documentClaims: [],
      },
    };

  assert.equal(reduceTaskEvent(snapshot, release).lease, null);
  assert.throws(
    () =>
      reduceTaskEvent(snapshot, {
        ...release,
        payload: { ...release.payload, task: { ...release.payload.task, title: "Changed" } },
      }),
    /replayed lease release is incomplete/u,
  );
});

function legacyCompletion() {
  // The gated fixture stops before CompleteTask: an unwitnessed cut cannot complete through the
  // command path, which is exactly the historical-acceptance asymmetry this replay test exercises.
  const fixture = lifecycleFixture({
    gates: [
      {
        gateId: "ci",
        appliesTo: "code" as const,
        witness: {
          ...retiredHostedCiSource,
          adapterId: "github-actions" as const,
          adapterOptions: {
            workflows: ["rewrite-ci"],
            branch: "main",
            event: "push",
            coverage: "exact" as const,
            selection: "newest" as const,
          },
        },
      },
    ],
    complete: false,
  });
  let snapshot = fixture.events.reduce(reduceTaskEvent, emptyTaskLifecycleSnapshot());
  const current = snapshot.executions[0]!;
  const historicalReviews = snapshot.reviews;
  snapshot = {
    ...snapshot,
    reviews: historicalReviews,
    gateWitnesses: [
      {
        schema: "completion-gate-witness/v1",
        witnessId: "gate-legacy",
        taskId: current.taskId,
        executionId: current.executionId,
        gateId: "ci",
        checkerId: "standard",
        receiptId: "op-legacy-ci",
        commitSha: current.submission!.commitSha,
        iteration: current.iteration,
        result: "pass",
        actor: implementer,
        source: "local",
        verifiedAt: "2026-08-11T00:04:30.000Z",
      },
    ],
  };
  // The accepted completion event is historical input: fabricate it the way a migrated ledger
  // carries it, since the current command path would never admit this cut.
  const completed: TaskEventV1 = {
    schema: "task-event/v1",
    eventId: "event-complete",
    workspaceRevision: snapshot.revision + 1,
    opId: "op-complete",
    taskId: current.taskId,
    type: "task_completed",
    actor: implementer,
    source: "local",
    occurredAt: "2026-08-11T00:05:00.000Z",
    payload: {
      task: { ...snapshot.task!, status: "done" },
      execution: { ...current, state: "accepted", closedAt: "2026-08-11T00:05:00.000Z" },
      // Completions recorded before the `fact` gate existed carry the other four gates only;
      // every ledger holds such events, so a cold replay must keep admitting this shape.
      closeoutGates: { review: true, consent: true, factDisposition: true },
      documentClaims: [],
    },
  };
  const converter = makeOfflineCompletionChain({
    generation: 2,
    snapshots: new Map(),
    missingSnapshots: new Set([snapshot.task!.presetSnapshotDigest!]),
    readContent: () => null,
  });
  const converted = fixture.events
    .map((event) => converter.convert(event).event as TaskEventV1)
    .reduce(reduceTaskEvent, emptyTaskLifecycleSnapshot());
  const witnessEvent = converter.convert({
    ...completed,
    opId: "op-legacy-ci",
    occurredAt: "2026-08-11T00:04:30.000Z",
    type: "completion_gate_verified",
    payload: { task: snapshot.task!, execution: current, witness: snapshot.gateWitnesses[0]!, documentClaims: [] },
  } as TaskEventV1).event as TaskEventV1;
  return {
    snapshot: reduceTaskEvent(converted, witnessEvent),
    completed: converter.convert({ ...completed, workspaceRevision: completed.workspaceRevision + 1 })
      .event as TaskEventV1,
    current: witnessEvent.payload.execution,
  };
}

test("accepted completion keeps legacy receipts without admitting a new unbound completion", () => {
  const { snapshot, completed, current } = legacyCompletion();
  const replayed = reduceTaskEvent(snapshot, completed);
  assert.equal(replayed.task?.status, "done");
  assert.equal(replayed.executions[0]?.state, "accepted");
  assert.deepEqual(replayed.gateWitnesses, snapshot.gateWitnesses);
  assert.equal(replayed.gateWitnesses[0]?.basis, undefined);
  // dec_5EC2631352B17EE2BF4979E37E: only explicit offline acceptance preserves history.
  assert.equal(closeoutReadiness(snapshot).readiness, "incomplete");
  const command = normalizeTaskLifecycleCommand(
    { workspaceId: "workspace-1", actor: implementer, source: "local", expectedRevision: snapshot.revision },
    { type: "CompleteTask", taskId: current.taskId, executionId: current.executionId },
  );
  assert.throws(
    () =>
      applyTransition(snapshot, command, {
        capability: "task-complete@v1",
        capabilityRef: "cap-complete",
        actorRole: "owner",
        noActiveLease: true,
        closeoutGates: { review: true, consent: true, factDisposition: true },
        gateReceipts: [],
      }),
    /gate|witness|completion/i,
  );
});

test("historical acceptance cannot authorize a new completion with missing approval or mismatched bindings", () => {
  const { snapshot, completed } = legacyCompletion();
  for (const invalid of [
    { ...snapshot, task: { ...snapshot.task!, iteration: snapshot.task!.iteration + 1 } },
    { ...snapshot, reviews: [] },
    { ...snapshot, consents: [] },
  ])
    assert.throws(
      () =>
        reduceTaskEvent(invalid, {
          ...completed,
          payload: { ...completed.payload, historicalAcceptance: undefined },
        } as TaskEventV1),
      /accepted task and execution state|invalid/,
    );
});

test("offline conversion freezes pre-freeze submissions before replaying historical witnesses", () => {
  // dec_5EC2631352B17EE2BF4979E37E: ordinary replay rejects pre-freeze carriers; offline conversion owns them.
  const fixture = lifecycleFixture({
      gates: [
        {
          gateId: "ci",
          appliesTo: "code" as const,
          witness: {
            ...retiredHostedCiSource,
            adapterId: "github-actions" as const,
            adapterOptions: {
              workflows: ["rewrite-ci"],
              branch: "main",
              event: "push",
              coverage: "exact" as const,
              selection: "newest" as const,
            },
          },
        },
      ],
      complete: false,
    }),
    replayed = fixture.events.reduce(reduceTaskEvent, emptyTaskLifecycleSnapshot()),
    current = replayed.executions[0]!,
    { completionContract: _frozen, ...legacySubmission } = current.submission!,
    legacyExecution = { ...current, submission: legacySubmission },
    snapshot: TaskLifecycleSnapshot = { ...replayed, executions: [legacyExecution] },
    verify = (witness: Record<string, unknown>): TaskEventV1 => ({
      schema: "task-event/v1",
      eventId: "event-witness",
      workspaceRevision: snapshot.revision + 1,
      opId: "op-legacy-ci",
      taskId: snapshot.task!.taskId,
      type: "completion_gate_verified",
      actor: implementer,
      source: "local",
      occurredAt: "2026-08-11T00:04:30.000Z",
      payload: {
        task: snapshot.task!,
        execution: legacyExecution,
        witness: {
          schema: "completion-gate-witness/v1",
          witnessId: "gate-legacy",
          taskId: snapshot.task!.taskId,
          executionId: legacyExecution.executionId,
          gateId: "ci",
          checkerId: "standard",
          receiptId: "op-legacy-ci",
          commitSha: legacySubmission.commitSha,
          iteration: legacyExecution.iteration,
          result: "pass",
          actor: implementer,
          source: "local",
          verifiedAt: "2026-08-11T00:04:30.000Z",
          ...witness,
        },
        documentClaims: [],
      },
    });

  assert.throws(() => reduceTaskEvent(snapshot, verify({})), /completionContract|Submission/);
  const converter = makeOfflineCompletionChain({
    generation: 2,
    snapshots: new Map(),
    missingSnapshots: new Set([snapshot.task!.presetSnapshotDigest!]),
    readContent: () => null,
  });
  const carrier = converter.convert({
    ...verify({}),
    type: "execution_submitted",
    payload: { task: snapshot.task!, execution: legacyExecution, documentClaims: [] },
  } as TaskEventV1).event as TaskEventV1;
  const convertedSnapshot = {
    ...snapshot,
    task: carrier.payload.task,
    executions: [carrier.payload.execution],
  } as TaskLifecycleSnapshot;
  const convertedWitness = converter.convert(verify({})).event as TaskEventV1;
  const bound = reduceTaskEvent(convertedSnapshot, convertedWitness);
  assert.equal(bound.gateWitnesses.length, 1);
  assert.equal(bound.gateWitnesses[0]?.gateId, "ci");
  for (const unbound of [
    { taskId: "other-task" },
    { commitSha: "b".repeat(40) },
    { executionId: "other-execution" },
    { iteration: legacyExecution.iteration + 1 },
  ])
    assert.throws(
      () =>
        reduceTaskEvent(convertedSnapshot, {
          ...convertedWitness,
          payload: { ...convertedWitness.payload, witness: { ...convertedWitness.payload.witness, ...unbound } },
        } as TaskEventV1),
      /not bound to the execution cut|pinned to its canonical event receipt/u,
    );
});

test("a graph stored with the retired maxIterations field still validates strictly", () => {
  assert.deepEqual(validateTaskGraph({ ...REPLAY_TASK_GRAPH, maxIterations: 1 }), []);
  assert.equal(validateTaskGraph({ ...REPLAY_TASK_GRAPH, maxIterationz: 1 }).length, 1);
});

test("execution annotation appends one note to a historical execution without rewriting it", () => {
  const { snapshot } = twoRoundLifecycleEvents(),
    historical = snapshot.executions.find((value) => value.executionId === "execution-round-one")!,
    compiled = compileExecutionAnnotation({
      snapshot,
      taskId: "task-two-round",
      executionId: "execution-round-one",
      actor: implementer,
      source: "local",
      kind: "superseded-by",
      note: "Superseded by execution-round-two after requested changes.",
      opId: "op-annotate",
      eventId: "event-annotate",
      workspaceRevision: snapshot.revision + 1,
      occurredAt: "2026-08-11T00:10:00.000Z",
    });
  assert.equal(compiled.event.type, "execution_annotated");
  const annotated = compiled.snapshot.executions.find((value) => value.executionId === "execution-round-one")!,
    current = compiled.snapshot.executions.find((value) => value.executionId === "execution-round-two")!;
  // Original record fields are untouched; only the append-only notes list grew.
  const { annotations: _annotations, ...rest } = annotated;
  assert.deepEqual(rest, historical);
  assert.deepEqual(annotated.annotations, [
    {
      kind: "superseded-by",
      note: "Superseded by execution-round-two after requested changes.",
      actor: implementer,
      annotatedAt: "2026-08-11T00:10:00.000Z",
    },
  ]);
  assert.equal(current.annotations, undefined);
  assert.equal(compiled.snapshot.task?.iteration, snapshot.task?.iteration);
  // The write plan rewrites only the annotated Execution's record, even for a past iteration.
  assert.deepEqual(lifecycleDocumentPaths(compiled.event, "tasks/task-two-round"), [
    "tasks/task-two-round/executions/execution-round-one.md",
  ]);
  const write = compileTaskLifecycleWrite({
    event: compiled.event,
    snapshot: compiled.snapshot,
    packagePath: "tasks/task-two-round",
    currentDocuments: [],
  });
  assert.deepEqual(write.changedPaths, ["tasks/task-two-round/executions/execution-round-one.md"]);
  assert.match(
    write.blobs[0]!.body,
    /## Annotations\n\n- 2026-08-11T00:10:00\.000Z superseded-by by person-owner: Superseded by execution-round-two/u,
  );
  // Replay of the canonical event lands the same snapshot; a payload that does not append the
  // envelope-pinned note is rejected, so history stays append-only.
  assert.deepEqual(reduceTaskEvent(snapshot, compiled.event), compiled.snapshot);
  const tampered = {
    ...compiled.event,
    payload: { ...compiled.event.payload, execution: historical },
  } as TaskEventV1;
  assert.throws(() => reduceTaskEvent(snapshot, tampered), /append exactly one/u);
  for (const invalid of [
    { executionId: "execution-missing" },
    { note: "   " },
    { kind: "obsolete" as never },
    { workspaceRevision: snapshot.revision },
  ])
    assert.throws(
      () =>
        compileExecutionAnnotation({
          snapshot,
          taskId: "task-two-round",
          executionId: "execution-round-one",
          actor: implementer,
          source: "local",
          kind: "correction",
          note: "correction",
          opId: "op-annotate",
          eventId: "event-annotate",
          workspaceRevision: snapshot.revision + 1,
          occurredAt: "2026-08-11T00:10:00.000Z",
          ...invalid,
        }),
      /annotation|append/u,
    );
});

test("admitted frozen gate witnesses replay outside the task declaration", () => {
  const gates = [
    {
      gateId: "ci",
      appliesTo: "code" as const,
      witness: {
        ...retiredHostedCiSource,
        adapterId: "github-actions" as const,
        adapterOptions: {
          workflows: ["rewrite-ci"],
          branch: "main",
          event: "push",
          coverage: "exact" as const,
          selection: "newest" as const,
        },
      },
    },
  ];
  const fixture = lifecycleFixture({ gates, complete: false });
  const snapshot = { ...fixture.snapshot, task: { ...fixture.snapshot.task!, completionGateIds: [] } };
  const original = snapshot.executions[0]!;
  const execution = {
    ...original,
    gateRuns: [
      claimGateRun({
        repoId: "repo",
        execution: original,
        requirement: gates[0]!,
        runId: "run-frozen",
        claimFence: 1,
        actor: implementer,
        occurredAt: "2026-08-11T00:04:00.000Z",
        expiresAt: "2026-08-11T01:00:00.000Z",
      }),
    ],
  };
  snapshot.executions = [execution];
  const event = compileCompletionGateWitness({
    snapshot,
    taskId: snapshot.task.taskId,
    executionId: execution.executionId,
    gateId: "ci",
    result: "pass",
    receiptId: "op-frozen",
    checkerId: "ci",
    commitSha: execution.submission!.commitSha,
    iteration: execution.iteration,
    reviewGate: true,
    actor: implementer,
    source: "local",
    opId: "op-frozen",
    eventId: "event-frozen",
    workspaceRevision: snapshot.revision + 1,
    occurredAt: "2026-08-11T00:05:00.000Z",
    packagePath: null,
    currentDocuments: [],
    evidence: {
      schema: "completion-evidence/v1",
      checkerId: "ci",
      gateId: "ci",
      result: "pass",
      observed: true,
      basis: completionEvidenceBasis(execution),
      subjects: [],
      predicateType: gates[0]!.witness.predicateType,
      predicate: {},
      diagnostic: "CI passed",
      provenance: {
        source: "runner",
        adapterId: "github-actions",
        runId: "run-frozen",
        claimFence: 1,
        rawResult: "success",
      },
    },
  }).event;
  assert.equal(reduceTaskEvent(snapshot, event).gateWitnesses.length, 1);
  for (const invalid of [
    { gateId: "unknown" },
    { executionId: "other" },
    { commitSha: "b".repeat(40) },
    { iteration: execution.iteration + 1 },
  ]) {
    assert.throws(
      () =>
        reduceTaskEvent(snapshot, {
          ...event,
          payload: { ...event.payload, witness: { ...event.payload.witness, ...invalid } },
        }),
      /not bound to the execution cut/u,
    );
  }
  const wrongScope = {
    ...execution,
    submission: {
      ...execution.submission!,
      completionContract: {
        ...execution.submission!.completionContract,
        gates: gates.map((gate) => ({ ...gate, appliesTo: "artifacts" as const })),
      },
    },
  };
  assert.throws(
    () =>
      reduceTaskEvent(
        { ...snapshot, executions: [wrongScope] },
        {
          ...event,
          payload: {
            ...event.payload,
            execution: wrongScope,
          },
        },
      ),
    /Only the holder of the current submission run and fence may publish/u,
  );
});
