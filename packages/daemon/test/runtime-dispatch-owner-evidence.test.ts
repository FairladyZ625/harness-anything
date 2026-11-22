// harness-test-tier: fast
import assert from "node:assert/strict";
import test from "node:test";
import type { TaskProjection } from "@harness-anything/kernel";
import { readRuntimeDispatchOwnerEvidence } from "../src/daemon-host/runtime-dispatch-owner-evidence.ts";

test("runtime dispatch owner evidence preserves dispatch identity metadata", () => {
  const payload = {
    dispatchId: "dispatch_0123456789abcdef01234567",
    taskId: "task_0123456789abcdef01234567",
    agentId: "agent-alpha",
    agentDeclarationDigest: `sha256:${"a".repeat(64)}`,
    skillSnapshotDigest: `sha256:${"b".repeat(64)}`,
    instanceId: "instance-alpha",
  };
  const projection = {
    readRuntimeSession: () => ({ definitionSnapshotRef: "definition-snapshot" }),
    readRuntimeDispatch: () => ({
      actor: { principal: { personId: "person-owner" }, executor: null },
      source: { kind: "local" },
      payload,
    }),
    readRuntimeSessionEventsByType: () => [],
  } as unknown as Pick<TaskProjection, "readRuntimeSession" | "readRuntimeDispatch" | "readRuntimeSessionEventsByType">;

  const evidence = readRuntimeDispatchOwnerEvidence(projection, "runtime_0123456789abcdef01234567");

  assert.deepEqual(evidence?.payload, {
    dispatchId: payload.dispatchId,
    taskId: payload.taskId,
    agentId: payload.agentId,
    agentDeclarationDigest: payload.agentDeclarationDigest,
    skillSnapshotDigest: payload.skillSnapshotDigest,
  });
  assert.equal(evidence?.instanceId, payload.instanceId);
});
