// harness-test-tier: fast
import assert from "node:assert/strict";
import test from "node:test";
import type { AgentRuntimeEventV1, RuntimeSession } from "@harness-anything/kernel";
import { reviewAttemptEnded } from "../src/review-dispatch-state.ts";
import { readRuntimeDispatchOwnerEvidence } from "../src/runtime-spawn-control.ts";

const runtimeSessionId = "runtime-session-owner";

function liveness(processGroupPid?: number): AgentRuntimeEventV1 {
  return {
    schema: "agent-runtime-event/v1",
    eventId: `event-${processGroupPid ?? "state"}`,
    workspaceRevision: processGroupPid ?? 2,
    opId: `op-${processGroupPid ?? "state"}`,
    actor: { principal: { personId: "owner" }, executor: null },
    source: "local",
    occurredAt: "2026-11-07T00:00:00.000Z",
    type: "runtime_session_liveness_changed",
    payload: { runtimeSessionId, liveness: "live", ...(processGroupPid ? { processGroupPid } : {}) },
  } as AgentRuntimeEventV1;
}

test("owner evidence reads the session's liveness events only and keeps the newest pid match", () => {
  const readTypes: string[][] = [],
    session = {
      runtimeSessionId,
      instanceId: "instance-owner",
      definitionSnapshotRef: "artifact:runtime-definition/test",
    } as RuntimeSession,
    projection = {
      readRuntimeSession: () => session,
      readRuntimeDispatch: () => ({
        actor: { principal: { personId: "owner" }, executor: null },
        source: "local",
        payload: { dispatchId: "dispatch_owner", instanceId: "instance-owner" },
      }),
      readRuntimeSessionEventsByType: (_id: string, types: readonly string[]) => {
        readTypes.push([...types]);
        return [liveness(4242), liveness()];
      },
      readRuntimeSessionEvents: () => {
        throw new Error("owner evidence must not read the session's whole event history");
      },
    },
    evidence = readRuntimeDispatchOwnerEvidence(projection as never, runtimeSessionId);

  assert.equal(evidence?.processGroupPid, 4242);
  assert.deepEqual(readTypes, [["runtime_session_liveness_changed"]]);
});

test("review attempt end is decided from terminal event types only", () => {
  const readTypes: string[][] = [],
    projection = {
      readRuntimeSessionEventsByType: (_id: string, types: readonly string[]) => {
        readTypes.push([...types]);
        return [{ type: "runtime_session_exited", payload: { runtimeSessionId } } as AgentRuntimeEventV1];
      },
      readRuntimeSessionEvents: () => {
        throw new Error("review end must not read the session's whole event history");
      },
    };
  assert.equal(reviewAttemptEnded({ projection } as never, runtimeSessionId), true);
  assert.deepEqual(readTypes, [
    ["runtime_session_exited", "runtime_session_outcome_observed", "runtime_dispatch_outcome_unknown"],
  ]);
});
