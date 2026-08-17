// harness-test-tier: contract
import assert from "node:assert/strict";
import test from "node:test";
import {
  REPLAY_TASK_GRAPH,
  parseCanonicalEvent,
  serializeCanonicalEvent,
  type TaskBootstrapEventV1
} from "../../src/index.ts";

const event: TaskBootstrapEventV1 = {
  schema: "task-bootstrap-event/v1",
  eventId: "event-bootstrap-1",
  workspaceRevision: 1,
  opId: "op-bootstrap-1",
  taskId: "task-bootstrap-1",
  type: "task_bootstrapped",
  actor: { principal: { personId: "person-1" }, executor: null },
  source: "local",
  occurredAt: "2026-08-13T00:00:00.000Z",
  payload: {
    task: {
      schema: "task/v1",
      taskId: "task-bootstrap-1",
      title: "Bootstrap",
      taskClass: "milestone",
      status: "planned",
      graph: REPLAY_TASK_GRAPH,
      currentNode: "implementation",
      iteration: 0,
      createdBy: { principal: { personId: "person-1" }, executor: null },
      completionGateIds: ["ci"],
      presetSnapshotDigest: `sha256:${"a".repeat(64)}`
    },
    presetSnapshotClaim: {
      digest: `sha256:${"a".repeat(64)}`,
      sha256: "b".repeat(64),
      size: 2,
      mediaType: "application/json"
    },
    initialDocumentClaims: [{
      path: "tasks/task-bootstrap-1-bootstrap/task_plan.md",
      sha256: "c".repeat(64),
      size: 7,
      mediaType: "text/markdown",
      owner: "doc-sync",
      policyId: "markdown-body-replaceable/v1"
    }]
  }
};

test("TaskBootstrapEventV1 is a canonical closed-union member with an explicit taskClass", () => {
  const body = serializeCanonicalEvent(event);
  assert.deepEqual(parseCanonicalEvent(body), event);
  assert.throws(() => serializeCanonicalEvent({ ...event, payload: { ...event.payload, task: { ...event.payload.task, taskClass: undefined } } } as unknown as TaskBootstrapEventV1), /invalid taskClass/u);
  assert.throws(() => serializeCanonicalEvent({ ...event, payload: { ...event.payload, initialDocumentClaims: [{ ...event.payload.initialDocumentClaims[0]!, path: "tasks/task-bootstrap-1-/task_plan.md" }] } }), /package path/u);
  assert.throws(() => serializeCanonicalEvent({ ...event, payload: { ...event.payload, initialDocumentClaims: [{ ...event.payload.initialDocumentClaims[0]!, mediaType: "application/json" }] } } as unknown as TaskBootstrapEventV1), /claims are invalid/u);
});

test("long_running is a kernel taskClass and the retired longRunning boolean is only read-tolerated", () => {
  const metadata = { idempotencyKey: null, parentTaskId: null, workKind: null, riskTier: null, urgency: null, verticalId: "software/coding", presetId: "docs-task", profileId: "default", moduleKey: null, slug: "bootstrap", surfaces: [], fromLegacyId: null };
  const resident = serializeCanonicalEvent({ ...event, payload: { ...event.payload, task: { ...event.payload.task, taskClass: "long_running", metadata } } } as TaskBootstrapEventV1);
  assert.match(resident, /"taskClass":"long_running"/u);
  assert.doesNotMatch(resident, /longRunning/u);
  // Historical events recorded metadata.longRunning before taskClass=long_running existed; the
  // immutable log must keep replaying, so the retired key is tolerated when it carries its old type.
  const legacy = parseCanonicalEvent(serializeCanonicalEvent({ ...event, payload: { ...event.payload, task: { ...event.payload.task, taskClass: "long_running", metadata: { ...metadata, longRunning: true } } } } as unknown as TaskBootstrapEventV1));
  assert.deepEqual(legacy.payload.task.metadata, { ...metadata, longRunning: true });
  assert.throws(() => serializeCanonicalEvent({ ...event, payload: { ...event.payload, task: { ...event.payload.task, metadata: { ...metadata, longRunning: "yes" } } } } as unknown as TaskBootstrapEventV1), /metadata is incomplete or invalid/u);
  assert.throws(() => serializeCanonicalEvent({ ...event, payload: { ...event.payload, task: { ...event.payload.task, metadata: { ...metadata, orbit: true } } } } as unknown as TaskBootstrapEventV1), /metadata is incomplete or invalid/u);
  assert.throws(() => serializeCanonicalEvent({ ...event, payload: { ...event.payload, task: { ...event.payload.task, taskClass: "long-running", metadata } } } as unknown as TaskBootstrapEventV1), /invalid taskClass/u);
});
