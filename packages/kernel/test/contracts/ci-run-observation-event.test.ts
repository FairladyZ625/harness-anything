// harness-test-tier: contract
import assert from "node:assert/strict";
import test from "node:test";
import {
  serializeCiRunObservationEvent,
  validateCiRunObservationEvent,
  validateCurrentCiRunObservationEvent,
  type CiRunObservationEventV2,
} from "../../src/domain/ci-run-observation-event.ts";

const event: CiRunObservationEventV2 = {
  schema: "ci-run-observation/v2",
  eventId: "event-ci-run",
  workspaceRevision: 1,
  opId: "op-ci-run",
  type: "ci_run_observed",
  actor: { principal: { personId: "person-test" }, executor: null },
  source: "local",
  occurredAt: "2026-08-27T00:00:00.000Z",
  payload: {
    verification: null,
    run: { runId: "run-1", sha: "abc", branch: "main", prNumber: null, job: "test", wallclockMs: 10, runner: "ubuntu" },
    tests: [{ file: "a.test.ts", name: "works", tier: "fast", shard: null, durationMs: 5, status: "passed", retry: 0 }],
    gates: [{ gate: "G32", pass: true, metrics: { count: 1 } }],
  },
};

test("ci run observation contract round-trips canonical event bytes", () => {
  assert.deepEqual(validateCiRunObservationEvent(event), []);
  assert.deepEqual(validateCurrentCiRunObservationEvent(event), []);
  assert.equal(JSON.parse(serializeCiRunObservationEvent(event)).schema, "ci-run-observation/v2");
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

test("v2 requires explicit workflow verification and rejects legacy envelopes", () => {
  const run = { ...event.payload.run, runId: "123.2", sha: "tested-sha" };
  const verification = {
    source: "github-actions",
    workflow: "rewrite-ci",
    runId: "123",
    attempt: 2,
    headSha: "tested-sha",
    conclusion: "success",
  };
  const verified = { ...event, payload: { ...event.payload, run, verification } };
  assert.deepEqual(validateCurrentCiRunObservationEvent(verified), []);
  for (const candidate of [
    { ...verified, schema: "ci-run-observation/v1" },
    { ...verified, payload: { run, tests: [], gates: [{ gate: "ci", pass: true, metrics: { runAttempt: 2 } }] } },
    { ...verified, payload: { ...verified.payload, verification: { ...verification, attempt: 3 } } },
    { ...verified, payload: { ...verified.payload, verification: { ...verification, headSha: "other" } } },
    { ...verified, payload: { ...verified.payload, run: { ...run, branch: "feature" } } },
  ])
    assert.notDeepEqual(validateCurrentCiRunObservationEvent(candidate), []);
  assert.deepEqual(
    validateCurrentCiRunObservationEvent({ ...verified, payload: { ...verified.payload, verification: null } }),
    [],
  );
});
