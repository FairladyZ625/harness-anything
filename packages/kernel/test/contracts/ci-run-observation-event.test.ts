// harness-test-tier: contract
import assert from "node:assert/strict";
import test from "node:test";
import {
  validateCiRunObservationEvent,
  validateCiRunObservationEventV2,
  type CiRunObservationEventV2,
  type CiRunObservationEventV3,
} from "../../src/domain/ci-run-observation-event.ts";
import { validateRetiredCiRunObservationEvent } from "../../src/domain/ci-run-observation-retired-event.ts";
import { validateCiRunObservationEventV4 } from "../../src/domain/ci-run-observation-v4.ts";
import {
  parseCanonicalEvent,
  serializeCanonicalEvent,
  validateCurrentCanonicalEvent,
} from "../../src/domain/doc-sync-canonical-events.ts";

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
  assert.deepEqual(validateRetiredCiRunObservationEvent(v2), []);
  assert.notDeepEqual(validateCurrentCanonicalEvent(v2), []);
});

test("v3 remains historical only and cannot be written as current", () => {
  assert.deepEqual(validateCiRunObservationEvent(event), []);
  assert.deepEqual(validateRetiredCiRunObservationEvent(event), []);
  assert.notDeepEqual(validateCurrentCanonicalEvent(event), []);
  assert.throws(() => serializeCanonicalEvent(event as never), /not current/u);
});

test("v3 rejects legacy boolean gates", () => {
  assert.notDeepEqual(
    validateRetiredCiRunObservationEvent({ ...event, payload: { ...event.payload, gates: v2.payload.gates } }),
    [],
  );
});

test("current validation rejects unknown schema generations", () => {
  assert.notDeepEqual(validateRetiredCiRunObservationEvent({ ...event, schema: "ci-run-observation/v5" }), []);
  assert.notDeepEqual(validateCurrentCanonicalEvent({ ...event, schema: "ci-run-observation/v4" }), []);
});

test("v1 event fixture remains readable as retired history and is not writable", async () => {
  const { readFileSync } = await import("node:fs");
  const body = readFileSync(
    new URL("../../fixtures/canonical-events/ci-run-observation-v1/accepted.json", import.meta.url),
    "utf8",
  );
  const parsed = parseCanonicalEvent(body);
  assert.equal(parsed.schema, "ci-run-observation/v1");
  assert.deepEqual(validateRetiredCiRunObservationEvent(parsed), []);
  assert.notDeepEqual(validateCurrentCanonicalEvent(parsed), []);
  assert.equal(JSON.stringify(parsed) + "\n", body);
});

test("ci run observation rejects invalid retry and metric values", () => {
  assert.match(
    validateRetiredCiRunObservationEvent({
      ...event,
      payload: { ...event.payload, tests: [{ ...event.payload.tests[0]!, retry: -1 }] },
    }).join("\n"),
    /invalid/u,
  );
  assert.match(
    validateRetiredCiRunObservationEvent({
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
      event: "push",
    },
  },
};

test("v3 requires matching workflow verification when present", () => {
  assert.deepEqual(validateCiRunObservationEvent(verified), []);
  const legacy = structuredClone(verified);
  delete legacy.payload.verification.event;
  assert.deepEqual(validateCiRunObservationEvent(legacy), []);
  assert.deepEqual(validateRetiredCiRunObservationEvent(legacy), []);
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
      payload: { ...verified.payload, verification: { ...verified.payload.verification, event: undefined } },
    },
    {
      ...verified,
      payload: { ...verified.payload, verification: { ...verified.payload.verification, headSha: "other" } },
    },
    { ...verified, payload: { ...verified.payload, run: { ...verified.payload.run, branch: "feature" } } },
  ])
    assert.notDeepEqual(validateRetiredCiRunObservationEvent(candidate), []);
});

test("v4 workflow fixture stays readable and cannot be written as a current event", async () => {
  const { readFileSync } = await import("node:fs");
  const { validateCurrentCanonicalEvent, canonicalEventSchemas } = await import(
    "../../src/domain/doc-sync-canonical-events.ts"
  );
  const valid = JSON.parse(
    readFileSync(
      new URL("../../fixtures/canonical-events/ci-run-observation-v4/workflow.json", import.meta.url),
      "utf8",
    ),
  );
  const invalid = JSON.parse(
    readFileSync(
      new URL("../../../../tools/gates/test/fixtures/ci-run-observation-invalid.json", import.meta.url),
      "utf8",
    ),
  );
  assert.deepEqual(validateRetiredCiRunObservationEvent(valid), []);
  assert.notDeepEqual(validateCurrentCanonicalEvent(invalid), []);
  assert.deepEqual(
    parseCanonicalEvent(
      readFileSync(
        new URL("../../fixtures/canonical-events/ci-run-observation-v4/workflow.json", import.meta.url),
        "utf8",
      ),
    ),
    valid,
  );
  assert.throws(() => serializeCanonicalEvent(valid as never), /not current/u);
  for (const history of [v2, event]) {
    assert.deepEqual(canonicalEventSchemas.find((entry) => entry.schema === history.schema)!.validate(history), []);
    assert.notDeepEqual(validateCurrentCanonicalEvent(history), []);
  }
});

test("v4 historical job boundaries tolerate additions and reject malformed history", async () => {
  const { readFileSync } = await import("node:fs");
  const fixture = JSON.parse(
    readFileSync(new URL("../../fixtures/canonical-events/ci-run-observation-v4/job.json", import.meta.url), "utf8"),
  );
  assert.deepEqual(validateRetiredCiRunObservationEvent(fixture), []);
  const boundaries = [
    [],
    ["payload"],
    ["payload", "identity"],
    ["payload", "run"],
    ["payload", "measurementCoverage"],
    ["payload", "testSummary"],
    ["payload", "failedTests", 0],
    ["payload", "failedTests", 0, "declarationLocation"],
    ["payload", "failedTests", 0, "failureLocation"],
    ["payload", "fileOutcomes", 0],
    ["payload", "shardDurations", 0],
    ["payload", "detailRef"],
  ];
  for (const boundary of boundaries) {
    const event = structuredClone(fixture);
    let object = event;
    for (const key of boundary) object = object[key];
    object.futureOptionalField = true;
    assert.deepEqual(validateCiRunObservationEventV4(event), [], String(boundary));
    assert.deepEqual(validateRetiredCiRunObservationEvent(event), [], String(boundary));
  }
  for (const missing of ["testKey", "declarationLocation", "failureLocation", "durationMs"]) {
    const event = structuredClone(fixture);
    delete event.payload.failedTests[0][missing];
    assert.notDeepEqual(validateCiRunObservationEventV4(event), [], missing);
    assert.notDeepEqual(validateRetiredCiRunObservationEvent(event), [], missing);
  }
});
