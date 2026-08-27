// harness-test-tier: contract
import assert from "node:assert/strict";
import test from "node:test";
import {
  serializeCiRunObservationEvent,
  validateCiRunObservationEvent,
  validateCurrentCiRunObservationEvent,
  type CiRunObservationEventV1,
} from "../../src/domain/ci-run-observation-event.ts";

const event: CiRunObservationEventV1 = {
  schema: "ci-run-observation/v1",
  eventId: "event-ci-run",
  workspaceRevision: 1,
  opId: "op-ci-run",
  type: "ci_run_observed",
  actor: { principal: { personId: "person-test" }, executor: null },
  source: "local",
  occurredAt: "2026-08-27T00:00:00.000Z",
  payload: {
    run: { runId: "run-1", sha: "abc", branch: "main", prNumber: null, job: "test", wallclockMs: 10, runner: "ubuntu" },
    tests: [{ file: "a.test.ts", name: "works", tier: "fast", shard: null, durationMs: 5, status: "passed", retry: 0 }],
    gates: [{ gate: "G32", pass: true, metrics: { count: 1 } }],
  },
};

test("ci run observation contract round-trips canonical event bytes", () => {
  assert.deepEqual(validateCiRunObservationEvent(event), []);
  assert.deepEqual(validateCurrentCiRunObservationEvent(event), []);
  assert.equal(JSON.parse(serializeCiRunObservationEvent(event)).schema, "ci-run-observation/v1");
});

test("ci run observation rejects invalid retry and metric values", () => {
  assert.match(
    validateCurrentCiRunObservationEvent({
      ...event,
      payload: { ...event.payload, tests: [{ ...event.payload.tests[0]!, retry: -1 }] },
    }).join("\n"),
    /invalid/u,
  );
  assert.match(
    validateCurrentCiRunObservationEvent({
      ...event,
      payload: { ...event.payload, gates: [{ gate: "G32", pass: true, metrics: { count: Number.NaN } }] },
    }).join("\n"),
    /invalid/u,
  );
});
