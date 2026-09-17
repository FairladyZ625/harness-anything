// harness-test-tier: contract
import assert from "node:assert/strict";
import test from "node:test";
import {
  CiRunObservationContractError,
  serializeCiRunObservationEvent,
  validateCiRunObservationEvent,
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

test("v2 decodes only through the offline migrator's legacy validator", () => {
  assert.deepEqual(validateCiRunObservationEventV2(v2), []);
  assert.notDeepEqual(validateCiRunObservationEvent(v2), []);
});

test("v3 accepts semantic gate results and serializes as current", () => {
  assert.deepEqual(validateCiRunObservationEvent(event), []);
  assert.equal(JSON.parse(serializeCiRunObservationEvent(event)).schema, "ci-run-observation/v3");
});

test("v3 rejects legacy boolean gates", () => {
  assert.notDeepEqual(
    validateCiRunObservationEvent({ ...event, payload: { ...event.payload, gates: v2.payload.gates } }),
    [],
  );
});

test("the single parser rejects unknown schema generations", () => {
  assert.notDeepEqual(validateCiRunObservationEvent({ ...event, schema: "ci-run-observation/v2" }), []);
});

test("ci run observation rejects invalid retry and metric values", () => {
  assert.match(
    validateCiRunObservationEvent({
      ...event,
      payload: { ...event.payload, tests: [{ ...event.payload.tests[0]!, retry: -1 }] },
    }).join("\n"),
    /invalid/u,
  );
  assert.match(
    validateCiRunObservationEvent({
      ...event,
      payload: { ...event.payload, gates: [{ gate: "G32", result: "pass", metrics: { count: Number.NaN } }] },
    }).join("\n"),
    /invalid/u,
  );
});

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
      event: "push",
    },
  },
};

test("github verification carries an explicit trigger event; null marks migration-preserved history", () => {
  assert.deepEqual(validateCiRunObservationEvent(verified), []);
  // The field is always present: null is the explicit historical-unobserved representation.
  const historical = structuredClone(verified) as {
    payload: { verification: { event: string | null } };
  };
  historical.payload.verification.event = null;
  assert.deepEqual(validateCiRunObservationEvent(historical), []);
  // A missing field is the retired permissive shape and fails closed.
  const legacy = structuredClone(verified) as { payload: { verification: Record<string, unknown> } };
  delete legacy.payload.verification.event;
  assert.notDeepEqual(validateCiRunObservationEvent(legacy), []);
  // Migration output validates, but a current writer can never serialize event:null.
  assert.throws(
    () => serializeCiRunObservationEvent(historical as CiRunObservationEventV3),
    (error: unknown) => {
      assert.ok(error instanceof CiRunObservationContractError);
      assert.match(error.message, /trigger event/u);
      return true;
    },
  );
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
      payload: { ...verified.payload, verification: { ...verified.payload.verification, event: 42 } },
    },
    {
      ...verified,
      payload: { ...verified.payload, verification: { ...verified.payload.verification, headSha: "other" } },
    },
    { ...verified, payload: { ...verified.payload, run: { ...verified.payload.run, branch: "feature" } } },
  ])
    assert.notDeepEqual(validateCiRunObservationEvent(candidate), []);
});

test("write-coordinator verification carries exactly its own field set", () => {
  const coordinator = {
    ...event,
    payload: {
      ...event.payload,
      run: { ...event.payload.run, runId: "ledger-abc", sha: "abc" },
      verification: {
        source: "write-coordinator" as const,
        workflow: "ledger-publication" as const,
        runId: "ledger-abc",
        attempt: 1,
        headSha: "abc",
        conclusion: "success",
      },
    },
  };
  assert.deepEqual(validateCiRunObservationEvent(coordinator), []);
  assert.notDeepEqual(
    validateCiRunObservationEvent({
      ...coordinator,
      payload: { ...coordinator.payload, verification: { ...coordinator.payload.verification, event: "push" } },
    }),
    [],
  );
});
