// harness-test-tier: fast
import assert from "node:assert/strict";
import test from "node:test";
import { buildHandoffPacket, canonicalJson, packetDigest, verifyHandoffPacketDigest } from "../src/handoff-packet.ts";

const input = {
  handoffId: "handoff-1",
  revision: 3,
  mode: "transfer" as const,
  expiresAt: "2026-11-01T00:00:00.000Z",
  work: { id: "task-1", title: "Ship packet", description: "Continue safely", specRevision: 2, specDigest: "spec-sha" },
  attempt: {
    id: "attempt-1",
    status: "failed",
    sessionId: "session-1",
    runtime: "codex",
    error: "provider stopped",
    artifactId: "artifact-1",
    artifactDigest: "artifact-sha",
  },
  sourceEmployeeId: "worker-a",
  decisions: [{ knowledgeId: "decision-1", version: 4 }],
  sourceRefs: [{ sourceId: "fact-1", revision: 7, digest: "fact-sha" }],
  readers: ["worker-b"],
  openItems: ["finish tests"],
  sideEffects: "none",
  skills: ["backend-boundary-card"],
  target: { employeeId: "worker-b", name: "Next worker" },
  taskContext: '<task-context>\n<work ref="task/task-1">Ship packet</work>\n</task-context>',
};

test("canonical JSON is key-order independent and the digest verifies", () => {
  assert.equal(canonicalJson({ b: 2, a: { y: 1, x: 0 } }), '{"a":{"x":0,"y":1},"b":2}');
  const result = buildHandoffPacket(input);
  assert.equal(result.packet.completed[0]?.artifactId, "artifact-1");
  assert.deepEqual(result.packet.knownFailures, ["failed: provider stopped"]);
  assert.equal(result.digest, packetDigest(result.packet));
  assert.equal(verifyHandoffPacketDigest(result.packet, result.digest), true);
  assert.equal(
    verifyHandoffPacketDigest({ ...result.packet, goal: { ...result.packet.goal, title: "changed" } }, result.digest),
    false,
  );
});

test("explicit failure and artifact lists override attempt-derived summaries", () => {
  const result = buildHandoffPacket({
    ...input,
    knownFailures: ["known failure"],
    completed: [{ artifactId: "manual", digest: "manual-sha" }],
    taskContext: null,
    project: undefined,
    decisions: [],
  });
  assert.deepEqual(result.packet.knownFailures, ["known failure"]);
  assert.deepEqual(result.packet.completed, [{ artifactId: "manual", digest: "manual-sha" }]);
  assert.equal(result.packet.taskContext, null);
});

test("causal rows can render a bounded context when the caller has not pre-rendered one", () => {
  const result = buildHandoffPacket({
    ...input,
    taskContext: undefined,
    causalContext: undefined,
    project: { id: "project-1", name: "Parent work" },
    upstream: { id: "upstream-1", title: "Upstream task" },
    knowledge: [
      {
        id: "decision-2",
        version: 1,
        statement: "Keep the lease until proven stopped",
        sources: [{ sourceId: "fact-2", revision: 1, digest: "sha", text: "Observed stop proof" }],
      },
    ],
  });
  assert.match(result.packet.taskContext ?? "", /<work ref="task\/project-1">Parent work<\/work>/u);
  assert.match(
    result.packet.taskContext ?? "",
    /<chosen ref="decision\/decision-2">Keep the lease until proven stopped<\/chosen>/u,
  );
  assert.match(result.packet.taskContext ?? "", /<fact ref="fact\/fact-2@r1">Observed stop proof<\/fact>/u);
});
