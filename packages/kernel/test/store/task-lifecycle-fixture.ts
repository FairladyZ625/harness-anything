import { REPLAY_TASK_GRAPH } from "../../src/domain/task-graph.ts";
import {
  applyTransition,
  emptyTaskLifecycleSnapshot,
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

export function lifecycleFixture(): { readonly events: readonly TaskEventV1[]; readonly snapshot: TaskLifecycleSnapshot } {
  const events: TaskEventV1[] = [];
  let snapshot = emptyTaskLifecycleSnapshot();
  const run = (command: TaskLifecycleCommand, proof: CreateReplayTaskProof | StartExecutionProof | SubmitExecutionProof | ReviewProof | CompleteTaskProof) => {
    const result = applyTransition(snapshot, command, proof as never);
    snapshot = result.snapshot;
    events.push(result.event);
  };
  run({
    type: "CreateReplayTask", taskId: "task-1", title: "Replay task", graph: REPLAY_TASK_GRAPH,
    completionGateIds: [], actor: implementer, opId: "op-1", eventId: "event-1", workspaceRevision: 1,
    occurredAt: "2026-08-11T00:00:00.000Z"
  }, { taskIdUnique: true, actorBinding: implementer });
  run({
    type: "StartExecution", taskId: "task-1", executionId: "execution-1", actor: implementer,
    opId: "op-2", eventId: "event-2", workspaceRevision: 2, occurredAt: "2026-08-11T00:01:00.000Z"
  }, {
    actorBinding: implementer, expectedRevision: 1,
    reservation: { taskId: "task-1", executionId: "execution-1", credentialHash: "credential-1", expiresAt: "2026-08-11T01:00:00.000Z", version: 0 }
  });
  run({
    type: "SubmitExecution", taskId: "task-1", executionId: "execution-1", actor: implementer,
    opId: "op-3", eventId: "event-3", workspaceRevision: 3, occurredAt: "2026-08-11T00:02:00.000Z",
    submission: { claim: "implemented", deliverables: [], evidenceRefs: [], verification: ["tests"], knownGaps: [], residualRisks: [], commitSha }
  }, { expectedRevision: 2, credentialHash: "credential-1", sessionDisposition: "complete" });
  run(reviewCommand(4, "anti_entropy", "approved", "review-ae"), {
    expectedRevision: 3, actorBinding: reviewer, capability: "anti-entropy@v1", capabilityRef: "cap-ae", archiveWarningsPresent: false
  });
  run(reviewCommand(5, "acceptance", "approved", "review-acceptance"), {
    expectedRevision: 4, actorBinding: reviewer, capability: "acceptance-review@v1", capabilityRef: "cap-acceptance", archiveWarningsPresent: false
  });
  run({
    type: "CompleteTask", taskId: "task-1", executionId: "execution-1", actor: implementer,
    opId: "op-6", eventId: "event-6", workspaceRevision: 6, occurredAt: "2026-08-11T00:05:00.000Z"
  }, { expectedRevision: 5, capability: "task-complete@v1", capabilityRef: "cap-complete", actorRole: "owner", noActiveLease: true, gateReceipts: [] });
  return { events, snapshot };
}

function reviewCommand(revision: number, kind: "anti_entropy" | "acceptance", verdict: "approved", reviewId: string): RecordReviewCommand {
  return {
    type: "RecordReview", taskId: "task-1", executionId: "execution-1", reviewId, kind, verdict,
    actorRole: kind, reason: `${kind} approved`, evidenceChecked: [], commitSha, iteration: 0,
    archiveWarningsAcknowledged: false, actor: reviewer, opId: `op-${revision}`, eventId: `event-${revision}`,
    workspaceRevision: revision, occurredAt: `2026-08-11T00:0${revision}:00.000Z`
  };
}
