// harness-test-tier: fast
import test from "node:test";
import assert from "node:assert/strict";
import { ciRunWindow, ciRerunStatistics } from "../src/domain/ci-rerun-statistics.ts";
import type { CiObservationRead, CiRunDetail } from "../src/domain/ci-run-observation-v4.ts";
import job from "../fixtures/canonical-events/ci-run-observation-v4/job.json" with { type: "json" };
import { decodeCiObservation } from "../src/domain/ci-run-observation-v4.ts";

function observation(
  attempt: number,
  status: "passed" | "failed",
  patch: Partial<CiObservationRead["payload"]["identity"]> = {},
) {
  const value = structuredClone(job) as unknown as Parameters<typeof decodeCiObservation>[0];
  const event = decodeCiObservation(value);
  const detail: CiRunDetail = {
    schema: "ci-run-detail/v1",
    fileOutcomes: [],
    diagnostics: [],
    tests: [
      {
        testKey: "test-key",
        file: "a.ts",
        name: "same name",
        suite: [],
        executionOrdinal: 1,
        declarationLocation: { line: 2, column: 1 },
        failureLocation: null,
        tier: "fast",
        shard: 1,
        durationMs: attempt * 10,
        status,
      },
    ],
  };
  return {
    event: {
      ...event,
      eventId: `event-${attempt}-${patch.jobKey ?? "job"}`,
      workspaceRevision: attempt,
      payload: {
        ...event.payload,
        scope: "job" as const,
        identity: {
          ...event.payload.identity,
          provider: "github-actions" as const,
          repositoryId: "repo",
          workflowId: "1",
          databaseRunId: "9007199254740993",
          runAttempt: attempt,
          jobKey: "job",
          jobExecutionId: `${attempt}-${patch.jobKey ?? "job"}`,
          ...patch,
        },
        run: { ...event.payload.run, branch: "main", sha: "sha" },
        measurementCoverage: { status: "complete", missingReason: null, startedFileCount: 1, completedFileCount: 1 },
      },
    },
    detail,
  };
}
function inventory(rows: ReturnType<typeof observation>[]) {
  const groups = new Map<string, ReturnType<typeof observation>[]>();
  for (const row of rows) {
    const i = row.event.payload.identity,
      key = JSON.stringify([i.databaseRunId, i.runAttempt]);
    groups.set(key, [...(groups.get(key) ?? []), row]);
  }
  return [...groups.values()].map((group) => {
    const event = group[0]!.event;
    return {
      ...event,
      eventId: `inventory-${event.eventId}`,
      payload: {
        ...event.payload,
        scope: "attempt" as const,
        identity: { ...event.payload.identity, jobKey: null, jobExecutionId: null },
        attemptInventory: {
          jobs: group.map((row) => ({
            jobExecutionId: row.event.payload.identity.jobExecutionId!,
            name: row.event.payload.identity.jobKey!,
            conclusion: "success",
          })),
          missingArtifactJobIds: [],
        },
        detailRef: null,
      },
    };
  });
}
function stats(...rows: ReturnType<typeof observation>[]) {
  return ciRerunStatistics(
    [...rows.map((row) => row.event), ...inventory(rows)],
    new Map(rows.map((row) => [row.event.eventId, row.detail])),
  );
}
test("actual failure then rerun pass is import-order independent and has traceable refs", () => {
  const a = observation(1, "failed"),
    b = observation(2, "passed");
  assert.deepEqual(stats(a, b), stats(b, a));
  const result = stats(b, a);
  assert.equal(result.recoveries.length, 1);
  assert.deepEqual(result.recoveries[0]?.from, { eventId: a.event.eventId, attempt: 1 });
  assert.equal(result.tests[0]?.rerunRecoveryRate, 1);
  assert.equal(result.tests[0]?.n, 2);
  assert.equal(result.tests[0]?.p95Ms, 20);
});
test("a later failure preserves the earlier recovery", () => {
  assert.equal(
    stats(observation(1, "failed"), observation(2, "passed"), observation(3, "failed")).recoveries.length,
    1,
  );
});
test("different run at the same SHA cannot establish rerun recovery", () => {
  const a = observation(1, "failed"),
    b = observation(1, "passed", { databaseRunId: "9007199254740994" });
  b.event.eventId = "other-run";
  assert.equal(stats(a, b).recoveries.length, 0);
  assert.equal(stats(a, b).tests[0]?.families, 2);
});
test("different matrices with the same test name remain separate", () => {
  const result = stats(observation(1, "failed", { jobKey: "linux" }), observation(2, "passed", { jobKey: "windows" }));
  assert.equal(result.tests.length, 2);
  assert.equal(result.recoveries.length, 0);
});
test("a job absent from the rerun has no synthetic pass", () => {
  const result = stats(
    observation(1, "failed", { jobKey: "rerun" }),
    observation(1, "passed", { jobKey: "absent" }),
    observation(2, "passed", { jobKey: "rerun" }),
  );
  assert.equal(result.recoveries.length, 1);
  assert.equal(result.tests.find((row) => row.identity.includes("absent"))?.n, 1);
});
test("a missing middle attempt preserves observed recovery but excludes the family from rate", () => {
  const result = stats(observation(1, "failed"), observation(3, "passed"));
  assert.equal(result.recoveries[0]?.complete, false);
  assert.equal(result.tests[0]?.rerunRecoveryRate, null);
  assert.equal(result.tests[0]?.excludedFamilies, 1);
});
test("missing details do not produce zero statistics; fetching restores complete calculation", () => {
  const a = observation(1, "failed"),
    b = observation(2, "passed");
  const result = ciRerunStatistics([a.event, b.event, ...inventory([a, b])], new Map([[a.event.eventId, a.detail]]));
  assert.equal(result.availability, "pending");
  assert.deepEqual(result.missing, [b.event.eventId]);
  assert.deepEqual(result.tests, []);
  assert.equal(stats(a, b).availability, "ready");
});
test("legacy nonunique identity is excluded from reliable recovery", () => {
  const a = observation(1, "failed"),
    b = observation(2, "passed");
  const events = [a, b].map((row) => ({ ...row.event, payload: { ...row.event.payload, scope: "legacy" as const } }));
  const result = ciRerunStatistics(
    events,
    new Map([
      [a.event.eventId, a.detail],
      [b.event.eventId, b.detail],
    ]),
  );
  assert.equal(result.recoveries.length, 0);
  assert.equal(result.tests[0]?.excludedFamilies, 1);
});
test("run window uses integer provider run identity, never import order or float rounding", () => {
  const a = observation(1, "failed"),
    b = observation(1, "passed", { databaseRunId: "9007199254740994" });
  b.event.eventId = "new";
  assert.deepEqual(ciRunWindow([b.event, a.event], 1), [b.event]);
});
test("durations include all completed executions, nearest rank, and omit skip/cancel", () => {
  const a = observation(1, "passed");
  a.detail = {
    ...a.detail,
    tests: [
      { ...a.detail.tests[0]!, status: "failed", durationMs: 5 },
      { ...a.detail.tests[0]!, executionOrdinal: 2, durationMs: 50 },
      { ...a.detail.tests[0]!, testKey: "skip", status: "skipped", durationMs: 1000 },
    ],
  };
  const result = stats(a);
  assert.equal(result.tests.find((row) => row.name === "same name" && row.n > 0)?.n, 2);
  assert.equal(result.tests.find((row) => row.n > 0)?.p50Ms, 5);
  assert.equal(result.tests.find((row) => row.n === 0)?.p95Ms, null);
  assert.equal(result.recoveries.length, 0);
});
test("workflow attempt without job inventory cannot prove complete statistics", () => {
  const a = observation(1, "failed"),
    b = observation(2, "passed");
  const workflow = {
    ...b.event,
    eventId: "workflow-2",
    payload: {
      ...b.event.payload,
      scope: "workflow" as const,
      identity: { ...b.event.payload.identity, jobKey: null, jobExecutionId: null },
      detailRef: null,
    },
  };
  // The same accepted facts represent either a job not rerun, or a rerun whose artifact is missing.
  // In the latter world it could have passed; the available events cannot determine either count.
  const result = ciRerunStatistics([a.event, workflow], new Map([[a.event.eventId, a.detail]]));
  assert.equal(result.availability, "pending");
});

test("executed job with missing artifact cannot be confused with a job not rerun", () => {
  const a = observation(1, "failed"),
    b = observation(2, "passed");
  const inv = inventory([a, b]);
  inv[1]!.payload.attemptInventory.missingArtifactJobIds = [b.event.payload.identity.jobExecutionId!];
  const missing = ciRerunStatistics([a.event, ...inv], new Map([[a.event.eventId, a.detail]]));
  assert.equal(missing.availability, "pending");
  assert.ok(missing.missing.some((ref) => ref.startsWith("artifact:")));
  assert.deepEqual(missing.tests, []);
  const complete = ciRerunStatistics(
    [a.event, b.event, ...inv],
    new Map([
      [a.event.eventId, a.detail],
      [b.event.eventId, b.detail],
    ]),
  );
  assert.deepEqual(
    complete,
    stats(a, b),
    "accepted job facts close the persisted missing set without rewriting the initial scan",
  );
});
test("conflicting authoritative job inventories are visible", () => {
  const a = observation(1, "failed"),
    inv = inventory([a])[0]!;
  const conflict = structuredClone(inv);
  conflict.eventId = "conflict";
  conflict.payload.attemptInventory.jobs.push({ jobExecutionId: "other", name: "other", conclusion: "success" });
  assert.throws(
    () => ciRerunStatistics([a.event, inv, conflict], new Map([[a.event.eventId, a.detail]])),
    /Conflicting/,
  );
});
