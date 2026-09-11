// harness-test-tier: contract
import assert from "node:assert/strict";
import test from "node:test";
import {
  serializeCiRunObservationEvent,
  validateCiRunObservationEvent,
  validateCurrentCiRunObservationEvent,
  validateCiRunObservationEventV2,
  type CiRunObservationEventV2,
  type CiRunObservationEventV3,
} from "../../src/domain/ci-run-observation-event.ts";

const base = {
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
  },
};
const v2: CiRunObservationEventV2 = {
  ...base,
  schema: "ci-run-observation/v2",
  payload: { ...base.payload, gates: [{ gate: "G32", pass: true, metrics: { count: 1 } }] },
};
const event: CiRunObservationEventV3 = {
  ...base,
  schema: "ci-run-observation/v3",
  payload: { ...base.payload, gates: [{ gate: "G32", result: "pass", metrics: { count: 1 } }] },
};

test("v2 retains the legacy boolean gate shape", () => {
  assert.deepEqual(validateCiRunObservationEventV2(v2), []);
  assert.notDeepEqual(validateCurrentCiRunObservationEvent(v2), []);
});

test("v3 accepts semantic gate results and serializes as current", () => {
  assert.deepEqual(validateCiRunObservationEvent(event), []);
  assert.deepEqual(validateCurrentCiRunObservationEvent(event), []);
  assert.equal(JSON.parse(serializeCiRunObservationEvent(event)).schema, "ci-run-observation/v3");
});

test("v3 rejects legacy boolean gates", () => {
  assert.notDeepEqual(
    validateCurrentCiRunObservationEvent({ ...event, payload: { ...event.payload, gates: v2.payload.gates } }),
    [],
  );
});

test("current validation rejects unknown schema generations", () => {
  assert.notDeepEqual(validateCurrentCiRunObservationEvent({ ...event, schema: "ci-run-observation/v2" }), []);
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
      payload: { ...event.payload, gates: [{ gate: "G32", result: "pass", metrics: { count: Number.NaN } }] },
    }).join("\n"),
    /invalid/u,
  );
});

/* legacy workflow verification cases continue to exercise the v3 validator. */
const verified = {
  ...event,
  payload: {
    ...event.payload,
    run: { ...event.payload.run, runId: "123.2", sha: "tested-sha" },
    verification: {
      source: "github-actions" as const,
      workflow: "rewrite-ci" as const,
      runId: "123",
      attempt: 2,
      headSha: "tested-sha",
      conclusion: "success",
    },
  },
};

test("v3 requires matching workflow verification when present", () => {
  assert.deepEqual(validateCurrentCiRunObservationEvent(verified), []);
  for (const candidate of [
    { ...verified, schema: "ci-run-observation/v1" },
    {
      ...verified,
      payload: {
        run: verified.payload.run,
        tests: [],
        gates: [{ gate: "ci", result: "pass", metrics: { runAttempt: 2 } }],
      },
    },
    { ...verified, payload: { ...verified.payload, verification: { ...verified.payload.verification, attempt: 3 } } },
    {
      ...verified,
      payload: { ...verified.payload, verification: { ...verified.payload.verification, headSha: "other" } },
    },
    { ...verified, payload: { ...verified.payload, run: { ...verified.payload.run, branch: "feature" } } },
  ])
    assert.notDeepEqual(validateCurrentCiRunObservationEvent(candidate), []);
});
