import { REPLAY_TASK_GRAPH } from "../../src/domain/task-graph.ts";
import {
  applyTransition,
  emptyTaskLifecycleSnapshot,
  normalizeTaskLifecycleCommand,
  reviewDigest,
  type CompleteTaskProof,
  type CreateReplayTaskProof,
  type RecordReviewCommand,
  type ReviewProof,
  type StartExecutionProof,
  type SubmitExecutionProof,
  type TaskEventV1,
  type TaskLifecycleCommand,
  type TaskLifecycleSnapshot
} from "../../src/domain/task-lifecycle.contract.ts";
import type { ActorAxes } from "../../src/domain/task.ts";

export const implementer: ActorAxes = { principal: { personId: "person-owner" }, executor: { kind: "agent", id: "codex" } };
export const reviewer: ActorAxes = { principal: { personId: "person-reviewer" }, executor: { kind: "agent", id: "reviewer" } };
export const commitSha = "a".repeat(40);

function command<C extends Parameters<typeof normalizeTaskLifecycleCommand>[1]>(actor: ActorAxes, revision: number, intent: C) {
  return { ...normalizeTaskLifecycleCommand({ workspaceId: "workspace-1", actor, source: "local", expectedRevision: revision - 1 }, intent), eventId: `event-${revision}`,
    workspaceRevision: revision, occurredAt: `2026-08-11T00:0${revision - 1}:00.000Z` };
}

export function lifecycleFixture(): { readonly events: readonly TaskEventV1[]; readonly snapshot: TaskLifecycleSnapshot } {
  const events: TaskEventV1[] = [];
  let snapshot = emptyTaskLifecycleSnapshot();
  const run = (command: TaskLifecycleCommand, proof: CreateReplayTaskProof | StartExecutionProof | SubmitExecutionProof | ReviewProof | CompleteTaskProof) => {
    const result = applyTransition(snapshot, command, proof as never);
    snapshot = result.snapshot;
    events.push(result.event);
  };
  run(command(implementer, 1, {
    type: "CreateReplayTask", taskId: "task-1", title: "Fixture", taskClass: "standard", graph: REPLAY_TASK_GRAPH, completionGateIds: [], presetSnapshotDigest: null
  }), { taskIdUnique: true, actorBinding: implementer });
  snapshot = {
    ...snapshot,
    decisionRelations: [
      {
        relationId: "fixture-decision-task",
        sourceRef: "decision/dec-fixture/CH1",
        targetRef: "task/task-1",
        relationType: "derives",
        state: "active",
      },
    ],
  };
  run(command(implementer, 2, {
    type: "StartExecution", taskId: "task-1", executionId: "execution-1"
  }), {
    actorBinding: implementer,
    reservation: { taskId: "task-1", executionId: "execution-1", expiresAt: "2026-08-11T01:00:00.000Z", ttlMs: 1_800_000,
      previousHolder: null, reason: "initial_claim", version: 0 }
  });
  run(command(implementer, 3, {
    type: "SubmitExecution", taskId: "task-1", executionId: "execution-1",
    submission: { completionClaim: "implemented", deliverables: [], outputs: [], verificationNotes: ["tests"], knownGaps: [], residualRisks: [], commitSha }
  }), { actorBinding: implementer, leaseVersion: 0, sessionDisposition: "complete" });
  run(reviewCommand(4, "approved", "review-execution"), {
    actorBinding: reviewer, capability: "execution-review@v1", capabilityRef: "cap-review"
  });
  const review = snapshot.reviews[0]!;
  run(command(implementer, 5, { type: "RecordReviewConsent", taskId: "task-1", executionId: "execution-1", reviewId: review.reviewId, consentId: "consent-1", reviewDigest: reviewDigest(review), contentDigest: review.contentDigest }), { actorBinding: implementer, capability: "execution-consent@v1", capabilityRef: "cap-consent" } as never);
  run(command(implementer, 6, { type: "CompleteTask", taskId: "task-1", executionId: "execution-1" }),
    { capability: "task-complete@v1", capabilityRef: "cap-complete", actorRole: "owner", noActiveLease: true, gateReceipts: [] });
  return { events, snapshot };
}

function reviewCommand(revision: number, verdict: "approved", reviewId: string): RecordReviewCommand {
  return command(reviewer, revision, {
    type: "RecordReview", taskId: "task-1", executionId: "execution-1", reviewId, verdict,
    reason: "execution approved", evidenceChecked: [], commitSha, iteration: 0,
    contentDigest: `sha256:${"b".repeat(64)}`
  });
}
